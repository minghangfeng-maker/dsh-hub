<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import type { DevCockpitSession } from '@/components/admin/cockpit/dev-sessions'
import CockpitPlaceholder from '@/components/admin/cockpit/CockpitPlaceholder.vue'
import {
  cockpitFrameUrl,
  cockpitLayoutMessage,
  parseCockpitMessage,
  type CockpitInboundMessage,
  type CockpitOutboundMessage,
} from '@/utils/cockpit'
import type { CockpitAppStatus } from '@/utils/assist-phase'
import type { CockpitLayoutPayload } from '@/utils/assist-layout'

/**
 * 座舱左 + 中区域：真实模式是同源 iframe `/m/?embed=cockpit`，开发环境用占位面板。
 *
 * postMessage 协议父页面一侧（docs/24 §6、docs/26 §5）：
 * - 子 → 父：`cockpit.ready`（可带 `caps`）/ `cockpit.status`（WP58 新增）/ `cockpit.session`
 *   / `cockpit.auth-expired` / `cockpit.focus-proposal` / `cockpit.focus-canvas` / `cockpit.turn`；
 * - 父 → 子：`cockpit.focus-session` / `cockpit.prefill` / `cockpit.handoff` / `cockpit.layout`（WP58 新增）。
 *
 * 两条硬约束：**消息必须同源**（`event.origin === location.origin`，且来历只能是这个 iframe 或本站自己），
 * 交接码只经 URL hash 与 postMessage 传递，不落到日志里。
 */
const props = withDefaults(
  defineProps<{
    mode: 'iframe' | 'placeholder'
    code: string | null
    sessionId: string | null
    prefill: { text: string; seq: number } | null
    sessions: DevCockpitSession[]
    /** 占位面板里显示当前会话标题用 */
    placeholderPrefill: string
    /**
     * 嵌入页主题：缺省 `console`（App 的控制台主题）；传 null = App 自己的浅色主题。
     * 只是原样拼进 iframe 的查询串，主题本身由 App 网页版实现。
     */
    theme?: string | null
    /**
     * WP57：把嵌入页的页面底色换成本页的某个令牌（传令牌名，如 `--c-surface`；AI 助手页要白底，
     * App 浅色主题是暖白）。iframe 同源，加载后往它的 `<head>` 里塞一条 `:root{--bg:…}`；不改 App 本身。
     */
    pageBackground?: string | null
    /**
     * WP58：要同步给 App 的布局（docs/26 §5）。收到 `cockpit.ready` 后发一次，之后档位变化时再发。
     * null / 不传 = 不发（舰桥不需要）。
     */
    layout?: CockpitLayoutPayload | null
  }>(),
  { theme: 'console', pageBackground: null, layout: null },
)

const emit = defineEmits<{
  ready: [caps?: string[]]
  status: [status: CockpitAppStatus]
  session: [id: string | null, title?: string]
  'auth-expired': []
  'focus-proposal': [id: number]
  'focus-canvas': [id: string]
  turn: [running: boolean]
}>()

const frameRef = ref<HTMLIFrameElement | null>(null)
const ready = ref(false)
const loaded = ref(false)

/**
 * 首次的交接码写进 iframe URL（`#code=…`，docs/24 §6）；之后再换码只走 postMessage，
 * 不能改 src —— 那会把整个 App 网页版重新加载一次，会话就断了。
 */
const initialCode = ref<string | null>(props.code)
// 主题随查询串交给 App 网页版（docs/24 §6）
const src = computed(() => cockpitFrameUrl(initialCode.value, { theme: props.theme }))

function frameWindow(): Window | null {
  return frameRef.value?.contentWindow ?? null
}

/** 父 → 子：只在 iframe 就绪后发；`targetOrigin` 永远是本站，不写 `*`。 */
function post(message: CockpitOutboundMessage): void {
  const target = frameWindow()
  if (!target || props.mode !== 'iframe') return
  target.postMessage(message, window.location.origin)
}

/**
 * 同一个码只发一次：码是一次性的，App 收到两次就会兑换两次，后一次 401 又让它喊「重新交接」，
 * 父页面拿新码再发两次……（WP57d 上线后出现过每秒几十次的交接风暴）。
 */
