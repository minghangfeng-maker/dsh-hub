/**
 * 会话级动作与投影：`rename` / `archive` / `set-model`（带超时与「结果未知」）、
 * 模型目录（`models` / `model-changed`）、用量（`usage`）。
 *
 * 三条来自真机的规则：
 *  1. **有界回调**：这些动作各有自己的错误出口，不能掉进「旧请求污染新会话」的通用
 *     错误条；超时按「结果未知」处理——`set-model` 超时**不**回滚（宁可保留用户的选择，
 *     也不要闪回旧值），rename/archive 超时则明确报失败（UI 据此回滚标题/归档标记）。
 *  2. **芯片只认投影**（冻结契约 §5.4）：`state{modelSelection}` 是唯一真相，
 *     `model-changed` 只用于清 loading + 兜底；投影到了就把等待中的 set-model 全算成功。
 *  3. **用量失败只进面板**（`sessionUsageError`），不弹全局错误条；切会话清空，
 *     迟到的别会话结果直接丢。
 */

import { archive as archiveFrame, models as modelsFrame, rename as renameFrame, setModel as setModelFrame, usage as usageFrame } from './wire.js'
import { errorMessage } from '../errors.js'
import { catalogFromServer, selectionFromServer, tierOfDshEffort } from '../models/catalog.js'
import type { ModelSelection } from '../models/catalog.js'
import type { MobileModel } from '../contracts/mobile-v2.js'
import type { ActionOutcome, FrameOf, ModelEcho, WorkspaceState } from './workspace-state.js'
import type { RequestFrame, RequestRegistry } from './requests.js'
import { displayErrorText } from './retry.js'

const ACTION_TIMEOUT_MS = 8_000
const SET_MODEL_TIMEOUT_MS = 6_000

export interface ActionsDeps {
  state(): WorkspaceState
  patch(partial: Partial<WorkspaceState>): void
  send(frame: RequestFrame): boolean
  requests: RequestRegistry
  fail(code: string, message: string): void
}

export class SessionActions {
  /** 等待投影/回执的 set-model（requestId → sessionId）；投影到了按会话整批结算。 */
  private readonly pendingModel = new Map<string, string>()

  constructor(private readonly deps: ActionsDeps) {}

  // ── 模型目录 ──────────────────────────────────────────────────────────────

  /**
   * 拉模型目录（v2 `models` 帧）。没有协商到 `models` feature 时不发；
   * UI 会退回本地 mock 目录（数据驱动，后续只换数据源）。
   */
  requestModels(sessionId?: string | null): void {
    if (!this.deps.state().features.includes('models')) return
    const requestId = this.deps.requests.nextId()
    if (!this.deps.send(modelsFrame(requestId, sessionId ?? undefined))) return
    this.deps.requests.track(requestId, { kind: 'models', sessionId: sessionId ?? null })
  }

  /**
   * 切换当前会话的模型/档位（只对下一次请求生效）。
   * 只在 `models` feature 已协商且会话已打开时发送；`effort` 缺省表示模型不支持思考。
   */
  setModel(
    input: ModelEcho,
    callbacks: { onResult?: (outcome: ActionOutcome) => void; timeoutMs?: number } = {},
  ): void {
    if (!this.deps.state().features.includes('models')) {
      this.deps.fail('feature-unsupported', '当前后端不支持切换模型')
      callbacks.onResult?.({ ok: false, code: 'feature-unsupported', message: '当前后端不支持切换模型' })
      return
    }
    const open = this.deps.state().openSessionId
    if (open == null) return

    // 没有回调 = 不需要结果：只登记归属，错误照旧走通用分支（与拆分前一致）。
    if (!callbacks.onResult) {
      const requestId = this.deps.requests.nextId()
      if (!this.deps.send(setModelFrame(requestId, open, input))) return
      this.deps.requests.track(requestId, { kind: 'set-model', sessionId: open })
      return
    }
    const onResult = callbacks.onResult
    // 失败回滚要及时，成功则等 model-changed / 投影确认；都超时就当「结果未知」，
    // **不**回滚（宁可保留用户的选择，也不要闪回旧值）。
    const call = this.deps.requests.request<ActionOutcome>((requestId) => setModelFrame(requestId, open, input), {
      kind: 'set-model',
      sessionId: open,
      timeout: {
        ms: callbacks.timeoutMs ?? SET_MODEL_TIMEOUT_MS,
        settlement: { resolve: { ok: false, code: 'timeout', message: errorMessage('timeout') } },
        keepRecord: true,
      },
      notSent: { resolve: { ok: false, code: 'not-connected', message: errorMessage('not-connected') } },
    })
    if (!call) {
      onResult({ ok: false, code: 'not-connected', message: errorMessage('not-connected') })
      return
    }
    this.pendingModel.set(call.id, open)
    void call.reply.then((outcome) => {
      this.pendingModel.delete(call.id)
      onResult(outcome)
    })
  }

