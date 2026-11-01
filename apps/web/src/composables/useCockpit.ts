import { computed, onScopeDispose, ref, type ComputedRef, type Ref } from 'vue'

import {
  closeCanvasItem,
  cockpitEventsUrl,
  createHandoff,
  fetchBoard,
  fetchCockpitState,
  fetchStatusStrip,
  listCanvas,
  listProposals,
  patchCanvasItem,
  restartOpsInstance,
  startOpsInstance,
  type CanvasItem,
  type CapabilityDescriptor,
  type CockpitEvent,
  type CockpitStatusStrip,
  type ProposalView,
  type SecretRequestView,
} from '@/api/admin-cockpit'
import { describeError, type ErrorDescription } from '@/api/errors'
import { useSse, type SseStatus } from '@/composables/useSse'
import {
  applyCockpitEvent,
  dropTargetOf,
  emptyCockpitLive,
  normalizeCockpitEvent,
  type CockpitLive,
} from '@/utils/cockpit'

/** 两次要交接码之间的最小间隔（第一次不等） */
const HANDOFF_MIN_INTERVAL_MS = 3000

/**
 * 座舱页的数据与实时通道（docs/24 §2）：
 *
 * - 打开时拉一次 `/state`（状态 + 待处理方案数 + 能力目录），再拉态势板与方案；
 * - `/events` SSE 推进来的东西就地归约（`utils/cockpit.ts` 的 `applyCockpitEvent`），不整页重拉；
 * - 切换会话时按会话拉画布；没选会话 = 态势板。
 */
export interface UseCockpitReturn {
  live: Ref<CockpitLive>
  catalog: Ref<CapabilityDescriptor[]>
  sessionId: Ref<string | null>
  items: ComputedRef<CanvasItem[]>
  proposals: ComputedRef<ProposalView[]>
  secrets: ComputedRef<SecretRequestView[]>
  status: ComputedRef<CockpitLive['status']>
  strip: ComputedRef<CockpitStatusStrip | null>
  pendingCount: ComputedRef<number>
  loading: Ref<boolean>
  error: Ref<ErrorDescription | null>
  unseen: Ref<number>
  sseStatus: Ref<SseStatus>
  load: () => Promise<void>
  selectSession: (id: string | null) => Promise<void>
  refreshBoard: () => Promise<void>
  refreshStrip: () => Promise<void>
  requestHandoff: () => Promise<string | null>
  /** 重启座舱容器；返回失败描述（成功为 null），重启走与启动同一套加载阶段 */
  restart: () => Promise<ErrorDescription | null>
  /**
   * 显式启动座舱容器（概览里的 AI 助手「启动」按钮），之后轮询到 running。
   * 返回失败描述（成功为 null）：WP58 的加载卡要拿它判 `failed` 并显示原因。
   */
  start: () => Promise<ErrorDescription | null>
  togglePin: (item: CanvasItem) => Promise<void>
  closeCard: (item: CanvasItem) => Promise<void>
  /** 拖动换舷 / 舷内排序（docs/24 §1） */
  moveCard: (payload: { id: string; placement: 'left' | 'right'; beforeId?: string }) => Promise<void>
  applyProposal: (proposal: ProposalView) => void
  applySecret: (request: SecretRequestView) => void
  resetUnseen: () => void
  focusProposal: (id: number) => CanvasItem | null
  /** 这张卡是不是整批拉下来的（首屏 / 切会话）：是 → 不算「投放」，不做入场动效、不开回合 */
  isBaseline: (id: string) => boolean
}

export interface UseCockpitOptions {
  /**
   * 打开时是否顺手拉起座舱容器（缺省 true = 舰桥 `/admin` 的老行为）。
   * WP57 概览里的 AI 助手传 false：只读状态，由管理员点「启动」。
   */
  autoStart?: boolean
  /** 要不要拉态势板（概览自己就是态势，AI 助手不需要；缺省 true） */
  board?: boolean
}

