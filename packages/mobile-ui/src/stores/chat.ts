/**
 * 对话 store：把 `WorkspaceController`（纯 TS 状态机）接成 Vue 状态。
 *
 * WP46 B/C 之后的分工（重要，别再把业务塞回来）：
 *  - **通道与帧时序、发送队列（Outbox）、建会话、唤醒排队、附件就绪编排全在 core**；
 *  - 这里只持有一份 `state = shallowRef<WorkspaceState>`（controller 每次提交换一个新对象，
 *    没变的字段保持同一引用），所有字段用 `computed` 取 —— **不再逐个镜像成 ref**；
 *  - 只有「跨重启的第一屏缓存、附件预览与缩略图、当前面板的用量覆盖」这类
 *    **不属于 controller** 的东西才是本地 ref；
 *  - 会话列表/对话快照的持久化按「输入引用没变就不写」（流式 delta 帧一次都不写 IndexedDB）；
 *  - 文件加载与预取在 `stores/files.ts`；后端/唤醒在 `stores/backend.ts`；
 *    模型与特性在 `stores/models.ts`；App 更新在 `stores/app-update.ts`。
 *
 * 发送（`send()`）现在只是「入队」：唤醒中/断线中/还没会话/附件还在传都能入队，
 * 由 core 的 Outbox 决定什么时候真正发出去（连上自动发、按序发、幂等键 = 队列 id）。
 * 队列条目持久化在 IndexedDB，冷启动恢复后照常显示成「待发气泡」。
 */

import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import {
  FileCache,
  WorkspaceController,
  mergeThread,
  type ActionOutcome,
  type ChatEntry,
  type DeliverableItem,
  type MobileOutgoingAttachment,
  type MobileSessionRowV2,
  type MobileSessionUsageStats,
  type ModelSelection,
  type QuestionPrompt,
  type ThreadItem,
  type ToolCard,
  type UiError,
  type WorkspaceState,
} from '@dsh-hub/mobile-core'
import { APP_VERSION } from '@/lib/app-info'
import { fileStore, gateway, outboxStore, prefs, sessionCache } from '@/lib/instance'
import { clearLastSession, saveLastSession } from '@/lib/last-session'
import { recordDiag } from '@/lib/diagnostics'
import { isCockpitEmbed } from '@/lib/cockpit-embed'
import {
  CONNECTION_GRACE_MS,
  connectionBanner as buildConnectionBanner,
  queuedLinkState as resolveQueuedLinkState,
  type BannerTone,
  type ConnectionBanner,
  type QueuedLinkState,
} from '@/lib/connection-banner'
import { setHighlightDeferred } from '@/lib/highlight'
import { checkAttachmentLimit, type PickedFile } from '@/lib/media'
import { useAuthStore } from './auth'
import { useBackendStore } from './backend'
import { useModelsStore } from './models'
import { useUiStore } from './ui'

export type LocalAttachmentState = 'local' | 'uploading' | 'ready' | 'failed'

/**
 * 连接计时的 tick（0.4.1 §2）：横幅要按秒从「连接中」升级到「暂时连不上」，
 * **只在未连接时运行**（连上立刻停，见 `stopConnectionTick`）。
 */
export const CONNECTION_TICK_MS = 1_000

/** 记进「连接诊断」的通道事件（只事件名，不记正文）。 */
const LINK_LOG_EVENTS = new Set([
  'link-closed',
  'link-dead',
  'link-probe-timeout',
  'channel-open-failed',
  'channel-error',
  'reconnect-failed',
])

/**
 * 与连接有关的瞬态错误码（0.4.1 §2）：这些不再单独弹错误条 —— 顶部横幅负责说
 * 「暂时连不上服务器 + 重试」（宽限期内干脆不说），避免同一件事两条提示一起闪。
 */
const CONNECTION_ERROR_CODES = new Set([
  'reconnecting',
  'upstream-unavailable',
  'reconnect-failed',
  'network',
])

/** 记进「连接诊断」的文件缓存/下载事件（只事件名 + 大小/错误码，不记路径与文件名）。 */
const FILE_LOG_EVENTS = new Set([
  'file-cache-hit',
  'file-cache-write-failed',
  'file-download-ok',
  'file-download-retry',
  'file-download-failed',
  'file-aborted',
])

/** 记进「连接诊断」的发送队列事件（只错误码/计数，不看正文）。 */
const OUTBOX_LOG_EVENTS = new Set([
  'outbox-restored',
  'outbox-sent',
  'outbox-create',
  'outbox-create-ok',
  'outbox-create-failed',
  'outbox-create-give-up',
  'outbox-attachment-dropped',
  'outbox-discard-session',
  'outbox-id-mismatch',
])

/** 文件类诊断的 meta 压成一行（真机排查「图片为什么没出来」用，不含文件名/路径）。 */
function summarizeFileMeta(meta: Record<string, unknown> | undefined): string {
  if (!meta) return ''
  const parts: string[] = []
  for (const key of ['bytes', 'mediaType', 'code', 'attempt', 'retryable', 'count']) {
    const value = meta[key]
    if (value === undefined || value === null) continue
    const text = String(value)
    parts.push(`${key}=${text.length > 24 ? `${text.slice(0, 24)}…` : text}`)
  }
  return parts.join(' ')
}

/** 诊断 meta 压成一行短文本（只保留错误码/原因/计数这类短字段）。 */
function summarizeLinkMeta(meta: Record<string, unknown> | undefined): string {
  if (!meta) return ''
  const parts: string[] = []
  for (const key of ['code', 'reason', 'idleMs', 'timeoutMs', 'error', 'count', 'attempt']) {
    const value = meta[key]
    if (value === undefined || value === null) continue
    const text = String(value)
    parts.push(`${key}=${text.length > 60 ? `${text.slice(0, 60)}…` : text}`)
  }
  return parts.join(' ')
}

/** 输入卡上的一个附件（本地预览 + 上传进度）。 */
export interface LocalAttachment {
  localId: string
  kind: 'image' | 'file'
  name: string
  mimeType: string
  bytes: number
  base64: string
  previewUrl: string | null
  state: LocalAttachmentState
  progress: number
  error: string | null
  /** core 里的上传任务 id（会话就绪后才创建）。 */
  taskId: string | null
  uploadId: string | null
}

/**
 * 会话用量快照（会话信息面板的「用量」段）。
 *
 * 直接沿用协议层契约 `MobileSessionUsageStats`（core → shared）：
 * inputTokens / outputTokens / totalTokens / cacheReadTokens / turns /
 * assistantMessages / userMessages / truncated。字段缺失或尚未接通时优雅降级。
 */
export type SessionUsageInfo = MobileSessionUsageStats

/** 还没有 controller 时先暂存的一条消息（后端列表还没回来；建好 controller 立刻转进 Outbox）。 */
interface DeferredSend {
  id: string
  text: string
  at: number
  attachmentIds: string[]
}