  onModels(frame: FrameOf<'models'>): void {
    this.deps.requests.delete(frame.requestId)
    const catalog = catalogFromServer({
      backendId: this.deps.state().nodeId,
      items: frame.items as MobileModel[],
      default: frame.default ?? null,
      failures: frame.failures ?? [],
    })
    const current = frame.current ? selectionFromServer(catalog, frame.current) : this.deps.state().modelSelection
    this.deps.patch({ models: catalog, modelSelection: current })
  }

  onModelChanged(frame: FrameOf<'model-changed'>): void {
    // 冻结契约 §5.4：`model-changed` 只用于清 loading；芯片以 state{modelSelection} 投影为准。
    // 没有投影能力的节点（v1 降级）就靠这里兜底，避免 UI 永远停在旧值。
    if (frame.requestId) {
      this.deps.requests.delete(frame.requestId)
      this.settleForRequest(frame.requestId, { ok: true })
    }
    if (frame.sessionId !== this.deps.state().openSessionId) return
    if (!this.deps.state().features.includes('models')) return
    const catalog = this.deps.state().models
    const selection = catalog
      ? selectionFromServer(catalog, { provider: frame.provider, model: frame.model, effort: frame.effort })
      : { provider: frame.provider, model: frame.model, effortTier: tierOfDshEffort(frame.effort) }
    if (selection) this.deps.patch({ modelSelection: selection })
  }

  /** `created` 帧回显的模型（v2 created 会带回真正生效的 preset/model）。 */
  applyModelEcho(model: ModelEcho): void {
    const catalog = this.deps.state().models
    const selection: ModelSelection | null = catalog
      ? selectionFromServer(catalog, model)
      : { provider: model.provider, model: model.model, effortTier: tierOfDshEffort(model.effort) }
    if (selection) this.deps.patch({ modelSelection: selection })
  }

  /** `state{modelSelection}` 投影：芯片以它为准，并把等待中的 set-model 全算成功。 */
  applyProjection(sessionId: string, selection: ModelSelection): void {
    this.deps.patch({ modelSelection: selection })
    this.settleSessionModelActions(sessionId)
  }

  // ── 重命名 / 归档 ────────────────────────────────────────────────────────

  renameSession(sessionId: string, title: string): Promise<ActionOutcome> {
    if (!this.deps.state().features.includes('rename')) {
      return Promise.resolve({ ok: false, code: 'rename-unsupported', message: '当前后端不支持重命名' })
    }
    const call = this.deps.requests.request<ActionOutcome>((requestId) => renameFrame(requestId, sessionId, title), {
      kind: 'rename',
      sessionId,
      timeout: {
        ms: ACTION_TIMEOUT_MS,
        settlement: { resolve: { ok: false, code: 'timeout', message: errorMessage('timeout') } },
        keepRecord: true,
      },
      notSent: { resolve: { ok: false, code: 'not-connected', message: errorMessage('not-connected') } },
    })
    return call ? call.reply : Promise.resolve({ ok: false, code: 'not-connected', message: errorMessage('not-connected') })
  }

  archiveSession(sessionId: string, archived: boolean): Promise<ActionOutcome> {
    if (!this.deps.state().features.includes('archive')) {
      return Promise.resolve({ ok: false, code: 'archive-unsupported', message: '当前后端不支持归档' })
    }
    const call = this.deps.requests.request<ActionOutcome>(
      (requestId) => archiveFrame(requestId, sessionId, archived),
      {
        kind: 'archive',
        sessionId,
        timeout: {
          ms: ACTION_TIMEOUT_MS,
          settlement: { resolve: { ok: false, code: 'timeout', message: errorMessage('timeout') } },
          keepRecord: true,
        },
        notSent: { resolve: { ok: false, code: 'not-connected', message: errorMessage('not-connected') } },
      },
    )
    return call ? call.reply : Promise.resolve({ ok: false, code: 'not-connected', message: errorMessage('not-connected') })
  }

  onRenamed(frame: FrameOf<'renamed'>): void {
    this.deps.requests.delete(frame.requestId)
    this.settleForRequest(frame.requestId, { ok: true })
    this.deps.patch({
      sessions: this.deps.state().sessions.map((row) =>
        row.sessionId === frame.sessionId ? { ...row, title: frame.title } : row,
      ),
    })
  }

