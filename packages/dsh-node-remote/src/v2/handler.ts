import { randomUUID } from 'node:crypto'
import { HostRpcError, HostTransportError, type HostHttp } from '../http.js'
import type { MuxConnection } from '../mux.js'
import type {
  FileRefView,
  FrameSink,
  MobileClientFrame,
  MobileServerFrame,
  MobileV2Feature,
  ModelPricingHooks,
  ModelSelectionView,
  ModelView,
  NodeCapabilitiesV2,
  ToolKind,
} from '../types.js'
import { readByteResponse } from './multipart.js'
import {
  checkEffort,
  findModel,
  projectModelCatalog,
  type ModelCatalogView,
  type ModelEntry,
} from './models.js'
import {
  authorizeStat,
  decodeFileRef,
  encodeFileRef,
  relativeLabel,
  resolveRequestPath,
  type PathRules,
} from './paths.js'
import { leafName, mediaTypeOfPath, mimeTypeOfPath, sha256Hex } from './text.js'
import { projectToolCall, projectToolResult } from './tool.js'

/**
 * 通道 v2 的全部新行为（契约 §4–§10）。
 *
 * 为什么单独一个类：v1 的翻译逻辑已经稳定（`adapter.ts`），v2 是**纯增量**。
 * 把新行为收在这里，adapter 只保留「分发 + 少量钩子」，v1 路径不受影响，
 * 也方便把 v2 的规则（截断、包含检查、分块）单独单测。
 */

const CHUNK_BYTES = 144 * 1024
const INLINE_BYTES = 96 * 1024
const FILE_MAX_BYTES = 20 * 1024 * 1024
const IMAGE_MAX_BYTES = 5 * 1024 * 1024
const DESKTOP_MAX_BYTES = 1 * 1024 * 1024
const UPLOAD_TTL_MS = 10 * 60_000
const UPLOAD_TOTAL_BYTES = 32 * 1024 * 1024
const CATALOG_TTL_MS = 60_000
const CANDIDATE_BUDGET_MS = 1500
const CANDIDATE_PER_TURN = 16

/** v2 能力位全 false 的初值（探测前）。 */
export function emptyCapabilitiesV2(): NodeCapabilitiesV2 {
  return {
    models: false,
    rename: false,
    archive: false,
    filesRead: false,
    filesList: false,
    filesUpload: false,
    deliverables: true,
  }
}

/** 探测用的已知非法载荷（与 v1 同一纪律：Host 在业务调用前就拒）。 */
const PROBE_PAYLOAD = { __dsh_hub_probe: true }

/** 每个特性依赖哪些能力位（协商时按需探测，老客户端一个多余请求都不发）。 */
const FEATURE_CAPABILITIES: Readonly<Record<MobileV2Feature, readonly (keyof NodeCapabilitiesV2)[]>> = {
  models: ['models'],
  tools: [],
  reasoning: [],
  files: ['filesRead'],
  deliverables: ['deliverables'],
  attachments: ['filesUpload'],
  rename: ['rename'],
  archive: ['archive'],
  // 用量是只读聚合：复用 session/page（history 本来就要它），没有额外端点/能力位
  usage: [],
  // WP46：会话快照由 Hub 的 NodeSession 组装，adapter 不需要任何额外端点
  'session-state': [],
}

interface UploadRecord {
  id: string
  sessionId: string
  kind: 'image' | 'file'
  name: string
  mimeType: string
  declaredBytes: number
  chunks: Buffer[]
  received: number
  nextSeq: number
  createdAt: number
  expiresAt: number
  /** 文件已经过 `uploadFileBinary`（或 unary 回退）拿到 receipt。 */
  receiptId?: string
  /** 图片字节（内联发送用；文件上传成功后不再保留）。 */
  image?: Buffer
  done: boolean
}

/** 工具调用要记住的开始信息（`tool/result` 到达时补 end 帧）。 */
interface ToolCallState {
  callId: string
  name: string
  turn: number
  step: number
  seq: number
  time: number
  argumentsJson: string
  kind: ToolKind
  title: string
  inputPreview?: string
  inputBytes?: number
  truncatedInput: boolean
}

export interface V2Deps {
  nodeKind: 'cloud' | 'desktop'
  http: HostHttp
  mux: MuxConnection
  probeTimeoutMs: number
  /** 取 follow opening cursor 的超时（adapter 的 cursorFor 用；比 probe 宽松）。 */
  cursorTimeoutMs?: number
  log?: (event: string, meta?: Record<string, unknown>) => void
  chatDir?: string
  fileRoots?: readonly string[]
  maxUploadBytes?: number
  /** v1 的流能力（tools/reasoning 依赖它）。 */
  streamAvailable: boolean
  /**
   * 取会话当前游标（`session/follow` 的 opening cursor 或已见最大 seq）。
   * `session/page` 必须带 throughSeq；拿不到就是 null（用量聚合要用它翻页）。
   */
  cursorFor: (sessionId: string) => Promise<number | null>
  /** Hub 注入的计费钩子（模型倍率 / 用量积分）；缺省不发这两类字段。 */
  pricing?: ModelPricingHooks
  /** 发一帧给手机（走 adapter 当前的 sink）。 */
  emit: (frame: MobileServerFrame) => Promise<void>
  /**
   * Host 的默认工作区 id（`workspace/initializeDefault`，adapter 缓存）。`refresh` 丢掉缓存重取
   * （用户在 DSH 里删了默认工作区之后）。缺省 = 不挂工作区（老行为）。
   */
  defaultWorkspace?: (refresh?: boolean) => Promise<string>
}

export class V2Handler {
  capabilities: NodeCapabilitiesV2 = emptyCapabilitiesV2()
  private features: MobileV2Feature[] = []
  private readonly deps: V2Deps
  private readonly cwds = new Map<string, string>()
  private catalog: { at: number; value: ModelCatalogView } | null = null
  private catalogOpening: Promise<ModelCatalogView> | null = null
  private archived: ReadonlySet<string> | null = null
  private archivedOpening: Promise<ReadonlySet<string> | null> | null = null
  private archivedStreamId: string | null = null
  private archivedBaselineAt = 0
  private readonly uploads = new Map<string, UploadRecord>()
  private readonly toolCalls = new Map<string, ToolCallState>()
  private readonly turnFiles = new Map<string, number>()
  private closed = false

  constructor(deps: V2Deps) {
    this.deps = deps
  }

  get enabledFeatures(): readonly MobileV2Feature[] {
    return this.features
  }

  enabled(feature: MobileV2Feature): boolean {
    return this.features.includes(feature)
  }

  // ── 协商与探测 ────────────────────────────────────────────────────────────