export const useChatStore = defineStore('chat', () => {
  const auth = useAuthStore()
  // 后端/唤醒、模型/特性各自独立成 store（WP46 C）；依赖方向仍是单向：chat → 它们。
  const backend = useBackendStore()
  const models = useModelsStore()
  const ui = useUiStore()

  const controller = shallowRef<WorkspaceController | null>(null)
  /**
   * controller 的状态快照：**唯一数据源**。
   *
   * controller 每次提交都换一个新的 `WorkspaceState` 对象（没变的字段保持同一引用），
   * 所以这里一个 `shallowRef` 就够；字段全部按需 `computed`，不做逐字段镜像。
   */
  const state = shallowRef<WorkspaceState | null>(null)
  const fileCache = new FileCache()
  const backendId = ref<string | null>(null)

  // ── controller 状态的投影（不要再加镜像 ref！）────────────────────────────
  const link = computed<WorkspaceState['link']>(() => state.value?.link ?? 'idle')
  const capabilities = computed(() => state.value?.capabilities ?? null)
  const nodeConnectable = computed(() => state.value?.nodeConnectable ?? true)
  const features = computed<string[]>(() => state.value?.features ?? [])
  /** 切后端的第一屏：IndexedDB 里缓存的会话列表（controller 建好后的第一帧会替换它）。 */
  const cachedSessionsList = ref<MobileSessionRowV2[]>([])
  const sessions = computed<MobileSessionRowV2[]>(() => {
    const live = state.value?.sessions ?? []
    return live.length > 0 ? live : cachedSessionsList.value
  })
  const sessionsLoading = computed(() => state.value?.sessionsLoading ?? false)
  const activeId = computed<string | null>(() => state.value?.openSessionId ?? null)
  const liveMessages = computed<ChatEntry[]>(() => state.value?.messages ?? [])
  const streamingText = computed(() => state.value?.streamingText ?? '')
  const streamingReasoning = computed(() => state.value?.streamingReasoning ?? '')
  const reasoningDone = computed(() => state.value?.reasoningDone ?? false)
  const turnRunning = computed(() => state.value?.turnRunning ?? false)
  const stopRequested = computed(() => state.value?.stopRequested ?? false)
  const pendingSendCount = computed(() => state.value?.pendingSendCount ?? 0)
  const historyHasMore = computed(() => state.value?.historyHasMore ?? false)
  const historyLoading = computed(() => state.value?.historyLoading ?? false)
  const workspaceError = computed<UiError | null>(() => state.value?.error ?? null)
  const questions = computed<QuestionPrompt[]>(() => state.value?.questions ?? [])
  const approvals = computed(() => state.value?.approvals ?? [])
  const reconnectAttempt = computed(() => state.value?.reconnectAttempt ?? 0)
  const toolCards = computed<ToolCard[]>(() => state.value?.toolCards ?? [])
  const deliverables = computed<DeliverableItem[]>(() => state.value?.deliverables ?? [])
  const uploads = computed<WorkspaceState['uploads']>(() => state.value?.uploads ?? [])
  const outbox = computed(() => state.value?.outbox ?? [])

  // ── 本地状态（不属于 controller）──────────────────────────────────────────
  /** 第一屏缓存：history 没到之前先显示上一次看到的对话（绝不覆盖服务端结果）。 */
  const cachedMessages = ref<ChatEntry[]>([])
  const historyLoaded = ref(true)
  /** 「全部会话 → 已归档」筛选（仅在服务端回显 archive feature 时显示入口）。 */
  const showArchived = ref(false)
  /** 输入卡上的附件（发送后移进 `queuedAttachments`，等 Outbox 发出去）。 */
  const attachments = ref<LocalAttachment[]>([])
  /** 已入队消息的本地附件：队列 id（= clientMessageId）→ 附件。 */
  const queuedAttachments = ref<Record<string, LocalAttachment[]>>({})
  /** 用户消息气泡里的附件缩略图：clientMessageId → 本地附件（发送前后都不丢）。 */
  const messageAttachments = ref<Record<string, LocalAttachment[]>>({})
  /** 还没有 controller（后端列表没回来）时先暂存的消息。 */
  const deferredSends = ref<DeferredSend[]>([])

  // 用量面板：core 投影 + 本地覆盖（手动写入 / 8s 超时兜底）
  const usageOverride = ref<{ usage: SessionUsageInfo | null; error: string | null } | null>(null)
  const usageTimedOut = ref(false)

  let unsubscribeState: (() => void) | null = null
  let wasHistoryLoading = false
  let cacheTimer: ReturnType<typeof setTimeout> | null = null
  let highlightTimer: ReturnType<typeof setTimeout> | null = null
  /** 建 controller 时用的账号键：账号变了必须重建（持久缓存 / 发送队列按账号隔离）。 */
  let controllerAccountKey: string | null = null
  /** 上一次提交的链路状态（诊断只在变化时记一条；与旧实现的初始值一致）。 */
  let lastLink: WorkspaceState['link'] = 'idle'

  // ── 连接计时（0.4.1 §1）─────────────────────────────────────────────────
  /**
   * 未连上的起点（毫秒）：link 离开 connected 时记、回到 connected 时清。
   * 顶部横幅的宽限期（4 秒）与警示（15 秒）都从这里算；`null` = 不计时
   * （已连上 / 切后台暂停 / 还没登录 / 刚退出登录）。
   */
  const notConnectedSince = ref<number | null>(null)
  /** 计时用的「现在」：未连接时每秒 tick 一次（连上就停，见 startConnectionTick）。 */
  const connectionNow = ref(Date.now())
  let connectionTick: ReturnType<typeof setInterval> | null = null
  /** 切后台期间暂停计时：回前台从那一刻重新算，锁屏很久回来不会立刻弹警示。 */
  let connectionPaused = false

  /** 启动 1 秒 tick（只在未连接时跑；已有定时器就复用）。 */
  function startConnectionTick(): void {
    if (connectionTick !== null) return
    connectionNow.value = Date.now()
    connectionTick = setInterval(() => {
      connectionNow.value = Date.now()
    }, CONNECTION_TICK_MS)
    // Node（单测）里 setInterval 会挂住事件循环；浏览器里没有 unref。
    ;(connectionTick as unknown as { unref?: () => void }).unref?.()
  }

  /** 停 tick（连上 / 切后台 / 退出登录）。 */
  function stopConnectionTick(): void {
    if (connectionTick === null) return
    clearInterval(connectionTick)
    connectionTick = null
    connectionNow.value = Date.now()
  }

  /** 开始（或保持）未连接计时 + tick。已经计时的不会被重置（同一段等待只算一次）。 */
  function startNotConnectedClock(): void {
    if (notConnectedSince.value === null) notConnectedSince.value = Date.now()
    connectionNow.value = Date.now()
    startConnectionTick()
  }

  /** 连上 / 切后台 / 退出登录：计时清零 + 停 tick（「连上立即隐藏、计时归零」）。 */
  function clearNotConnectedClock(): void {
    notConnectedSince.value = null
    stopConnectionTick()
  }

  const readyToSend = computed(
    () =>
      link.value === 'connected' &&
      !!capabilities.value?.send &&
      nodeConnectable.value &&
      !stopRequested.value,
  )

  const isStreaming = computed(
    () => turnRunning.value || !!streamingText.value || !!streamingReasoning.value,
  )

  const activeSession = computed(
    () => sessions.value.find((s) => s.sessionId === activeId.value) ?? null,
  )

  function pendingEntry(id: string, text: string, at: number, blocked: boolean): ChatEntry {
    return {
      seq: null,
      localId: id,
      role: 'user',
      text,
      tools: [],
      at,
      // 附件有问题时消息停在队列里：不能再显示「发送中…」（用户会以为在发）。
      pending: !blocked,
      failed: false,
      unknown: false,
    }
  }

  /** 当前会话的待发消息（core 的队列 + 还没有 controller 时暂存的）。 */
  const queuedEntries = computed<ChatEntry[]>(() => {
    const current = activeId.value
    const mine = outbox.value.filter(
      (entry) => entry.sessionId === null || entry.sessionId === current,
    )
    const entries: ChatEntry[] = mine.map((entry) =>
      pendingEntry(entry.id, entry.text, entry.at, entry.problem !== undefined),
    )
    for (const entry of deferredSends.value) {
      entries.push(pendingEntry(entry.id, entry.text, entry.at, false))
    }
    return entries
  })

  const title = computed(() => {
    if (activeSession.value?.title) return activeSession.value.title
    const pending = queuedEntries.value[0]
    if (pending) return pending.text.slice(0, 24)
    return '新会话'
  })

  const displayMessages = computed<ChatEntry[]>(() => {
    const base = historyLoaded.value
      ? liveMessages.value
      : cachedMessages.value.length > 0
        ? cachedMessages.value
        : liveMessages.value
    return [...base, ...queuedEntries.value]
  })

  /**
   * 渲染时间线：消息 / 工具卡 / 交付物按 seq 交错。
   * `system` 消息（DSH 注入、系统提示）不显示（§17 v1 缺陷 ①）。
   */
  const threadItems = computed<ThreadItem[]>(() => {
    const messages = displayMessages.value.filter((entry) => entry.role !== 'system')
    return mergeThread(messages, toolCards.value, deliverables.value)
  })

  const canSend = computed(() => readyToSend.value || queuedEntries.value.length > 0)

  /**
   * 有「待回答的提问/审批」的会话（WP46：`pendingInteractions` 由 Hub 给）。
   *
   * 注意排除当前打开的会话：当前会话的提问卡就在页面上，不需要再提示一次。
   */
  const pendingAnswerSessions = computed(() =>
    sessions.value.filter(
      (row) => (row.pendingInteractions ?? 0) > 0 && row.sessionId !== activeId.value,
    ),
  )
  /** 顶部的细提示用：「有 N 个对话在等你回答」（0 = 不显示）。 */
  const pendingAnswerCount = computed(() => pendingAnswerSessions.value.length)
  /** 点提示时打开的第一个会话。 */
  const firstPendingAnswerSession = computed(() => pendingAnswerSessions.value[0] ?? null)

  // ── 用量（会话信息面板）──────────────────────────────────────────────────
  const USAGE_TIMEOUT_MS = 8_000
  let usageTimer: ReturnType<typeof setTimeout> | null = null

  function clearUsageTimer(): void {
    if (usageTimer !== null) {
      clearTimeout(usageTimer)
      usageTimer = null
    }
  }

  /** core 投影（属于别的会话的迟到用量不显示）。 */
  const projectedUsage = computed<SessionUsageInfo | null>(() => {
    const current = state.value
    if (!current) return null
    if (current.sessionUsageSessionId !== null && current.sessionUsageSessionId !== activeId.value) {
      return null
    }
    return current.sessionUsage
  })

  const sessionUsage = computed<SessionUsageInfo | null>(() =>
    usageOverride.value ? usageOverride.value.usage : projectedUsage.value,
  )
  const sessionUsageLoading = computed(() => {
    if (usageOverride.value) return false
    return state.value?.sessionUsageLoading === true && !usageTimedOut.value
  })
  const sessionUsageError = computed<string | null>(() => {
    if (usageOverride.value) return usageOverride.value.error
    if (usageTimedOut.value) return '统计用量超时，请重试'
    const current = state.value
    if (!current) return null
    if (current.sessionUsageSessionId !== null && current.sessionUsageSessionId !== activeId.value) {
      return null
    }
    return current.sessionUsageError
  })

  /**
   * 打开信息面板时拉一次当前会话用量。
   *
   * `requestUsage` 由协议层（core 的 WorkspaceController）提供；结果由 core 的 `usage`
   * 帧投影进 `WorkspaceState`，再经上面的 computed 显示。
   */
  function loadSessionUsage(): void {
    const sessionId = activeId.value
    const instance = controller.value
    clearUsageTimer()
    usageOverride.value = null
    usageTimedOut.value = false
    if (!sessionId || !instance) return
    usageTimer = setTimeout(() => {
      usageTimer = null
      if (!state.value?.sessionUsageLoading) return
      // 服务端一直不回帧：让 core 收尾成可重试的失败态（否则协议层会一直 loading）。
      usageTimedOut.value = true
      instance.clearUsage()
    }, USAGE_TIMEOUT_MS)
    try {
      instance.requestUsage(sessionId)
    } catch {
      clearUsageTimer()
      usageOverride.value = { usage: null, error: '统计用量失败，请重试' }
    }
  }

  /** 关闭信息面板 / 切后端时清空；同时让协议层丢掉这份投影（避免迟到帧又写回来）。 */
  function clearSessionUsage(): void {
    clearUsageTimer()
    usageOverride.value = null
    usageTimedOut.value = false
    controller.value?.clearUsage()
  }

  /**
   * 手动写入口（调试/测试直接灌数据）：非 null 时优先于 core 投影。
   * `usage = null` 表示当前会话确实没有可统计的数据；`error` 用于失败文案。
   */
  function applySessionUsage(usage: SessionUsageInfo | null, error: string | null = null): void {
    clearUsageTimer()
    usageTimedOut.value = false
    usageOverride.value = { usage, error }
  }

  // ── 附件 ────────────────────────────────────────────────────────────────

  function attachmentLimit(picked: PickedFile): { ok: boolean; message?: string } {
    return checkAttachmentLimit({
      kind: picked.kind,
      bytes: picked.bytes,
      backendKind: backend.selectedBackend?.kind === 'desktop' ? 'desktop' : 'cloud',
    })
  }

  /** 加一个附件：本地先展示，有会话就立刻开始上传。 */
  function addAttachment(picked: PickedFile): boolean {
    const limit = attachmentLimit(picked)
    if (!limit.ok) {
      ui.toast(limit.message ?? '附件太大', 2600)
      return false
    }
    const item: LocalAttachment = {
      localId: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      kind: picked.kind,
      name: picked.name,
      mimeType: picked.mimeType,
      bytes: picked.bytes,
      base64: picked.base64,
      previewUrl: picked.previewUrl,
      state: 'local',
      progress: 0,
      error: null,
      taskId: null,
      uploadId: null,
    }
    attachments.value = [...attachments.value, item]
    startUploads()
    return true
  }

  /** 有会话就为还没开始的附件发 upload-begin（幂等：Outbox 在需要时也会来踢一脚）。 */
  function startUploads(): void {
    const instance = controller.value
    const sessionId = activeId.value
    if (!instance || !sessionId) return
    let changed = false
    const next = attachments.value.map((item) => {
      if (item.state !== 'local' || item.taskId) return item
      const taskId = instance.uploadAttachment(sessionId, {
        kind: item.kind,
        name: item.name,
        mimeType: item.mimeType,
        bytes: item.bytes,
        data: item.base64,
      })
      if (!taskId) return item
      changed = true
      return { ...item, taskId, state: 'uploading' as LocalAttachmentState }
    })
    if (changed) attachments.value = next
  }

  /** 某个待发气泡的附件问题（`problem`），没有就返回 null。 */
  function queuedProblemOf(localId: string | null): WorkspaceState['outbox'][number]['problem'] | null {
    if (!localId) return null
    return outbox.value.find((entry) => entry.id === localId)?.problem ?? null
  }

  /** 气泡上的「重试」：让 core 把这条消息的附件上传重推一遍。 */
  function retryQueuedAttachments(entryId: string): void {
    controller.value?.retryQueuedAttachments(entryId)
  }

  /** 气泡上的「去掉附件发送」：用户明确选择按纯文字发出去。 */
  function sendQueuedWithoutAttachments(entryId: string): void {
    const items = queuedAttachments.value[entryId] ?? []
    for (const item of items) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
    const nextQueued = { ...queuedAttachments.value }
    delete nextQueued[entryId]
    queuedAttachments.value = nextQueued
    const nextMessages = { ...messageAttachments.value }
    delete nextMessages[entryId]
    messageAttachments.value = nextMessages
    controller.value?.sendQueuedWithoutAttachments(entryId)
  }

  /** 气泡上的「删除」：整条作废（附件一起）。 */
  function discardQueuedMessage(entryId: string): void {
    const items = queuedAttachments.value[entryId] ?? []
    for (const item of items) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
    const nextQueued = { ...queuedAttachments.value }
    delete nextQueued[entryId]
    queuedAttachments.value = nextQueued
    const nextMessages = { ...messageAttachments.value }
    delete nextMessages[entryId]
    messageAttachments.value = nextMessages
    controller.value?.discardQueuedMessage(entryId)
  }

  /** 某个附件（可能在输入卡、队列条目或已发送气泡里）。 */
  function findAttachment(localId: string): LocalAttachment | null {
    const inTray = attachments.value.find((item) => item.localId === localId)
    if (inTray) return inTray
    for (const items of Object.values(queuedAttachments.value)) {
      const hit = items.find((item) => item.localId === localId)
      if (hit) return hit
    }
    for (const items of Object.values(messageAttachments.value)) {
      const hit = items.find((item) => item.localId === localId)
      if (hit) return hit
    }
    return null
  }

  function removeAttachment(localId: string): void {
    const instance = controller.value
    const target = findAttachment(localId)
    if (target?.taskId) instance?.cancelUpload(target.taskId)
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
    attachments.value = attachments.value.filter((item) => item.localId !== localId)
    const nextQueued: Record<string, LocalAttachment[]> = {}
    for (const [entryId, items] of Object.entries(queuedAttachments.value)) {
      const kept = items.filter((item) => item.localId !== localId)
      if (kept.length > 0) nextQueued[entryId] = kept
    }
    queuedAttachments.value = nextQueued
    const nextMessages: Record<string, LocalAttachment[]> = {}
    for (const [key, items] of Object.entries(messageAttachments.value)) {
      const kept = items.filter((item) => item.localId !== localId)
      if (kept.length > 0) nextMessages[key] = kept
    }
    messageAttachments.value = nextMessages
    // 队列条目里的这一条附件也要摘掉（纯附件消息摘完即作废）。
    instance?.detachQueuedAttachment(localId)
  }

  function retryAttachment(localId: string): void {
    const item = findAttachment(localId)
    if (!item) return
    if (item.taskId) controller.value?.retryUpload(item.taskId)
    else startUploads()
  }

  /** 把 core 的上传进度写回本地附件（按 taskId 对齐）。 */
  function syncAttachmentProgress(): void {
    if (attachments.value.length === 0 && Object.keys(queuedAttachments.value).length === 0) return
    const byTask = new Map(uploads.value.map((task) => [task.localId, task]))
    const mapItem = (item: LocalAttachment): LocalAttachment => {
      if (!item.taskId) return item
      const task = byTask.get(item.taskId)
      if (!task) return item
      const state: LocalAttachmentState =
        task.state === 'ready'
          ? 'ready'
          : task.state === 'failed' || task.state === 'cancelled'
            ? 'failed'
            : task.state === 'uploading'
              ? 'uploading'
              : 'local'
      return {
        ...item,
        state,
        progress: task.progress,
        error: task.error,
        uploadId: task.uploadId,
      }
    }
    attachments.value = attachments.value.map(mapItem)
    if (Object.keys(queuedAttachments.value).length > 0) {
      const next: Record<string, LocalAttachment[]> = {}
      for (const [entryId, items] of Object.entries(queuedAttachments.value)) {
        next[entryId] = items.map(mapItem)
      }
      queuedAttachments.value = next
    }
  }

  function clearAttachments(): void {
    for (const item of attachments.value) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
    }
    attachments.value = []
    queuedAttachments.value = {}
    controller.value?.clearUploads()
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  function attachState(): void {
    unsubscribeState?.()
    const instance = controller.value
    if (!instance) return
    state.value = instance.getState()
    unsubscribeState = instance.subscribe((next) => {
      state.value = next
    })
  }

  function ensureController(): WorkspaceController | null {
    const target = backend.selectedBackend
    if (!target) return null
    const account = auth.accountKey
    if (controller.value && backendId.value === target.id && controllerAccountKey === account) {
      return controller.value
    }
    teardownController()
    backendId.value = target.id
    controllerAccountKey = account
    const instance = new WorkspaceController({
      nodeId: target.id,
      client: { name: 'dsh-hub-app', version: APP_VERSION },
      openChannel: (nodeId) => gateway.openChannel(nodeId),
      // 弱网/切网时一直重试（15s 退避封顶），别在 8 次后显示「连接已断开」让用户手动重开。
      reconnect: { baseMs: 1_000, maxMs: 15_000, maxAttempts: 1_000 },
      fileCache,
      // 持久文件缓存（IndexedDB）：交付物/对话内图片下载一次后，重开会话/重启 App 秒开。
      // accountKey 是缓存隔离键，accountKey 变化时 ensureController 会重建实例。
      fileStore,
      ...(account === null ? {} : { accountKey: account }),
      onSessionExpired: () => {
        void auth.forceLogout('expired')
      },
      outbox: {
        // 发送队列持久化（IndexedDB，按 accountKey + backendId 隔离；退出登录一起清）。
        store: outboxStore,
        // 建会话时带上当前的模型/思考程度 + 预设（与旧 UI 的 pump 一致）。
        createOptions: () => {
          const model = models.selectionPayload()
          return {
            ...(model
              ? {
                  provider: model.provider,
                  model: model.model,
                  ...(model.effort ? { effort: model.effort } : {}),
                }
              : {}),
            ...(models.presetId ? { preset: models.presetId } : {}),
          }
        },
        // 建会话失败只认那一次 create 的回包：预设不存在就丢掉它并提示（错误条由 core 给）。
        onCreateFailed: ({ code }) => {
          if (code === 'preset-not-found' && models.presetId !== null) {
            models.presetId = null
            ui.toast('这个对话预设不存在，已改用默认设置')
          }
        },
        attachmentState: (localId) => findAttachment(localId)?.state ?? 'missing',
        outgoingAttachment: (localId): MobileOutgoingAttachment | null => {
          const item = findAttachment(localId)
          if (!item?.taskId) return null
          return instance.outgoingAttachment(item.taskId)
        },
        startUploads: () => startUploads(),
        // 气泡上的「重试」：把这条附件的上传任务重新推起来。
        retryAttachment: (localId) => {
          const item = findAttachment(localId)
          if (!item) return
          if (item.taskId) controller.value?.retryUpload(item.taskId)
          else startUploads()
        },
      },
      log: (event, meta) => {
        // 只记事件名与计数，不记正文（M4 §5）。
        if (import.meta.env.DEV) console.debug('[channel]', event, meta ?? {})
        if (LINK_LOG_EVENTS.has(event)) recordDiag(event, summarizeLinkMeta(meta))
        // 文件缓存/下载只记事件与大小，便于真机排查「图片为什么没出来」。
        if (FILE_LOG_EVENTS.has(event)) recordDiag(event, summarizeFileMeta(meta))
        // 发送队列只记事件与计数/错误码。
        if (OUTBOX_LOG_EVENTS.has(event)) recordDiag(event, summarizeLinkMeta(meta))
      },
    })
    controller.value = instance
    attachState()
    // 后端列表还没回来时打的字：现在有 controller 了，立刻转进 Outbox（保持顺序）。
    flushDeferredSends(instance)
    return instance
  }

  function teardownController(): void {
    unsubscribeState?.()
    unsubscribeState = null
    controller.value?.dispose()
    controller.value = null
    state.value = null
    backendId.value = null
    cachedMessages.value = []
    cachedSessionsList.value = []
    historyLoaded.value = true
    lastLink = 'idle'
    controllerAccountKey = null
    fileCache.clearAll()
    clearAttachments()
    messageAttachments.value = {}
    clearSessionUsage()
    cachedSessions = null
    cachedConversation = null
    featuresRef = null
    featuresMirror = null
  }

  /** 账号退出/切换账号：断开通道并清空内存状态（磁盘缓存与队列由账号级清理器清）。 */
  function reset(): void {
    teardownController()
    deferredSends.value = []
    clearAttachments()
    // 连接计时一起清掉（退出登录不该留下「未连上 3 分钟」的记录，也不该有定时器在跑）。
    connectionPaused = false
    clearNotConnectedClock()
  }

  /** 切换后端：先显示该后端的缓存，再刷新。 */
  async function switchBackend(nextBackendId: string): Promise<void> {
    if (backendId.value === nextBackendId && controller.value) {
      void ensureConnected()
      return
    }
    teardownController()
    backendId.value = nextBackendId
    const acc = auth.accountKey
    if (acc) {
      const cached = await sessionCache.getSessions(acc, nextBackendId)
      // 期间又切走了就丢弃
      if (backendId.value === nextBackendId && cached) cachedSessionsList.value = cached.sessions
    }
    await ensureConnected()
  }

  /** 唤醒就绪 / 账号就绪后调用：连接通道并拉会话。 */
  async function ensureConnected(): Promise<void> {
    if (!auth.isAuthenticated) return
    const target = backend.selectedBackend
    if (!target || target.id !== backendId.value) return
    // **不论后端此刻能不能连**都先把 controller 建起来：发送队列的冷启动恢复
    // （上次没发出去的待发气泡）不依赖通道，唤醒期间也要能看见自己打过的字。
    const instance = ensureController()
    if (!instance) return
    if (!target.connectable) {
      // 后端不可连接：保持缓存展示，等 App 在唤醒成功后再次调用。
      return
    }
    instance.start()
  }

  /**
   * 嵌入座舱（WP56e3）：主动把通道建起来，并等一次 hello（`link=connected`）。
   *
   * 为什么不能只靠 `ensureConnected()`：它只在「后端可连接」的那一瞬间启动链路；启动失败
   * （座舱容器刚起来时 ticket 可能 409）或链路被 `pagehide` 干净断开之后，没有别的地方会
   * 再踢一脚。座舱又没有 `wake()` 可以叫醒实例（`scope=cockpit` 的令牌调 wake 会 403），
   * 所以嵌入模式由 App 在「auth 就绪 + 节点可连接」以及「回前台 / iframe 重载」时调用这里：
   * 建链 → 等 hello；期间链路 failed/closed 就退避重试（2 秒一次），直到超时。
   *
   * 普通 `/m/` 与 APK 不走这里（`isCockpitEmbed()` 恒 false），行为不变。
   *
   * @returns 是否等到了 hello（超时只记诊断，后续 connectable 变化/回前台仍会再来一次）
   */
  let cockpitChannelInflight: Promise<boolean> | null = null

  function ensureCockpitChannel(timeoutMs = 30_000): Promise<boolean> {
    // 同一时刻只跑一份：bootstrap 连续刷新 / 回前台会并发触发，别叠出好几条重试循环。
    if (cockpitChannelInflight !== null) return cockpitChannelInflight
    const task = runEnsureCockpitChannel(timeoutMs).finally(() => {
      cockpitChannelInflight = null
    })
    cockpitChannelInflight = task
    return task
  }

  async function runEnsureCockpitChannel(timeoutMs: number): Promise<boolean> {
    if (!isCockpitEmbed() || !auth.isAuthenticated) return false
    const target = backend.selectedBackend
    if (!target || !target.connectable) return false
    if (backendId.value !== target.id) await switchBackend(target.id)
    const instance = ensureController()
    if (!instance) return false
    if (link.value !== 'connected') instance.start()
    const startedAt = Date.now()
    let lastRetry = startedAt
    while (Date.now() - startedAt < timeoutMs) {
      // 账号退出/切换后端会把 controller 换掉（teardownController 已 dispose 旧实例）
      if (controller.value !== instance || !auth.isAuthenticated) return false
      if (backend.selectedBackendId !== target.id) return false
      if (link.value === 'connected') {
        recordDiag('cockpit:hello', 'connected')
        return true
      }
      if (
        (link.value === 'closed' || link.value === 'failed' || link.value === 'idle') &&
        Date.now() - lastRetry >= 2_000
      ) {
        lastRetry = Date.now()
        recordDiag('cockpit:retry', link.value)
        instance.start()
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 200))
    }
    recordDiag('cockpit:hello', 'timeout')
    return false
  }

  // ── 状态提交（每帧只做「输入引用变了才做」的昂贵工作）────────────────────
  /** 上一次落盘的会话列表（账号 / 后端 / 数组引用三者都没变就跳过写 IndexedDB）。 */
  let cachedSessions: { account: string; backend: string; rows: MobileSessionRowV2[] } | null = null
  /** 上一次落盘的对话快照（同一份消息数组不必每 500ms 再写一遍）。 */
  let cachedConversation: {
    account: string
    backend: string
    sessionId: string
    messages: ChatEntry[]
  } | null = null
  /** features 去重用：上一帧的数组引用 + 当时 models 侧的数组。 */
  let featuresRef: string[] | null = null
  let featuresMirror: string[] | null = null

  function onStateCommit(next: WorkspaceState): void {
    if (lastLink !== next.link) {
      lastLink = next.link
      recordDiag(`link:${next.link}`)
    }

    // v2 协商与模型目录交给 models store（弹层/芯片的数据源）。
    // 引用没变的帧（流式 delta）不必每帧拼接两份逗号串再比。
    if (next.features !== featuresRef || models.features !== featuresMirror) {
      featuresRef = next.features
      if (next.features.join(',') !== models.features.join(',')) {
        models.applyFeatures([...next.features])
      }
      featuresMirror = models.features
    }
    if (next.models) {
      const incoming = next.models
      if (!models.serverCatalog || models.serverCatalog !== incoming) {
        void models.applyServerModels(incoming)
      }
    }

    // 附件上传进度回灌到本地附件列表
    syncAttachmentProgress()

    // 消息已经发出去（离开 outbox）的条目：附件从「待发」表里去掉（气泡缩略图仍在）。
    if (Object.keys(queuedAttachments.value).length > 0) {
      const alive = new Set(next.outbox.map((entry) => entry.id))
      const nextQueued: Record<string, LocalAttachment[]> = {}
      let changed = false
      for (const [entryId, items] of Object.entries(queuedAttachments.value)) {
        if (alive.has(entryId)) nextQueued[entryId] = items
        else changed = true
      }
      if (changed) queuedAttachments.value = nextQueued
    }

    // 首次 history 到达（或确认是空会话）后不再显示缓存。
    // 可重试错误（切后台回来 mux 抖一下）时**继续显示缓存**，别让会话突然变空；
    // 错误条上的「重试」会重新拉首页。
    if (next.messages.length > 0) historyLoaded.value = true
    else if (wasHistoryLoading && !next.historyLoading && !(next.error && next.error.retryable)) {
      historyLoaded.value = true
    }
    wasHistoryLoading = next.historyLoading

    // 流式期间延后代码高亮（Shiki 首次 tokenize 是 100ms 级任务，见 lib/highlight.ts）。
    if (isStreaming.value) {
      if (highlightTimer) {
        clearTimeout(highlightTimer)
        highlightTimer = null
      }
      setHighlightDeferred(true)
    } else if (!next.turnRunning && !highlightTimer) {
      highlightTimer = setTimeout(() => {
        highlightTimer = null
        if (!isStreaming.value) setHighlightDeferred(false)
      }, 400)
      ;(highlightTimer as unknown as { unref?: () => void }).unref?.()
    }

    // 用量：core 收尾（loading=false）时清掉本地兜底定时器/超时标记。
    if (!next.sessionUsageLoading) {
      clearUsageTimer()
      usageTimedOut.value = false
    }

    // 会话列表与对话缓存：列表数组没换引用就不落盘（流式 delta 帧一次都不写 IndexedDB）
    const acc = auth.accountKey
    if (acc && backendId.value) {
      if (next.sessions.length > 0) {
        const cached = cachedSessions
        if (
          cached === null ||
          cached.account !== acc ||
          cached.backend !== backendId.value ||
          cached.rows !== next.sessions
        ) {
          cachedSessions = { account: acc, backend: backendId.value, rows: next.sessions }
          void sessionCache.putSessions(acc, backendId.value, next.sessions)
        }
      }
      scheduleConversationCache(acc, backendId.value)
    }
  }

  function scheduleConversationCache(acc: string, backend: string): void {
    const sessionId = activeId.value
    if (!sessionId || liveMessages.value.length === 0) return
    // 同一份消息数组已经落过盘：不必每 500ms 再写一遍完全相同的快照。
    const cached = cachedConversation
    if (
      cached !== null &&
      cached.account === acc &&
      cached.backend === backend &&
      cached.sessionId === sessionId &&
      cached.messages === liveMessages.value
    ) {
      return
    }
    if (cacheTimer) return
    cacheTimer = setTimeout(() => {
      cacheTimer = null
      const current = activeId.value
      if (!current || backendId.value !== backend) return
      const messages = liveMessages.value
      if (messages.length === 0) return
      cachedConversation = { account: acc, backend, sessionId: current, messages }
      void sessionCache.putConversation(acc, backend, current, messages)
    }, 500)
  }

  watch(
    () => state.value,
    (next) => {
      if (!next) return
      onStateCommit(next)
    },
  )

  // ── 会话 ────────────────────────────────────────────────────────────────

  async function openSession(sessionId: string): Promise<void> {
    const instance = ensureController()
    if (!instance) return
    if (activeId.value === sessionId) return
    // 换会话：文件失败冷却/路径图片 URL 由 stores/files.ts 的 watch(activeId) 作废。
    historyLoaded.value = false
    cachedMessages.value = []
    // 先打开（同步发出 history/subscribe），再把缓存填进展示层：
    // 缓存只用于「history 到达之前」的第一屏，绝不覆盖服务端结果。
    instance.openSession(sessionId)
    // 记下「上次打开的会话」：冷启动时据此回到这轮对话（0.2.9）
    void saveLastSession(prefs, { sessionId, backendId: backendId.value, at: Date.now() })
    const acc = auth.accountKey
    if (acc && backendId.value) {
      const cached = await sessionCache.getConversation(acc, backendId.value, sessionId)
      if (activeId.value === sessionId && cached) cachedMessages.value = cached.messages
    }
  }

  function newSession(): void {
    void clearLastSession(prefs)
    controller.value?.closeSession()
    cachedMessages.value = []
    historyLoaded.value = true
    clearSessionUsage()
  }

  function refreshSessions(): void {
    controller.value?.refreshSessions(showArchived.value)
  }

  /** 「全部会话 → 已归档」筛选：服务端默认过滤已归档，切到已归档时用 includeArchived 重拉。 */
  function setShowArchived(next: boolean): void {
    showArchived.value = next
    controller.value?.setIncludeArchived(next)
  }

  /**
   * 弹层里改了模型/档位：立刻作用到当前会话（只对下一次请求生效）。
   *
   * 失败要让用户知道并**回滚**（§1.4：选择后立即生效；不能停在一个服务端不认的值上）。
   * 调用方（ModelSheet）先调 `rememberSelectionBeforeChange()`，这里成功后清掉快照。
   */
  async function pushModelSelection(): Promise<void> {
    const before = previousSelection
    previousSelection = null
    if (!models.features.includes('models')) return
    const payload = models.selectionPayload()
    if (!payload) return
    const instance = controller.value
    if (!instance) return
    if (!instance.getState().openSessionId) return
    await new Promise<void>((resolve) => {
      instance.setModel(payload, {
        onResult: (outcome: ActionOutcome) => {
          if (!outcome.ok) {
            if (before) void models.restoreSelection(before)
            ui.toast(outcome.message ?? '切换失败，已恢复原来的模型')
          }
          resolve()
        },
      })
    })
  }

  /** 弹层点选时先记住「改之前」的选择，供失败回滚。 */
  let previousSelection: ModelSelection | null = null
  function rememberSelectionBeforeChange(): void {
    previousSelection = models.selection ? { ...models.selection } : null
  }

  /** 重命名：失败要提示（服务端可能拒绝非法标题）。 */
  async function renameSession(sessionId: string, nextTitle: string): Promise<boolean> {
    const instance = controller.value
    if (!instance) return false
    const trimmed = nextTitle.trim()
    if (!trimmed) return false
    const outcome = await instance.renameSession(sessionId, trimmed)
    if (!outcome.ok) {
      ui.toast(outcome.message ?? '重命名失败')
      return false
    }
    ui.toast('已重命名')
    return true
  }

  /** 归档 / 取消归档（DSH 没有删除接口，UI 也不提供删除）。 */
  async function archiveSession(sessionId: string, archived: boolean): Promise<boolean> {
    const instance = controller.value
    if (!instance) return false
    const outcome = await instance.archiveSession(sessionId, archived)
    if (!outcome.ok) {
      ui.toast(outcome.message ?? '归档失败')
      return false
    }
    ui.toast(archived ? '已归档' : '已取消归档')
    if (archived) {
      // 归档后这个会话再也发不出去：属于它的草稿一并作废（否则永远卡在队列里）。
      instance.discardQueuedForSession(sessionId)
      if (activeId.value === sessionId) newSession()
    }
    return true
  }

  // ── 发送 / 停止 ─────────────────────────────────────────────────────────

  /**
   * 发送（= 入队，见 core 的 `Outbox`）。
   *
   * 有附件时：附件与这条消息绑定（Outbox 等它 `ready` 才真正发 `send`，进度显示在附件卡上）。
   * @returns 当前会话 id（有的话）；null 表示还没有会话（首页应跳到 /c/new 等待创建）。
   */
  function send(text: string): string | null {
    const trimmed = text.trim()
    const pending = attachments.value
    if (!trimmed && pending.length === 0) return activeId.value
    const attachmentIds = pending.map((item) => item.localId)
    const instance = ensureController()
    if (instance) {
      const entryId = instance.enqueueSend(trimmed, { attachmentIds })
      if (pending.length > 0) {
        queuedAttachments.value = { ...queuedAttachments.value, [entryId]: pending }
        // 气泡缩略图按 clientMessageId 挂：发送中→已发送都不会丢图。
        messageAttachments.value = { ...messageAttachments.value, [entryId]: pending }
      }
      attachments.value = []
      // 附件若还没开始传，这里立刻推起来（Outbox 在就绪判定时也会再踢一脚）。
      startUploads()
      return activeId.value
    }
    // 后端列表还没回来（controller 还没建）：本地暂存，建好后立刻转进 Outbox。
    const deferred: DeferredSend = {
      id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text: trimmed,
      at: Date.now(),
      attachmentIds,
    }
    deferredSends.value = [...deferredSends.value, deferred]
    if (pending.length > 0) {
      messageAttachments.value = { ...messageAttachments.value, [deferred.id]: pending }
    }
    attachments.value = []
    return activeId.value
  }

  /** 建好 controller 后把暂存的消息转进 Outbox（保持顺序；附件映射跟着换 key）。 */
  function flushDeferredSends(instance: WorkspaceController): void {
    if (deferredSends.value.length === 0) return
    const nextMessages = { ...messageAttachments.value }
    const nextQueued = { ...queuedAttachments.value }
    for (const deferred of deferredSends.value) {
      const entryId = instance.enqueueSend(deferred.text, { attachmentIds: deferred.attachmentIds })
      const local = nextMessages[deferred.id]
      if (local) {
        nextMessages[entryId] = local
        delete nextMessages[deferred.id]
        nextQueued[entryId] = local
      }
    }
    deferredSends.value = []
    messageAttachments.value = nextMessages
    queuedAttachments.value = nextQueued
  }

  function stop(): void {
    controller.value?.stopTurn()
  }

  /** 手机端直接处理审批（v2 通道能力 approvals=true 时可用）。 */
  function answerApproval(sessionId: string, approvalId: string, approve: boolean): void {
    controller.value?.answerApproval(approvalId, sessionId, approve)
  }

  function retryUnknown(localId: string): void {
    controller.value?.retryUnknown(localId)
  }

  function answerQuestion(
    prompt: QuestionPrompt,
    answers: Array<{ id: string; selected: string[]; custom?: string }>,
  ): void {
    controller.value?.answerQuestion(prompt, answers)
  }

  function clearError(): void {
    controller.value?.clearError()
  }

  /**
   * 回到前台：会话列表刷一次，并**主动探活**。
   *
   * 手机切后台/换网后 WS 可能半边开：浏览器拿不到 close，界面还显示已连接，
   * 但发出去的帧全进黑洞（改模型/归档会「请求超时」）。探活 3 秒内没任何下行就主动
   * 断开重连；界面只在状态条上显示「正在重连」，不弹大错误条。
   *
   * 连接计时从**回到前台的这一刻**重新开始（0.4.1 §1）：锁屏一晚上回来不该立刻弹警示。
   */
  function onForeground(): void {
    resumeConnectionClock()
    if (link.value === 'connected') {
      refreshSessions()
      controller.value?.probeLink(3_000)
    } else void ensureConnected()
  }

  /** 切到后台：干净断开（避免 Hub 45s 空闲关闭后再回来撞上「半边开」的通道）。 */
  function pauseConnection(): void {
    pauseConnectionClock()
    controller.value?.disconnect()
  }

  /**
   * 页面切到后台（网页端 `document.hidden`；Android 走 `pauseConnection`）：
   * **只暂停连接计时**，不断开通道。
   */
  function onHidden(): void {
    pauseConnectionClock()
  }

  /** 暂停连接计时：切后台期间不计时（回前台重新开始算）。 */
  function pauseConnectionClock(): void {
    connectionPaused = true
    clearNotConnectedClock()
  }

  /** 回前台：没连上的话从现在开始计（已连上则保持清零）。 */
  function resumeConnectionClock(): void {
    connectionPaused = false
    if (!auth.isAuthenticated) return
    if (link.value === 'connected') {
      clearNotConnectedClock()
      return
    }
    startNotConnectedClock()
  }

  function retryConnection(): void {
    const instance = controller.value
    if (!instance) {
      void ensureConnected()
      return
    }
    instance.retryConnection()
  }

  /**
   * 错误条的「重试」：通道还连着、只是当前会话没加载出来时，重新拉首页/重订阅。
   * （链路断了才走 `retryConnection()` 重建通道。）
   */
  function retryOpenSession(): void {
    controller.value?.retryOpenSession()
  }

  function loadOlder(): void {
    controller.value?.loadOlder()
  }

  /**
   * 连接诊断（只本地、只事件名）：启动/登录/链路事件写入持久化环形缓冲，
   * 会话信息面板里展开看。真机出现「用着用着不可用 / 又要登录」时能跨重启排查。
   */
  function recordAppState(active: boolean): void {
    recordDiag(active ? 'app-foreground' : 'app-background')
    // 连接计时跟着前后台走（0.4.1 §1）：切后台暂停，回前台从那一刻重新算。
    if (active) resumeConnectionClock()
    else pauseConnectionClock()
  }

  // ── 附件缩略图 ──────────────────────────────────────────────────────────

  /**
   * 某个消息气泡上的附件缩略图。
   *
   * core 的 pending 气泡 `localId` 就是 clientMessageId，canonical 消息也带同一个 id，
   * 所以发送中→已发送的切换不会丢图，也不需要按文本猜测配对。
   */
  function localAttachmentFor(entry: ChatEntry): LocalAttachment[] {
    if (entry.clientMessageId) return messageAttachments.value[entry.clientMessageId] ?? []
    if (entry.localId) return messageAttachments.value[entry.localId] ?? []
    return []
  }

  /**
   * 顶部连接横幅（0.4.1 §2）：**所有判断都在 lib/connection-banner.ts 里**（纯函数、可单测），
   * 这里只负责喂输入与维护计时：
   *   1) 只有真的连不上才显示 —— 未连上不足 4 秒一律安静（锁屏回来不再闪一下）；
   *   2) 4–15 秒中性提示，≥15 秒 / link failed / 明确原因才警示 + 重试；
   *   3) 连上立刻隐藏，计时清零；
   *   4) 切后台暂停计时，回前台从那一刻重新算。
   */
  const connectionBanner = computed<ConnectionBanner>(() => {
    const selected = backend.selectedBackend
    const reason = auth.issue ? { text: auth.issue.message, retryable: auth.issue.retryable } : null
    return buildConnectionBanner({
      link: link.value,
      wakeState: backend.wakeState,
      instanceStatus: backend.instance?.status ?? null,
      connectable: selected ? selected.connectable : null,
      capacityFull: backend.instance?.capacityFull === true,
      reason,
      notConnectedSince: notConnectedSince.value,
      now: connectionNow.value,
      queued: queuedEntries.value.length,
      graceMs: CONNECTION_GRACE_MS,
    })
  })

  /** 供状态条使用：横幅文案（空字符串 = 一切就绪，视图不挂载状态条）。 */
  const statusText = computed(() => (connectionBanner.value.show ? connectionBanner.value.text : ''))
  /** 状态条语气（info 中性 / warn 警示 / error 不可重试的明确原因）。 */
  const statusTone = computed<BannerTone>(() =>
    connectionBanner.value.show ? connectionBanner.value.tone : 'info',
  )
  /** 状态条按钮：'重连' / '重试'（空 = 没有可执行动作）。 */
  const statusAction = computed(() => connectionBanner.value.action ?? '')

  /**
   * 旧渲染用的状态（0.4.1 起仍由同一个横幅驱动，保留给兼容读法）：
   * 中性 → waking（accent 色），警示/失败 → busy（琥珀/危险色）。
   */
  const statusState = computed<'waking' | 'ready' | 'busy'>(() => {
    if (!connectionBanner.value.show) return 'ready'
    return connectionBanner.value.tone === 'info' ? 'waking' : 'busy'
  })

  /**
   * 错误条实际显示的错误（0.4.1 §2）：
   *  - `reconnecting` 本来就不显示（连接层自己会重连）；
   *  - 与连接相关的瞬态错误（建链失败/网络）**整类交给顶部横幅**：
   *    宽限期内不显示，超过 15 秒 / link failed 时由横幅统一说「暂时连不上服务器 + 重试」。
   *    否则锁屏回来会先闪一条「服务暂时不可用，请稍后重试」的红条，等横幅出来又叠成两条；
   *  - 其它错误（会话不存在、附件问题、通道级业务错误等）照常立即显示。
   */
  const visibleWorkspaceError = computed<UiError | null>(() => {
    const error = workspaceError.value
    if (!error) return null
    if (CONNECTION_ERROR_CODES.has(error.code)) return null
    return error
  })

  /**
   * 队列里的这条消息为什么还没发出去（0.4.1 §3）。
   *
   * 只在「因为没连上所以还排队」时返回状态：`connecting` → 气泡下显示
   * 「与服务器连接中…」+ 小转圈；`timeout`（这条自己排队 ≥15 秒）→
   * 「暂时连不上服务器，连上后自动发送 · 重试」。附件问题有自己的文案（`queuedProblemOf`），
   * 连上之后返回 null，交给原来的「发送中…」。
   */
  function queuedLinkStateOf(localId: string | null): QueuedLinkState | null {
    if (!localId) return null
    if (queuedProblemOf(localId)) return null
    const entry = outbox.value.find((item) => item.id === localId) ?? null
    const deferred = deferredSends.value.find((item) => item.id === localId) ?? null
    if (!entry && !deferred) return null
    return resolveQueuedLinkState({
      queued: true,
      connected: link.value === 'connected' && nodeConnectable.value,
      queuedAt: entry?.at ?? deferred?.at ?? connectionNow.value,
      now: connectionNow.value,
    })
  }

  /** 诊断：横幅显示/隐藏（只事件名 + 语气 + 等了多久，不记正文）。 */
  watch(
    () => (connectionBanner.value.show ? `${connectionBanner.value.tone}` : ''),
    (tone, previous) => {
      if (!tone) {
        if (previous) recordDiag('conn-banner:hide')
        return
      }
      const since = notConnectedSince.value
      const waited = since === null ? 0 : Math.max(0, connectionNow.value - since)
      recordDiag('conn-banner:show', `tone=${tone} waited=${waited}ms`)
    },
  )

  /**
   * 连接计时跟着 link 与登录态走（0.4.1 §1）：
   *  - 登录后开始计；
   *  - link 回到 connected 立刻清零（横幅同时消失）；
   *  - 切后台（connectionPaused）不动计时 —— guard 保证后台里 link 变成 closed 也不会重新开始计。
   */
  watch(
    [() => auth.isAuthenticated, link],
    ([authenticated, nextLink]) => {
      if (!authenticated || nextLink === 'connected') {
        clearNotConnectedClock()
        return
      }
      if (connectionPaused) return
      startNotConnectedClock()
    },
    { immediate: true },
  )

  return {
    // 状态（controller 投影）
    state,
    controller,
    backendId,
    link,
    capabilities,
    nodeConnectable,
    sessions,
    sessionsLoading,
    activeId,
    displayMessages,
    threadItems,
    activeSession,
    title,
    streamingText,
    streamingReasoning,
    reasoningDone,
    isStreaming,
    turnRunning,
    stopRequested,
    pendingSendCount,
    historyHasMore,
    historyLoading,
    workspaceError,
    /** 诊断面板用（「重连中（第 N 次）」）：顶部横幅不再显示重连次数。 */
    reconnectAttempt,
    questions,
    approvals,
    features,
    toolCards,
    deliverables,
    uploads,
    outbox,
    // 会话信息面板：用量（可写覆盖：协议层/调试可直接赋值）
    sessionUsage,
    sessionUsageLoading,
    sessionUsageError,
    // 本地状态
    attachments,
    readyToSend,
    canSend,
    statusText,
    statusState,
    // 连接横幅（0.4.1）：连接计时 + 宽限期 + 队列消息的连接状态
    connectionBanner,
    statusTone,
    statusAction,
    visibleWorkspaceError,
    notConnectedSince,
    queuedLinkStateOf,
    // 动作
    reset,
    switchBackend,
    ensureConnected,
    ensureCockpitChannel,
    openSession,
    newSession,
    refreshSessions,
    setShowArchived,
    showArchived,
    pushModelSelection,
    rememberSelectionBeforeChange,
    renameSession,
    archiveSession,
    // 用量（会话信息面板）
    loadSessionUsage,
    clearSessionUsage,
    applySessionUsage,
    retryConnection,
    retryOpenSession,
    loadOlder,
    send,
    stop,
    retryUnknown,
    answerQuestion,
    answerApproval,
    clearError,
    onForeground,
    pauseConnection,
    onHidden,
    recordAppState,
    // 待发气泡的附件问题与三个动作
    queuedProblemOf,
    retryQueuedAttachments,
    sendQueuedWithoutAttachments,
    discardQueuedMessage,
    // 待回答角标
    pendingAnswerSessions,
    pendingAnswerCount,
    firstPendingAnswerSession,
    // 附件
    addAttachment,
    removeAttachment,
    retryAttachment,
    clearAttachments,
    attachmentLimit,
    localAttachmentFor,
  }
})
