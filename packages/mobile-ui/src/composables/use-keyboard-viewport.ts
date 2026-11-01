/**
 * 键盘 / 可视视口 → CSS 变量（网页版 WP54 / W2）。
 *
 * APK 里键盘由 Capacitor 的 Keyboard 插件 resize WebView，输入卡天然被顶上来；
 * 浏览器里没有这个插件，只能看 `visualViewport`：
 *
 *   blocked = innerHeight − vv.height − vv.offsetTop
 *           = 「布局视口底部被键盘（或浏览器工具栏）挡住了多少」
 *
 * 两种情况分别处理，`index.html` 带不带 W5 的 `interactive-widget=resizes-content` 都对：
 *
 *  1. **带 meta（resizes-content）**：键盘弹起时 `innerHeight` 自己就变小了，blocked ≈ 0，
 *     这里什么都不做（`--app-height` 不设），布局照旧；
 *  2. **不带 meta（resizes-visual，iOS Safari 永远是这样）**：`innerHeight` 不变、
 *     `vv.height` 变小，blocked ≈ 键盘高度 —— 这时把整个壳缩到 `innerHeight − blocked`
 *     （`--app-height`），输入卡、发送锚定的底部留白、问题导航条都跟着上移，不会藏在键盘后面。
 *
 * 为什么用「缩壳」而不是给输入卡加 padding：抽屉/弹层是 `position: fixed`，
 * 只有壳真的变矮，它们（以及底部的留白计算）才会一起让开键盘。
 *
 * 网页版还会把 `--kb-inset` 钉成 0：`.composer` 那条 padding 兜底是老逻辑
 * （只有 `innerHeight` 不变时才有值），和缩壳叠加会把输入卡顶得太高。
 *
 * 阈值 80px：比这小的差异是浏览器工具栏收放（不是键盘），不值得动布局。
 * 双指缩放（`vv.scale ≠ 1`）时也不动：那时 `vv.height` 是缩放后的可见高度，不能拿来当布局高度。
 */

import { IS_WEB_BUILD } from '@/lib/app-info'

/** 小于这个高度的「底部遮挡」当作浏览器工具栏，不按键盘处理。 */
export const KEYBOARD_MIN_INSET = 80

export interface ViewportMetrics {
  /** 布局视口高度（`window.innerHeight`）。 */
  innerHeight: number
  /** 可视视口高度；没有 visualViewport 时等于 innerHeight。 */
  visualHeight: number
  /** 可视视口相对布局视口的纵向偏移（iOS 把页面顶上去时非 0）。 */
  visualOffsetTop: number
  /** 双指缩放倍数（没有 visualViewport 时按 1）。 */
  scale: number
}

export interface KeyboardLayout {
  /** 底部被键盘挡住了多少 px（0 = 没键盘）。 */
  blocked: number
  /** 是否按「键盘弹起」处理。 */
  keyboard: boolean
  /** 壳应该用的高度（px）；`null` 表示回到 100%。 */
  appHeight: number | null
  /** APK 老逻辑用的底部内边距（网页版恒为 0，见文件头）。 */
  kbInset: number
}

/**
 * 由可视视口尺寸算出布局该怎么让（纯函数，单测直接摆数字）。
 *
 * `web` 显式传进来（默认取构建期常量 `IS_WEB_BUILD`）：单测要同时覆盖网页版与 APK 两套口径。
 */
export function planKeyboardLayout(
  metrics: ViewportMetrics,
  web: boolean = IS_WEB_BUILD,
): KeyboardLayout {
  const innerHeight = Math.max(0, metrics.innerHeight)
  const visualHeight = Math.max(0, metrics.visualHeight)
  const offsetTop = Math.max(0, metrics.visualOffsetTop)
  const blocked = Math.max(0, Math.round(innerHeight - visualHeight - offsetTop))
  const zoomed = Math.abs(metrics.scale - 1) > 0.01
  if (!web) {
    // APK：Keyboard 插件已经 resize 过，这里恒为 0；保留原来的兜底口径
    return { blocked, keyboard: false, appHeight: null, kbInset: blocked }
  }
  const keyboard = !zoomed && blocked >= KEYBOARD_MIN_INSET
  return {
    blocked,
    keyboard,
    appHeight: keyboard ? Math.max(0, Math.round(innerHeight - blocked)) : null,
    kbInset: 0,
  }
}

function readMetrics(): ViewportMetrics {
  const vv = window.visualViewport
  return {
    innerHeight: window.innerHeight,
    visualHeight: vv ? vv.height : window.innerHeight,
    visualOffsetTop: vv ? vv.offsetTop : 0,
    scale: vv ? vv.scale : 1,
  }
}

/**
 * 开始跟踪键盘/可视视口。返回停止函数（App.vue 卸载时调用）。
 *
 * 监听三种信号：`visualViewport.resize`（键盘弹起/收起）、`visualViewport.scroll`
 * （iOS 是把页面顶上去而不是 resize）、`window.resize` / `orientationchange`
 * （转屏、带 meta 时布局视口自己变高）。
 */
export function startKeyboardViewport(): () => void {
  const root = document.documentElement

  const apply = (): void => {
    const plan = planKeyboardLayout(readMetrics())
    if (plan.appHeight === null) root.style.removeProperty('--app-height')
    else root.style.setProperty('--app-height', `${plan.appHeight}px`)
    root.style.setProperty('--kb-inset', `${plan.kbInset}px`)
    if (IS_WEB_BUILD) root.dataset.kb = plan.keyboard ? 'open' : 'closed'
  }

  apply()
  const vv = window.visualViewport
  vv?.addEventListener('resize', apply)
  if (IS_WEB_BUILD) vv?.addEventListener('scroll', apply)
  window.addEventListener('resize', apply)
  window.addEventListener('orientationchange', apply)
  return () => {
    vv?.removeEventListener('resize', apply)
    vv?.removeEventListener('scroll', apply)
    window.removeEventListener('resize', apply)
    window.removeEventListener('orientationchange', apply)
  }
}