let lastPostedCode: string | null = null

function postHandoffCode(code: string): void {
  if (code === lastPostedCode || code === initialCode.value) return
  if (!frameWindow() || props.mode !== 'iframe') return
  lastPostedCode = code
  post({ type: 'cockpit.handoff', code })
}

function postHandoff(): void {
  if (props.code) postHandoffCode(props.code)
}

function onMessage(event: MessageEvent): void {
  if (event.origin !== window.location.origin) return

  const target = frameWindow()
  const fromFrame = target !== null && event.source === target
  // 占位面板自己发出来的消息（`window.postMessage` 给本站）：走同一条处理路径
  const fromSelf = event.source === window || event.source === null
  if (!fromFrame && !fromSelf) return

  const message = parseCockpitMessage(event.origin, window.location.origin, event.data)
  if (!message) return
  handleInbound(message)
}

/** 子页面消息的处理（iframe 与 dev 占位面板共用这一份逻辑）。 */
function handleInbound(message: CockpitInboundMessage): void {
  switch (message.type) {
    case 'cockpit.ready':
      ready.value = true
      emit('ready', message.caps)
      // 只有在「码比首次那个新」时才补发（过期换码的场景）
      if (props.code && props.code !== initialCode.value) postHandoff()
      // 收到 ready 后发一次布局（docs/26 §5）；老 App 不认识会自己忽略
      postLayout()
      break
    case 'cockpit.status':
      emit('status', message.message ? { phase: message.phase, message: message.message } : { phase: message.phase })
      break
    case 'cockpit.session':
      // 老 App 不带 title：只透出 id（保持两参与一参两种形状，事件监听方都兼容）
      if (message.title === undefined) emit('session', message.sessionId)
      else emit('session', message.sessionId, message.title)
      break
    case 'cockpit.auth-expired':
      emit('auth-expired')
      break
    case 'cockpit.focus-proposal':
      emit('focus-proposal', message.id)
      break
    case 'cockpit.focus-canvas':
      emit('focus-canvas', message.id)
      break
    case 'cockpit.turn':
      emit('turn', message.running)
      break
  }
}

/**
 * 把当前档位的布局同步给 App（`cockpit.layout { scale, sessions }`，docs/26 §5）。
 * 只在 ready 之后发：App 还没接管 postMessage 时发过去会被丢掉。
 */
function postLayout(): void {
  if (!ready.value || !props.layout) return
  post(cockpitLayoutMessage(props.layout))
}

// 令牌过期后父页面换来的新码：等 iframe 就绪再发（不重载 iframe）
watch(
  () => props.code,
  (code) => {
    if (code && ready.value && code !== initialCode.value) postHandoff()
  },
)

// 切会话 → 让 iframe 跟着切
watch(
  () => props.sessionId,
  (sessionId) => {
    if (sessionId) post({ type: 'cockpit.focus-session', sessionId })
  },
)

// 「问 DSH」/「追问这一行」：seq 变化才算新的一次（同一句话连点两次也要发）
watch(
  () => props.prefill?.seq,
  () => {
    const text = props.prefill?.text
    if (text) post({ type: 'cockpit.prefill', text })
  },
)

// 档位变化（拖窗口跨档）：ready 之后再发一次布局（docs/26 §5）
watch(
  () => props.layout,
  () => postLayout(),
  { deep: true },
)

onMounted(() => {
  window.addEventListener('message', onMessage)
})

onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage)
  themeGuard?.disconnect()
})

/**
 * 占位面板点了会话：直接进同一份处理逻辑。
 * （不发 `window.postMessage` —— jsdom 不填 `origin`，测试里跟浏览器行为不一致；
 * 真实 iframe 那条路的 origin 校验由 `parseCockpitMessage` 单独覆盖。）
 */
function onPlaceholderSession(id: string | null): void {
  handleInbound({ type: 'cockpit.session', sessionId: id })
}

/** 占位面板模拟 App 的 `cockpit.ready`（可带 caps，`null` = 老 App）。 */
function onPlaceholderReady(caps?: string[]): void {
  handleInbound(caps ? { type: 'cockpit.ready', caps } : { type: 'cockpit.ready' })
}