  /**
   * 客户端在 `hello.features` 里声明的特性 → 本 adapter **实际启用**的特性。
   *
   * 只探测声明过的特性需要的端点（老客户端一个多余请求都不发）；探测失败的项
   * 一律降级为 false（fail closed，绝不假装成功）。
   */
  async negotiate(declared: readonly string[]): Promise<MobileV2Feature[]> {
    const wanted = new Set(declared)
    const needed = new Set<keyof NodeCapabilitiesV2>()
    for (const feature of this.featuresFrom(wanted)) {
      for (const key of FEATURE_CAPABILITIES[feature]) needed.add(key)
    }
    if (needed.size > 0 || wanted.has('models')) await this.probeCapabilities(needed)
    const enabled = this.featuresFrom(wanted).filter((feature) =>
      FEATURE_CAPABILITIES[feature].every((key) => this.capabilities[key]),
    )
    // tools/reasoning 没有自己的端点，依赖 v1 的 stream
    this.features = enabled.filter(
      (feature) => (feature !== 'tools' && feature !== 'reasoning') || this.deps.streamAvailable,
    )
    // 归档需要真实基线：拿不到基线就不能声称支持（否则列表会漏掉已归档会话）
    if (this.enabled('archive')) {
      const ids = await this.archivedIds(this.deps.probeTimeoutMs)
      if (ids === null) {
        this.capabilities = { ...this.capabilities, archive: false }
        this.features = this.features.filter((feature) => feature !== 'archive')
      }
    }
    return [...this.features]
  }

  private featuresFrom(wanted: ReadonlySet<string>): MobileV2Feature[] {
    const order: MobileV2Feature[] = [
      'models',
      'tools',
      'reasoning',
      'files',
      'deliverables',
      'attachments',
      'rename',
      'archive',
      'usage',
      'session-state',
    ]
    return order.filter((feature) => wanted.has(feature))
  }

  private async probeCapabilities(needed: ReadonlySet<keyof NodeCapabilitiesV2>): Promise<void> {
    const results: Partial<Record<keyof NodeCapabilitiesV2, boolean>> = {}
    const endpointProbes: Array<readonly [string, keyof NodeCapabilitiesV2]> = []
    if (needed.has('rename')) endpointProbes.push(['session/rename', 'rename'])
    if (needed.has('archive')) {
      endpointProbes.push(['workspace/archiveSession', 'archive'])
      endpointProbes.push(['workspace/unarchiveSession', 'archive'])
    }
    if (needed.has('filesRead')) {
      endpointProbes.push(['workspaceFiles/stat', 'filesRead'])
      endpointProbes.push(['workspaceFiles/read', 'filesRead'])
      endpointProbes.push(['workspaceFiles/readBytes', 'filesRead'])
    }
    if (needed.has('filesList')) endpointProbes.push(['workspaceFiles/list', 'filesList'])
    if (needed.has('filesUpload')) endpointProbes.push(['fileUploads/upload', 'filesUpload'])
    if (needed.has('models')) endpointProbes.push(['session/selectModel', 'models'])

    await Promise.all(
      endpointProbes.map(async ([endpoint, key]) => {
        const present = await this.probeEndpoint(endpoint)
        results[key] = (results[key] ?? true) && present
      }),
    )
    if (needed.has('models')) {
      // `session/modelCatalog` 是纯读端点：**真调用**比非法载荷更可靠（契约 §3）
      const catalog = await this.loadCatalog().catch((error: unknown) => {
        this.deps.log?.('v2.catalog-probe-failed', { message: messageOf(error) })
        return null
      })
      results['models'] = (results['models'] ?? true) && catalog !== null
    }
    if (needed.has('filesUpload')) {
      const route = await this.probeUploadRoute()
      results['filesUpload'] = results['filesUpload'] === true || route
    }
    const merged: NodeCapabilitiesV2 = { ...this.capabilities }
    for (const key of Object.keys(results) as (keyof NodeCapabilitiesV2)[]) {
      const verdict = results[key]
      if (verdict === undefined) continue
      merged[key] = verdict
    }
    this.capabilities = merged
  }

  /** 非法载荷探测：只有「参数类错误」能证明端点存在（其余一律 fail closed）。 */
  private async probeEndpoint(endpoint: string): Promise<boolean> {
    const envelope = await this.deps.http.call(endpoint, PROBE_PAYLOAD).catch(() => null)
    if (envelope === null) return false
    if (envelope.ok) {
      // 非法载荷被接受 = 端点不做参数校验，探测不能证明「业务可安全调用」→ 不算支持
      this.deps.log?.('v2.probe-unsafe', { endpoint })
      return false
    }
    const code = envelope.error?.code ?? ''
    if (
      code === 'gateway/arguments-invalid' ||
      code === 'gateway/input-invalid' ||
      code === 'gateway/bad-request'
    ) {
      return true
    }
    if (code === 'gateway/signature-invalid') return true
    this.deps.log?.('v2.probe-failed', { endpoint, code })
    return false
  }

  /**
   * `POST /api/session/uploadFileBinary` 的探测。
   *
   * 用**错误的 content-type** 打一下：Host 在业务调用之前就回 415，不产生任何上传。
   * 这也是「不用执行变更来探测」的纪律。
   */
  private async probeUploadRoute(): Promise<boolean> {
    try {
      const response = await this.deps.http.postRaw(
        '/api/session/uploadFileBinary?sessionId=__dsh_hub_probe__',
        Buffer.alloc(0),
        { 'content-type': 'application/json' },
        this.deps.probeTimeoutMs,
      )
      return response.status === 415 || response.status === 400 || response.status === 200
    } catch {
      return false
    }
  }

  // ── 分发（只处理 v2 独有帧；v1 帧仍由 adapter 处理） ────────────────────────

  /** @returns true = 已处理（adapter 不再往下走）。 */
  async dispatch(frame: MobileClientFrame, sink: FrameSink): Promise<boolean> {
    switch (frame.type) {
      case 'models':
        this.requireFeature('models')
        await this.emitModels(frame.requestId, frame.sessionId)
        return true
      case 'set-model':
        this.requireFeature('models')
        await this.handleSetModel(frame.requestId, frame.sessionId, frame.provider, frame.model, frame.effort)
        return true
      case 'rename':
        this.requireFeature('rename')
        await this.handleRename(frame.requestId, frame.sessionId, frame.title)
        return true
      case 'archive':
        this.requireFeature('archive')
        await this.handleArchive(frame.requestId, frame.sessionId, frame.archived)
        return true
      case 'usage':
        this.requireFeature('usage')
        await this.handleUsage(frame.requestId, frame.sessionId)
        return true
      case 'file-read':
        this.requireFeature('files')
        await this.handleFileRead(frame.requestId, frame.sessionId, frame.fileRef ?? null, frame.path ?? null)
        return true
      case 'file-list':
        this.requireFeature('files')
        await this.handleFileList(frame.requestId, frame.sessionId, frame.path)
        return true
      case 'upload-begin':
        this.requireFeature('attachments')
        await this.handleUploadBegin(frame)
        return true
      case 'upload-chunk':
        this.requireFeature('attachments')
        await this.handleUploadChunk(frame)
        return true
      case 'upload-abort':
        this.uploads.delete(frame.uploadId)
        return true
      default:
        void sink
        return false
    }
  }

  private requireFeature(feature: MobileV2Feature): void {
    if (this.enabled(feature)) return
    throw new HostRpcError(
      'feature-unsupported',
      `该连接没有协商「${feature}」能力：先升级 App/Hub 或换一个支持它的节点`,
    )
  }

  // ── a) 模型目录 ───────────────────────────────────────────────────────────

  async loadCatalog(force = false): Promise<ModelCatalogView> {
    if (!force && this.catalog !== null && Date.now() - this.catalog.at < CATALOG_TTL_MS) {
      return this.catalog.value
    }
    if (this.catalogOpening !== null) return await this.catalogOpening
    this.catalogOpening = (async () => {
      const value = await this.deps.http.unary('session/modelCatalog', {})
      const view = projectModelCatalog(value)
      if (view.items.length === 0) {
        throw new HostRpcError('model-unavailable', '实例没有返回任何可用模型，请检查模型配置')
      }
      this.catalog = { at: Date.now(), value: view }
      return view
    })()
    try {
      return await this.catalogOpening
    } finally {
      this.catalogOpening = null
    }
  }

