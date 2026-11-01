/**
 * 嵌入模式的**运行时单例**（WP56d）：入口解析、待用的交接码、postMessage 桥。
 *
 * 为什么单独一个模块（而不是塞进 Pinia store）：
 *  - `main.ts` 必须在**安装 router 之前**就把 `#code=` 从地址栏抹掉（vue-router 用的是
 *    hash 路由，`#code=…` 会被它当成一个不存在的路由）；
 *  - `stores/auth.ts` 的 `init()` 早于任何组件/store 的创建，它要读「有没有待用的码」；
 *  - 两处都需要「是不是嵌入模式」这个**进程级**判断，而且不能互相 import（auth → store 会成环）。
 *
 * 所以这里只放纯状态 + 桥，不 import 任何 store；store 与 auth 都只依赖它。
 */

import { IS_WEB_BUILD } from './app-info'
import { recordDiag } from './diagnostics'
import {
  COCKPIT_BRIDGE_CLASS,
  COCKPIT_CONSOLE_CLASS,
  CockpitBridge,
  parseCockpitEntry,
  readCockpitCode,
  stripCockpitCode,
  type CockpitIncomingMessage,
  type CockpitOutgoingMessage,
  type CockpitWindowLike,
} from './cockpit'

let embed = false
let initialised = false
let pendingCode: string | null = null
let bridge: CockpitBridge | null = null
/** `theme=bridge`：舰桥深色 + 透明背景（docs/24 §1/§6）。 */
let bridgeTheme = false
/** `theme=console`：控制台浅色 + 透明背景（docs/26 §3）。 */
let consoleTheme = false

/** 当前这个页面是不是「嵌入座舱」模式（APK 构建恒 false）。 */
export function isCockpitEmbed(): boolean {
  return embed
}

/** 是不是舰桥主题（父页面传了 `theme=bridge`）：深色 + 透明背景，不允许白底。 */
export function isCockpitBridgeTheme(): boolean {
  return bridgeTheme
}

/**
 * 是不是控制台主题（父页面传了 `theme=console`，docs/26 §3）：
 * **强制浅色**（忽略系统深色与用户自己的主题设置）+ 透明背景 + 桌面控件。
 */
export function isCockpitConsoleTheme(): boolean {
  return consoleTheme
}

/**
 * 读入口（`main.ts` 在 createApp/router 之前调用一次）。
 *
 * `?embed=cockpit` 才进入嵌入模式；同时把 hash 里的 `code` 取出来并**立刻**从地址栏抹掉
 * （`history.replaceState`，不新增历史记录 —— 父页面刷新 iframe 时不会把码留在历史里）。
 *
 * @returns 是否进入嵌入模式
 */
export function initCockpitEmbed(): boolean {
  if (initialised) return embed
  initialised = true
  if (!IS_WEB_BUILD) return false
  const locationLike = typeof globalThis.location === 'undefined' ? null : globalThis.location
  if (locationLike === null) return false
  // 优先用 `theme-boot.js` 在 <head> 里留下的原文：router 的 hash 历史在创建时会改写
  // 非 `#/` 开头的 hash（把 `#code=…` 抹成 `#/`），那时再读地址栏就晚了（见 theme-boot.js 第 3 段）。
  const stashed = (globalThis as { __dshCockpitEntry?: { search?: unknown; hash?: unknown } })
    .__dshCockpitEntry
  const search =
    typeof stashed?.search === 'string' ? stashed.search : (locationLike.search ?? '')
  const hash = typeof stashed?.hash === 'string' ? stashed.hash : (locationLike.hash ?? '')
  const entry = parseCockpitEntry(search, hash)
  embed = entry.embed
  if (!embed) return false
  pendingCode = entry.code
  // 诊断（不含码本身）：父页面的参数形状、有没有拿到码、是不是舰桥主题。
  recordDiag(
    'cockpit:entry',
    `${search}|hash=${entry.code === null ? 'none' : 'code'}|theme=${String(entry.theme)}`,
  )
  bridgeTheme = entry.theme === 'bridge'
  consoleTheme = entry.theme === 'console'
  if (bridgeTheme) applyBridgeTheme()
  if (consoleTheme) applyConsoleTheme()
  if (entry.cleanedHash !== (locationLike.hash ?? '')) {
    try {
      const historyLike = globalThis.history
      const url = `${locationLike.pathname}${locationLike.search}${entry.cleanedHash}`
      historyLike.replaceState(historyLike.state, '', url)
    } catch {
      /* 隐私模式/被策略禁用：码留在地址栏也不会被再次使用（pendingCode 只会消费一次） */
    }
  }
  return true
}

/**
 * 落到 DOM 上：给 `<html>` 打 `cockpit-bridge` 并强制深色。
 *
 * 为什么必须在 App 主包求值**之前**就做：`stores/settings.ts` 会根据用户自己的主题设置
 * 写 `data-theme` 和 inline `background`（浅色是 `#F9F8F6`）—— 舰桥里那会是一块白底。
 * 这里先把类和数据属性挂上，`applyTheme` 再看 `isCockpitBridgeTheme()` 让路（见 stores/settings）。
 */
function applyBridgeTheme(): void {
  try {
    const root = globalThis.document?.documentElement
    if (root === undefined) return
    root.classList.add(COCKPIT_BRIDGE_CLASS)
    root.dataset.theme = 'dark'
    root.style.removeProperty('background')
  } catch {
    /* 没有 DOM（单测）就算了 */
  }
}

