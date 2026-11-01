/**
 * 发送队列（**Outbox**）：还没真正发出去的消息的唯一队列。
 *
 * 0.2.x 这套编排在 UI 里（`packages/mobile-ui/src/stores/chat.ts` 的 `queue` / `pendingFirst` /
 * `creatingForSend`），只在内存、且靠「任何错误」判建会话失败。现在下沉到 core：
 *
 *  1. **还没会话时先建会话再发首条**：建会话只按**那一次 create 请求的回包**判定
 *     （`requestId` 关联），不看全局 `state.error`——以前任何无关错误都会把首条消息退回队列；
 *  2. **唤醒 / 断线时排队、连上自动发**：只有「链路连接 + 节点可连接 + 没在停止 + 有 send
 *     能力」才动，其余情况原样排队（UI 用 `state.outbox` 画待发气泡）；
 *  3. **附件就绪后再发**：附件上传由 UI 侧的任务推进，这里只问「这条附件的本地状态」；
 *     没就绪就等（顺带把上传踢起来）；上传失败 / 跨重启后字节丢失时**条目停在队列里**、
 *     标记 `problem`（气泡给「重试 / 去掉附件发送 / 删除」三个动作），由用户决定 ——
 *     **绝不自动丢附件把文字发出去**（否则用户以为图发了，其实没发）；
 *  4. **持久化**：每条入队即落盘（`cache/outbox-store.ts`，按 accountKey + backendId 隔离），
 *     冷启动恢复后照常显示成待发气泡、连上后按序发出；退出登录由账号级清理器清空；
 *  5. **幂等**：队列 id **就是** `clientMessageId`。发出前先把条目从盘上删掉，再写帧——
 *     已经发出但结果未知的消息**绝不自动重发**（M4 §12.1，沿用 `pending-sends.ts` 的
 *     `unknown` 逻辑，由用户显式重试且沿用同一个 id）。
 *
 * 队列是**按会话区分**的：条目记住自己排进哪个会话，只在该会话打开时发（不悄悄切会话，
 * 也不把 A 的草稿发进 B）。`sessionId === null` 的条目属于「还没有会话」，需要先建。
 */

import { create as createFrame } from './wire.js'
import type { CreateFrameOptions } from './wire.js'
import type { MobileOutgoingAttachment } from '../contracts/mobile-v2.js'
import type { OutboxProblem, OutboxRecord, OutboxStore } from '../cache/outbox-store.js'
import type { LinkState, OutboxEntryView, OutboxAttachmentState, WorkspaceState } from './workspace-state.js'
import { randomId } from './ids.js'

/** 建会话失败后的自动重试退避（1s 起，封顶 10s；最多自动试 4 次，之后等新触发）。 */
const CREATE_RETRY_BASE_MS = 1_000
const CREATE_RETRY_MAX_MS = 10_000
const CREATE_RETRY_MAX_ATTEMPTS = 4

export interface OutboxDeps {
  state(): WorkspaceState
  patch(partial: Partial<WorkspaceState>): void
  /** 建会话（返回 requestId；能力不支持 / 帧没发出去时返回 null）。 */
  createSession(options: CreateFrameOptions): string | null
  /** 真正发一条（= `PendingSends.send`）：必须沿用传入的 `clientMessageId`。 */
  deliver(
    text: string,
    options: { clientMessageId: string; attachments?: MobileOutgoingAttachment[] },
  ): string | null
  fail(code: string, message: string, retryable?: boolean): void
  now(): number
  log(event: string, meta?: Record<string, unknown>): void
  /** 建会话帧的附加参数（模型 / 思考程度 / 预设）。 */
  createOptions?(): CreateFrameOptions
  /** 建会话失败（只按该次 create 的回包判定）：UI 据此丢掉无效 preset 并提示。 */
  onCreateFailed?(input: { code: string; message: string; retryable: boolean }): void
  /** 附件本地状态（UI 侧上传任务）；缺省视为「没有附件」。 */
  attachmentState?(localId: string): OutboxAttachmentState
  /** 已就绪附件的 outgoing 引用；缺省视为还没就绪。 */
  outgoingAttachment?(localId: string): MobileOutgoingAttachment | null
  /** 有会话了：把还没开始的附件上传推起来。 */
  startUploads?(sessionId: string): void
  /** 用户在气泡上点「重试」：把该附件的上传任务重新推起来（缺省 = 不可重试）。 */
  retryAttachment?(localId: string): void
  /** 持久化（缺省 = 只在内存里排队，不跨重启）。 */
  store?: OutboxStore
  /** 持久化的账号隔离键（缺省 = 不落盘）。 */
  accountKey?: string
  backendId: string
}

