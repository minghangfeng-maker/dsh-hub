<script setup lang="ts">
/**
 * 对话页。
 *
 * 吸底状态机沿用 S0 真机反馈后的版本（不要回退）：
 *   1. 用户意图优先：touchstart / pointerdown / wheel 立刻 pinned=false；
 *   2. userInteracting 期间（含惯性，松手后 150ms 无 scroll 才算结束）一律不 scrollTo；
 *   3. 程序滚动带标记窗口，不会反过来改 pinned；
 *   4. 惯性结束后若已回到距底 24px 以内，自动恢复吸底；
 *   5. 手指在屏幕上时把「渲染用的文本」冻在当前长度，避免内容高度每帧变化打断惯性。
 *
 * 0.4.8 在它**上面**加了一个「发送锚定」模式（上面 5 条一条没动）：
 *   1. 用户发出新问题时，把这条用户消息平滑滚到对话区顶部（间距 = `RAIL_JUMP_OFFSET`，
 *      与问题导航条跳转同一个常量），下面用留白（`.thread-spacer`）补足一屏，
 *      像开始了一个新会话；
 *   2. 留白高度 = `max(0, clientHeight − 锚点顶部到内容末尾的高度 − RAIL_JUMP_OFFSET)`
 *      （纯函数在 `lib/send-anchor.ts`）：只补足到「恰好能把锚点放到顶部」，回复长高时
 *      同步缩小、缩到 0 之后就只剩正常内容；`scrollHeight − clientHeight` 恰好等于锚点位置，
 *      所以除了「锚点已经在顶部、还能往下滚到留白末尾」之外不会多出空白；
 *   3. 锚定期间 `pinned=false`：流式回复再长也不跟随；定位靠 `markProgrammatic` + 平滑滚动，
 *      `onScroll` 在锚定期间直接返回（不把程序滚动 / 留白重算当成用户滚动）；
 *      内容长高、键盘弹出收起（clientHeight 变化）只重算留白、不动 scrollTop；只有浏览器
 *      自己把 scrollTop 夹到新上限时（键盘收起、下方内容塌缩）才拨回目标位置（`holdAnchor`）；
 *   4. 用户接管：`onUserIntent`（touchstart / pointerdown / wheel）立刻退出锚定、回到原来的
 *      状态机，**留白留着**（用户滚动时抽走留白会跳）；留白还在时「跟随底部」正好停在锚点，
 *      所以不会来回跳；
 *   5. 「回到底部」是显式接管：收掉留白 → `pinned=true` → 平滑回到底部继续跟着回复走；
 *   6. 换会话 / 重新打开会话 / 加载更早消息都清掉锚定与留白（打开旧会话底部不能多出空白）；
 *      打开会话的初始行为不变（滚到底部、无留白）。
 *
 * 时间线来自 core 的 `mergeThread`（消息 + 工具卡 + 交付物按 seq 交错），再按 0.4.0 的
 * 「过程行」规则分组：思考/命令/文件读写收进一个可折叠的过程行（默认折叠，运行中也折叠），
 * 对话正文、交付物、提问卡、审批卡保持独立展示。
 *
 * 0.4.0 §2：实时思考并进**最后一个过程行**的末行（不再渲染在时间线末尾的独立流式块），
 * 过程行的块 key 由「前一个边界条目」派生，所以思考落库时同一个 DOM 节点原地更新、位置不跳；
 * 正文（`streamingText`）始终渲染在过程行之后。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppIcon from '@/components/AppIcon.vue'
import Composer from '@/components/Composer.vue'
import StatusStrip from '@/components/StatusStrip.vue'
import StreamingMarkdown from '@/components/StreamingMarkdown.vue'
import ProcessRow from '@/components/ProcessRow.vue'
import QuestionRail from '@/components/QuestionRail.vue'
import FileAttachment from '@/components/FileAttachment.vue'
import QuestionCard from '@/components/QuestionCard.vue'
import ApprovalCard from '@/components/ApprovalCard.vue'
import { useBackendStore } from '@/stores/backend'
import { useChatStore } from '@/stores/chat'
import { useCockpitStore } from '@/stores/cockpit'
import { useFilesStore } from '@/stores/files'
import { useModelsStore } from '@/stores/models'
import { useUiStore } from '@/stores/ui'
import { useTtsStore } from '@/stores/tts'
import { hapticStrong, hapticTap } from '@/lib/platform'
import { buildConversationBlocks, turnCitations, type Citation } from '@/lib/activity'
import { RAIL_JUMP_OFFSET } from '@/lib/question-rail'
import { planSendAnchor, sendAnchorScrollTop, sendAnchorSpacer } from '@/lib/send-anchor'
import { appendTranscript } from '@/lib/voice-input'
import { getCloudImageResolver, setCloudImageResolver } from '@/lib/markdown'
import { QUEUED_CONNECTING_TEXT, QUEUED_TIMEOUT_TEXT } from '@/lib/connection-banner'
import { formatBytes, maskSecretsInText } from '@dsh-hub/mobile-core'
import { isCockpitEmbed } from '@/lib/cockpit-embed'

const route = useRoute()
const router = useRouter()
const backend = useBackendStore()
const chat = useChatStore()
const files = useFilesStore()
const models = useModelsStore()
const ui = useUiStore()
const tts = useTtsStore()
const cockpit = useCockpitStore()

/**
 * 正文里的云端路径图片（`/workspace/.../pelican.png`）：Markdown 会把它渲染成
 * `<dsh-cloud-image>`，元素挂载时通过这个 resolver 走 `file-read({path})` 取字节。
 * 放在对话页注册（而不是 markdown 库里持有 chat store），避免 lib 反向依赖 store。
 */
const cloudImageResolver = {
  load: (path: string, meta?: { alt?: string; force?: boolean }) => files.loadCloudImage(path, meta ?? {}),
  save: (path: string, meta?: { alt?: string }) => files.saveCloudImage(path, meta ?? {}),
}
setCloudImageResolver(cloudImageResolver)

const draft = ref('')

/**
 * 预填输入框（WP56d 的 `cockpit.prefill`）：与首页同一个 `ui.prefillRequest`，
 * 只有当前页面在屏幕上，所以两个 watcher 不会互相抢。
 */