/**
 * 落到 DOM 上：给 `<html>` 打 `cockpit-console` 并强制**浅色**（docs/26 §3.1）。
 *
 * 和舰桥同一个口子、同一时刻做：`stores/settings.ts` 的 `applyTheme` 会按用户自己的设置
 * 写 `data-theme` 与 inline `background`（深色是 `#17171A`）—— 控制台里那会是一块深底。
 * 这里先挂类并把 data-theme 定成 light，`applyTheme` 再看 `isCockpitConsoleTheme()` 让路。
 *
 * 背景透明交给 `styles/cockpit-console.css`（`!important`），这里只删掉 theme-boot.js
 * 可能写下的 inline background（删不掉也不影响：CSS 的 `!important` 会压过 inline 普通声明）。
 */
function applyConsoleTheme(): void {
  try {
    const root = globalThis.document?.documentElement
    if (root === undefined) return
    root.classList.add(COCKPIT_CONSOLE_CLASS)
    root.dataset.theme = 'light'
    root.style.removeProperty('background')
  } catch {
    /* 没有 DOM（单测）就算了 */
  }
}

/**
 * 取走待用的交接码（**只能用一次**：取走就清空）。
 *
 * 为什么这么设计：交接码在 Hub 侧是「60 秒、一次性」的。App 只在启动与「父页面重新交接」
 * 时各用一次；任何重试都不该复用同一个码（一定失败，还会让父页面以为码还在）。
 */
export function takeCockpitCode(): string | null {
  const code = pendingCode
  pendingCode = null
  return code
}

/** 父页面发来新码（`cockpit.handoff`）时存起来，等 auth 去交换。 */
export function setCockpitCode(code: string | null): void {
  pendingCode = typeof code === 'string' && code.trim() !== '' ? code.trim() : null
}

/** 当前桥（没有父页面 / 非嵌入模式时是 null）。 */
export function currentCockpitBridge(): CockpitBridge | null {
  return bridge
}

/** 登记桥（组件卸载时传 null 清掉）。 */
export function adoptCockpitBridge(next: CockpitBridge | null): void {
  bridge = next
}

/**
 * 挂桥：只有在嵌入模式**且有父页面**时才建（顶层直接打开 `/m/?embed=cockpit` 时返回 null，
 * 界面照常可用，只是没人跟它说话）。
 */
export function openCockpitBridge(
  onMessage: (message: CockpitIncomingMessage) => void,
): CockpitBridge | null {
  if (!embed) return null
  const win = (globalThis as { window?: unknown }).window as
    | (CockpitWindowLike & { parent?: CockpitWindowLike | null })
    | undefined
  if (win === undefined) return null
  const origin = typeof globalThis.location === 'undefined' ? '' : globalThis.location.origin
  if (origin === '') return null
  const next = new CockpitBridge({
    selfWindow: win,
    parentWindow: win.parent ?? null,
    origin,
    onMessage,
  })
  next.start()
  bridge = next
  return next
}

/** 给父页面发一条消息；没有父页面时静默返回 false（不抛错，docs/24 §6）。 */
export function postCockpitMessage(message: CockpitOutgoingMessage): boolean {
  return bridge !== null && bridge.post(message)
}

/** 令牌过期/401：告诉父页面「重新给我一个交接码」（父页面接着发 `cockpit.handoff`）。 */
export function notifyCockpitAuthExpired(): boolean {
  return postCockpitMessage({ type: 'cockpit.auth-expired' })
}

/**
 * 盯住「地址栏 hash 里又出现了一个交接码」的情况（父页面**不重载 iframe**、只改 hash 时）。
 *
 * docs/24 §6 约定父页面用 `cockpit.handoff` 续期，但另一种实现同样自然：把 iframe 的
 * `location.hash` 改成 `#code=…`（同文档导航、不白屏）。两种都得能用 —— 这里补上第二种：
 * 发现 hash 里有码 → 立刻从地址栏抹掉 → 交给 `onCode`（auth 的 `cockpitHandoff`）。
 *
 * 只有嵌入模式才安装；返回卸载函数（重复调用无副作用）。
 */
export function installCockpitEntryWatcher(onCode: (code: string) => void): () => void {
  if (!embed) return () => undefined
  const win = (globalThis as { window?: { addEventListener?: unknown; removeEventListener?: unknown } })
    .window
  if (win === undefined || typeof win.addEventListener !== 'function') return () => undefined
  const handler = (): void => {
    const locationLike = typeof globalThis.location === 'undefined' ? null : globalThis.location
    if (locationLike === null) return
    const code = readCockpitCode(locationLike.hash ?? '')
    if (code === null) return
    const cleaned = stripCockpitCode(locationLike.hash ?? '')
    try {
      const historyLike = globalThis.history
      historyLike.replaceState(
        historyLike.state,
        '',
        `${locationLike.pathname}${locationLike.search}${cleaned}`,
      )
    } catch {
      /* 抹不掉也不影响：码已经交给 onCode，且不会再用第二次 */
    }
    onCode(code)
  }
  ;(win as { addEventListener: (type: string, fn: () => void) => void }).addEventListener(
    'hashchange',
    handler,
  )
  return () => {
    ;(win as { removeEventListener?: (type: string, fn: () => void) => void }).removeEventListener?.(
      'hashchange',
      handler,
    )
  }
}

/** 单测用：把运行时状态复位（产品代码里没有任何调用点）。 */
export function resetCockpitEmbedForTests(): void {
  embed = false
  initialised = false
  pendingCode = null
  bridgeTheme = false
  consoleTheme = false
  bridge?.stop()
  bridge = null
}
