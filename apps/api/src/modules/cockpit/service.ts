import {
  COCKPIT_CANVAS_MAX_ITEMS,
  COCKPIT_HANDOFF_TTL_SECONDS,
  COCKPIT_PENDING_PROPOSALS_MAX,
  COCKPIT_PROPOSAL_TTL_MINUTES,
  COCKPIT_RATIONALE_MAX,
  COCKPIT_SECRET_REF_PREFIX,
  COCKPIT_SECRET_TTL_MINUTES,
  COCKPIT_STEPS_MAX,
  CanvasItemSchema,
  CanvasSpecSchema,
  OpsCallRequestSchema,
  type CanvasItem,
  type CanvasPlacement,
  type CanvasSize,
  type CanvasSpec,
  type CockpitStatusStrip,
  type CockpitHandoffResponse,
  type CockpitSourceResponse,
  type CockpitStateResponse,
  type CockpitSettingsRequest,
  type CockpitSettingsResponse,
  type OpsCallRequest,
  type OpsCallResult,
  type OpsCatalogQuery,
  type OpsCatalogResponse,
  type OpsContextResponse,
  type OpsSecretRequestCreate,
  type OpsSecretStatusResponse,
  type OpsStatus,
  type ProposalOutcomeStep,
  type ProposalPreview,
  type ProposalStatus,
  type ProposalView,
  type SecretRequestView,
} from '@dsh-hub/shared'
import { HUB_VERSION } from '../../config.js'
import type { AppDeps, BaseDeps, RequestMeta } from '../../context.js'
import { runWithAuditContext } from '../../lib/audit.js'
import { isoPlusMinutes, isoPlusMs } from '../../lib/clock.js'
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from '../../lib/crypto.js'
import { HubError } from '../../lib/errors.js'
import { loadOrCreateMasterKey } from '../../lib/secrets.js'
import { createDefaultCapabilityRegistry } from './capabilities/index.js'
import { redact, truncateResult } from './capabilities/redact.js'
import type { CapabilityContext, CapabilityDefinition, CapabilityRegistry } from './capabilities/types.js'
import { createCockpitEventBus, type CockpitEventBus } from './events.js'
import type { OpsInstanceProbe } from './ops-probe.js'
import * as repo from './repo.js'
import type { AdminIdentity, CockpitService } from './types.js'
import {
  assertSourceAllowed,
  canvasRowToItem,
  highestRisk,
  parseSecretRequest,
  proposalRowToView,
  resolvePlacement,
  secretRowToView,
  secretStatus,
  toRows,
} from './view.js'

/** 创建座舱服务：`probe` 由装配处注入（WP56b 的真实现 / 测试的 `FakeOpsInstanceProbe`） */
export interface CreateCockpitServiceOptions {
  deps: BaseDeps
  probe: OpsInstanceProbe
  /** 注入一份能力注册表（测试用它加夹具能力）；缺省用 docs/24 §4 的全集 */
  registry?: CapabilityRegistry
}

interface StoredStep {
  capability: string
  args: Record<string, unknown>
  preview: ProposalPreview
}

const WAIT_POLL_MS = 250