watch(
  () => ui.prefillRequest,
  (request) => {
    if (request === null) return
    draft.value = request.text
    ui.consumePrefill()
  },
)

const scroller = ref<HTMLElement>()
/** 内容容器：它的高度变化才是「有新内容/图片加载/高亮完成」，`.thread` 自身高度固定。 */
const inner = ref<HTMLElement>()
const pinned = ref(true)
const userInteracting = ref(false)

const NEAR_BOTTOM_PX = 24
const IDLE_MS = 150

let resizeObserver: ResizeObserver | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let programmaticTop = -1
let programmaticUntil = 0

/**
 * 0.4.8 发送锚定（规则见文件头）：
 * - `anchorKey`：这次锚定的用户消息块 key（= localId），null 表示没有锚定；
 * - `anchorOn`：还在锚定模式里（用户一碰就关）；关了之后留白仍然保留；
 * - `spacerPx`：底部留白高度；
 * - `anchorSessionId`：锚定开始时所在的会话；新建会话的 id 是后补的（null → 真 id），
 *   那次变化不算「换会话」。
 */
const anchorKey = ref<string | null>(null)
const anchorOn = ref(false)
const spacerPx = ref(0)
const spacerEl = ref<HTMLElement>()
let anchorSessionId: string | null | undefined
let anchorExclude: Set<string> | null = null
let anchorRaf = 0
let anchorDeadline = 0
/** 锚点已经滚到位（之后 ResizeObserver 的位置纠正才有意义）。 */
let anchorScrolled = false

const items = computed(() => chat.threadItems)
/**
 * 0.4.0 §2：把思考/工具收进过程行，并**把实时思考并进最后一个过程行的末行**。
 * 块 key 以前一个边界条目派生，实时 → 落库切换时不变（位置不跳）。
 */
const blocks = computed(() =>
  buildConversationBlocks(items.value, {
    turnRunning: chat.turnRunning,
    streamingReasoning: displayStreamingReasoning.value,
    reasoningDone: chat.reasoningDone,
    hasStreamingText: chat.streamingText !== '',
  }),
)
const streaming = computed(() => chat.isStreaming)
const hasStreamingText = computed(() => chat.streamingText !== '')

/** 问题导航条：已加载的用户提问（≥3 条才显示，§4.1）。 */
const userMarks = computed(() =>
  blocks.value.flatMap((block) =>
    block.kind === 'item' &&
    block.item.kind === 'message' &&
    block.item.entry.role === 'user' &&
    block.item.entry.text.trim() !== ''
      ? [{ key: block.key, text: block.item.entry.text }]
      : [],
  ),
)

/**
 * 每条助手回答后面的「引用来源角标」（本轮搜索/抓取到的来源）。
 * 默认显示前 3 个，其余收成「+N」；点「+N」展开全部，展开后末尾有「收起」（按块 key 记，换会话清空）。
 */