  private async emitModels(requestId: string, sessionId: string | undefined): Promise<void> {
    const catalog = await this.loadCatalog()
    const current =
      sessionId === undefined ? undefined : await this.currentSelection(sessionId).catch(() => undefined)
    await this.deps.emit({
      v: 1,
      type: 'models',
      requestId,
      default: catalog.default,
      ...(current === undefined ? {} : { current }),
      items: catalog.items.map((item) => toModelView(item, this.deps.pricing)),
      failures: catalog.failures,
    })
  }

  /** 当前会话的模型选择（`session/projections` 的 modelSelection 投影）。 */
  async currentSelection(sessionId: string): Promise<ModelSelectionView | undefined> {
    const value = await this.deps.http.unary('session/projections', { request: { sessionId } })
    const record = asRecord(value)
    const values = asRecord(record['values'])
    const selection = asRecord(values['modelSelection'])
    const chosen = asRecord(selection['next'] ?? selection['lastUsed'])
    const provider = typeof chosen['provider'] === 'string' ? chosen['provider'] : null
    const model = typeof chosen['model'] === 'string' ? chosen['model'] : null
    if (provider === null || model === null) return undefined
    const effort = typeof chosen['reasoningEffort'] === 'string' ? chosen['reasoningEffort'] : null
    return { provider, model, ...(effort === null ? {} : { effort }) }
  }

  /**
   * 切模型/档位（契约 §5）：Hub 先用缓存的目录预检，档位不在列表里**不发上游请求**。
   *
   * DSH 的语义要原样保留：只对下一次请求生效；不支持的档位**不钳制、不取近似**。
   */
  private async handleSetModel(
    requestId: string,
    sessionId: string,
    provider: string,
    model: string,
    effort: string | undefined,
  ): Promise<void> {
    const catalog = await this.loadCatalog()
    const item = findModel(catalog, provider, model)
    if (item === undefined) {
      throw new HostRpcError('model-unavailable', '该模型不在当前实例的模型列表里，请重新拉取模型列表')
    }
    const verdict = checkEffort(item, effort)
    if (!verdict.ok) {
      throw new HostRpcError(
        'effort-unsupported',
        verdict.reason === 'model-no-reasoning' ? '该模型不支持调节思考程度' : '该模型不支持这个思考档位',
      )
    }
    const selected = await this.selectModel(sessionId, provider, model, verdict.effort)
    await this.deps.emit({
      v: 1,
      type: 'model-changed',
      requestId,
      sessionId,
      provider: selected.provider,
      model: selected.model,
      ...(selected.effort === undefined ? {} : { effort: selected.effort }),
    })
    // 投影帧也会来一次（可能来自电脑端）；App 只认投影刷新芯片，本帧只用于清 loading。
  }

  /** 调 `session/selectModel`；返回真正生效的选择。 */
  async selectModel(
    sessionId: string,
    provider: string,
    model: string,
    effort: string | undefined,
  ): Promise<ModelSelectionView> {
    const value = await this.deps.http.unary('session/selectModel', {
      request: {
        sessionId,
        provider,
        model,
        // 模型不支持思考时**必须省略**（传 'off' 也会被 DSH 拒，见 llm/src/index.ts:908-940）
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      },
    })
    const selected = asRecord(asRecord(value)['selected'])
    const selectedProvider = typeof selected['provider'] === 'string' ? selected['provider'] : provider
    const selectedModel = typeof selected['model'] === 'string' ? selected['model'] : model
    const selectedEffort =
      typeof selected['reasoningEffort'] === 'string' ? selected['reasoningEffort'] : undefined
    return {
      provider: selectedProvider,
      model: selectedModel,
      ...(selectedEffort === undefined ? {} : { effort: selectedEffort }),
    }
  }

  /**
   * v2 `create`：先 `session/create{workspaceId|cwd, preset}`，再（可选）`selectModel`。
   *
   * 没配 `chatDir` 时挂到 Host 的**默认工作区**：`session/create` 只有带 `workspaceId` 才会把会话
   * 加进工作区，只给 cwd（或什么都不给、落到 defaultCwd）的会话在 DSH 侧栏里是「未分组」，
   * cwd 也和默认工作区不同（dsh-memory 按 cwd 分工作区记忆，手机与桌面会各记各的）。
   */
  async create(options: { preset?: string; provider?: string; model?: string; effort?: string }): Promise<{
    sessionId: string
    preset?: string
    model?: ModelSelectionView
    warning?: { code: 'model-unavailable'; message: string }
  }> {
    const cwd = await this.ensureChatDir()
    const presetField = options.preset === undefined ? {} : { agentPreset: options.preset }
    let value: unknown
    if (cwd === null && this.deps.defaultWorkspace !== undefined) {
      value = await this.createInDefaultWorkspace(presetField)
    } else {
      value = await this.deps.http.unary('session/create', {
        // §17：显式配了 chatDir 的部署才写死 cwd
        request: { ...(cwd === null ? {} : { cwd }), ...presetField },
      })
    }
    const record = asRecord(value)
    const sessionId = typeof record['sessionId'] === 'string' ? record['sessionId'] : null
    if (sessionId === null) throw new HostRpcError('internal', 'Host 未返回 sessionId')
    const preset = typeof record['agentPreset'] === 'string' ? record['agentPreset'] : undefined
    if (cwd !== null) this.cwds.set(sessionId, cwd)

    if (options.model === undefined || options.provider === undefined) {
      return { sessionId, ...(preset === undefined ? {} : { preset }) }
    }
    try {
      const selected = await this.selectModel(sessionId, options.provider, options.model, options.effort)
      return { sessionId, ...(preset === undefined ? {} : { preset }), model: selected }
    } catch (error) {
      // 会话已经建好：**不回滚**（删掉反而更糟），把原因放进 warning
      this.deps.log?.('v2.create-select-failed', {
        code: error instanceof HostRpcError ? error.code : 'internal',
      })
      return {
        sessionId,
        ...(preset === undefined ? {} : { preset }),
        warning: {
          code: 'model-unavailable',
          message: '会话已创建，但没能切到你选的模型；已使用实例默认模型',
        },
      }
    }
  }

  /**
   * 在默认工作区里建会话。缓存的工作区被删了（`workspace/not-found`）→ 重取一次再建；
   * 老 Host 没有 `workspace/initializeDefault` → 退回不挂工作区（落到 defaultCwd，与以前一致）。
   */
  private async createInDefaultWorkspace(preset: { agentPreset?: string }): Promise<unknown> {
    const getWorkspace = this.deps.defaultWorkspace!
    let workspaceId: string
    try {
      workspaceId = await getWorkspace()
    } catch (error) {
      this.deps.log?.('v2.create-default-workspace-unavailable', {
        code: error instanceof HostRpcError ? error.code : 'internal',
      })
      return this.deps.http.unary('session/create', { request: { ...preset } })
    }
    try {
      return await this.deps.http.unary('session/create', { request: { workspaceId, ...preset } })
    } catch (error) {
      if (!(error instanceof HostRpcError) || error.code !== 'workspace/not-found') throw error
      const fresh = await getWorkspace(true)
      return this.deps.http.unary('session/create', { request: { workspaceId: fresh, ...preset } })
    }
  }