export function createCockpitService(options: CreateCockpitServiceOptions): CockpitService {
  const deps = options.deps
  const appDeps = deps as AppDeps
  const probe = options.probe
  const registry = options.registry ?? createDefaultCapabilityRegistry()
  const events: CockpitEventBus = createCockpitEventBus((error) =>
    deps.logger.warn({ err: error }, '座舱 SSE 订阅者抛错'),
  )
  let masterKey: Buffer | null = null
  /** 上一次推给状态条的数字（只在变化时推 strip.update） */
  let lastStrip: string | null = null

  const nowIso = (): string => deps.clock.nowIso()
  const settingsOf = (): { model: string | null; autoExecuteR1: boolean } => deps.settings.get('cockpit')
  const keyOf = (): Buffer => {
    masterKey ??= loadOrCreateMasterKey(deps.paths.masterKeyFile)
    return masterKey
  }
  /** 系统账号（hub-ops）。没建好之前写操作没有执行者 —— R1 会退化成方案（更保守） */
  const opsActor = (): AdminIdentity | null => {
    const id = probe.systemUserId()
    return id === null ? null : { id, username: 'hub-ops' }
  }

  // ── 能力上下文与执行 ──────────────────────────────────────────────────────

  function capabilityContext(opts: {
    actor: AdminIdentity | null
    meta: RequestMeta
    via: CapabilityContext['via']
    sessionId?: string
    proposalId?: number
  }): CapabilityContext {
    return {
      deps: appDeps,
      actor: opts.actor,
      meta: opts.meta,
      via: opts.via,
      ...(opts.sessionId === undefined ? {} : { sessionId: opts.sessionId }),
      ...(opts.proposalId === undefined ? {} : { proposalId: opts.proposalId }),
      host: { listProposals: (query) => listProposalViews(query) },
    }
  }

  /** `secretFields` 只接受 secretRef：明文一律 400（§3.4），且不写进任何日志 */
  function assertSecretArgs(def: CapabilityDefinition, args: Record<string, unknown>): void {
    for (const field of def.secretFields ?? []) {
      const value = args[field]
      if (value === undefined || value === null) continue
      if (typeof value !== 'string' || !value.startsWith(COCKPIT_SECRET_REF_PREFIX)) {
        throw new HubError(
          'VALIDATION_FAILED',
          `参数 ${field} 只接受密钥引用（secret_request 得到的 ${COCKPIT_SECRET_REF_PREFIX}…），不接受明文`,
          { fields: { [field]: '只接受 secretRef' } },
        )
      }
    }
  }

  /** 解析一个密钥引用（校验归属 → 解密 → 用完即删） */
  function resolveSecret(
    ref: string,
    scope: { sessionId?: string; capability: string; field: string },
  ): string {
    const row = repo.getSecret(deps.db, ref)
    if (!row) throw new HubError('VALIDATION_FAILED', '密钥引用不存在（可能已过期或已用完）')
    const request = parseSecretRequest(row.request_json)
    if (scope.sessionId !== undefined && request.sessionId !== scope.sessionId) {
      throw new HubError('VALIDATION_FAILED', '这个密钥引用不属于当前会话')
    }
    if (request.capability !== scope.capability || request.field !== scope.field) {
      throw new HubError('VALIDATION_FAILED', '密钥引用与要用的参数不匹配')
    }
    if (!row.ciphertext || secretStatus(row, nowIso()) !== 'filled') {
      throw new HubError('VALIDATION_FAILED', '密钥请求还没填写，或已经过期')
    }
    const plaintext = decryptSecret(row.ciphertext, keyOf())
    repo.consumeSecret(deps.db, ref, nowIso())
    return plaintext
  }

  /** 执行一个能力：先 zod 校验，再把 secretRef 换成明文（用完即删） */
  async function executeCapability(
    def: CapabilityDefinition,
    rawArgs: Record<string, unknown>,
    ctx: CapabilityContext,
  ): Promise<unknown> {
    assertSecretArgs(def, rawArgs)
    const args = def.input.parse(rawArgs) as Record<string, unknown>
    if (def.secretFields && def.secretFields.length > 0) {
      const resolved: Record<string, unknown> = { ...args }
      for (const field of def.secretFields) {
        const ref = resolved[field]
        if (ref === undefined || ref === null) continue
        resolved[field] = resolveSecret(String(ref), {
          sessionId: ctx.sessionId,
          capability: def.id,
          field,
        })
      }
      return await def.run(ctx, resolved)
    }
    return await def.run(ctx, args)
  }

  function emit(event: Parameters<CockpitEventBus['emit']>[0]): void {
    events.emit(event)
  }

  function requireDefinition(id: string): CapabilityDefinition {
    const def = registry.get(id)
    if (!def) {
      throw new HubError(
        'VALIDATION_FAILED',
        `未知能力 ${id}：先用 GET /ops/catalog?q=… 查能力 id 与参数（不要凭记忆猜）`,
      )
    }
    return def
  }

  // ── 状态 / 目录 / 上下文 ──────────────────────────────────────────────────

  async function status(): Promise<OpsStatus> {
    const [raw, settings] = [await probe.status(), settingsOf()]
    return {
      instance: raw.instance,
      model: raw.model ?? settings.model,
      ...(raw.reason === undefined ? {} : { reason: raw.reason }),
      // I1：只看服务端设置，请求里的任何字段都不参与
      autoExecuteR1: settings.autoExecuteR1,
    }
  }

  /** 状态条（§1）：运行实例/总数、今日中转站用量、失败任务、待确认方案；变化时经 SSE 推 */
  function statusStrip(): CockpitStatusStrip {
    const counts = appDeps.services.instances.counts()
    const relay = appDeps.services.relay.overview()
    const strip: CockpitStatusStrip = {
      instancesRunning: counts.running,
      instancesTotal: repo.countInstances(deps.db),
      relayTodayRequests: relay.today.requests,
      relayTodayCredits: Math.round(relay.today.costMicro) / 1_000_000,
      failedJobs: appDeps.services.jobs.countByStatus('failed'),
      pendingProposals: repo.countPendingProposals(deps.db),
    }
    const serialized = JSON.stringify(strip)
    if (serialized !== lastStrip) {
      lastStrip = serialized
      emit({ type: 'strip.update', strip })
    }
    return strip
  }

  async function state(options: { autoStart?: boolean } = {}): Promise<CockpitStateResponse> {
    let current = await status()
    // I6：`/admin` 打开时若未运行就自动拉起（不等待就绪；拉不起来也不影响态势板与方案）。
    // WP57：概览里的 AI 助手传 autoStart=false —— 打开概览不该把座舱容器拉起来
    const autoStart = options.autoStart ?? true
    if (
      autoStart &&
      (current.instance === 'missing' || current.instance === 'stopped' || current.instance === 'error')
    ) {
      try {
        await probe.ensureStarted()
        deps.audit.log({
          actorId: null,
          action: 'cockpit.ops-start',
          targetType: 'cockpit-instance',
          targetId: 'hub-ops',
          detail: { via: 'cockpit', auto: true },
        })
        current = await status()
        emit({ type: 'ops.status', status: current })
      } catch (error) {
        deps.logger.warn({ err: error }, '座舱容器自动拉起失败（态势板与方案卡照常可用）')
        current = { ...current, reason: current.reason ?? '座舱容器启动失败，已降级为态势板' }
      }
    }
    repo.expireStaleProposals(deps.db, nowIso())
    return {
      status: current,
      pendingProposals: repo.countPendingProposals(deps.db),
      catalog: registry.descriptors(),
      strip: statusStrip(),
    }
  }

  async function context(): Promise<OpsContextResponse> {
    const overview = await appDeps.services.adminUsers.overview()
    const relay = appDeps.services.relay.overview()
    const now = deps.clock.now()
    return {
      version: HUB_VERSION,
      today: now.toISOString().slice(0, 10),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      policy: { autoExecuteR1: settingsOf().autoExecuteR1 },
      counts: {
        users: overview.users.total,
        usersActive: overview.users.active,
        instancesRunning: overview.instances.running,
        instancesStarting: overview.instances.starting,
        instancesError: overview.instances.error,
        jobsRunning: overview.jobs.running,
        jobsFailed24h: overview.jobs.failedLast24h,
        relayRequestsToday: relay.today.requests,
        pendingProposals: repo.countPendingProposals(deps.db),
        canvasPinned: repo.listPinnedCanvas(deps.db).length,
        capabilities: registry.descriptors().length,
      },
    }
  }

  function catalog(query?: OpsCatalogQuery): OpsCatalogResponse {
    return registry.catalog(query)
  }

  // ── 方案 ──────────────────────────────────────────────────────────────────

  function listProposalViews(
    query: {
      status?: ProposalStatus
      sessionId?: string
      limit?: number
    } = {},
  ): ProposalView[] {
    repo.expireStaleProposals(deps.db, nowIso())
    return repo.listProposals(deps.db, query).map(proposalRowToView)
  }

  function proposalRowOrThrow(id: number): repo.ProposalRow {
    repo.expireStaleProposals(deps.db, nowIso())
    const row = repo.getProposal(deps.db, id)
    if (!row) throw new HubError('NOT_FOUND', `方案 ${String(id)} 不存在`)
    return row
  }

  function getProposalView(id: number): ProposalView {
    return proposalRowToView(proposalRowOrThrow(id))
  }

  function emitProposal(id: number): void {
    const row = repo.getProposal(deps.db, id)
    if (!row) return
    emit({ type: 'proposal.upsert', proposal: proposalRowToView(row) })
  }

  async function createProposal(input: {
    sessionId: string
    title: string
    rationale: string
    steps: { capability: string; args: Record<string, unknown> }[]
    actor: AdminIdentity | null
    meta: RequestMeta
  }): Promise<ProposalView> {
    if (input.steps.length === 0 || input.steps.length > COCKPIT_STEPS_MAX) {
      throw new HubError('VALIDATION_FAILED', `方案步骤数必须在 1–${String(COCKPIT_STEPS_MAX)} 之间`)
    }
    if (repo.countPendingProposals(deps.db) >= COCKPIT_PENDING_PROPOSALS_MAX) {
      throw new HubError(
        'RATE_LIMITED',
        `待确认方案已达 ${String(COCKPIT_PENDING_PROPOSALS_MAX)} 个上限：请先在右侧处理（执行或拒绝）一些`,
      )
    }
    const previewCtx = capabilityContext({
      actor: input.actor,
      meta: input.meta,
      via: 'proposal',
      sessionId: input.sessionId,
    })
    const steps: StoredStep[] = []
    for (const step of input.steps) {
      const def = requireDefinition(step.capability)
      assertSecretArgs(def, step.args)
      const args = def.input.parse(step.args) as Record<string, unknown>
      const preview: ProposalPreview = def.preview
        ? await def.preview(previewCtx, args)
        : { summary: `执行「${def.title}」` }
      steps.push({ capability: def.id, args, preview: redact(preview) as ProposalPreview })
    }
    const risk = highestRisk(steps.map((step) => requireDefinition(step.capability).risk))
    const createdAt = nowIso()
    const expiresAt = isoPlusMinutes(createdAt, COCKPIT_PROPOSAL_TTL_MINUTES)
    const title = input.title.trim().slice(0, 200)
    const id = repo.insertProposal(deps.db, {
      sessionId: input.sessionId,
      title,
      rationale: input.rationale.slice(0, COCKPIT_RATIONALE_MAX),
      risk,
      stepsJson: JSON.stringify(steps),
      createdAt,
      expiresAt,
    })
    deps.audit.log({
      actorId: input.actor?.id ?? null,
      actorIp: input.meta.ip,
      action: 'cockpit.proposal-create',
      targetType: 'cockpit-proposal',
      targetId: id,
      detail: {
        via: 'cockpit',
        sessionId: input.sessionId,
        risk,
        steps: steps.map((step) => step.capability),
      },
    })
    // 画布上立刻出方案卡（§1：方案卡是画布的一种卡）
    createCanvas(
      {
        sessionId: input.sessionId,
        title: `方案 #${String(id)} · ${title}`,
        spec: { kind: 'proposal', proposalId: id },
        placement: 'right',
      },
      'hub',
    )
    const view = getProposalView(id)
    emit({ type: 'proposal.upsert', proposal: view })
    statusStrip()
    return view
  }

  /** 逐步执行；遇错停止；`outcome` 逐步记录（I3） */
  async function executeProposal(id: number, actor: AdminIdentity, meta: RequestMeta): Promise<void> {
    const row = repo.getProposal(deps.db, id)
    if (!row) return
    const steps = parseStoredSteps(row.steps_json)
    const outcome: ProposalOutcomeStep[] = []
    let ok = true
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]!
      try {
        const def = requireDefinition(step.capability)
        const ctx = capabilityContext({
          actor,
          meta,
          via: 'proposal',
          sessionId: row.session_id,
          proposalId: id,
        })
        const result = await runWithAuditContext(
          { detail: { via: 'cockpit', proposalId: id, sessionId: row.session_id } },
          () => executeCapability(def, step.args, ctx),
        )
        outcome.push({ stepIndex: index, ok: true, result: truncateResult(redact(result)).value })
      } catch (error) {
        ok = false
        outcome.push({
          stepIndex: index,
          ok: false,
          error: {
            code: HubError.is(error) ? error.code : 'INTERNAL',
            message: error instanceof Error ? error.message.slice(0, 500) : '执行失败',
          },
        })
        break
      }
    }
    repo.finishProposal(deps.db, id, ok ? 'succeeded' : 'failed', JSON.stringify(outcome))
    deps.audit.log({
      actorId: actor.id,
      action: ok ? 'cockpit.proposal-succeeded' : 'cockpit.proposal-failed',
      targetType: 'cockpit-proposal',
      targetId: id,
      detail: {
        via: 'cockpit',
        proposalId: id,
        sessionId: row.session_id,
        steps: outcome.length,
        failedStep: ok ? undefined : outcome[outcome.length - 1]?.stepIndex,
      },
    })
    emitProposal(id)
    statusStrip()
  }

  async function waitProposal(id: number, waitSec: number): Promise<ProposalView> {
    const deadline = Date.now() + Math.min(60, Math.max(0, waitSec)) * 1000
    let view = getProposalView(id)
    while ((view.status === 'pending' || view.status === 'running') && Date.now() < deadline) {
      await sleep(WAIT_POLL_MS)
      view = getProposalView(id)
    }
    return view
  }

  async function approveProposal(id: number, actor: AdminIdentity, meta: RequestMeta): Promise<ProposalView> {
    const row = proposalRowOrThrow(id)
    const now = nowIso()
    if (row.status !== 'pending') {
      throw new HubError(
        'CONFLICT',
        row.status === 'expired'
          ? '方案已过期（30 分钟有效），请让座舱 DSH 重新提一次'
          : '这个方案已经被处理过了',
      )
    }
    if (row.expires_at <= now) {
      repo.finishProposal(deps.db, id, 'expired', null)
      emitProposal(id)
      throw new HubError('CONFLICT', '方案已过期（30 分钟有效），请让座舱 DSH 重新提一次')
    }
    // 并发批准只执行一次：pending → running 的 CAS
    const changes = repo.decideProposal(deps.db, id, 'running', { decidedBy: actor.id, decidedAt: now })
    if (changes === 0) throw new HubError('CONFLICT', '这个方案正在被执行或已被处理')
    deps.audit.log({
      actorId: actor.id,
      actorIp: meta.ip,
      action: 'cockpit.proposal-approve',
      targetType: 'cockpit-proposal',
      targetId: id,
      detail: { via: 'cockpit', proposalId: id, sessionId: row.session_id, risk: row.risk },
    })
    const view = getProposalView(id)
    emit({ type: 'proposal.upsert', proposal: view })
    statusStrip()
    // 异步执行：批准的响应不等它（状态经 SSE 推，§3.2）
    void executeProposal(id, actor, meta).catch((error: unknown) => {
      deps.logger.error({ err: error, proposalId: id }, '座舱方案执行失败')
      repo.finishProposal(deps.db, id, 'failed', null)
      emitProposal(id)
    })
    return view
  }

  function rejectProposal(id: number, actor: AdminIdentity): ProposalView {
    const row = proposalRowOrThrow(id)
    if (row.status !== 'pending') throw new HubError('CONFLICT', '这个方案已经不在待确认状态')
    const changes = repo.decideProposal(deps.db, id, 'rejected', { decidedBy: actor.id, decidedAt: nowIso() })
    if (changes === 0) throw new HubError('CONFLICT', '这个方案已经被处理过了')
    deps.audit.log({
      actorId: actor.id,
      action: 'cockpit.proposal-reject',
      targetType: 'cockpit-proposal',
      targetId: id,
      detail: { via: 'cockpit', proposalId: id, sessionId: row.session_id, risk: row.risk },
    })
    const view = getProposalView(id)
    emit({ type: 'proposal.upsert', proposal: view })
    statusStrip()
    return view
  }

  /**
   * 启动清扫（WP56e1）：把上次进程里还在 `running` 的方案标 failed（「Hub 重启中断」）并推 SSE。
   *
   * 方案执行是进程内 fire-and-forget，Hub 在两步之间重启会留下 running 的死方案。
   * 由 `cockpitAdminPlugin` 的 `onReady` 调用（与 runtimes 的 `reconcileStaleBuilds` 同一个时机）。
   */
  function reconcileInterruptedProposals(): number[] {
    const ids = repo.failInterruptedProposals(deps.db, 'Hub 重启中断：方案执行被进程重启打断')
    for (const id of ids) {
      deps.audit.log({
        actorId: null,
        action: 'cockpit.proposal-failed',
        targetType: 'cockpit-proposal',
        targetId: id,
        detail: { via: 'cockpit', reason: 'hub-restart', proposalId: id },
      })
      emitProposal(id)
    }
    if (ids.length > 0) statusStrip()
    return ids
  }

  /**
   * SSE 连上时的补发快照（WP56e1）：还没处理完的**方案**与**待填写**的密钥请求。
   *
   * 为什么需要：SSE 是增量通道，管理员刷新页面后只能看到之后发生的事件。方案卡还有 `GET /proposals`
   * 兜底，密钥请求**没有任何列表接口**，不补发的话刷新后的密钥卡只剩一个 requestId（拿不到用途/来源）。
   */
  function pendingSnapshot(): { proposals: ProposalView[]; secretRequests: SecretRequestView[] } {
    const now = nowIso()
    repo.expireStaleProposals(deps.db, now)
    repo.expireStaleSecrets(deps.db, now)
    return {
      proposals: repo
        .listProposals(deps.db, { limit: 100 })
        .map(proposalRowToView)
        .filter((proposal) => proposal.status === 'pending' || proposal.status === 'running'),
      secretRequests: repo.listSecretsByStatus(deps.db, 'pending').map((row) => secretRowToView(row, now)),
    }
  }

  // ── 画布 ──────────────────────────────────────────────────────────────────

  function createCanvas(
    input: {
      sessionId: string
      title: string
      spec: CanvasSpec
      placement?: CanvasPlacement | 'auto'
      size?: CanvasSize
    },
    origin: 'dsh' | 'hub',
  ): CanvasItem {
    const spec = CanvasSpecSchema.parse(input.spec)
    if ((spec.kind === 'proposal' || spec.kind === 'secret-request') && origin !== 'hub') {
      throw new HubError('VALIDATION_FAILED', 'proposal / secret-request 卡只能由 Hub 生成')
    }
    assertSourceAllowed(spec, (id) => registry.get(id))
    // 每会话 60 张：超了删最旧的非钉住卡（§3.1）
    for (const staleId of repo.canvasOverflow(deps.db, input.sessionId, COCKPIT_CANVAS_MAX_ITEMS)) {
      const removed = repo.deleteCanvas(deps.db, staleId)
      if (removed) emit({ type: 'canvas.remove', id: removed.id, sessionId: removed.session_id })
    }
    const now = nowIso()
    const id = `cv_${randomToken(12)}`
    repo.insertCanvas(deps.db, {
      id,
      sessionId: input.sessionId,
      title: input.title.trim().slice(0, 200),
      specJson: JSON.stringify(spec),
      pinned: false,
      order: repo.nextCanvasOrder(deps.db, input.sessionId),
      origin,
      // Hub 生成的方案卡 / 密钥卡一律右舷（§1）；DSH 的 auto 按卡片类型解析
      placement: origin === 'hub' ? 'right' : resolvePlacement(spec, input.placement ?? 'auto'),
      size: input.size ?? 'm',
      createdAt: now,
      updatedAt: now,
    })
    const row = repo.getCanvas(deps.db, id)
    const item = row ? canvasRowToItem(row) : null
    if (!item) throw new HubError('INTERNAL', '画布卡写入后读不出来')
    emit({ type: 'canvas.upsert', item })
    return item
  }

  function patchCanvas(
    id: string,
    input: {
      sessionId: string
      title?: string
      spec?: CanvasSpec
      placement?: CanvasPlacement
      size?: CanvasSize
    },
  ): CanvasItem {
    const row = repo.getCanvas(deps.db, id)
    if (!row) throw new HubError('NOT_FOUND', `画布卡 ${id} 不存在`)
    if (row.origin !== 'dsh') throw new HubError('FORBIDDEN', 'Hub 生成的卡（方案卡/密钥卡）不能由座舱修改')
    if (row.session_id !== input.sessionId) throw new HubError('FORBIDDEN', '只能改本会话的卡')
    const spec = input.spec === undefined ? undefined : CanvasSpecSchema.parse(input.spec)
    if (spec) {
      if (spec.kind === 'proposal' || spec.kind === 'secret-request') {
        throw new HubError('VALIDATION_FAILED', 'proposal / secret-request 卡只能由 Hub 生成')
      }
      assertSourceAllowed(spec, (capabilityId) => registry.get(capabilityId))
    }
    repo.updateCanvas(deps.db, id, {
      ...(input.title === undefined ? {} : { title: input.title.trim().slice(0, 200) }),
      ...(spec === undefined ? {} : { specJson: JSON.stringify(spec) }),
      ...(input.placement === undefined ? {} : { placement: input.placement }),
      ...(input.size === undefined ? {} : { size: input.size }),
      updatedAt: nowIso(),
    })
    const updated = repo.getCanvas(deps.db, id)
    const item = updated ? canvasRowToItem(updated) : null
    if (!item) throw new HubError('INTERNAL', '画布卡更新后读不出来')
    emit({ type: 'canvas.upsert', item })
    return item
  }

  function listCanvas(sessionId: string): CanvasItem[] {
    return repo
      .listCanvasBySession(deps.db, sessionId)
      .map(canvasRowToItem)
      .filter((item): item is CanvasItem => item !== null)
  }

  function setCanvasFlags(
    id: string,
    patch: { pinned?: boolean; order?: number; placement?: CanvasPlacement; size?: CanvasSize },
  ): CanvasItem {
    const row = repo.getCanvas(deps.db, id)
    if (!row) throw new HubError('NOT_FOUND', `画布卡 ${id} 不存在`)
    repo.updateCanvas(deps.db, id, {
      ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
      ...(patch.order === undefined ? {} : { order: patch.order }),
      ...(patch.placement === undefined ? {} : { placement: patch.placement }),
      ...(patch.size === undefined ? {} : { size: patch.size }),
      updatedAt: nowIso(),
    })
    const updated = repo.getCanvas(deps.db, id)
    const item = updated ? canvasRowToItem(updated) : null
    if (!item) throw new HubError('INTERNAL', '画布卡更新后读不出来')
    emit({ type: 'canvas.upsert', item })
    return item
  }

  function removeCanvas(id: string): void {
    const removed = repo.deleteCanvas(deps.db, id)
    if (!removed) throw new HubError('NOT_FOUND', `画布卡 ${id} 不存在`)
    emit({ type: 'canvas.remove', id: removed.id, sessionId: removed.session_id })
  }

  /** 态势板：钉住的卡 + 默认四张（§1：全部 source 卡，不依赖模型） */
  async function board(): Promise<{ pinned: CanvasItem[]; defaults: CanvasItem[] }> {
    const pinned = repo
      .listPinnedCanvas(deps.db)
      .map(canvasRowToItem)
      .filter((item): item is CanvasItem => item !== null)
    return { pinned, defaults: boardDefaults(nowIso()) }
  }

  // ── 密钥请求 ──────────────────────────────────────────────────────────────

  function requireSecretRow(id: string): repo.SecretRow {
    repo.expireStaleSecrets(deps.db, nowIso())
    const row = repo.getSecret(deps.db, id)
    if (!row) throw new HubError('NOT_FOUND', `密钥请求 ${id} 不存在`)
    return row
  }

  function createSecretRequest(input: OpsSecretRequestCreate): SecretRequestView {
    const def = requireDefinition(input.capability)
    if (!def.secretFields || !def.secretFields.includes(input.field)) {
      throw new HubError('VALIDATION_FAILED', `能力 ${def.id} 没有密钥参数 ${input.field}`)
    }
    const createdAt = nowIso()
    const expiresAt = isoPlusMinutes(createdAt, COCKPIT_SECRET_TTL_MINUTES)
    const id = `${COCKPIT_SECRET_REF_PREFIX}${randomToken(24)}`
    repo.insertSecret(deps.db, {
      id,
      requestJson: JSON.stringify({
        sessionId: input.sessionId,
        purpose: input.purpose,
        capability: input.capability,
        field: input.field,
      }),
      createdAt,
      expiresAt,
    })
    const view = secretRowToView(requireSecretRow(id), nowIso())
    emit({ type: 'secret.request', request: view })
    createCanvas(
      {
        sessionId: input.sessionId,
        title: `密钥输入 · ${input.purpose}`.slice(0, 200),
        spec: { kind: 'secret-request', requestId: id },
        placement: 'right',
      },
      'hub',
    )
    return view
  }

  function getSecretRequest(id: string): SecretRequestView {
    return secretRowToView(requireSecretRow(id), nowIso())
  }

  async function waitSecretRequest(id: string, waitSec: number): Promise<OpsSecretStatusResponse> {
    const deadline = Date.now() + Math.min(60, Math.max(0, waitSec)) * 1000
    let row = requireSecretRow(id)
    while (secretStatus(row, nowIso()) === 'pending' && Date.now() < deadline) {
      await sleep(WAIT_POLL_MS)
      row = requireSecretRow(id)
    }
    const status = secretStatus(row, nowIso())
    // **不返回值**，只给引用号（§3.1）
    return status === 'filled' ? { status, secretRef: row.id } : { status }
  }

  function fillSecretRequest(id: string, value: string, actor: AdminIdentity): void {
    const row = requireSecretRow(id)
    if (secretStatus(row, nowIso()) !== 'pending') {
      throw new HubError('CONFLICT', '这个密钥请求已经不是待填写状态（已填写 / 已取消 / 已过期）')
    }
    const changes = repo.fillSecret(deps.db, id, encryptSecret(value, keyOf()), nowIso())
    if (changes === 0) throw new HubError('CONFLICT', '这个密钥请求已经不是待填写状态')
    const request = parseSecretRequest(row.request_json)
    deps.audit.log({
      actorId: actor.id,
      action: 'cockpit.secret-fill',
      targetType: 'cockpit-secret',
      targetId: id,
      // 绝不写值，连末 4 位都不写
      detail: {
        via: 'cockpit',
        capability: request.capability,
        field: request.field,
        purpose: request.purpose,
      },
    })
    emit({ type: 'secret.request', request: secretRowToView(requireSecretRow(id), nowIso()) })
  }

  function cancelSecretRequest(id: string, actor: AdminIdentity): void {
    const row = requireSecretRow(id)
    const changes = repo.cancelSecret(deps.db, id)
    if (changes === 0) throw new HubError('CONFLICT', '这个密钥请求已经不能取消了')
    deps.audit.log({
      actorId: actor.id,
      action: 'cockpit.secret-cancel',
      targetType: 'cockpit-secret',
      targetId: id,
      detail: { via: 'cockpit', capability: parseSecretRequest(row.request_json).capability },
    })
    emit({ type: 'secret.request', request: secretRowToView(requireSecretRow(id), nowIso()) })
  }

  // ── 交接码 ────────────────────────────────────────────────────────────────

  function createHandoff(adminId: number): CockpitHandoffResponse {
    const createdAt = nowIso()
    repo.purgeExpiredHandoffs(deps.db, createdAt)
    const code = randomToken(32)
    const expiresAt = isoPlusMs(createdAt, COCKPIT_HANDOFF_TTL_SECONDS * 1000)
    repo.insertHandoff(deps.db, { codeHash: sha256Hex(code), adminId, createdAt, expiresAt })
    return { code, expiresAt }
  }

  function consumeHandoff(code: string): number | null {
    if (code.length === 0 || code.length > 200) return null
    return repo.consumeHandoff(deps.db, sha256Hex(code), nowIso())
  }

  // ── 调用与数据源 ──────────────────────────────────────────────────────────

  async function call(raw: OpsCallRequest, meta: RequestMeta): Promise<OpsCallResult> {
    const input = OpsCallRequestSchema.parse(raw)
    const requests: { capability: string; args: Record<string, unknown> }[] = input.steps
      ? input.steps.map((step) => ({ capability: step.capability, args: step.args ?? {} }))
      : [{ capability: input.capability ?? '', args: input.args ?? {} }]
    const defs = requests.map((request) => requireDefinition(request.capability))
    const risk = highestRisk(defs.map((def) => def.risk))

    if (risk !== 'R0' && (input.title === undefined || input.title.trim().length === 0)) {
      throw new HubError('VALIDATION_FAILED', '写类能力必须带 title（方案卡的标题）')
    }
    if (input.steps !== undefined && risk === 'R0') {
      throw new HubError(
        'VALIDATION_FAILED',
        '多步方案里至少要有一个写操作；只读请求请用 capability 单步调用',
      )
    }

    // R0：直接执行并返回（脱敏 + 64 KB 截断，I4）
    if (input.steps === undefined && risk === 'R0') {
      const def = defs[0]!
      const ctx = capabilityContext({ actor: opsActor(), meta, via: 'ops', sessionId: input.sessionId })
      const result = await runWithAuditContext(
        { detail: { via: 'cockpit', capability: def.id, sessionId: input.sessionId } },
        () => executeCapability(def, requests[0]!.args, ctx),
      )
      const truncated = truncateResult(redact(result))
      return {
        kind: 'data',
        data: truncated.value,
        truncated: truncated.truncated,
        ...(truncated.hint === undefined ? {} : { hint: truncated.hint }),
      }
    }

    // R1：设置允许且写操作有执行者（hub-ops）时自动执行
    const executor = opsActor()
    if (input.steps === undefined && risk === 'R1' && settingsOf().autoExecuteR1 && executor !== null) {
      const def = defs[0]!
      const ctx = capabilityContext({ actor: executor, meta, via: 'ops', sessionId: input.sessionId })
      try {
        const result = await runWithAuditContext(
          {
            actorId: executor.id,
            detail: { via: 'cockpit', policy: 'autoExecuteR1', sessionId: input.sessionId },
          },
          () => executeCapability(def, requests[0]!.args, ctx),
        )
        const auditId = deps.audit.log({
          actorId: executor.id,
          actorIp: meta.ip,
          action: 'cockpit.auto-exec',
          targetType: 'cockpit-capability',
          targetId: def.id,
          detail: {
            via: 'cockpit',
            policy: 'autoExecuteR1',
            capability: def.id,
            sessionId: input.sessionId,
            jobId: jobIdOf(result),
          },
        })
        return { kind: 'done', result: truncateResult(redact(result)).value, auditId }
      } catch (error) {
        deps.audit.log({
          actorId: executor.id,
          actorIp: meta.ip,
          action: 'cockpit.auto-exec',
          targetType: 'cockpit-capability',
          targetId: def.id,
          detail: {
            via: 'cockpit',
            policy: 'autoExecuteR1',
            sessionId: input.sessionId,
            ok: false,
            error: error instanceof Error ? error.message.slice(0, 200) : '执行失败',
          },
        })
        throw error
      }
    }

    // R1（关闭自动 / 没有系统账号）、R2、R3：出方案卡
    const proposal = await createProposal({
      sessionId: input.sessionId,
      title: input.title ?? `执行「${defs[0]!.title}」`,
      rationale: input.rationale ?? '',
      steps: requests,
      actor: executor,
      meta,
    })
    return { kind: 'proposal', proposal }
  }

  async function source(
    input: { capability: string; args?: Record<string, unknown> },
    actor: AdminIdentity,
  ): Promise<CockpitSourceResponse> {
    const def = requireDefinition(input.capability)
    if (def.risk !== 'R0' || def.dataSource !== true) {
      throw new HubError('FORBIDDEN', '只有 dataSource=true 的 R0 能力可以作为画布数据源')
    }
    const ctx = capabilityContext({
      actor,
      meta: { ip: null, userAgent: 'cockpit-board' },
      via: 'admin',
    })
    const result = await runWithAuditContext(
      { detail: { via: 'cockpit', source: 'canvas', capability: def.id } },
      () => executeCapability(def, input.args ?? {}, ctx),
    )
    const truncated = truncateResult(redact(result))
    return {
      rows: toRows(truncated.value),
      truncated: truncated.truncated,
      ...(truncated.hint === undefined ? {} : { hint: truncated.hint }),
    }
  }

  async function updateSettings(
    input: CockpitSettingsRequest,
    actor: AdminIdentity,
  ): Promise<CockpitSettingsResponse> {
    const current = settingsOf()
    const next = {
      model: input.model === undefined ? current.model : input.model,
      autoExecuteR1: input.autoExecuteR1 ?? current.autoExecuteR1,
    }
    deps.settings.set('cockpit', next)
    /**
     * 座舱模型接线（WP56e1 / docs/24 §5）：`settings.cockpit.model` 要真的写进座舱容器的模型配置。
     *
     * 容器里的模型只有一个来源 —— `models.renderManaged(hub-ops)` 生成的 `managed.patch.yml`
     * （`agent-default-model` 条目，见 models service 的 `cockpitModelApplied`）。这里在模型变了之后
     * **立刻重渲染一次**，于是**下次启动/重启座舱容器就会用新模型**（选择「下次启动生效」而不是自动重启：
     * 座舱容器里可能正有一轮对话，改个模型不该把它掐断；顶栏「重启座舱」随时可以手动生效）。
     */
    let rendered: 'none' | 'ok' | 'failed' = 'none'
    if (next.model !== current.model) {
      const opsUserId = probe.systemUserId()
      if (opsUserId !== null) {
        try {
          await appDeps.services.models.renderManaged(opsUserId)
          rendered = 'ok'
        } catch (error) {
          rendered = 'failed'
          deps.logger.warn({ err: error, userId: opsUserId }, '座舱模型变更后重渲染 managed 配置失败')
        }
      }
    }
    deps.audit.log({
      actorId: actor.id,
      action: 'cockpit.settings',
      targetType: 'settings',
      targetId: 'cockpit',
      detail: {
        via: 'cockpit',
        model: next.model,
        autoExecuteR1: next.autoExecuteR1,
        ...(rendered === 'none' ? {} : { modelRender: rendered, appliesAt: 'next-start' }),
      },
    })
    const nextStatus = await status()
    emit({ type: 'ops.status', status: nextStatus })
    return { status: nextStatus }
  }

  async function startOpsInstance(actor: AdminIdentity): Promise<OpsStatus> {
    await probe.ensureStarted()
    deps.audit.log({
      actorId: actor.id,
      action: 'cockpit.ops-start',
      targetType: 'cockpit-instance',
      targetId: 'hub-ops',
      detail: { via: 'cockpit' },
    })
    const next = await status()
    emit({ type: 'ops.status', status: next })
    return next
  }

  async function restartOpsInstance(actor: AdminIdentity): Promise<OpsStatus> {
    await probe.restart()
    deps.audit.log({
      actorId: actor.id,
      action: 'cockpit.ops-restart',
      targetType: 'cockpit-instance',
      targetId: 'hub-ops',
      detail: { via: 'cockpit' },
    })
    const next = await status()
    emit({ type: 'ops.status', status: next })
    return next
  }

  return {
    registry,
    events,
    probe,
    catalog,
    context,
    status,
    state,
    updateSettings,
    startOpsInstance,
    restartOpsInstance,
    call,
    source,
    statusStrip,
    listProposals: listProposalViews,
    getProposal: getProposalView,
    waitProposal,
    approveProposal,
    rejectProposal,
    reconcileInterruptedProposals,
    pendingSnapshot,
    createCanvas,
    patchCanvas,
    listCanvas,
    board,
    setCanvasFlags,
    removeCanvas,
    createSecretRequest,
    getSecretRequest,
    waitSecretRequest,
    fillSecretRequest,
    cancelSecretRequest,
    createHandoff,
    consumeHandoff,
    dispose: () => events.clear(),
  }
}