export function useCockpit(options: UseCockpitOptions = {}): UseCockpitReturn {
  const autoStart = options.autoStart ?? true
  const withBoard = options.board ?? true
  const live = ref<CockpitLive>(emptyCockpitLive())
  const catalog = ref<CapabilityDescriptor[]>([])
  const sessionId = ref<string | null>(null)
  const loading = ref(false)
  const error = ref<ErrorDescription | null>(null)
  const unseen = ref(0)
  /** 整批加载（board / 会话画布 / 方案列表）带来的卡 id；SSE 新到的卡不在这里 */
  const baselineIds = new Set<string>()
  function markBaseline(rows: CanvasItem[]): void {
    for (const row of rows) baselineIds.add(row.id)
  }

  const items = computed<CanvasItem[]>(() => {
    const id = sessionId.value
    return id === null ? live.value.board : (live.value.canvas[id] ?? [])
  })

  const proposals = computed(() => live.value.proposals)
  const secrets = computed(() => live.value.secrets)
  const status = computed(() => live.value.status)
  const strip = computed(() => live.value.strip)
  const pendingCount = computed(() => live.value.proposals.filter((item) => item.status === 'pending').length)

  function handleEvent(event: CockpitEvent): void {
    const before = items.value.length
    live.value = applyCockpitEvent(live.value, event)
    if (event.type === 'canvas.upsert' && items.value.length !== before) unseen.value += 1
  }

  const sse = useSse(cockpitEventsUrl(), {
    events: {
      // 服务端用 `event: <名字>`；也兼容 `event: message` 里带 type 的写法
      message: (payload) => {
        const event = normalizeCockpitEvent('message', payload)
        if (event) handleEvent(event)
      },
      'canvas.upsert': (payload) => {
        const event = normalizeCockpitEvent('canvas.upsert', payload)
        if (event) handleEvent(event)
      },
      'canvas.remove': (payload) => {
        const event = normalizeCockpitEvent('canvas.remove', payload)
        if (event) handleEvent(event)
      },
      'proposal.upsert': (payload) => {
        const event = normalizeCockpitEvent('proposal.upsert', payload)
        if (event) handleEvent(event)
      },
      'secret.request': (payload) => {
        const event = normalizeCockpitEvent('secret.request', payload)
        if (event) handleEvent(event)
      },
      'ops.status': (payload) => {
        const event = normalizeCockpitEvent('ops.status', payload)
        if (event) handleEvent(event)
      },
      'strip.update': (payload) => {
        const event = normalizeCockpitEvent('strip.update', payload)
        if (event) handleEvent(event)
      },
    },
    onError: () => {
      // 断线由 useSse 自己重连；画布保留最后一次数据（I6：模型/通道挂了管理台不能瘫）
    },
  })

  async function refreshBoard(): Promise<void> {
    const board = await fetchBoard()
    markBaseline(board.items)
    live.value = {
      ...live.value,
      board: board.items,
    }
  }

  async function refreshStrip(): Promise<void> {
    const next = await fetchStatusStrip()
    live.value = { ...live.value, strip: next }
  }

  async function refreshProposals(): Promise<void> {
    const result = await listProposals()
    for (const row of result.items) baselineIds.add(`synthetic-proposal-${String(row.id)}`)
    live.value = { ...live.value, proposals: result.items }
  }

  async function loadCanvas(id: string): Promise<void> {
    const result = await listCanvas(id)
    markBaseline(result.items)
    live.value = { ...live.value, canvas: { ...live.value.canvas, [id]: result.items } }
  }

  /**
   * 座舱还没起来时**轮询** `/state`，直到 running。
   *
   * 为什么需要（WP56e2 端到端抓到的真问题）：`GET /state` 会在后台调
   * `ensureStarted()` 把座舱容器拉起来，但 Hub **不会**为这次「自动拉起」推
   * `ops.status`（只在自己点「重启座舱」/改设置时推）。没有这个轮询，胶囊会一直停在
   * 「已停止」，而验收 1 要求它从「启动中」变「运行中」（docs/24 §8 第 1 条）。
   * 只在非 running 时轮询（3 秒一次、最多 5 分钟），running 之后完全交给 SSE。
   */
  let statusPoll: ReturnType<typeof setInterval> | null = null
  const STATUS_POLL_MS = 3_000
  const STATUS_POLL_MAX_MS = 5 * 60_000

  function stopStatusPoll(): void {
    if (statusPoll !== null) {
      clearInterval(statusPoll)
      statusPoll = null
    }
  }

  function startStatusPoll(): void {
    stopStatusPoll()
    const startedAt = Date.now()
    statusPoll = setInterval(() => {
      if (Date.now() - startedAt > STATUS_POLL_MAX_MS) {
        stopStatusPoll()
        return
      }
      void fetchCockpitState({ autoStart })
        .then((state) => {
          live.value = { ...live.value, status: state.status, strip: state.strip ?? live.value.strip }
          if (state.status.instance === 'running' || state.status.instance === 'error') stopStatusPoll()
        })
        .catch(() => {
          // 拉不到就等下一次；断网/重启中的报错不值得刷屏
        })
    }, STATUS_POLL_MS)
  }

  onScopeDispose(stopStatusPoll)

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const state = await fetchCockpitState({ autoStart })
      catalog.value = state.catalog
      // `strip` 是 WP56a 追加的：老后端没有就再单独拉一次状态条接口
      live.value = { ...live.value, status: state.status, strip: state.strip ?? live.value.strip }
      // 不自动拉起时，只有「启动中」才值得轮询（已停止就等管理员点「启动」）
      const shouldPoll = autoStart || state.status.instance === 'starting'
      if (state.status.instance === 'running' || !shouldPoll) stopStatusPoll()
      else startStatusPoll()
      if (!state.strip) await refreshStrip()
      await Promise.all([withBoard ? refreshBoard() : Promise.resolve(), refreshProposals()])
      if (sessionId.value) await loadCanvas(sessionId.value)
    } catch (cause) {
      error.value = describeError(cause)
    } finally {
      loading.value = false
    }
  }

  async function selectSession(id: string | null): Promise<void> {
    sessionId.value = id
    unseen.value = 0
    if (id === null) {
      await refreshBoard()
      return
    }
    try {
      await loadCanvas(id)
    } catch (cause) {
      error.value = describeError(cause)
    }
  }

  /**
   * 要一个新的交接码。并发的请求合并成一个；两次之间至少隔 HANDOFF_MIN_INTERVAL_MS ——
   * 嵌入页反复喊「登录过期」时不至于把 Hub 打成每秒几十次（WP57d 的交接风暴）。
   */
  let handoffInflight: Promise<string | null> | null = null
  let lastHandoffAt = 0

  function requestHandoff(): Promise<string | null> {
    handoffInflight ??= (async () => {
      const wait = lastHandoffAt + HANDOFF_MIN_INTERVAL_MS - Date.now()
      if (lastHandoffAt > 0 && wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      lastHandoffAt = Date.now()
      try {
        const result = await createHandoff()
        return result.code
      } catch (cause) {
        error.value = describeError(cause)
        return null
      }
    })().finally(() => {
      handoffInflight = null
    })
    return handoffInflight
  }

  async function start(): Promise<ErrorDescription | null> {
    try {
      const result = await startOpsInstance()
      live.value = { ...live.value, status: result.status }
      if (result.status.instance !== 'running') startStatusPoll()
      return null
    } catch (cause) {
      error.value = describeError(cause)
      return error.value
    }
  }

  async function restart(): Promise<ErrorDescription | null> {
    try {
      const result = await restartOpsInstance()
      live.value = { ...live.value, status: result.status }
      if (result.status.instance !== 'running') startStatusPoll()
      return null
    } catch (cause) {
      error.value = describeError(cause)
      return error.value
    }
  }

  /** 钉住 / 取消钉住：先本地改（即时反馈），SSE 回来的同一张卡会覆盖成服务端结果。 */
  async function togglePin(item: CanvasItem): Promise<void> {
    const next = { ...item, pinned: !item.pinned, updatedAt: new Date().toISOString() }
    live.value = applyCockpitEvent(live.value, { type: 'canvas.upsert', item: next })
    try {
      const saved = await patchCanvasItem(item.id, { pinned: next.pinned })
      live.value = applyCockpitEvent(live.value, { type: 'canvas.upsert', item: saved })
    } catch (cause) {
      error.value = describeError(cause)
      // 失败回滚
      live.value = applyCockpitEvent(live.value, { type: 'canvas.upsert', item })
    }
  }

  async function closeCard(item: CanvasItem): Promise<void> {
    const snapshot = live.value
    live.value = applyCockpitEvent(live.value, {
      type: 'canvas.remove',
      id: item.id,
      sessionId: item.sessionId,
    })
    try {
      await closeCanvasItem(item.id)
    } catch (cause) {
      error.value = describeError(cause)
      live.value = snapshot
    }
  }

  /** 拖动落点：先本地改（即时），再 PATCH `placement` + `order`；失败回滚 */
  async function moveCard(payload: {
    id: string
    placement: 'left' | 'right'
    beforeId?: string
  }): Promise<void> {
    const item = items.value.find((row) => row.id === payload.id)
    if (!item) return

    const target = dropTargetOf(items.value, payload.id, payload.placement, payload.beforeId)
    const optimistic: CanvasItem = {
      ...item,
      placement: target.placement,
      order: target.order,
      updatedAt: new Date().toISOString(),
    }
    live.value = applyCockpitEvent(live.value, { type: 'canvas.upsert', item: optimistic })

    try {
      const saved = await patchCanvasItem(item.id, {
        placement: target.placement,
        order: target.order,
      })
      live.value = applyCockpitEvent(live.value, { type: 'canvas.upsert', item: saved })
    } catch (cause) {
      error.value = describeError(cause)
      live.value = applyCockpitEvent(live.value, { type: 'canvas.upsert', item })
    }
  }

  function applyProposal(proposal: ProposalView): void {
    live.value = applyCockpitEvent(live.value, { type: 'proposal.upsert', proposal })
  }

  function applySecret(request: SecretRequestView): void {
    live.value = applyCockpitEvent(live.value, { type: 'secret.request', request })
  }

  function resetUnseen(): void {
    unseen.value = 0
  }

  function focusProposal(id: number): CanvasItem | null {
    return items.value.find((item) => item.spec.kind === 'proposal' && item.spec.proposalId === id) ?? null
  }

  function isBaseline(id: string): boolean {
    return baselineIds.has(id)
  }

  return {
    live,
    catalog,
    sessionId,
    items,
    proposals,
    secrets,
    status,
    strip,
    pendingCount,
    loading,
    error,
    unseen,
    sseStatus: sse.status,
    load,
    selectSession,
    refreshBoard,
    refreshStrip,
    requestHandoff,
    restart,
    start,
    togglePin,
    closeCard,
    moveCard,
    applyProposal,
    applySecret,
    resetUnseen,
    focusProposal,
    isBaseline,
  }
}