  /**
   * 新建会话的 cwd。
   *
   * 0.2.12 起手机端也用**标准 DSH 模式**：不写死 `/workspace/chat`，交给 Host 的
   * defaultCwd（标准 DSH 默认工作区）。只有显式配了 `chatDir` 的部署才指定目录。
   */
  async ensureChatDir(): Promise<string | null> {
    return this.deps.chatDir ?? null
  }

  // ── h) 重命名 / 归档 ──────────────────────────────────────────────────────

  private async handleRename(requestId: string, sessionId: string, title: string): Promise<void> {
    const value = await this.deps.http.unary('session/rename', { request: { sessionId, title } })
    const record = asRecord(value)
    const accepted = typeof record['title'] === 'string' ? record['title'] : title
    const seq = typeof record['seq'] === 'number' ? record['seq'] : 0
    await this.deps.emit({ v: 1, type: 'renamed', requestId, sessionId, title: accepted, seq })
  }

  private async handleArchive(requestId: string, sessionId: string, archived: boolean): Promise<void> {
    const value = await this.deps.http.unary(
      archived ? 'workspace/archiveSession' : 'workspace/unarchiveSession',
      { request: { sessionId } },
    )
    const record = asRecord(value)
    const ids = Array.isArray(record['archivedSessionIds'])
      ? record['archivedSessionIds'].filter((item): item is string => typeof item === 'string')
      : []
    this.archived = new Set(ids)
    this.archivedBaselineAt = Date.now()
    await this.deps.emit({
      v: 1,
      type: 'archived',
      requestId,
      sessionId,
      archived,
      sessionIds: ids.slice(0, 500),
    })
  }

  /**
   * 归档集合（§17 D5）：来自 `workspace/follow` 的 `baseline.archivedSessionIds` 与
   * `archived` 帧。`session/list` 没有归档过滤，只有这里能拿到。
   *
   * @returns 归档集合；拿不到基线返回 null（调用方**不过滤**，且不声称支持 archive）。
   */
  async archivedIds(timeoutMs = this.deps.probeTimeoutMs): Promise<ReadonlySet<string> | null> {
    if (this.archived !== null && Date.now() - this.archivedBaselineAt < 10 * 60_000) return this.archived
    if (this.archivedOpening !== null) return await this.archivedOpening
    this.archivedOpening = new Promise<ReadonlySet<string> | null>((resolve) => {
      let settled = false
      const finish = (value: ReadonlySet<string> | null): void => {
        if (!settled) {
          settled = true
          resolve(value)
        }
      }
      const timer = setTimeout(() => {
        this.deps.log?.('v2.workspace-follow-timeout')
        finish(this.archived)
      }, timeoutMs)
      timer.unref?.()
      void this.deps.mux
        .open(
          'workspace/follow',
          { args: {} },
          {
            onItem: (value) => {
              const frame = asRecord(value)
              if (frame['type'] === 'baseline') {
                const baseline = asRecord(frame['value'])
                this.archived = stringSet(baseline['archivedSessionIds'])
                this.archivedBaselineAt = Date.now()
                clearTimeout(timer)
                finish(this.archived)
                return
              }
              if (frame['type'] === 'archived') {
                this.archived = stringSet(frame['archivedSessionIds'])
                this.archivedBaselineAt = Date.now()
                clearTimeout(timer)
                finish(this.archived)
                return
              }
              if (frame['type'] === 'replace') {
                const baseline = asRecord(frame['value'])
                this.archived = stringSet(baseline['archivedSessionIds'])
                this.archivedBaselineAt = Date.now()
                clearTimeout(timer)
                finish(this.archived)
              }
            },
            onEnd: () => {
              this.archivedStreamId = null
              clearTimeout(timer)
              finish(this.archived)
            },
            onError: (error) => {
              this.archivedStreamId = null
              this.deps.log?.('v2.workspace-follow-failed', { code: error.code })
              clearTimeout(timer)
              finish(null)
            },
          },
        )
        .then((streamId) => {
          this.archivedStreamId = streamId
        })
        .catch((error: unknown) => {
          this.deps.log?.('v2.workspace-follow-open-failed', { message: messageOf(error) })
          clearTimeout(timer)
          finish(null)
        })
    })
    try {
      return await this.archivedOpening
    } finally {
      this.archivedOpening = null
    }
  }

  // ── i) 会话用量（只读聚合） ───────────────────────────────────────────────

