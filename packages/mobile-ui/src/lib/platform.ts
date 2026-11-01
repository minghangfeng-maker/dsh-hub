/** 原生能力的薄封装：所有调用都先判断平台，浏览器里跑 dev 时不会抛错。 */

import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { Keyboard } from '@capacitor/keyboard'
import { IS_WEB_BUILD } from './app-info'
import { isCockpitEmbed } from './cockpit-embed'
import { HAPTIC_STRONG_MS, HAPTIC_TAP_MS, webHaptic } from './haptic-web'

export const isNative = (): boolean => Capacitor.isNativePlatform()
export const platformName = (): string => Capacitor.getPlatform()

/** 触感：只用在发送、停止、长按（文档 §6.3 第 5 条） */
export async function hapticTap(): Promise<void> {
  if (!isNative()) {
    webHaptic(HAPTIC_TAP_MS)
    return
  }
  try {
    await Haptics.impact({ style: ImpactStyle.Light })
  } catch {
    /* 忽略：旧设备或未授予权限 */
  }
}

export async function hapticStrong(): Promise<void> {
  if (!isNative()) {
    webHaptic(HAPTIC_STRONG_MS)
    return
  }
  try {
    await Haptics.impact({ style: ImpactStyle.Medium })
  } catch {
    /* ignore */
  }
}

/**
 * 手机网页版（WP54 / W2）启动时的一次性准备：APK 构建里整体是空操作。
 *
 * 只做「构建期就知道、和具体组件无关」的事：给 `<html>` 打 `is-web` 类。
 * App.vue 的全局样式按这个类开网页版专属规则（整页回弹/下拉刷新、输入框字号、
 * 长按选择），APK 构建里那些选择器一条都不会命中。
 *
 * 判断「是不是网页版」一律用构建期常量 `IS_WEB_BUILD`，**不要**用 `isNative()` 推断：
 * 开发时在电脑浏览器里跑 APK 构建（vite dev / e2e）`isNative()` 也是 false，用它推断会把
 * 开发预览当成网页版。
 */
export function initWebShell(): void {
  if (!IS_WEB_BUILD) return
  document.documentElement.classList.add('is-web')
}

// ── 返回键：Android 物理返回键 / 浏览器返回（网页版）──────────────────────────

export interface BackEvent {
  canGoBack: boolean
}

/**
 * 返回键处理函数。返回值只有网页版会看：
 *  - `true`：这次确实关掉了一层（或把路由换回了首页）；
 *  - `false`：什么也没关（已经在根页面）——网页版据此给一句提示，仍然留在页面里。
 * APK 不看返回值（行为与 0.4.x 完全一致）。
 */
export type BackHandler = () => void | boolean | Promise<void | boolean>

/** 网页版历史守卫的标记键。 */
const BACK_GUARD_KEY = '__dshBackGuard'

/** 这条历史记录是不是我们压的「守卫」（同 URL 的一条占位记录）。 */
export function isBackGuardState(state: unknown): boolean {
  if (typeof state !== 'object' || state === null) return false
  return (state as Record<string, unknown>)[BACK_GUARD_KEY] === 1
}

/**
 * 生成守卫记录的历史 state：**原样复制当前 state**，只多一个标记。
 *
 * 为什么要复制：hash 路由由 vue-router 记账（它把自己的 `position` / `scroll` 存在
 * `history.state` 里，popstate 时读回来）。守卫记录 URL 不变，把它的 state 带上就不会
 * 打断 vue-router 的记账；少了这些键，它 popstate 时会当成「未知历史」处理。
 */
export function withBackGuard(state: unknown): Record<string, unknown> {
  const base =
    typeof state === 'object' && state !== null ? { ...(state as Record<string, unknown>) } : {}
  return { ...base, [BACK_GUARD_KEY]: 1 }
}

/** 在栈顶压一条守卫记录（URL 不变，所以不会触发路由导航）。 */
function pushBackGuard(): void {
  try {
    history.pushState(withBackGuard(history.state), '', location.href)
  } catch {
    /* 隐私模式/被策略禁用：退化成没有守卫，返回走浏览器默认行为 */
  }
}

/**
 * 保证历史栈顶是守卫（已经是最上面那条就什么都不做）。网页版专用，APK 里是空操作。
 *
 * 为什么要有守卫：网页里「返回」只能靠 history，而打开抽屉/弹层**不应该**产生一条历史
 * 记录（否则 × 关闭时就得再补一次 back()，很容易「多退一步」直接退出页面）。所以改成
 * **常驻一条同 URL 的守卫记录**顶在最上面：
 *   - 抽屉/弹层/设置页打开时什么也不用做，返回键天然先被这条记录接住；
 *   - 每次处理完返回（关掉一层、或者本来就在首页）再把守卫补回栈顶，
 *     于是「连开两层连按两次返回」逐层关、「首页再按返回」停在首页；
 *   - 用界面上的 × 关闭时栈里还是那一条，不会越积越多，也不用 back() 一次。
 *
 * 调用点（都在 W2 自己的文件里）：`onBackButton` 安装后、每次路由导航结束（App.vue 的
 * afterEach）、每层遮罩打开时（App.vue 的 watcher，兜住守卫被别的历史记录盖住的情况）、
 * 每次处理完一次 popstate。
 */