  onArchived(frame: FrameOf<'archived'>): void {
    this.deps.requests.delete(frame.requestId)
    this.settleForRequest(frame.requestId, { ok: true })
    const archived = new Set(frame.sessionIds)
    // §17 D5：默认列表**不含**已归档。归档成功后要把这一行从当前列表里拿掉
    // （否则用户会看到「归档了但还在」），在「已归档」视图里则保留并打标。
    const includeArchived = this.deps.state().sessionsIncludeArchived
    this.deps.patch({
      sessions: this.deps.state().sessions
        .filter((row) => includeArchived || !archived.has(row.sessionId))
        .map((row) => ({
          ...row,
          // 「已归档」视图里给明确的布尔值（列表要按它显示「已归档 / 未归档」）；
          // 默认视图里不写这个字段（行本来就不该是归档的）。
          ...(includeArchived ? { archived: archived.has(row.sessionId) } : {}),
        })),
    })
  }

  // ── 用量 ──────────────────────────────────────────────────────────────────

  /**
   * 请求一个会话的 token 用量（只读；v2 `usage` 特性）。
   *
   * 结果进 `state.sessionUsage`；失败只写 `sessionUsageError`（面板里显示 + 重试），
   * 不弹全局错误条。只对当前打开的会话语义有效（adapter 需要会话游标）。
   */
  requestUsage(sessionId: string): void {
    if (!this.deps.state().features.includes('usage')) {
      this.deps.patch({
        sessionUsage: null,
        sessionUsageSessionId: sessionId,
        sessionUsageLoading: false,
        sessionUsageError: '当前后端不支持查看用量',
      })
      return
    }
    const requestId = this.deps.requests.nextId()
    if (!this.deps.send(usageFrame(requestId, sessionId))) {
      this.deps.patch({ sessionUsageLoading: false, sessionUsageError: errorMessage('not-connected') })
      return
    }
    this.deps.requests.track(requestId, { kind: 'usage', sessionId })
    this.deps.patch({
      sessionUsage: null,
      sessionUsageSessionId: sessionId,
      sessionUsageLoading: true,
      sessionUsageError: null,
    })
  }

  /** 关闭面板/切会话时清掉用量，避免把 A 的用量显示在 B 上。 */
  clearUsage(): void {
    this.deps.patch({
      sessionUsage: null,
      sessionUsageSessionId: null,
      sessionUsageLoading: false,
      sessionUsageError: null,
    })
  }

  onUsage(frame: FrameOf<'usage'>): void {
    this.deps.requests.delete(frame.requestId)
    // 只认当前会话的结果（切走之后迟到的放宽）
    if (frame.sessionId !== this.deps.state().openSessionId) return
    if (
      this.deps.state().sessionUsageSessionId !== null &&
      frame.sessionId !== this.deps.state().sessionUsageSessionId
    ) {
      return
    }
    this.deps.patch({
      sessionUsage: frame.stats,
      sessionUsageSessionId: frame.sessionId,
      sessionUsageLoading: false,
      sessionUsageError: null,
    })
  }

  /** 用量请求失败：只进面板（技术码用中文兜底）。 */
  onUsageError(code: string, message: string | undefined): void {
    this.deps.patch({
      sessionUsageLoading: false,
      sessionUsageError: displayErrorText(code, message),
    })
  }

  // ── 错误路由 ──────────────────────────────────────────────────────────────

  /**
   * 错误帧按 requestId 落到对应的动作上；返回 true = 已结算，调用方不要弹通用错误条。
   */
  failRequest(requestId: string, code: string, message: string): boolean {
    const settled = this.deps.requests.resolve(requestId, { ok: false, code, message })
    if (settled) this.pendingModel.delete(requestId)
    return settled
  }

  private settleForRequest(requestId: string, outcome: ActionOutcome): void {
    if (this.deps.requests.resolve(requestId, outcome)) this.pendingModel.delete(requestId)
  }

  /** 会话级结算：投影已经反映出新选择时，把该会话里等待中的 set-model 都算成功。 */
  private settleSessionModelActions(sessionId: string): void {
    if (this.pendingModel.size === 0) return
    for (const [requestId, pendingSession] of [...this.pendingModel]) {
      if (pendingSession !== sessionId) continue
      if (this.deps.requests.resolve(requestId, { ok: true })) this.pendingModel.delete(requestId)
    }
  }
}