// ── 工具 ────────────────────────────────────────────────────────────────────

function parseStoredSteps(raw: string): StoredStep[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as StoredStep[]) : []
  } catch {
    return []
  }
}

function jobIdOf(result: unknown): number | undefined {
  if (result !== null && typeof result === 'object') {
    const value = (result as { jobId?: unknown }).jobId
    if (typeof value === 'number') return value
  }
  return undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 态势板的默认五张（全部是 source 卡：Hub 用管理员身份重查，不经过模型）。
 *
 * WP56h：管理员的原话是「能用图的不要用表，图是可以显示变化的」，所以左舷从三张表格改成
 * ①舰况指标 + ②近 7 天用量堆叠柱 + ③实例资源柱状 + ④失败任务表格（明细要逐行追问，`size s`），
 * 右舷「待处理方案」也压成 `s`。表格只在「必须逐行看/追问」的地方留一张。
 */
function boardDefaults(now: string): CanvasItem[] {
  const base = (
    id: string,
    title: string,
    order: number,
    placement: 'left' | 'right',
    spec: CanvasSpec,
    size: CanvasSize = 'm',
  ): CanvasItem =>
    CanvasItemSchema.parse({
      id,
      sessionId: 'board',
      title,
      spec,
      pinned: false,
      order,
      placement,
      size,
      createdAt: now,
      updatedAt: now,
      origin: 'hub',
    })
  return [
    // ① 舰况：状态条那四个数字，指标卡形态（运行实例带 max、今日请求/积分带 7 天 spark）
    base(
      'board:vitals',
      '舰况',
      10,
      'left',
      {
        kind: 'stats',
        items: [],
        data: { source: { capability: 'cockpit.board-vitals', args: {}, refreshSec: 15 } },
      },
      's',
    ),
    // ② 近 7 天中转站用量：输入 / 输出 tokens 的堆叠柱，一眼看出趋势
    base('board:relay-usage', '近 7 天中转站用量', 20, 'left', {
      kind: 'chart',
      chart: 'stacked-bar',
      x: { key: 'day', format: 'date' },
      series: [
        { key: 'inputTokens', label: '输入 tokens' },
        { key: 'outputTokens', label: '输出 tokens' },
      ],
      unit: 'tokens',
      data: { source: { capability: 'relay.usage', args: { by: 'day' }, refreshSec: 60 } },
    }),
    // ③ 实例资源：按用户的内存占用（MB 由 instances.list 的派生字段 memoryUsedMb 给，前端不换算）
    base('board:instance-resources', '实例资源', 30, 'left', {
      kind: 'chart',
      chart: 'bar',
      x: { key: 'username', format: 'text' },
      series: [{ key: 'memoryUsedMb', label: '内存 MB' }],
      unit: 'MB',
      data: { source: { capability: 'instances.list', args: { status: 'running' }, refreshSec: 30 } },
    }),
    // ④ 失败任务：保留表格（每一条都要能「追问这一行」），高度压到 s；没有失败时渲染「一切正常」空态
    base(
      'board:failed-jobs',
      '失败任务',
      40,
      'left',
      {
        kind: 'table',
        columns: [
          { key: 'id', label: '任务', format: 'number' },
          { key: 'title', label: '标题' },
          { key: 'status', label: '状态', format: 'status' },
          { key: 'failed', label: '失败数', format: 'number' },
          { key: 'createdAt', label: '创建时间', format: 'datetime' },
        ],
        data: {
          source: { capability: 'jobs.list', args: { status: 'failed', pageSize: 20 }, refreshSec: 60 },
        },
        rowRef: { entity: 'job', idKey: 'id' },
      },
      's',
    ),
    // 右舷：待处理方案（明细表，`s`；没有待确认时渲染「没有待确认的操作」空态）
    base(
      'board:pending-proposals',
      '待处理方案',
      50,
      'right',
      {
        kind: 'table',
        columns: [
          { key: 'proposalId', label: '方案', format: 'number' },
          { key: 'title', label: '标题' },
          { key: 'risk', label: '风险', format: 'status' },
        ],
        data: { source: { capability: 'cockpit.pending-proposals', args: {}, refreshSec: 15 } },
      },
      's',
    ),
  ]
}