export function ensureBackGuard(): void {
  if (!IS_WEB_BUILD) return
  // 嵌入座舱（WP56d）：页面在 iframe 里，浏览器的「返回」不该被 App 抢走 ——
  // 父页面（/admin）自己管历史，这里不要往 iframe 的历史栈里压记录。
  if (isCockpitEmbed()) return
  if (!isBackGuardState(history.state)) pushBackGuard()
}

/**
 * 网页版的返回键：把 `popstate`（浏览器返回 / 侧滑返回 / Android 系统返回）接到同一个
 * 处理函数上，并用守卫记录保证**永远不会真的离开页面**。
 */
function installWebBack(handler: BackHandler): () => void {
  let running = false
  let queued = false

  const onPopState = (): void => {
    // 连点返回：前一次还在处理（可能要等路由 replace）时排队，处理完再补一次，
    // 这样两层抽屉连按两次也是逐层关，不会丢一次。
    if (running) {
      queued = true
      return
    }
    running = true
    void Promise.resolve()
      .then(() => handler())
      .catch(() => {
        /* 处理函数自己的异常不影响返回语义 */
      })
      .then(() => {
        // 不论这次关掉了一层还是本来就在首页，都留在页面里：
        // APK 在首页按返回是 minimizeApp（退到桌面），浏览器没有等价物，也不能真的离开 /m/。
        ensureBackGuard()
        running = false
        if (queued) {
          queued = false
          onPopState()
        }
      })
  }

  window.addEventListener('popstate', onPopState)
  ensureBackGuard()
  return () => window.removeEventListener('popstate', onPopState)
}

/** Android 物理返回键（Capacitor 会先吃掉，交给 JS 决定）；网页版走 history 守卫。 */
export async function onBackButton(handler: BackHandler): Promise<() => void> {
  if (IS_WEB_BUILD) return installWebBack(handler)
  if (!isNative()) return () => {}
  const handle = await App.addListener('backButton', () => void handler())
  return () => void handle.remove()
}

// ── 前后台：Capacitor appStateChange / 浏览器生命周期（网页版）────────────────

/**
 * 前后台事件的来源。`native` = Capacitor 的 `appStateChange`（APK 唯一来源）；
 * 其余是网页版：`visibilitychange`、`pagehide`、`pageshow`（bfcache 恢复）、
 * `freeze` / `resume`（Chrome Page Lifecycle）。
 */
export type LifecycleSource =
  | 'native'
  | 'visibility'
  | 'pagehide'
  | 'pageshow'
  | 'freeze'
  | 'resume'

export interface LifecycleState {
  active: boolean
  /** 上次真正回调的时间（强制回调的合并窗口用它）。 */
  lastNotifyAt: number
}

export interface LifecycleInput {
  active: boolean
  source: LifecycleSource
  /** 状态没变也强制回调一次（bfcache 恢复 / `resume`：链路一定已经断了，必须重连）。 */
  force?: boolean
  now: number
  /** 强制回调的最小间隔，默认 {@link LIFECYCLE_COALESCE_MS}。 */
  coalesceMs?: number
}

/**
 * 相邻两个「回前台」事件的最小间隔：bfcache 恢复时 `pageshow` 和 `visibilitychange`
 * 会背靠背各来一次，间隔太短就不重复回调（否则会连着重连两遍、刷新两遍 bootstrap）。
 */
export const LIFECYCLE_COALESCE_MS = 500

/**
 * 把一次生命周期事件折算成「要不要回调」（纯函数，单测直接摆状态）。
 *
 *  - 前后台状态**变了**：一定回调；
 *  - 状态没变但带 `force`（bfcache 的 `pageshow.persisted`、Page Lifecycle 的 `resume`）：
 *    合并窗口之外再回调一次 —— 这两种情况下页面还在、WebSocket 早就断了，必须触发重连；
 *  - 其余（重复的 visibilitychange 之类）：忽略。
 */
export function planLifecycleEvent(
  state: LifecycleState,
  input: LifecycleInput,
): { notify: boolean; next: LifecycleState } {
  const coalesce = input.coalesceMs ?? LIFECYCLE_COALESCE_MS
  if (input.active !== state.active) {
    return { notify: true, next: { active: input.active, lastNotifyAt: input.now } }
  }
  if (input.force === true && input.now - state.lastNotifyAt >= coalesce) {
    return { notify: true, next: { active: state.active, lastNotifyAt: input.now } }
  }
  return { notify: false, next: state }
}