export interface OutboxEntryInput {
  text: string
  /** 附件本地 id（UI 的上传任务）；就绪后由 `outgoingAttachment` 换成 uploadId 引用。 */
  attachmentIds?: string[]
  /** 指定会话（缺省 = 当前打开的会话；都没有就留 null 等发送前建会话）。 */
  sessionId?: string | null
}

export class Outbox {
  private entries: OutboxRecord[] = []
  /** 正在为队首条目建会话（create 的 requestId → 那一条的队列 id）。 */
  private creating: { requestId: string; entryId: string } | null = null
  private pumping = false
  /** 推进过程中又来了触发（上传进度/连接变化）：这一轮结束再跑一轮，别把触发丢掉。 */
  private repump = false
  private disposed = false
  private restored: Promise<void> | null = null
  private published: OutboxEntryView[] = []
  private createFailures = 0
  private retryNotBefore = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private lastLink: LinkState | null = null

  constructor(private readonly deps: OutboxDeps) {}

  get count(): number {
    return this.entries.length
  }

  /** 队列里还有多少条属于这个会话（含 `sessionId === null` 的「待建会话」条目）。 */
  countForSession(sessionId: string | null): number {
    return this.entries.filter((entry) =>
      sessionId === null ? entry.sessionId === null : entry.sessionId === sessionId,
    ).length
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  /**
   * 冷启动恢复：把盘上排队的条目读回来并显示成待发气泡，然后尝试发。
   *
   * 幂等：进程内只读一次（重复调用返回同一个 Promise）。
   */
  restore(): Promise<void> {
    if (this.restored) return this.restored
    this.restored = this.doRestore()
    return this.restored
  }

  private async doRestore(): Promise<void> {
    const store = this.deps.store
    const accountKey = this.deps.accountKey
    if (!store || accountKey === undefined || this.disposed) {
      this.publish()
      return
    }
    const rows = await store.load(accountKey, this.deps.backendId)
    if (this.disposed) return
    // 恢复的条目排在内存里已有的条目之前（正常情况下 restore 早于第一次入队）。
    const known = new Set(this.entries.map((entry) => entry.id))
    const restored = rows.filter((row) => !known.has(row.id))
    this.entries = [...restored, ...this.entries]
    if (restored.length > 0) {
      this.deps.log('outbox-restored', {
        count: restored.length,
        withSession: restored.filter((entry) => entry.sessionId !== null).length,
      })
    }
    this.publish()
    void this.pump()
  }

  dispose(): void {
    this.disposed = true
    this.repump = false
    this.clearRetryTimer()
    this.creating = null
  }

  // ── 入队 / 出队 ──────────────────────────────────────────────────────────

  /**
   * 入队一条消息。
   *
   * @returns 队列 id —— **就是**这条消息将来的 `clientMessageId`（气泡身份稳定、便于幂等）。
   */
  enqueue(input: OutboxEntryInput): string {
    const id = `m_${randomId()}`
    const entry: OutboxRecord = {
      id,
      text: input.text.trim(),
      at: this.deps.now(),
      sessionId: input.sessionId === undefined ? this.deps.state().openSessionId : input.sessionId,
      attachments: [],
      attachmentIds: [...(input.attachmentIds ?? [])],
      attempts: 0,
    }
    this.entries.push(entry)
    // 新消息是一个明确的触发：清掉上一次建会话失败的退避，立刻试一次。
    this.resetCreateBackoff()
    this.publish()
    void this.persist()
    void this.pump()
    return id
  }

  /**
   * 用户移除了一条还没发出去的附件（输入卡上的「移除」）。
   *
   * 从所有排队条目里摘掉它；纯附件消息（没有文字）摘完就整条作废。
   */
  detachAttachment(localId: string): void {
    let changed = false
    for (const entry of [...this.entries]) {
      if (!entry.attachmentIds.includes(localId)) continue
      entry.attachmentIds = entry.attachmentIds.filter((id) => id !== localId)
      changed = true
      if (entry.text === '' && entry.attachments.length === 0 && entry.attachmentIds.length === 0) {
        this.entries = this.entries.filter((item) => item.id !== entry.id)
      }
    }
    if (!changed) return
    this.publish()
    void this.persist()
    void this.pump()
  }

  /** 会话被归档：属于它、还没发出去的草稿一并作废（否则永远发不出去）。 */
  discardSession(sessionId: string): number {
    const before = this.entries.length
    this.entries = this.entries.filter((entry) => entry.sessionId !== sessionId)
    const dropped = before - this.entries.length
    if (dropped === 0) return 0
    this.deps.log('outbox-discard-session', { sessionId, count: dropped })
    this.publish()
    void this.persist()
    return dropped
  }

  // ── create 回包（只认 requestId）──────────────────────────────────────────

  /** 建会话成功（`created` 帧）：把「还没有会话」的条目都归到新会话，然后继续发。 */
  onCreateResult(requestId: string, sessionId: string): void {
    if (this.creating?.requestId !== requestId) return
    this.creating = null
    this.resetCreateBackoff()
    let changed = false
    for (const entry of this.entries) {
      if (entry.sessionId !== null) continue
      entry.sessionId = sessionId
      changed = true
    }
    this.deps.log('outbox-create-ok', { count: this.entries.length })
    this.publish()
    if (changed) void this.persist()
    void this.pump()
  }

  /**
   * 建会话失败（`error` 帧带的是这一次 create 的 requestId）。
   *
   * @returns true = 属于 Outbox 的 create：调用方不要再弹通用错误（文案已由这里给出）。
   */
  onCreateError(requestId: string, code: string, message: string, retryable: boolean): boolean {
    if (this.creating?.requestId !== requestId) return false
    this.creating = null
    this.createFailures += 1
    this.deps.log('outbox-create-failed', { code, attempt: this.createFailures, retryable })
    // 先排退避再动状态：`fail()` 会提交一次状态（进而触发 pump），顺序反了就会立刻重试。
    this.scheduleRetry()
    // 错误条交给用户看（以前这里把所有错误都静默吞掉）。
    this.deps.fail(code, message, retryable)
    this.deps.onCreateFailed?.({ code, message, retryable })
    return true
  }

  // ── 推进一步 ──────────────────────────────────────────────────────────────

  /**
   * 状态变了 / 定时器到点：试着把队列往前推。
   *
   * 由门面在**每次**状态提交后调用（`patchState`）。队列空时是几次比较，开销可忽略。
   */
  pump(): void {
    const state = this.deps.state()
    if (state.link !== this.lastLink) {
      if (state.link === 'connected' && this.lastLink !== null) this.resetCreateBackoff()
      this.lastLink = state.link
    }
    if (this.disposed || this.entries.length === 0) return
    if (this.pumping) {
      // 正在推进（drain 里有 await）：记下来，这一轮结束后再跑一轮。
      this.repump = true
      return
    }
    this.pumping = true
    void this.drain().finally(() => {
      this.pumping = false
      if (this.repump) {
        this.repump = false
        this.pump()
      }
    })
  }

  private async drain(): Promise<void> {
    while (!this.disposed && this.entries.length > 0) {
      const state = this.deps.state()
      if (!readyToSend(state)) return
      const entry = this.nextEntry(state)
      if (!entry) return
      if (entry.sessionId === null) {
        // 需要先建会话：发 create 帧，等这次请求的回包（成功/失败都只认 requestId）。
        this.beginCreate(entry)
        return
      }
      if (entry.sessionId !== state.openSessionId) {
        // 条目属于另一个会话：不悄悄切会话，等用户打开它（冷启动的 last-session 恢复会打开）。
        return
      }
      const before = `${entry.attachments.length}:${entry.attachmentIds.length}:${problemKey(entry)}`
      const status = this.resolveAttachments(entry)
      if (`${entry.attachments.length}:${entry.attachmentIds.length}:${problemKey(entry)}` !== before) {
        await this.persist()
      }
      if (status === 'blocked') {
        // 附件出问题了：**停在这里**，气泡给用户三个动作，绝不自动丢附件发出。
        this.publish()
        return
      }
      if (status === 'wait') {
        // 附件还没传完：把上传推起来，等下一帧上传进度再试。
        this.deps.startUploads?.(entry.sessionId)
        this.publish()
        return
      }
      // **先落盘删除再写帧**：崩溃/断线也不会让「已经发出但结果未知」的消息被自动重发。
      this.entries = this.entries.filter((item) => item.id !== entry.id)
      await this.persist()
      let clientMessageId: string | null = null
      try {
        clientMessageId = this.deps.deliver(entry.text, {
          clientMessageId: entry.id,
          ...(entry.attachments.length > 0 ? { attachments: entry.attachments } : {}),
        })
      } catch (error) {
        this.deps.log('outbox-deliver-threw', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
      if (clientMessageId === null) {
        // 帧没发出去（链路在两步之间断了 / 前置条件不满足）：放回队首，等下一次状态变化。
        this.entries = [entry, ...this.entries]
        await this.persist()
        this.publish()
        return
      }
      if (clientMessageId !== entry.id) {
        // 真正负责发送的模块必须沿用队列 id，否则「待发气泡」与「发送中气泡」会变成两条。
        this.deps.log('outbox-id-mismatch', { entry: entry.id, clientMessageId })
      }
      this.deps.log('outbox-sent', { id: entry.id, attachments: entry.attachments.length })
      this.publish()
    }
  }

  /** 挑一条现在就能发的：只认「当前打开的会话」；没有会话时只认需要建会话的条目。 */
  private nextEntry(state: WorkspaceState): OutboxRecord | null {
    const open = state.openSessionId
    for (const entry of this.entries) {
      if (open === null) {
        if (entry.sessionId === null) return entry
        continue
      }
      if (entry.sessionId === open) return entry
    }
    return null
  }

  private beginCreate(entry: OutboxRecord): void {
    if (this.creating !== null) return
    if (this.deps.now() < this.retryNotBefore) {
      this.scheduleRetry()
      return
    }
    const state = this.deps.state()
    if (!(state.capabilities?.create ?? false)) {
      this.deps.fail('unsupported', '当前后端不支持新建会话')
      return
    }
    const options = this.deps.createOptions?.() ?? {}
    const requestId = this.deps.createSession(options)
    if (requestId === null) return
    this.creating = { requestId, entryId: entry.id }
    entry.attempts += 1
    this.deps.log('outbox-create', { id: entry.id, attempt: entry.attempts })
    void this.persist()
  }

  /**
   * 附件就绪判定（顺带把已就绪的换成 outgoing 引用，并把「问题」标到条目上）。
   *
   * 三态：
   * - `ready`：全部就绪（或没有附件）→ 可以发；
   * - `wait`：还有附件在上传 → 等下一帧上传进度（顺带把上传踢起来）；
   * - `blocked`：有附件上传失败 / 跨重启丢了字节 → **停在队列里**，等用户决定
   *   （重试 / 去掉附件只发文字 / 删除）。以前这里会把附件悄悄丢掉按纯文字发出去，
   *   用户会以为图发了、其实没发，所以现在一律交给用户选。
   */
  private resolveAttachments(entry: OutboxRecord): 'ready' | 'wait' | 'blocked' {
    if (entry.attachmentIds.length === 0) {
      if (entry.problem !== undefined) delete entry.problem
      return 'ready'
    }
    const keep: string[] = []
    const added: MobileOutgoingAttachment[] = []
    const failed: string[] = []
    const missing: string[] = []
    for (const localId of entry.attachmentIds) {
      const state = this.deps.attachmentState?.(localId) ?? 'missing'
      if (state === 'ready') {
        const outgoing = this.deps.outgoingAttachment?.(localId) ?? null
        if (outgoing === null) {
          keep.push(localId)
          continue
        }
        added.push(outgoing)
        continue
      }
      if (state === 'failed' || state === 'cancelled') {
        failed.push(localId)
        keep.push(localId)
        continue
      }
      if (state === 'missing') {
        missing.push(localId)
        keep.push(localId)
        continue
      }
      // local / uploading：还在传。
      keep.push(localId)
    }
    entry.attachmentIds = keep
    if (added.length > 0) entry.attachments = [...entry.attachments, ...added]
    if (failed.length > 0 || missing.length > 0) {
      // 上传失败优先展示（用户能重试）；只有「丢失」时才提示附件丢失（重试没意义）。
      const problem: OutboxProblem =
        failed.length > 0
          ? { kind: 'upload-failed', attachmentIds: failed }
          : { kind: 'attachment-missing', attachmentIds: missing }
      entry.problem = problem
      if (problem.kind === 'upload-failed') {
        // 上传任务可能还在（failed 可重试）：把上传推起来交给用户点。
        this.deps.log('outbox-attachment-blocked', { id: entry.id, count: problem.attachmentIds.length })
      }
      return 'blocked'
    }
    if (keep.length > 0) {
      if (entry.problem !== undefined) delete entry.problem
      return 'wait'
    }
    if (entry.problem !== undefined) delete entry.problem
    return 'ready'
  }

  // ── 用户对「附件有问题」的气泡做出的三个选择 ──────────────────────────────

  /** 「重试」：把出问题的附件上传重新推起来（任务已不存在时什么也不做）。 */
  retryProblem(entryId: string): boolean {
    const entry = this.entries.find((item) => item.id === entryId)
    if (!entry?.problem) return false
    for (const localId of entry.problem.attachmentIds) this.deps.retryAttachment?.(localId)
    this.deps.log('outbox-attachment-retry', { id: entryId, count: entry.problem.attachmentIds.length })
    // 状态会随上传进度推进；先清掉问题标记，让下一轮判定重新给出结论。
    delete entry.problem
    this.publish()
    void this.persist()
    void this.pump()
    return true
  }

  /** 「去掉附件发送」：整条摘掉附件，按纯文字发出（用户明确选择的结果）。 */
  sendWithoutAttachments(entryId: string): boolean {
    const entry = this.entries.find((item) => item.id === entryId)
    if (!entry) return false
    const dropped = entry.attachmentIds.length + entry.attachments.length
    entry.attachmentIds = []
    entry.attachments = []
    delete entry.problem
    this.deps.log('outbox-attachment-detach-all', { id: entryId, dropped })
    if (entry.text === '') {
      // 纯附件消息摘掉附件后没有内容可发：整条作废。
      this.entries = this.entries.filter((item) => item.id !== entryId)
    }
    this.publish()
    void this.persist()
    void this.pump()
    return true
  }

  /** 「删除」：整条消息作废（连附件一起）。 */
  discard(entryId: string): boolean {
    const before = this.entries.length
    this.entries = this.entries.filter((item) => item.id !== entryId)
    if (this.entries.length === before) return false
    this.deps.log('outbox-discard', { id: entryId })
    this.publish()
    void this.persist()
    return true
  }

  // ── 持久化 / 状态投影 / 退避 ──────────────────────────────────────────────

  private async persist(): Promise<void> {
    const store = this.deps.store
    const accountKey = this.deps.accountKey
    if (!store || accountKey === undefined) return
    await store.save(accountKey, this.deps.backendId, this.entries)
  }

  /** 把队列投影进 `WorkspaceState.outbox`（内容没变就不提交，避免白白多一帧）。 */
  private publish(): void {
    const next: OutboxEntryView[] = this.entries.map((entry) => ({
      id: entry.id,
      text: entry.text,
      at: entry.at,
      sessionId: entry.sessionId,
      ...(entry.problem === undefined ? {} : { problem: entry.problem }),
    }))
    if (sameViews(this.published, next)) return
    this.published = next
    this.deps.patch({ outbox: next })
  }

  private resetCreateBackoff(): void {
    this.createFailures = 0
    this.retryNotBefore = 0
    this.clearRetryTimer()
  }

  private scheduleRetry(): void {
    const base = CREATE_RETRY_BASE_MS
    const max = CREATE_RETRY_MAX_MS
    const failures = this.createFailures
    if (failures > CREATE_RETRY_MAX_ATTEMPTS) {
      // 自动重试到上限就停：留着条目排队，等新的触发（新消息 / 链路变化 / 用户操作）。
      this.deps.log('outbox-create-give-up', { attempts: failures })
      return
    }
    const delay = Math.min(max, base * 2 ** Math.max(0, failures - 1))
    this.retryNotBefore = this.deps.now() + delay
    this.clearRetryTimer()
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.pump()
    }, delay)
    // Node/无 DOM 环境：不阻止进程退出。
    ;(this.retryTimer as unknown as { unref?: () => void }).unref?.()
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === null) return
    clearTimeout(this.retryTimer)
    this.retryTimer = null
  }
}

/** 队列「现在能不能发」（不含「哪个会话」）：与 `WorkspaceController.canSend` 同一套前置条件。 */
function readyToSend(state: WorkspaceState): boolean {
  return (
    state.link === 'connected' &&
    state.nodeConnectable &&
    !state.stopRequested &&
    (state.capabilities?.send ?? false)
  )
}

/** `problem` 的比较键（undefined 与「同一组问题」要能被当成没变）。 */
function problemKey(view: OutboxEntryView): string {
  if (view.problem === undefined) return ''
  return `${view.problem.kind}:${view.problem.attachmentIds.join(',')}`
}

function sameViews(a: readonly OutboxEntryView[], b: readonly OutboxEntryView[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!
    const right = b[i]!
    if (
      left.id !== right.id ||
      left.text !== right.text ||
      left.at !== right.at ||
      left.sessionId !== right.sessionId ||
      problemKey(left) !== problemKey(right)
    ) {
      return false
    }
  }
  return true
}