const expandedCites = ref(new Set<string>())
function toggleCites(key: string): void {
  const next = new Set(expandedCites.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expandedCites.value = next
}
watch(
  () => chat.activeId,
  () => {
    expandedCites.value = new Set()
  },
)
const turnSources = computed(() => {
  const map = new Map<number, { shown: Citation[]; rest: number }>()
  blocks.value.forEach((block, index) => {
    if (
      block.kind === 'item' &&
      block.item.kind === 'message' &&
      block.item.entry.role === 'assistant'
    ) {
      const list = turnCitations(blocks.value, index)
      if (list.length === 0) return
      const open = expandedCites.value.has(block.key) && list.length > 3
      map.set(index, { shown: open ? list : list.slice(0, 3), rest: open ? 0 : list.length - 3 })
    }
  })
  return map
})

const frozen = ref<{ text: number; reasoning: number } | null>(null)

watch(
  () => userInteracting.value,
  (interacting) => {
    if (interacting) {
      frozen.value = {
        text: chat.streamingText.length,
        reasoning: chat.streamingReasoning.length,
      }
    } else {
      frozen.value = null
    }
  },
)

const displayStreamingText = computed(() => {
  const full = chat.streamingText
  if (!frozen.value) return full
  return full.slice(0, frozen.value.text)
})

const displayStreamingReasoning = computed(() => {
  const full = chat.streamingReasoning
  if (!frozen.value) return full
  return full.slice(0, frozen.value.reasoning)
})

const caretStreaming = computed(() => streaming.value && !userInteracting.value)
/**
 * 「回到底部」只在下面真有没看到的内容时出现（0.4.8）：发送锚定后回复还没写满一屏时，
 * 下面只是留白，这时出现箭头是噪音。`hiddenBelowPx` = 距底部的距离扣掉留白。
 */
const hiddenBelowPx = ref(0)
const showJump = computed(() => !pinned.value && hiddenBelowPx.value > NEAR_BOTTOM_PX)

function refreshHiddenBelow(): void {
  hiddenBelowPx.value = Math.max(0, distanceFromBottom() - spacerPx.value)
}

// 留白高度改了要等 DOM 更新后再量（同步量会拿新留白去扣旧的 scrollHeight）
watch(spacerPx, () => void nextTick(refreshHiddenBelow))

/**
 * 顶栏（0.4.0 §1.1）：左侧 ☰ 抽屉、中间不再显示标题、右上「新对话」+「⋮」。
 *
 * 滚动提示（内容滚到顶栏下方时出现 0.5px 分隔线）用一个**独立的** scroll 监听驱动，
 * 不塞进下面的吸底状态机 `onScroll`：那个状态机有程序滚动标记窗口，混进来容易互相干扰。
 */
const headerScrolled = ref(false)

function onHeaderScroll(): void {
  headerScrolled.value = (scroller.value?.scrollTop ?? 0) > 2
  refreshHiddenBelow()
}

/** 新对话：清掉当前会话状态后回首页（首页就是新的空白对话）。 */
function newChat(): void {
  void hapticTap()
  chat.newSession()
  void router.replace('/')
}

/** ⋮ 菜单：开合状态在 ui store（返回键由 `ui.consumeOverlay` 先吃掉）。 */
function toggleSessionMenu(): void {
  void hapticTap()
  ui.toggleSessionMenu()
}

const showEmpty = computed(
  () =>
    items.value.length === 0 &&
    !hasStreamingText.value &&
    !chat.historyLoading &&
    !chat.turnRunning,
)

/**
 * 顶部细状态条（0.4.1 §2）：文案与语气全部来自 `chat.connectionBanner` ——
 * 未连上不足 4 秒不显示（锁屏回来不再闪），4–15 秒中性提示，≥15 秒 / 明确原因才警示 + 重试。
 */
const stripText = computed(() => chat.statusText)
const stripAction = computed(() => chat.statusAction)

function onStripAction(): void {
  // 唤醒被拦 → 重新唤醒；其它都是链路问题 → 重建通道。
  if (chat.statusAction === '重试' && backend.wakeState === 'blocked') {
    void backend.retryWake()
    return
  }
  chat.retryConnection()
}

/**
 * 气泡下方的连接状态（0.4.1 §3）：这条消息在队列里、因为没连上还没发出去。
 * 连上之后返回 null，交给原来的「发送中…」。
 */
function queuedLinkState(entry: { localId: string | null }): 'connecting' | 'timeout' | null {
  return chat.queuedLinkStateOf(entry.localId)
}

function distanceFromBottom(): number {
  const el = scroller.value
  if (!el) return 0
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

function markProgrammatic(top: number, windowMs: number): void {
  programmaticTop = top
  programmaticUntil = performance.now() + windowMs
}

function isProgrammaticScroll(): boolean {
  if (performance.now() > programmaticUntil) return false
  const el = scroller.value
  if (!el) return false
  return Math.abs(el.scrollTop - programmaticTop) <= 64
}

function scrollToBottom(behavior: ScrollBehavior = 'auto'): void {
  const el = scroller.value
  if (!el) return
  markProgrammatic(el.scrollHeight, behavior === 'smooth' ? 700 : 180)
  el.scrollTo({ top: el.scrollHeight, behavior })
}

// ── 0.4.8 发送锚定（纯计算在 lib/send-anchor.ts）─────────────────────────────

/**
 * 量一次锚点：距内容顶部的偏移 + 锚点顶部到内容末尾的高度（**都不含留白**）。
 *
 * 留白是 `.thread__inner` 后面的兄弟节点（不是它的子项），所以「内容高度」= inner 自己的高度，
 * 与留白互不影响：留白怎么变都不会改变这两个量。
 */
function measureAnchor(node: HTMLElement): { anchorTop: number; belowHeight: number } {
  const root = inner.value
  if (!root) return { anchorTop: 0, belowHeight: 0 }
  const rect = root.getBoundingClientRect()
  const anchorTop = node.getBoundingClientRect().top - rect.top
  return { anchorTop, belowHeight: rect.height - anchorTop }
}

/**
 * 锚点消息的 DOM：优先按 key 找；key 找不到（后端的 deferred 队列转 Outbox 时会换 id）
 * 就退化成「最新一条用户消息」——这条正是刚发出去的那条。
 */
function anchorNode(): HTMLElement | null {
  const nodes = inner.value?.querySelectorAll<HTMLElement>('[data-user-msg-key]')
  if (!nodes || nodes.length === 0) return null
  const key = anchorKey.value
  if (key !== null) {
    for (const node of nodes) if (node.dataset.userMsgKey === key) return node
  }
  const exclude = anchorExclude
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (!node) continue
    if (exclude === null || !exclude.has(node.dataset.userMsgKey ?? '')) return node
  }
  return null
}

/**
 * 重算留白：内容长高（流式 / 图片 / 高亮完成）和键盘弹出收起（clientHeight 变）都走这里。
 * **只改留白高度、不动 scrollTop** —— 锚点在内容里的位置不变，视图就不会跳（e2e B/F/H）。
 */
function refreshAnchorSpacer(): void {
  if (anchorKey.value === null) return
  const el = scroller.value
  const node = anchorNode()
  if (!el || !node) return
  const { anchorTop, belowHeight } = measureAnchor(node)
  const plan = planSendAnchor({ anchorTop, belowHeight, viewportHeight: el.clientHeight })
  // 亚像素抖动不重设（ResizeObserver 会来回触发，写同一个值也会白跑一次渲染）
  if (Math.abs(plan.spacer - spacerPx.value) > 0.5) spacerPx.value = plan.spacer
  holdAnchor()
}

/**
 * 锚定期间保住位置（不跟随）。
 *
 * 唯一的例外是「浏览器自己把 scrollTop 夹掉了」：键盘收起（视口变高）或下方内容塌缩
 * （流式块落成正式消息）的那一帧，可滚范围会短暂变小，浏览器把 scrollTop 压到新上限 ——
 * 锚点就被顶上去一大截。这时把 scrollTop 拨回目标位置（不平滑，避免看到回弹）。
 * 平滑滚动在飞的时候（programmaticUntil 之内）不插手；用户一碰就退出锚定，也不会被拨。
 */
function holdAnchor(): void {
  if (!anchorOn.value || !anchorScrolled) return
  if (performance.now() < programmaticUntil) return
  const el = scroller.value
  const node = anchorNode()
  if (!el || !node) return
  const { anchorTop } = measureAnchor(node)
  const target = sendAnchorScrollTop(anchorTop)
  if (Math.abs(el.scrollTop - target) <= 1) return
  markProgrammatic(target, 200)
  // 等留白这一帧渲染完再拨：否则 scrollTop 会被**旧留白**算出来的上限夹住（拨不到位）
  void nextTick(() => {
    if (anchorOn.value) scroller.value?.scrollTo({ top: target, behavior: 'auto' })
  })
}

/** 补齐留白之后平滑滚到锚点：留白保证了目标位置够得着（maxScroll = 目标位置）。 */
function anchorScrollTo(node: HTMLElement): void {
  const el = scroller.value
  if (!el) return
  const { anchorTop, belowHeight } = measureAnchor(node)
  const plan = planSendAnchor({ anchorTop, belowHeight, viewportHeight: el.clientHeight })
  spacerPx.value = plan.spacer
  void nextTick(() => {
    if (!anchorOn.value) return
    anchorScrolled = true
    markProgrammatic(plan.scrollTop, 900)
    el.scrollTo({ top: plan.scrollTop, behavior: 'smooth' })
  })
}

/** 等这条用户消息的 DOM 出现（本地入队 → 渲染最多一两帧，离线排队也一样），再锚定。 */
function waitSendAnchor(): void {
  anchorRaf = 0
  if (!anchorOn.value) return
  const node = anchorNode()
  if (!node) {
    if (performance.now() <= anchorDeadline) {
      anchorRaf = requestAnimationFrame(waitSendAnchor)
      return
    }
    // 兜底：消息没进时间线（极端情况）就退回原来的「发完吸底」，至少不让用户看不见自己发的
    anchorExclude = null
    anchorOn.value = false
    pinned.value = true
    scrollToBottom()
    return
  }
  anchorExclude = null
  if (node.dataset.userMsgKey) anchorKey.value = node.dataset.userMsgKey
  anchorScrollTo(node)
}

/**
 * 开始一次发送锚定。
 *
 * - `key`：直接指定要锚的消息（「去掉附件发送」这种已经渲染出来的队列气泡）；
 * - `exclude`：发送前已有的用户消息 key（send() 用），新出现的那条才是要锚的。
 */
function beginSendAnchor(options: { key?: string | null; exclude?: Set<string> | null }): void {
  if (anchorRaf !== 0) cancelAnimationFrame(anchorRaf)
  anchorRaf = 0
  anchorKey.value = options.key ?? null
  anchorExclude = options.exclude ?? null
  anchorSessionId = chat.activeId
  anchorOn.value = true
  anchorScrolled = false
  // 从这一刻起不跟随：回复流式输出时视图保持不动（问题停在顶部，回复在下面长）
  pinned.value = false
  userInteracting.value = false
  clearIdleTimer()
  anchorDeadline = performance.now() + 2500
  anchorRaf = requestAnimationFrame(waitSendAnchor)
}

/** 清掉锚定与留白（换会话 / 加载更早消息 / 点回到底部时用）。 */
function clearSendAnchor(): void {
  if (anchorRaf !== 0) cancelAnimationFrame(anchorRaf)
  anchorRaf = 0
  anchorKey.value = null
  anchorExclude = null
  anchorSessionId = undefined
  anchorOn.value = false
  anchorScrolled = false
  spacerPx.value = 0
}

/** 当前已经渲染的用户消息 key（send() 用它认出「哪一条是刚发的」）。 */
function renderedUserKeys(): Set<string> {
  const out = new Set<string>()
  const nodes = inner.value?.querySelectorAll<HTMLElement>('[data-user-msg-key]')
  if (!nodes) return out
  for (const node of nodes) if (node.dataset.userMsgKey) out.add(node.dataset.userMsgKey)
  return out
}

function clearIdleTimer(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

function scheduleIdleCheck(): void {
  clearIdleTimer()
  idleTimer = setTimeout(() => {
    idleTimer = null
    userInteracting.value = false
    // 锚定期间不恢复吸底：视图要停在锚点（等用户自己接管或点「回到底部」）
    if (anchorOn.value) return
    if (distanceFromBottom() < NEAR_BOTTOM_PX) pinned.value = true
  }, IDLE_MS)
}

function onUserIntent(): void {
  // 0.4.8：手指按到对话区 = 用户接管：退出锚定模式，回到原来的状态机。
  // 留白**不**在这里拿掉（滚动中途改内容高度会跳），留着等下次发送 / 离开会话。
  anchorOn.value = false
  userInteracting.value = true
  pinned.value = false
  clearIdleTimer()
}

function onScroll(): void {
  // 0.4.8：锚定期间不跟随、也不改 pinned —— 平滑滚动的中间帧、留白重算引起的滚动
  // 都不是用户意图（用户真的滚了会先走 onUserIntent，那时锚定已经关了）；
  // 只处理「浏览器把 scrollTop 夹掉了」这种被动变化（holdAnchor 里会判断要不要拨回）。
  if (anchorOn.value) {
    holdAnchor()
    return
  }
  if (isProgrammaticScroll()) return
  if (userInteracting.value) {
    scheduleIdleCheck()
    return
  }
  if (distanceFromBottom() < NEAR_BOTTOM_PX) pinned.value = true
}

function jumpToBottom(): void {
  const el = scroller.value
  if (!el) return
  // 0.4.8：有留白时「底部」是留白撑出来的空白；真实内容底部在它上面 spacerPx 处。
  // 先算真实底部 → 收掉留白（显式接管）→ 平滑滚过去继续吸底跟随。
  const target = Math.max(0, el.scrollHeight - el.clientHeight - spacerPx.value)
  clearSendAnchor()
  pinned.value = true
  markProgrammatic(target, 700)
  el.scrollTo({ top: target, behavior: 'smooth' })
}

/**
 * 问题导航条跳转（§4.2）：让用户消息顶部对齐到对话区顶部下方 12px。
 * 设 pinned=false 并标记为程序滚动，不反过来改吸底状态机；流式输出中也能用。
 * 0.4.8：跳转 = 用户显式离开这一轮，退出锚定（留白留着，别在跳转时抽走导致跳动）。
 */
function jumpToQuestion(key: string): void {
  const el = scroller.value
  if (!el) return
  const nodes = inner.value?.querySelectorAll<HTMLElement>('[data-user-msg-key]')
  const node =
    nodes === undefined
      ? undefined
      : Array.from(nodes).find((item) => item.dataset.userMsgKey === key)
  if (node === undefined) return
  const offset = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
  const top = Math.max(0, offset - RAIL_JUMP_OFFSET)
  anchorOn.value = false
  pinned.value = false
  userInteracting.value = true
  markProgrammatic(top, 900)
  el.scrollTo({ top, behavior: 'smooth' })
  scheduleIdleCheck()
}

function followIfPinned(): void {
  if (!pinned.value || userInteracting.value) return
  scrollToBottom()
}

watch(
  () => [
    items.value.length,
    chat.streamingText.length,
    chat.streamingReasoning.length,
    chat.questions.length,
    chat.approvals.length,
  ],
  async () => {
    if (!pinned.value || userInteracting.value) return
    await nextTick()
    followIfPinned()
  },
)

watch(
  () => chat.activeId,
  (id) => {
    if (!id) return
    // 换会话 = 离开这条回复：朗读停掉（0.4.3 的停止条件之一）
    tts.stop('leave')
    if (route.params.id !== id) void router.replace(`/c/${id}`)
    // 0.4.8：换会话 = 离开锚定 —— 清掉留白，回到「打开会话就在底部、没有多余空白」。
    // 新建会话的 id 是后补的（null → 真 id），那次不是换会话，锚定要继续。
    if (anchorSessionId !== undefined && (anchorSessionId === null || anchorSessionId === id)) {
      anchorSessionId = id
      return
    }
    clearSendAnchor()
    pinned.value = true
    userInteracting.value = false
    void nextTick(() => scrollToBottom())
  },
)

function syncRoute(): void {
  const id = route.params.id
  if (typeof id !== 'string') return
  if (id === 'new') return
  if (id !== chat.activeId) void chat.openSession(id)
}

watch(() => route.params.id, syncRoute, { immediate: true })

/** 按住说话识别出的文字：追加到输入框现有内容后面（0.4.1，只改麦克风这块）。 */
function onVoiceText(text: string): void {
  draft.value = appendTranscript(draft.value, text)
}

/** 加载更早的消息：往顶部插内容前先收掉留白，否则底部会多出一块撑出来的空白。 */
function loadOlder(): void {
  clearSendAnchor()
  void chat.loadOlder()
}

function send(): void {
  let text = draft.value.trim()
  if (!text && chat.attachments.length === 0) return
  // 座舱：密钥不进对话（docs/24 §0-4）——像密钥的片段先打码再发，并提醒改用右舷的密钥卡
  if (text && isCockpitEmbed()) {
    const guarded = maskSecretsInText(text)
    if (guarded.masked > 0) {
      text = guarded.text
      ui.toast('密钥不能发进对话，已替换成 [已隐藏]；需要填密钥时 DSH 会在右舷发密钥卡', 4000)
    }
  }
  // 发新消息就停止朗读：用户开始新的交互，不该还在听上一条（0.4.3 停止条件）
  tts.stop('send')
  void hapticTap()
  // 0.4.8：记下发送前已经渲染的用户消息，发送之后新出现的那条就是要锚定的
  // （本地入队 → 待发气泡立刻出现；离线排队、带附件、按住说话识别后发送都走这里）
  const before = renderedUserKeys()
  const id = chat.send(text)
  draft.value = ''
  beginSendAnchor({ exclude: before })
  void nextTick(() => {
    if (id && route.params.id !== id) void router.replace(`/c/${id}`)
  })
}

function stop(): void {
  void hapticStrong()
  chat.stop()
}

function retry(localId: string): void {
  chat.retryUnknown(localId)
}

/**
 * 待发气泡上的附件问题（上传失败 / 跨重启丢失）：
 * 由用户选「重试 / 去掉附件发送 / 删除」，绝不自动丢附件发出。
 */
type QueuedProblem = { kind: 'upload-failed' | 'attachment-missing' } | null
function problemOf(entry: { localId: string | null }): QueuedProblem {
  return chat.queuedProblemOf(entry.localId)
}
function problemText(problem: QueuedProblem): string {
  if (!problem) return ''
  return problem.kind === 'attachment-missing' ? '附件丢失' : '附件上传失败'
}
function onRetryQueued(entry: { localId: string | null }): void {
  if (entry.localId) chat.retryQueuedAttachments(entry.localId)
}
function onSendWithoutAttachments(entry: { localId: string | null }): void {
  if (!entry.localId) return
  // 0.4.8：这条队列气泡现在真的发出去了 = 用户发出了新消息，同样把它顶到对话区顶部
  beginSendAnchor({ key: entry.localId })
  chat.sendQueuedWithoutAttachments(entry.localId)
}
function onDiscardQueued(entry: { localId: string | null }): void {
  if (entry.localId) chat.discardQueuedMessage(entry.localId)
}

/** 其它会话在等我回答：顶部细提示 → 打开第一个。 */
const pendingAnswers = computed(() => chat.pendingAnswerCount)
const pendingAnswerText = computed(() =>
  pendingAnswers.value > 0 ? `有 ${pendingAnswers.value} 个对话在等你回答` : '',
)
function openFirstPendingAnswer(): void {
  const session = chat.firstPendingAnswerSession
  if (!session) return
  void router.push(`/c/${session.sessionId}`)
}

/**
 * 错误条「重试」：链路断了就重建通道；通道还连着（例如切后台回来 mux 抖了一下）
 * 就重新加载当前会话，而不是只把错误条关掉（关掉会留下一个空会话）。
 */
function retryWorkspaceError(): void {
  if (chat.link === 'failed' || chat.link === 'closed') chat.retryConnection()
  else chat.retryOpenSession()
}

function openImage(fileRef: string): void {
  ui.openImageViewer(fileRef)
}

function removeAttachment(localId: string): void {
  chat.removeAttachment(localId)
}

function retryAttachment(localId: string): void {
  chat.retryAttachment(localId)
}

/** 朗读按钮：正在读这条 → 停止；否则开始读（切换播放器内部会先停上一条）。 */
function onReadReply(key: string, text: string): void {
  void hapticTap()
  tts.toggleMessage(key, text)
}

/**
 * 自动朗读新回复（0.4.3，默认关）：回合结束时读**最新一条**助手回复。
 *
 * 只在上一次 `turnRunning` 为 true（确实刚跑完一轮）时触发，且同一条 key 只自动读一次：
 * 打开会话、切后台回来都不会突然开口。
 */
let autoReadRunning = false
let autoReadKey: string | null = null

function latestAssistantReply(): { key: string; text: string } | null {
  for (let index = blocks.value.length - 1; index >= 0; index -= 1) {
    const block = blocks.value[index]
    if (block?.kind !== 'item' || block.item.kind !== 'message') continue
    if (block.item.entry.role !== 'assistant') continue
    const text = block.item.entry.text
    if (text.trim().length === 0) continue
    return { key: block.key, text }
  }
  return null
}

watch(
  () => chat.turnRunning,
  async (running) => {
    if (running) {
      autoReadRunning = true
      return
    }
    if (!autoReadRunning) return
    autoReadRunning = false
    if (!tts.available || !tts.autoRead) return
    await nextTick()
    const latest = latestAssistantReply()
    if (!latest || latest.key === autoReadKey) return
    autoReadKey = latest.key
    tts.playMessage(latest.key, latest.text)
  },
)

onMounted(() => {
  syncRoute()
  // 顶栏滚动提示的独立监听（见 onHeaderScroll）：不参与下面的吸底状态机。
  scroller.value?.addEventListener('scroll', onHeaderScroll, { passive: true })
  void nextTick(() => scrollToBottom())
  if (typeof ResizeObserver !== 'undefined') {
    // 同时观察视口（键盘/旋转导致 clientHeight 变化）和内容容器（流式结束落成消息、
    // 交付图片加载、Shiki 高亮完成都会让内容在 nextTick 之后继续长高）。
    // 只观察 scroller 的话，这些「下一帧才长高」的情况会漏掉：回复完成后视图停在离底部
    // 300px 的位置，看起来像消息排列/滚动坏了（真机反馈 2026-10-26）。
    resizeObserver = new ResizeObserver(() => {
      // 0.4.8：留白要跟着内容高度 / 视口高度重算（流式长高、图片与高亮完成、键盘弹出收起）
      if (anchorKey.value !== null) refreshAnchorSpacer()
      refreshHiddenBelow()
      // 锚定期间视图保持不动：回复再长也不跟随（Claude App 的做法）
      if (anchorOn.value) return
      if (!pinned.value || userInteracting.value) return
      scrollToBottom()
    })
    if (inner.value) resizeObserver.observe(inner.value)
    if (scroller.value) resizeObserver.observe(scroller.value)
  }
})

onBeforeUnmount(() => {
  // 离开对话页：立刻停止朗读（WebView 里离开页面后音频会继续，必须主动停）
  tts.stop('leave')
  // 0.4.8：停掉「等锚点消息出现」的 rAF 循环
  clearSendAnchor()
  resizeObserver?.disconnect()
  resizeObserver = null
  clearIdleTimer()
  scroller.value?.removeEventListener('scroll', onHeaderScroll)
  // 菜单/面板挂在 App 壳上：离开对话页要收起来，避免停在首页时还盖着一层。
  if (ui.sessionMenuOpen) ui.closeSessionMenu()
  if (ui.sidePanelOpen) ui.closeSidePanel()
  // 只清自己的注册（避免误清后挂载的对话页注册的 resolver）。
  if (getCloudImageResolver() === cloudImageResolver) setCloudImageResolver(null)
})
</script>

<template>
  <div class="app-body">
    <!-- 顶栏（0.4.0 §1.1）：☰ 打开抽屉 / 中间空（标题去掉）/ 右上「新对话」+「⋮」 -->
    <header class="app-header" :class="{ 'is-scrolled': headerScrolled }" data-header="conversation">
      <div class="app-header__side">
        <!-- 嵌入座舱（WP56d）：「航行日志」按钮（会话列表 + 新会话），不再有抽屉 -->
        <button
          v-if="cockpit.embed && !cockpit.sessionsDocked"
          class="cockpit-log-btn"
          type="button"
          data-testid="nav-log-button"
          aria-label="航行日志"
          :aria-expanded="cockpit.logOpen"
          @click="cockpit.toggleLog()"
        >
          <AppIcon name="menu" :size="16" />
          <span>航行日志</span>
          <AppIcon name="chevronDown" :size="12" />
        </button>
        <!-- 嵌入座舱里没有抽屉（docked 时连航行日志都不需要，这里就不渲染任何按钮） -->
        <button
          v-else-if="!cockpit.embed"
          class="icon-btn"
          type="button"
          aria-label="打开抽屉"
          @click="ui.openDrawer()"
        >
          <AppIcon name="menu" :size="24" />
        </button>
      </div>
      <div class="app-header__title" />
      <div class="app-header__side app-header__side--right">
        <button class="icon-btn" type="button" aria-label="新对话" @click="newChat()">
          <AppIcon name="newChat" :size="24" />
        </button>
        <button
          class="icon-btn"
          type="button"
          aria-label="会话菜单"
          :aria-expanded="ui.sessionMenuOpen"
          @click="toggleSessionMenu()"
        >
          <AppIcon name="moreVertical" :size="24" />
        </button>
      </div>
    </header>

    <StatusStrip
      v-if="stripText"
      :text="stripText"
      :tone="chat.statusTone"
      :action-label="stripAction"
      @action="onStripAction"
    />

    <!-- 其它会话在等你回答（WP46 的 pendingInteractions）：一条细提示，点它就是打开第一个。 -->
    <StatusStrip
      v-if="pendingAnswerText"
      :text="pendingAnswerText"
      tone="ready"
      action-label="去回答"
      @action="openFirstPendingAnswer()"
    />

    <!-- 连接相关的瞬态错误同样受宽限期约束（0.4.1 §2）：由 visibleWorkspaceError 决定 -->
    <div v-if="chat.visibleWorkspaceError" class="error-bar">
      <span class="error-bar__text">{{ chat.visibleWorkspaceError.message }}</span>
      <button
        v-if="chat.visibleWorkspaceError.retryable"
        class="error-bar__btn"
        type="button"
        @click="retryWorkspaceError()"
      >
        重试
      </button>
      <button class="error-bar__btn" type="button" @click="chat.clearError()">关闭</button>
    </div>

    <div class="thread-wrap">
      <div
        ref="scroller"
        class="thread"
        @scroll.passive="onScroll"
        @touchstart.passive="onUserIntent"
        @pointerdown="onUserIntent"
        @wheel.passive="onUserIntent"
        @touchend.passive="scheduleIdleCheck"
        @touchcancel.passive="scheduleIdleCheck"
      >
        <div ref="inner" class="thread__inner">
          <button
            v-if="chat.historyHasMore || chat.historyLoading"
            class="load-older"
            type="button"
            :disabled="chat.historyLoading"
            @click="loadOlder()"
          >
            {{ chat.historyLoading ? '正在加载…' : '加载更早的消息' }}
          </button>

          <template v-for="(block, blockIndex) in blocks" :key="block.key">
            <ProcessRow
              v-if="block.kind === 'activity'"
              :block-key="block.key"
              :rows="block.rows"
              :live="block.live"
              :running="chat.turnRunning"
              @focus-canvas="cockpit.focusCanvas"
              @focus-proposal="cockpit.focusProposal"
            />

            <template v-else-if="block.item.kind === 'deliverable'">
              <div class="deliverable">
                <p class="deliverable__title">交付了 {{ block.item.item.files.length }} 个文件</p>
                <div class="deliverable__files">
                  <FileAttachment
                    v-for="file in block.item.item.files"
                    :key="file.fileRef"
                    :file="file"
                    @preview="openImage"
                  />
                </div>
              </div>
            </template>

            <div
              v-else-if="block.item.kind === 'message' && block.item.entry.role === 'user'"
              class="msg-user"
              :data-user-msg-key="block.key"
            >
              <div v-if="chat.localAttachmentFor(block.item.entry).length > 0" class="msg-user__files">
                <template
                  v-for="attachment in chat.localAttachmentFor(block.item.entry)"
                  :key="attachment.localId"
                >
                  <img
                    v-if="attachment.kind === 'image' && attachment.previewUrl"
                    class="msg-user__thumb"
                    :src="attachment.previewUrl"
                    :alt="attachment.name"
                  />
                  <span v-else class="msg-user__file">
                    <AppIcon name="file" :size="13" />
                    {{ attachment.name }} · {{ formatBytes(attachment.bytes) }}
                  </span>
                </template>
              </div>
              <span v-if="block.item.entry.text">{{ block.item.entry.text }}</span>
              <span
                v-if="problemOf(block.item.entry)"
                class="msg-user__state msg-user__state--error msg-user__state--problem"
              >
                {{ problemText(problemOf(block.item.entry)) }}
                <button
                  v-if="problemOf(block.item.entry)?.kind === 'upload-failed'"
                  type="button"
                  @click="onRetryQueued(block.item.entry)"
                >
                  重试
                </button>
                <button type="button" @click="onSendWithoutAttachments(block.item.entry)">
                  去掉附件发送
                </button>
                <button type="button" @click="onDiscardQueued(block.item.entry)">删除</button>
              </span>
              <span v-else-if="block.item.entry.unknown" class="msg-user__state">
                结果未知 ·
                <button type="button" @click="retry(block.item.entry.localId!)">重试</button>
              </span>
              <span v-else-if="block.item.entry.failed" class="msg-user__state msg-user__state--error">
                发送失败
              </span>
              <!-- 0.4.1 §3：因为没连上还没发出去 —— 连接状态只显示在这条消息下方（顶部条不重复）。
                   排队超过 15 秒才升级成「暂时连不上服务器，连上后自动发送 · 重试」。 -->
              <span
                v-else-if="queuedLinkState(block.item.entry) === 'timeout'"
                class="msg-user__state msg-user__state--conn"
              >
                {{ QUEUED_TIMEOUT_TEXT }} ·
                <button type="button" @click="chat.retryConnection()">重试</button>
              </span>
              <span
                v-else-if="queuedLinkState(block.item.entry) === 'connecting'"
                class="msg-user__state msg-user__state--conn"
              >
                <span class="msg-user__spin" aria-hidden="true" />
                {{ QUEUED_CONNECTING_TEXT }}
              </span>
              <span v-else-if="block.item.entry.pending" class="msg-user__state">发送中…</span>
            </div>

            <div v-else-if="block.item.kind === 'message'" class="msg-assistant">
              <StreamingMarkdown v-if="block.item.entry.text" :text="block.item.entry.text" />
              <div v-if="turnSources.has(blockIndex)" class="cite-row">
                <a
                  v-for="source in turnSources.get(blockIndex)?.shown ?? []"
                  :key="source.url"
                  class="cite-pill"
                  :href="source.url"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {{ source.title || source.url }}
                </a>
                <button
                  v-if="(turnSources.get(blockIndex)?.rest ?? 0) > 0"
                  type="button"
                  class="cite-pill cite-pill--more"
                  :aria-label="`展开其余 ${turnSources.get(blockIndex)?.rest} 个来源`"
                  @click="toggleCites(block.key)"
                >
                  +{{ turnSources.get(blockIndex)?.rest }}
                </button>
                <button
                  v-else-if="expandedCites.has(block.key)"
                  type="button"
                  class="cite-pill cite-pill--more"
                  @click="toggleCites(block.key)"
                >
                  收起
                </button>
              </div>
              <!-- 0.4.3 朗读：回复下方一行轻量操作（灰色线性图标 20px，不喧宾夺主）。
                   老 Hub / 关掉朗读时整行不出现。 -->
              <div
                v-if="tts.available && block.item.entry.text"
                class="msg-actions"
                data-tts-actions
              >
                <button
                  class="msg-action"
                  type="button"
                  :data-tts-key="block.key"
                  :data-tts-state="
                    tts.isReading(block.key) ? (tts.loading ? 'loading' : 'playing') : 'idle'
                  "
                  :aria-label="
                    tts.isReading(block.key)
                      ? `停止朗读${tts.total > 0 ? `（第 ${tts.segment}/${tts.total} 段）` : ''}`
                      : '朗读这条回复'
                  "
                  @click="onReadReply(block.key, block.item.entry.text)"
                >
                  <template v-if="tts.isReading(block.key)">
                    <span v-if="tts.loading" class="msg-action__spin" aria-hidden="true" />
                    <AppIcon v-else name="square" :size="13" />
                    <span v-if="!tts.loading" class="msg-action__bars" aria-hidden="true">
                      <i /><i /><i />
                    </span>
                    <span class="msg-action__label">{{ tts.loading ? '准备中' : '停止' }}</span>
                  </template>
                  <template v-else>
                    <AppIcon name="speaker" :size="20" />
                    <span class="msg-action__label">朗读</span>
                  </template>
                </button>
              </div>
            </div>
          </template>

          <!-- 0.4.0 §2：思考与工具都在过程行里；这里只剩流式正文（永远在过程行下方）。 -->
          <div v-if="hasStreamingText" class="msg-assistant">
            <StreamingMarkdown
              :text="streaming ? displayStreamingText : chat.streamingText"
              :streaming="caretStreaming"
            />
          </div>

          <QuestionCard
            v-for="prompt in chat.questions"
            :key="`q-${prompt.callId}`"
            :prompt="prompt"
          />

          <ApprovalCard
            v-for="approval in chat.approvals"
            :key="`a-${approval.approvalId}`"
            :approval="approval"
          />

          <p v-if="showEmpty" class="empty">这个会话还没有消息</p>
        </div>

        <!-- 0.4.8 发送锚定的底部留白（内容末尾，挂在 .thread 下、thread__inner 之后）：
             高度由 lib/send-anchor.ts 算出，只补足到「恰好能把刚发出的这条用户消息顶到
             对话区顶部」，回复长高时同步缩小。放在 inner 外面是刻意的：内容高度 = inner
             自己的高度，留白不会污染「锚点顶部到内容末尾」的测量；也不影响 inner 内部
             那些 :last-child 结构。 -->
        <div
          v-if="spacerPx > 0"
          ref="spacerEl"
          class="thread-spacer"
          :style="{ height: `${spacerPx}px` }"
          aria-hidden="true"
        />
      </div>

      <!-- 问题导航条（§4）：≥3 条用户提问时出现，只在用户滚动后淡入。 -->
      <QuestionRail
        v-if="userMarks.length >= 3"
        :scroller="scroller"
        :marks="userMarks"
        :has-more="chat.historyHasMore"
        :interacting="userInteracting"
        @jump="jumpToQuestion"
        @load-older="loadOlder()"
      />

      <button
        v-if="showJump"
        class="to-bottom"
        type="button"
        aria-label="回到底部"
        @click="jumpToBottom"
      >
        <AppIcon name="down" :size="18" />
      </button>
    </div>

    <Composer
      v-model="draft"
      :effort-label="models.effortText"
      :model-name="models.chipModelShort"
      :effort-short="models.chipEffortShort"
      :streaming="streaming"
      :attachments="chat.attachments"
      @send="send"
      @stop="stop"
      @model="ui.openModelSheet()"
      @effort="ui.openEffortSheet()"
      @plus="ui.openPlusSheet()"
      @voice-text="onVoiceText"
      @voice-notice="ui.toast"
      @remove-attachment="removeAttachment"
      @retry-attachment="retryAttachment"
    />
  </div>
</template>

<style scoped>
/*
 * 0.4.8 发送锚定的底部留白：`.thread__inner` 之后的空白块（在滚动容器里，所以算进
 * scrollHeight）。高度由 view 按 `lib/send-anchor.ts` 算出，只补足到能把锚点消息顶到
 * 对话区顶部，不多给一像素；宽度不影响布局，也不吃点击。
 */
.thread-spacer {
  display: block;
  width: 100%;
  pointer-events: none;
}
.msg-user__files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}
.msg-user__thumb {
  width: 84px;
  height: 84px;
  border-radius: 10px;
  object-fit: cover;
  background: rgba(255, 255, 255, 0.12);
}
.msg-user__file {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.14);
  font-size: 11.5px;
}
.msg-user__state--problem {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.msg-user__state {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  /* 0.4.1：气泡在亮色主题是浅暖灰，写死 rgba(255,255,255,.62) 会看不见 —— 跟主题变量走。 */
  color: var(--text-2);
}
.msg-user__state--error {
  color: var(--danger);
}
/* 0.4.1 §3：气泡下方的连接状态（小号灰字 + 小转圈，独占一行在消息下面）。 */
.msg-user__state--conn {
  display: block;
  color: var(--text-2);
}
.msg-user__spin {
  display: inline-block;
  vertical-align: -1px;
  width: 9px;
  height: 9px;
  margin-right: 4px;
  border-radius: 50%;
  border: 1.5px solid color-mix(in srgb, currentColor 28%, transparent);
  border-top-color: currentColor;
  animation: msg-user-spin 0.8s linear infinite;
}
@keyframes msg-user-spin {
  to {
    transform: rotate(360deg);
  }
}
.msg-user__state button {
  color: inherit;
  text-decoration: underline;
  font-size: 11px;
}
/* 连接状态里的「重试」是可点的动作：用强调色，别跟灰字糊在一起。 */
.msg-user__state--conn button {
  color: var(--accent-ink);
}
.msg-assistant {
  display: block;
}

/*
 * 0.4.3 朗读操作行：灰色线性图标 + 12px 灰字，紧贴回复下方。
 * 不做按钮底色/边框（0.4.0 的设计语言：次要操作不喧宾夺主），按下时才有一点反馈。
 */
.msg-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 6px 0 2px -6px;
}
.msg-action {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 32px;
  padding: 4px 8px;
  border-radius: 9px;
  color: var(--text-3);
  font-size: 12px;
  transition: color 0.14s ease, background 0.14s ease;
}
.msg-action:active {
  background: var(--surface-2);
}
.msg-action[data-tts-state='playing'],
.msg-action[data-tts-state='loading'] {
  color: var(--accent-ink);
}
.msg-action__label {
  line-height: 1;
}
/* 首段加载中：小转圈（与消息状态里的转圈同一套尺寸/配色） */
.msg-action__spin {
  display: block;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.6px solid color-mix(in srgb, currentColor 26%, transparent);
  border-top-color: currentColor;
  animation: msg-action-spin 0.8s linear infinite;
}
@keyframes msg-action-spin {
  to {
    transform: rotate(360deg);
  }
}
/* 朗读中的动态指示：三根高低起伏的小竖条 */
.msg-action__bars {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 11px;
}
.msg-action__bars i {
  display: block;
  width: 2.5px;
  border-radius: 1.5px;
  background: currentColor;
  animation: msg-action-bars 0.9s ease-in-out infinite;
}
.msg-action__bars i:nth-child(1) {
  height: 6px;
  animation-delay: -0.6s;
}
.msg-action__bars i:nth-child(2) {
  height: 11px;
  animation-delay: -0.35s;
}
.msg-action__bars i:nth-child(3) {
  height: 8px;
  animation-delay: -0.1s;
}
@keyframes msg-action-bars {
  0%,
  100% {
    transform: scaleY(0.55);
    opacity: 0.65;
  }
  50% {
    transform: scaleY(1);
    opacity: 1;
  }
}
.deliverable {
  margin: 10px 0;
}
.deliverable__title {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--text-3);
}
.deliverable__files {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.load-older {
  display: block;
  margin: 4px auto 12px;
  padding: 6px 14px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 12.5px;
}
.error-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 12px 4px;
  padding: 8px 12px;
  border-radius: 10px;
  background: rgba(214, 81, 58, 0.1);
  color: var(--danger);
  font-size: 12px;
  flex: 0 0 auto;
}
.error-bar__text {
  flex: 1;
  min-width: 0;
  line-height: 1.4;
}
.error-bar__btn {
  flex: 0 0 auto;
  padding: 3px 8px;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.6);
  color: inherit;
  font-size: 12px;
  font-weight: 600;
}
</style>