  /**
   * 把 `session/page` 里的 `assistant/message.usage` 累加成会话用量。
   *
   * - 从最新游标往前翻页，最多 MAX_USAGE_PAGES 页；翻不完就标 `truncated`（不假装完整）。
   * - 只读：不往 Host 写任何东西，也不影响会话状态。
   * - `user/message` 只数 `source.kind === 'user'`（注入的 runtime-context/time-context 不算）。
   */
  private async handleUsage(requestId: string, sessionId: string): Promise<void> {
    const cursor = await this.deps.cursorFor(sessionId)
    if (cursor === null) {
      throw new HostRpcError(
        'upstream-unavailable',
        '无法取得会话游标（会话还没打开或 session/follow 未就绪）',
      )
    }
    const MAX_USAGE_PAGES = 20
    const PAGE_SIZE = 100
    const stats = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      assistantMessages: 0,
      userMessages: 0,
      turns: 0,
      truncated: false,
    }
    // Hub 注入了计费钩子时顺带算积分消耗（与 Hub 计费同一公式；拿不到价格的消息跳过）
    const pricingRequested = this.deps.pricing?.costMicroOf !== undefined
    let pointsMicro = 0
    let pricedMessages = 0
    let beforeSeq: number | null = null
    for (let pageIndex = 0; ; pageIndex += 1) {
      if (pageIndex >= MAX_USAGE_PAGES) {
        stats.truncated = true
        break
      }
      const value = asRecord(
        await this.deps.http.unary('session/page', {
          request: {
            address: { kind: 'session', sessionId },
            throughSeq: cursor,
            ...(beforeSeq === null ? {} : { beforeSeq }),
            maxMessages: PAGE_SIZE,
          },
        }),
      )
      const records = Array.isArray(value['records']) ? value['records'] : []
      for (const raw of records) {
        const record = asRecord(raw)
        if (record['type'] !== 'event') continue
        const event = asRecord(record['event'])
        const name = typeof event['type'] === 'string' ? event['type'] : ''
        const data = asRecord(event['data'])
        if (name === 'assistant/message') {
          stats.assistantMessages += 1
          const usage = asRecord(data['usage'])
          const input = intOf(usage['inputTokens'])
          const output = intOf(usage['outputTokens'])
          const total = intOf(usage['totalTokens'])
          stats.inputTokens += input
          stats.outputTokens += output
          stats.totalTokens += total > 0 ? total : input + output
          const cacheRead = intOf(usage['cacheReadTokens'])
          stats.cacheReadTokens += cacheRead
          if (pricingRequested) {
            const source = asRecord(data['source'])
            const provider = typeof source['provider'] === 'string' ? source['provider'] : ''
            const model = typeof source['model'] === 'string' ? source['model'] : ''
            const cost = this.deps.pricing?.costMicroOf?.({
              provider,
              model,
              tokens: {
                inputTokens: input,
                outputTokens: output,
                cacheReadTokens: cacheRead,
                cacheWriteTokens: intOf(usage['cacheWriteTokens']),
              },
            })
            if (typeof cost === 'number' && Number.isFinite(cost)) {
              pointsMicro += Math.max(0, Math.round(cost))
              pricedMessages += 1
            }
          }
          continue
        }
        if (name === 'user/message') {
          if (userSourceOf(data['source'])) stats.userMessages += 1
          continue
        }
        if (name === 'turn/start') stats.turns += 1
      }
      if (value['hasMore'] !== true || records.length === 0) break
      const firstEvent = asRecord(asRecord(records[0])['event'])
      const firstSeq = typeof firstEvent['seq'] === 'number' ? firstEvent['seq'] : null
      if (firstSeq === null || (beforeSeq !== null && firstSeq >= beforeSeq)) break
      beforeSeq = firstSeq
    }
    // 一条都没算出来（模型没有价格信息）就不发积分字段，App 会显示「—」
    await this.deps.emit({
      v: 1,
      type: 'usage',
      requestId,
      sessionId,
      stats:
        pricingRequested && pricedMessages > 0
          ? { ...stats, pointsMicro, pointsEstimated: pricedMessages < stats.assistantMessages }
          : stats,
    })
  }

  // ── f) 文件读取（含防穿越） ───────────────────────────────────────────────

  /** 会话的 cwd：先看缓存，再问 `session/projections`，最后退回 chatDir。 */
  async cwdFor(sessionId: string): Promise<string> {
    const cached = this.cwds.get(sessionId)
    if (cached !== undefined) return cached
    try {
      const value = await this.deps.http.unary('session/projections', { request: { sessionId } })
      const values = asRecord(asRecord(value)['values'])
      const cwd = typeof values['workingDirectory'] === 'string' ? values['workingDirectory'] : null
      if (cwd !== null && cwd !== '') {
        this.cwds.set(sessionId, cwd)
        return cwd
      }
    } catch (error) {
      this.deps.log?.('v2.cwd-probe-failed', { message: messageOf(error) })
    }
    // 拿不到 cwd 时：标准 DSH 模式的默认工作区在 /workspace 之下；桌面节点用当前目录。
    const fallback = this.deps.chatDir ?? (this.deps.nodeKind === 'cloud' ? '/workspace' : '.')
    return fallback
  }

  /** 从 follow 的 `snapshot.header.cwd` 学习会话目录（最权威、零额外请求）。 */
  learnCwd(sessionId: string, value: unknown): void {
    const cwd = typeof value === 'string' ? value : null
    if (cwd !== null && cwd !== '') this.cwds.set(sessionId, cwd)
  }

  private async rulesFor(sessionId: string): Promise<PathRules> {
    const cwd = await this.cwdFor(sessionId)
    const extra: string[] = []
    const chatDir = this.deps.chatDir ?? null
    if (chatDir !== null) extra.push(joinPath(chatDir, 'artifacts'))
    if (this.deps.fileRoots !== undefined) extra.push(...this.deps.fileRoots)
    return { cwd, roots: extra }
  }

  /**
   * 一次文件访问的完整授权（契约 §8.3）：词法检查 → `stat` → realpath 兜底。
   *
   * @returns 允许的绝对路径 + 字节数；任何越权都抛 `file-refused`（不回显路径）。
   */
  private async authorize(
    sessionId: string,
    input: string,
  ): Promise<{ absolute: string; bytes: number | null; rules: PathRules }> {
    const rules = await this.rulesFor(sessionId)
    const resolved = resolveRequestPath(input, rules)
    if (!resolved.ok) {
      this.deps.log?.('v2.file-refused', { reason: resolved.reason })
      throw new HostRpcError('file-refused', '不允许访问该路径')
    }
    const stat = await this.statPath(sessionId, resolved.absolute)
    if (stat === null) throw new HostRpcError('file-not-found', '文件不存在')
    // ← realpath 兜底：软链指向根外时只有这一步能拦住
    if (!authorizeStat(stat.absolutePath, rules)) {
      this.deps.log?.('v2.file-refused', { reason: 'realpath-outside-roots' })
      throw new HostRpcError('file-refused', '不允许访问该路径')
    }
    return { absolute: stat.absolutePath, bytes: stat.bytes, rules }
  }

  private async statPath(
    sessionId: string,
    path: string,
  ): Promise<{ absolutePath: string; bytes: number | null } | null> {
    try {
      const value = await this.deps.http.unary('workspaceFiles/stat', {
        workspaceFileScopeId: sessionId,
        path,
      })
      const record = asRecord(value)
      const absolutePath = typeof record['absolutePath'] === 'string' ? record['absolutePath'] : null
      if (absolutePath === null) return null
      return { absolutePath, bytes: typeof record['bytes'] === 'number' ? record['bytes'] : null }
    } catch (error) {
      if (error instanceof HostRpcError && /not-found|outside-workspace/u.test(error.code)) return null
      throw error
    }
  }

  private async handleFileRead(
    requestId: string,
    sessionId: string,
    fileRef: string | null,
    path: string | null,
  ): Promise<void> {
    const target = this.targetOf(sessionId, fileRef, path)
    const allowed = await this.authorize(sessionId, target)
    const { rules } = allowed
    const bytes = allowed.bytes
    if (bytes !== null && bytes > FILE_MAX_BYTES) {
      throw new HostRpcError('file-too-large', '文件超过 20 MiB，手机端暂不支持下载')
    }
    const name = leafName(allowed.absolute)
    const mediaType = mediaTypeOfPath(allowed.absolute)
    const mimeType = mimeTypeOfPath(allowed.absolute)
    const ref = encodeFileRef({ v: 1, s: sessionId, p: allowed.absolute })
    const total = bytes ?? 0
    if (total <= INLINE_BYTES) {
      const data = await this.readWindow(sessionId, allowed.absolute, 0, Math.max(total, 1))
      const buffer = data.bytes
      if (buffer.length > FILE_MAX_BYTES) throw new HostRpcError('file-too-large', '文件过大')
      if (buffer.length <= INLINE_BYTES) {
        await this.deps.emit({
          v: 1,
          type: 'file',
          requestId,
          sessionId,
          fileRef: ref,
          name,
          mediaType,
          mimeType,
          bytes: buffer.length,
          encoding: 'base64',
          data: buffer.toString('base64'),
          sha256: sha256Hex(buffer),
        })
        return
      }
    }
    // 分块：每片原始 ≤144 KiB（base64 后 192 KiB，整帧仍 <256 KiB）
    let offset = 0
    let seq = 0
    let sent = 0
    const chunks: Buffer[] = []
    while (offset < FILE_MAX_BYTES) {
      const window = await this.readWindow(sessionId, allowed.absolute, offset, CHUNK_BYTES)
      const piece = window.bytes
      if (piece.length === 0) break
      chunks.push(piece)
      sent += piece.length
      offset += piece.length
      if (sent > FILE_MAX_BYTES) throw new HostRpcError('file-too-large', '文件超过 20 MiB')
      const final = window.eof || (bytes !== null && offset >= bytes)
      const digest = final ? sha256Hex(Buffer.concat(chunks)) : undefined
      await this.deps.emit({
        v: 1,
        type: 'file-chunk',
        requestId,
        sessionId,
        fileRef: ref,
        seq,
        final,
        encoding: 'base64',
        data: piece.toString('base64'),
        ...(final ? { bytes: sent, ...(digest === undefined ? {} : { sha256: digest }) } : {}),
      })
      seq += 1
      if (final) return
      if (seq > Math.ceil(FILE_MAX_BYTES / CHUNK_BYTES) + 2) break
    }
    throw new HostRpcError('upstream-unavailable', '读取文件时 Host 没有返回完整内容')
  }

  private targetOf(sessionId: string, fileRef: string | null, path: string | null): string {
    if (fileRef !== null) {
      const payload = decodeFileRef(fileRef)
      if (payload === null || payload.s !== sessionId)
        throw new HostRpcError('file-refused', '不允许访问该路径')
      return payload.p
    }
    if (path === null || path === '') throw new HostRpcError('internal', '请求缺少 fileRef 或 path')
    return path
  }

  /** `workspaceFiles/readBytes` 的一个字节窗口（multipart 解析）。 */
  private async readWindow(
    sessionId: string,
    path: string,
    offset: number,
    length: number,
  ): Promise<{ bytes: Buffer; eof: boolean }> {
    const response = await this.deps.http.callRaw('workspaceFiles/readBytes', {
      workspaceFileScopeId: sessionId,
      path,
      options: { range: { offset, length } },
    })
    const parsed = readByteResponse(response.body, response.contentType)
    if (parsed === null) throw new HostTransportError('Host 返回了无法解析的文件响应（multipart）')
    if (!parsed.envelope.ok) {
      const code = parsed.envelope.error?.code ?? ''
      if (code === 'workspace-file/not-found') throw new HostRpcError('file-not-found', '文件不存在')
      if (code === 'workspace-file/too-large') throw new HostRpcError('file-too-large', '文件过大')
      if (code === 'workspace-file/not-text') throw new HostRpcError('file-not-text', '这不是文本文件')
      throw new HostRpcError('internal', parsed.envelope.error?.message ?? '读取文件失败')
    }
    return { bytes: parsed.bytes, eof: parsed.eof }
  }

  private async handleFileList(requestId: string, sessionId: string, path: string): Promise<void> {
    const rules = await this.rulesFor(sessionId)
    const resolved = resolveRequestPath(path, rules)
    if (!resolved.ok) {
      this.deps.log?.('v2.file-refused', { reason: resolved.reason })
      throw new HostRpcError('file-refused', '不允许访问该路径')
    }
    // DSH 的 list 只接受工作区内目录；能相对就相对，不能才给绝对路径
    const relative = relativeLabel(resolved.absolute, rules.cwd)
    const wirePath = relative.startsWith('..') ? resolved.absolute : relative === '.' ? './' : relative
    const value = await this.deps.http.unary('workspaceFiles/list', {
      workspaceFileScopeId: sessionId,
      path: wirePath,
    })
    const record = asRecord(value)
    const entries: { name: string; kind: 'file' | 'directory' | 'other'; fileRef?: string }[] = []
    const rawEntries = Array.isArray(record['entries']) ? record['entries'] : []
    for (const item of rawEntries.slice(0, 500)) {
      const entry = asRecord(item)
      const name = typeof entry['name'] === 'string' ? entry['name'] : null
      if (name === null || name === '') continue
      const type = entry['type']
      const kind = type === 'directory' ? 'directory' : type === 'file' ? 'file' : 'other'
      const absolute = joinPath(resolved.absolute, name)
      const allowed = kind === 'file' ? authorizeStat(absolute, rules) : false
      entries.push({
        name: name.slice(0, 255),
        kind,
        ...(allowed ? { fileRef: encodeFileRef({ v: 1, s: sessionId, p: absolute }) } : {}),
      })
    }
    await this.deps.emit({
      v: 1,
      type: 'file-list',
      requestId,
      sessionId,
      path: typeof record['path'] === 'string' ? record['path'] : '',
      entries,
      truncated: record['truncated'] === true,
    })
  }

  // ── g) 上传（帧） ─────────────────────────────────────────────────────────

  private maxUploadBytes(kind: 'image' | 'file'): number {
    if (this.deps.maxUploadBytes !== undefined) return this.deps.maxUploadBytes
    if (this.deps.nodeKind === 'desktop') return DESKTOP_MAX_BYTES
    return kind === 'image' ? IMAGE_MAX_BYTES : FILE_MAX_BYTES
  }

  private async handleUploadBegin(
    frame: Extract<MobileClientFrame, { type: 'upload-begin' }>,
  ): Promise<void> {
    const limit = this.maxUploadBytes(frame.kind)
    if (frame.bytes > limit) {
      throw new HostRpcError(
        'file-too-large',
        `${frame.kind === 'image' ? '图片' : '文件'}超过上限（${String(Math.round(limit / 1024 / 1024))} MiB）`,
      )
    }
    this.evictUploads()
    const upload: UploadRecord = {
      id: `up_${randomUUID()}`,
      sessionId: frame.sessionId,
      kind: frame.kind,
      name: frame.name,
      mimeType: frame.mimeType,
      declaredBytes: frame.bytes,
      chunks: [],
      received: 0,
      nextSeq: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + UPLOAD_TTL_MS,
      done: false,
    }
    this.uploads.set(upload.id, upload)
    await this.deps.emit({
      v: 1,
      type: 'upload-started',
      requestId: frame.requestId,
      uploadId: upload.id,
      maxChunkBytes: CHUNK_BYTES,
    })
  }

  private async handleUploadChunk(
    frame: Extract<MobileClientFrame, { type: 'upload-chunk' }>,
  ): Promise<void> {
    const upload = this.uploads.get(frame.uploadId)
    if (upload === undefined) throw new HostRpcError('file-not-found', '上传已过期或不存在，请重新上传')
    if (frame.seq !== upload.nextSeq) {
      throw new HostRpcError(
        'internal',
        `上传分片顺序不对：期望 ${String(upload.nextSeq)}，收到 ${String(frame.seq)}`,
      )
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(frame.data) || frame.data.length % 4 !== 0) {
      throw new HostRpcError('internal', '上传分片不是合法的 base64')
    }
    const piece = Buffer.from(frame.data, 'base64')
    if (piece.length > CHUNK_BYTES) throw new HostRpcError('file-too-large', '上传分片超过上限')
    upload.received += piece.length
    if (upload.received > upload.declaredBytes) {
      this.uploads.delete(upload.id)
      throw new HostRpcError('file-too-large', '上传字节数超过声明的大小')
    }
    upload.chunks.push(piece)
    upload.nextSeq += 1
    await this.deps.emit({
      v: 1,
      type: 'upload-received',
      requestId: frame.requestId,
      uploadId: upload.id,
      seq: frame.seq,
      received: upload.received,
    })
    if (frame.final !== true) return
    if (upload.received !== upload.declaredBytes) {
      this.uploads.delete(upload.id)
      throw new HostRpcError('internal', '上传字节数与声明不一致，请重新上传')
    }
    const bytes = Buffer.concat(upload.chunks)
    upload.chunks = []
    if (upload.kind === 'file') {
      upload.receiptId = await this.uploadToHost(upload.sessionId, upload.name, upload.mimeType, bytes)
      upload.done = true
      upload.expiresAt = Date.now() + UPLOAD_TTL_MS
    } else {
      // 图片内联发送（真视觉输入），字节留到 send 用
      upload.image = bytes
      upload.done = true
      upload.expiresAt = Date.now() + UPLOAD_TTL_MS
    }
    await this.deps.emit({
      v: 1,
      type: 'uploaded',
      requestId: frame.requestId,
      uploadId: upload.id,
      kind: upload.kind,
      name: upload.name,
      mimeType: upload.mimeType,
      bytes: upload.received,
      expiresAt: upload.expiresAt,
    })
  }

  /**
   * 把字节交给 Host 拿 receipt。
   *
   * 首选流式路由 `POST /api/session/uploadFileBinary`（裸字节、不经 base64 放大）；
   * 失败回退 unary `fileUploads/upload`（base64，小文件够用）。
   */
  private async uploadToHost(
    sessionId: string,
    name: string,
    mimeType: string,
    bytes: Buffer,
  ): Promise<string> {
    const query = new URLSearchParams({ sessionId, name })
    try {
      const response = await this.deps.http.postRaw(
        `/api/session/uploadFileBinary?${query.toString()}`,
        bytes,
        { 'content-type': 'application/octet-stream' },
        Math.max(this.deps.probeTimeoutMs, 30_000),
      )
      const parsed = JSON.parse(response.body.toString('utf8')) as {
        ok?: boolean
        value?: { receiptId?: string }
        error?: { message?: string }
      }
      if (response.status === 200 && parsed.ok === true && typeof parsed.value?.receiptId === 'string') {
        return parsed.value.receiptId
      }
      this.deps.log?.('v2.upload-route-failed', { status: response.status })
    } catch (error) {
      this.deps.log?.('v2.upload-route-error', { message: messageOf(error) })
    }
    const value = await this.deps.http.unary('fileUploads/upload', {
      agentId: sessionId,
      request: { data: bytes.toString('base64'), name, dataType: mimeType },
    })
    const receiptId =
      typeof asRecord(value)['receiptId'] === 'string' ? (asRecord(value)['receiptId'] as string) : null
    if (receiptId === null) throw new HostRpcError('internal', 'Host 没有返回上传凭据')
    return receiptId
  }

  private evictUploads(): void {
    const now = Date.now()
    let total = 0
    for (const [id, upload] of this.uploads) {
      if (now - upload.createdAt > UPLOAD_TTL_MS) {
        this.uploads.delete(id)
        continue
      }
      total += upload.received
    }
    if (total <= UPLOAD_TOTAL_BYTES) return
    for (const [id] of this.uploads) {
      this.uploads.delete(id)
      total = 0
      for (const item of this.uploads.values()) total += item.received
      if (total <= UPLOAD_TOTAL_BYTES) break
    }
  }

  /**
   * 把 `send.attachments[]` 变成 `session/prompt` 的 content 块。
   *
   * - 图片：内联 base64（DSH 的 `image` part 没有 receipt 变体）；发送后立即删掉字节。
   * - 文件：`{type:'file', receiptId}`（会话内凭据，App 永远看不到）。
   */
  async contentParts(
    sessionId: string,
    attachments: readonly { kind: 'image' | 'file'; uploadId: string; name: string; bytes: number }[],
  ): Promise<unknown[]> {
    const parts: unknown[] = []
    for (const attachment of attachments) {
      const upload = this.uploads.get(attachment.uploadId)
      if (upload === undefined || !upload.done || upload.sessionId !== sessionId) {
        throw new HostRpcError('file-not-found', '附件已过期或不属于这个会话，请重新上传')
      }
      if (upload.kind !== attachment.kind) throw new HostRpcError('internal', '附件类型与上传时不一致')
      if (upload.kind === 'image') {
        if (upload.image === undefined) throw new HostRpcError('internal', '图片字节已失效，请重新上传')
        parts.push({
          type: 'image',
          mediaType: upload.mimeType,
          data: upload.image.toString('base64'),
          name: upload.name,
        })
      } else {
        if (upload.receiptId === undefined) throw new HostRpcError('internal', '文件还没上传完成')
        parts.push({ type: 'file', receiptId: upload.receiptId })
      }
    }
    for (const attachment of attachments) this.uploads.delete(attachment.uploadId)
    return parts
  }

  // ── d/e) 事件投影（工具、交付物、模型变化） ────────────────────────────────

  /**
   * 一条 durable 事件 → v2 帧。
   *
   * 只在对应特性启用时发；`tool/call` 的 `seq` 是权威序号（start 帧用它），
   * `tool/result` 是唯一的结束信号（`assistant-stream.end` 只代表 attempt 结束）。
   */
  async onEvent(sessionId: string, value: unknown): Promise<void> {
    const event = asRecord(value)
    const name = typeof event['type'] === 'string' ? event['type'] : ''
    const seq = typeof event['seq'] === 'number' ? event['seq'] : 0
    const time = typeof event['time'] === 'number' ? event['time'] : 0
    const data = asRecord(event['data'])
    if (name === 'tool/call') {
      const callId = typeof data['callId'] === 'string' ? data['callId'] : null
      const toolName = typeof data['name'] === 'string' ? data['name'] : 'tool'
      if (callId === null) return
      const argumentsJson = typeof data['arguments'] === 'string' ? data['arguments'] : ''
      const projection = projectToolCall(toolName, argumentsJson)
      const state: ToolCallState = {
        callId,
        name: toolName,
        turn: typeof data['turn'] === 'number' ? data['turn'] : 0,
        step: typeof data['step'] === 'number' ? data['step'] : 0,
        seq,
        time,
        argumentsJson,
        kind: projection.kind,
        title: projection.title,
        ...(projection.inputPreview === undefined ? {} : { inputPreview: projection.inputPreview }),
        ...(projection.inputBytes === undefined ? {} : { inputBytes: projection.inputBytes }),
        truncatedInput: projection.truncatedInput,
      }
      this.toolCalls.set(callId, state)
      if (!this.enabled('tools')) return
      await this.deps.emit({
        v: 1,
        type: 'tool',
        sessionId,
        callId,
        kind: projection.kind,
        name: toolName.slice(0, 64),
        phase: 'start',
        seq,
        turn: state.turn,
        step: state.step,
        status: 'running',
        title: projection.title,
        ...(projection.inputPreview === undefined ? {} : { inputPreview: projection.inputPreview }),
        ...(projection.inputBytes === undefined ? {} : { inputBytes: projection.inputBytes }),
        ...(projection.truncatedInput ? { truncated: { input: true as const } } : {}),
      })
      return
    }
    if (name === 'tool/result') {
      const message = asRecord(data['message'])
      const source = asRecord(message['source'])
      const callId =
        typeof message['toolCallId'] === 'string'
          ? message['toolCallId']
          : typeof source['callId'] === 'string'
            ? source['callId']
            : null
      if (callId === null) return
      const state = this.toolCalls.get(callId)
      if (state === undefined) return
      this.toolCalls.delete(callId)
      if (!this.enabled('tools')) return
      const isError = message['isError'] === true
      const projection = projectToolResult(state.name, textOfContent(message['content']), 5)
      const files = await this.candidatesToRefs(
        sessionId,
        state.turn,
        projection.pathCandidates,
        this.deps.nodeKind === 'cloud' ? 6 : 3,
      )
      await this.deps.emit({
        v: 1,
        type: 'tool',
        sessionId,
        callId,
        kind: state.kind,
        name: state.name.slice(0, 64),
        phase: 'end',
        seq,
        turn: state.turn,
        step: state.step,
        status: isError ? 'error' : 'ok',
        title: state.title,
        ...(projection.outputPreview === undefined ? {} : { outputPreview: projection.outputPreview }),
        ...(projection.outputBytes === undefined ? {} : { outputBytes: projection.outputBytes }),
        ...(projection.truncatedOutput ? { truncated: { output: true as const } } : {}),
        ...(files.length === 0 ? {} : { files }),
        ...(projection.citations === undefined ? {} : { citations: projection.citations }),
        ...(isError ? { error: errorIdentityOf(data['error']) } : {}),
        ...(time > state.time ? { durationMs: time - state.time } : {}),
      })
      return
    }
    if (name === 'deliverables/presented') {
      if (!this.enabled('deliverables')) return
      const files = Array.isArray(data['files']) ? data['files'] : []
      const refs: FileRefView[] = []
      const rules = await this.rulesFor(sessionId)
      for (const item of files.slice(0, 8)) {
        const record = asRecord(item)
        const path = typeof record['path'] === 'string' ? record['path'] : null
        if (path === null || !authorizeStat(path, rules)) continue
        const stat = await this.statPath(sessionId, path).catch(() => null)
        const absolute = stat?.absolutePath ?? path
        if (!authorizeStat(absolute, rules)) continue
        refs.push({
          fileRef: encodeFileRef({ v: 1, s: sessionId, p: absolute }),
          name: leafName(absolute).slice(0, 255),
          pathLabel: relativeLabel(absolute, rules.cwd).slice(0, 1024),
          mediaType: mediaTypeOfPath(absolute),
          mimeType: mimeTypeOfPath(absolute),
          ...(stat?.bytes === null || stat?.bytes === undefined ? {} : { bytes: stat.bytes }),
        })
      }
      if (refs.length === 0) return
      await this.deps.emit({
        v: 1,
        type: 'deliverable',
        sessionId,
        seq,
        turn: typeof data['turn'] === 'number' ? data['turn'] : 0,
        callId: typeof data['callId'] === 'string' ? data['callId'] : '',
        files: refs,
      })
      return
    }
    if (name === 'model/selection') {
      if (!this.enabled('models')) return
      const provider = typeof data['provider'] === 'string' ? data['provider'] : null
      const model = typeof data['model'] === 'string' ? data['model'] : null
      if (provider === null || model === null) return
      const effort = typeof data['reasoningEffort'] === 'string' ? data['reasoningEffort'] : undefined
      await this.deps.emit({
        v: 1,
        type: 'model-changed',
        sessionId,
        provider,
        model,
        ...(effort === undefined ? {} : { effort }),
      })
    }
  }

  /** 工具结果里的候选路径 → `fileRef`（要 stat + 包含检查；总预算 1.5s）。 */
  private async candidatesToRefs(
    sessionId: string,
    turn: number,
    candidates: readonly string[],
    limit: number,
  ): Promise<FileRefView[]> {
    if (!this.enabled('files') || candidates.length === 0) return []
    const used = this.turnFiles.get(`${sessionId}:${String(turn)}`) ?? 0
    if (used >= CANDIDATE_PER_TURN) return []
    const budget = Math.max(0, Math.min(limit, CANDIDATE_PER_TURN - used))
    const rules = await this.rulesFor(sessionId)
    const deadline = Date.now() + CANDIDATE_BUDGET_MS
    const refs = await Promise.all(
      candidates.slice(0, budget).map(async (candidate): Promise<FileRefView | null> => {
        if (Date.now() > deadline) return null
        const resolved = resolveRequestPath(candidate, rules)
        if (!resolved.ok) return null
        const stat = await this.statPath(sessionId, resolved.absolute).catch(() => null)
        if (stat === null || !authorizeStat(stat.absolutePath, rules)) return null
        return {
          fileRef: encodeFileRef({ v: 1, s: sessionId, p: stat.absolutePath }),
          name: leafName(stat.absolutePath).slice(0, 255),
          pathLabel: relativeLabel(stat.absolutePath, rules.cwd).slice(0, 1024),
          mediaType: mediaTypeOfPath(stat.absolutePath),
          mimeType: mimeTypeOfPath(stat.absolutePath),
          ...(stat.bytes === null ? {} : { bytes: stat.bytes }),
        }
      }),
    )
    const kept = refs.filter((ref): ref is FileRefView => ref !== null).slice(0, budget)
    if (kept.length > 0) this.turnFiles.set(`${sessionId}:${String(turn)}`, used + kept.length)
    return kept
  }

  /**
   * history 页里的工具与交付物**再补发**（契约 §7.3 / §8.1）。
   *
   * 为什么塞进 `history` 之外：工具一多就会把整页顶出单帧上限，`tool` 帧有自己的
   * 截断预算；客户端按 `seq` 与消息合并排序即可。
   */
  async replayHistory(sessionId: string, records: readonly unknown[]): Promise<void> {
    const wantTools = this.enabled('tools')
    const wantDeliverables = this.enabled('deliverables')
    if (!wantTools && !wantDeliverables) return
    for (const raw of records) {
      const record = asRecord(raw)
      if (record['type'] !== 'event') continue
      const event = asRecord(record['event'])
      const name = typeof event['type'] === 'string' ? event['type'] : ''
      if (name !== 'tool/call' && name !== 'tool/result' && name !== 'deliverables/presented') continue
      await this.onEvent(sessionId, event)
    }
  }

  /** 关闭所有 v2 资源（幂等）。 */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.uploads.clear()
    this.toolCalls.clear()
    this.turnFiles.clear()
    if (this.archivedStreamId !== null) {
      this.deps.mux.cancel(this.archivedStreamId)
      this.archivedStreamId = null
    }
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