/**
 * 网页版的 `appStateChange`：把浏览器生命周期接到与 APK 相同的回调上。
 *
 * 覆盖五种事件（APK 只有一种）：
 *  - `visibilitychange`：切页签/切 App 的前后台等价物；
 *  - `pagehide`：离开页面（含进 bfcache）—— 先把通道干净断开，别把半边开的 socket 留在那；
 *  - `pageshow`（`persisted`）：bfcache 恢复。页面没有重新加载，但 WebSocket 早断了，
 *    所以强制按「回前台」处理（探活/重连、会话快照、bootstrap 刷新）；
 *  - `freeze` / `resume`：Chrome Page Lifecycle，冻结/解冻同理（解冻也强制重连）。
 *
 * APK 里这条分支不会走到（`IS_WEB_BUILD` 是构建期常量 false）。
 */
function installWebLifecycle(
  handler: (isActive: boolean, source: LifecycleSource) => void,
): () => void {
  let state: LifecycleState = { active: !document.hidden, lastNotifyAt: 0 }

  const emit = (input: Omit<LifecycleInput, 'now'>): void => {
    const plan = planLifecycleEvent(state, { ...input, now: Date.now() })
    state = plan.next
    if (plan.notify) handler(input.active, input.source)
  }

  const onVisibility = (): void => emit({ active: !document.hidden, source: 'visibility' })
  const onPageHide = (): void => emit({ active: false, source: 'pagehide' })
  const onPageShow = (event: Event): void => {
    const persisted = (event as PageTransitionEvent).persisted === true
    emit({ active: true, source: 'pageshow', force: persisted })
  }
  const onFreeze = (): void => emit({ active: false, source: 'freeze' })
  const onResume = (): void => emit({ active: true, source: 'resume', force: true })

  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('pageshow', onPageShow)
  document.addEventListener('freeze', onFreeze)
  document.addEventListener('resume', onResume)
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', onPageHide)
    window.removeEventListener('pageshow', onPageShow)
    document.removeEventListener('freeze', onFreeze)
    document.removeEventListener('resume', onResume)
  }
}

/** 前后台切换（APK：Capacitor `appStateChange`；网页版：浏览器生命周期，见 {@link installWebLifecycle}） */
export async function onAppStateChange(
  handler: (isActive: boolean, source: LifecycleSource) => void,
): Promise<() => void> {
  if (IS_WEB_BUILD) return installWebLifecycle(handler)
  const handle = await App.addListener('appStateChange', ({ isActive }) => handler(isActive, 'native'))
  return () => void handle.remove()
}

/** 退到桌面（返回键在首页时的行为，不要直接退出 App）；网页版没有等价物，什么也不做。 */
export async function minimizeApp(): Promise<void> {
  if (!isNative()) return
  try {
    await App.minimizeApp()
  } catch {
    /* ignore */
  }
}

/**
 * 焦点放回输入框，但**不把键盘顶起来**（0.4.1 按住说话，微信式）。
 *
 * 语音转文字结束后用户多半还要改字：光标应该落在末尾，但键盘只在用户真的点输入框时
 * 才弹。Android WebView 里对输入框 `focus()` 会异步拉起键盘，所以稍等一拍再 hide()；
 * 各机型时序不完全一致，这里尽力而为，失败也不影响文字已经填进去。
 *
 * 浏览器里没有「focus 但不弹键盘」的等价物（这正是键盘弹出要用户手势的原因），
 * 所以网页版只做 focus + 光标落末尾。
 */
export async function focusKeepKeyboardClosed(el: HTMLTextAreaElement | null): Promise<void> {
  if (!el || el.disabled) return
  try {
    el.focus({ preventScroll: true })
  } catch {
    try {
      el.focus()
    } catch {
      /* ignore */
    }
  }
  try {
    const end = el.value.length
    el.setSelectionRange(end, end)
  } catch {
    /* ignore */
  }
  if (!isNative()) return
  try {
    await Keyboard.hide()
    // 有的 ROM 在 focus 之后才把键盘排上来，再补一次
    setTimeout(() => {
      void Keyboard.hide().catch(() => {})
    }, 60)
  } catch {
    /* ignore */
  }
}

/** 键盘事件（仅原生；网页版用 `composables/use-keyboard-viewport.ts` 的 visualViewport） */
export async function onKeyboard(
  handlers: { onShow?: (height: number) => void; onHide?: () => void },
): Promise<() => void> {
  if (!isNative()) return () => {}
  const removers: Array<() => void> = []
  if (handlers.onShow) {
    const h = await Keyboard.addListener('keyboardWillShow', (info) => handlers.onShow!(info.keyboardHeight))
    removers.push(() => void h.remove())
  }
  if (handlers.onHide) {
    const h = await Keyboard.addListener('keyboardWillHide', () => handlers.onHide!())
    removers.push(() => void h.remove())
  }
  return () => removers.forEach((r) => r())
}