/** 占位面板模拟 App 的 `cockpit.status`。 */
function onPlaceholderStatus(status: CockpitAppStatus): void {
  handleInbound({ type: 'cockpit.status', ...status })
}

/** 父页面换码后（令牌过期）：iframe 还在，重新发一次（与 `code` 的 watch 重复时只发一次） */
function sendHandoff(code: string): void {
  postHandoffCode(code)
}

let themeGuard: MutationObserver | null = null

/**
 * 浅色嵌入（AI 助手页）把 App 钉在浅色：App 主题缺省「跟随系统」，系统是深色时会整页切深色，
 * 而本页只换了 `--bg`，结果是白底 + 黑输入框 + 看不清的灰字。App 自己（设置变化 / 系统切换）
 * 改回 `data-theme` 时再按回来。
 */
function pinLightTheme(doc: Document, background: string | null): void {
  const root = doc.documentElement
  const pin = () => {
    if (root.dataset.theme !== 'light') root.dataset.theme = 'light'
    // App 切主题时顺手写 inline 底色（深色那块），一起按回来
    if (background) root.style.background = background
    else root.style.removeProperty('background')
  }
  pin()
  themeGuard?.disconnect()
  themeGuard = new MutationObserver(pin)
  themeGuard.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
}

function onFrameLoad(): void {
  loaded.value = true
  if (!frameRef.value) return
  try {
    const doc = frameRef.value.contentDocument
    if (!doc) return
    const color = props.pageBackground
      ? getComputedStyle(frameRef.value).getPropertyValue(props.pageBackground).trim() || null
      : null
    if (color && !doc.getElementById('hub-embed-bg')) {
      const style = doc.createElement('style')
      style.id = 'hub-embed-bg'
      style.textContent = `:root,[data-theme='light']{--bg:${color};}`
      doc.head.append(style)
    }
    // 嵌入的 App 页恒按浅色主题渲染（AI 助手页的白底/暖白底）
    pinLightTheme(doc, color)
  } catch {
    // 跨源（不该发生）就保持 App 自己的主题和底色
  }
}

defineExpose({ sendHandoff, isReady: () => ready.value })
</script>

<template>
  <div class="cockpit-frame">
    <iframe
      v-if="mode === 'iframe'"
      ref="frameRef"
      class="cockpit-frame__iframe"
      :src="src"
      title="座舱对话"
      referrerpolicy="no-referrer"
      @load="onFrameLoad"
    />

    <CockpitPlaceholder
      v-else
      :sessions="sessions"
      :session-id="sessionId"
      :prefill="placeholderPrefill"
      :layout="layout"
      @session="onPlaceholderSession"
      @ready="onPlaceholderReady"
      @status="onPlaceholderStatus"
    />

    <p v-if="mode === 'iframe' && loaded && !ready" class="cockpit-frame__hint">
      <span class="i-ph-circle-notch ring-spin" aria-hidden="true" />
      正在连接座舱对话…
    </p>
  </div>
</template>

<style scoped>
/* 中控台：比两舷亮一档的描边 + 顶边地平线辉光 + 底下一圈很淡的光晕，视线自然落在中间 */
.cockpit-frame {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  border: var(--border-width) solid var(--b-line-strong, var(--c-border));
  border-radius: var(--radius-card-lg, var(--radius-card));
  background: var(--b-console, var(--c-surface));
  box-shadow: var(--b-console-shadow, var(--shadow-card));
}

.cockpit-frame::before {
  position: absolute;
  z-index: 1;
  top: -1px;
  right: 10%;
  left: 10%;
  height: 1px;
  background: var(--b-horizon, var(--c-sky));
  content: '';
  pointer-events: none;
}

.cockpit-frame__iframe {
  width: 100%;
  flex: 1;
  border: 0;
  border-radius: inherit;
  /* 嵌入页本身透明，透出的就是页面底色；嵌入页是浅色，color-scheme 对上免得 Chrome 垫深色底 */
  background: transparent;
  color-scheme: light;
}

.cockpit-frame__hint {
  position: absolute;
  bottom: var(--space-3);
  left: 50%;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-pill);
  background: var(--c-surface-glass);
  color: var(--c-text-2);
  font-size: var(--fs-12);
  transform: translateX(-50%);
}
</style>