/** 非负整数（缺省/非法当 0）。 */
function intOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** DSH 的 user/message 里 `source.kind === 'user'` 才是真人说的话。 */
function userSourceOf(source: unknown): boolean {
  const record = asRecord(source)
  return record['kind'] === 'user'
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function stringSet(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
}

/** 拼接 `ContentBlock[]` 里的 text（不碰 image/tool-call）。 */
function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record['type'] === 'text' && typeof record['text'] === 'string') parts.push(record['text'])
  }
  return parts.join('')
}

function errorIdentityOf(value: unknown): { name: string; code: string; reason?: string } {
  const record = asRecord(value)
  const name = typeof record['name'] === 'string' ? record['name'] : 'Error'
  const code = typeof record['code'] === 'string' ? record['code'] : 'UNKNOWN'
  const reason = typeof record['reason'] === 'string' ? record['reason'] : undefined
  return {
    name: name.slice(0, 80),
    code: code.slice(0, 80),
    ...(reason === undefined ? {} : { reason: reason.slice(0, 500) }),
  }
}

function joinPath(base: string, name: string): string {
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return base.endsWith(separator) ? `${base}${name}` : `${base}${separator}${name}`
}

/** 目录投影：补上 `input`（`image` 恒 null —— §17 D2 不做图片能力位）。 */
function toModelView(item: ModelEntry, pricing?: ModelPricingHooks): ModelView {
  const multiplier = pricing?.multiplierOf?.(item.model)
  return {
    ...item,
    input: { text: true, image: null },
    ...(typeof multiplier === 'number' && Number.isFinite(multiplier) && multiplier >= 0
      ? { multiplier }
      : {}),
  }
}
