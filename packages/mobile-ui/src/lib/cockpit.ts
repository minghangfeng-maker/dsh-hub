/**
 * 管理座舱「嵌入模式」（WP56d / docs/24 §6）。
 *
 * 手机网页版由 Hub 前端用**同源 iframe** 嵌进 `/admin` 座舱页：
 *
 *   /admin（Hub 前端）
 *    └─ iframe src="/m/?embed=cockpit#code=<交接码>"   ← 父页面每次新开/续期时换一个码
 *
 * 本文件只做三件事（都是可单测的纯逻辑 + 一层可注入的桥）：
 *  1. **入口解析**：认出 `?embed=cockpit`、从 hash 里取出交接码并把它从地址栏抹掉；
 *  2. **postMessage 桥**：双向校验 `event.origin === location.origin`；父页面不存在时静默；
 *  3. **展示用的小工具**：会话行的「发起人」、宽屏阈值（≥ 760 px 常驻左栏）。
 *
 * 令牌本身不在这里：交换在 `stores/auth.ts`（`sessionStorage` 的 cockpit 键，见 lib/storage.ts），
 * 这里只是把「有没有 code / 是不是嵌入模式」告诉它。
 */

import {
  COCKPIT_CODE_HASH_KEY,
  COCKPIT_EMBED_PARAM,
  COCKPIT_EMBED_VALUE,
  COCKPIT_INITIATOR_KEYS,
  cockpitInitiatorText,
  type OpsCallProposal,
} from '@dsh-hub/mobile-core'

// ── 入口：?embed=cockpit#code=… ────────────────────────────────────────────

/**
 * 舰桥主题参数（docs/24 §1「视觉方向：舰桥主题 bridge」/§6）：
 * 父页面用 `?embed=cockpit&theme=bridge` 传进来，App 就得**强制深色 + 透明背景**，
 * 不能再出现一块白底（Hub 舰桥是深色面板，白底会像贴了张纸）。
 */
export const COCKPIT_THEME_PARAM = 'theme'
export const COCKPIT_BRIDGE_THEME = 'bridge'
/** 舰桥主题时加在 `<html>` 上的类名（`styles/cockpit-bridge.css` 的作用域）。 */
export const COCKPIT_BRIDGE_CLASS = 'cockpit-bridge'
/**
 * 控制台主题（WP58 / docs/26 §3）：`?embed=cockpit&theme=console`。
 *
 * 与管理台的 AI 助手页配套——桌面控件（下拉 / 分段 / 悬停）、**强制浅色**、背景透明。
 * 作用域是 `html.cockpit-console`（`styles/cockpit-console.css`），
 * 普通 `/m/`、APK、`theme=bridge` 一条都不会命中。
 */
export const COCKPIT_CONSOLE_THEME = 'console'
export const COCKPIT_CONSOLE_CLASS = 'cockpit-console'

/** 嵌入主题：`bridge` 舰桥深色 / `console` 控制台浅色 / null = 跟随 App 自己的主题设置。 */
export type CockpitTheme = 'bridge' | 'console'

export interface CockpitEntry {
  /** 是嵌入模式（网页构建 + `?embed=cockpit`）。 */
  embed: boolean
  /** 交接码（hash 里的 `code=`），没有就是 null。 */
  code: string | null
  /** 抹掉交接码之后的 hash（含 `#`，没有内容时是空串）。 */
  cleanedHash: string
  /** `theme=bridge` / `theme=console`，其它值或没给是 null。 */
  theme: CockpitTheme | null
}

/**
 * 从 `location.search` / `location.hash` 里认出嵌入模式与交接码（纯函数）。
 *
 * 为什么码在 hash 里：docs/24 §7 —— 交接码只在 `/api/admin/cockpit/handoff` 的响应里出现，
 * 写进 iframe 的 URL **hash**（不进服务器日志、不发 Referer 给静态资源）。App 读到之后
 * 必须**立刻**从地址栏抹掉（`cleanedHash`），别让它留在历史记录/用户可见的地方。
 */
export function parseCockpitEntry(search: string, hash: string): CockpitEntry {
  const embed = isCockpitEmbedSearch(search)
  return {
    embed,
    code: embed ? readCockpitCode(hash) : null,
    cleanedHash: embed ? stripCockpitCode(hash) : hash,
    theme: embed ? readCockpitTheme(search) : null,
  }
}

/** `?theme=bridge` → `'bridge'`、`?theme=console` → `'console'`（其它值/没给 → null：跟随 App 自己的主题设置）。 */
export function readCockpitTheme(search: string): CockpitTheme | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const theme = (params.get(COCKPIT_THEME_PARAM) ?? '').trim().toLowerCase()
  if (theme === COCKPIT_BRIDGE_THEME) return 'bridge'
  if (theme === COCKPIT_CONSOLE_THEME) return 'console'
  return null
}

/** `?embed=cockpit`（大小写不敏感；其它值一律不算）。 */
export function isCockpitEmbedSearch(search: string): boolean {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  return (params.get(COCKPIT_EMBED_PARAM) ?? '').trim().toLowerCase() === COCKPIT_EMBED_VALUE
}

/**
 * 读 hash 里的交接码：`#code=abc`、`#code=abc&x=1`、`#/c/s1?code=abc` 都认。
 *
 * 码的长度上限按 Hub 契约（`CockpitHandoffExchangeRequestSchema`：1..200）截断校验，
 * 明显不合法的当作没有（别把一个坏码发给 Hub）。
 */
export function readCockpitCode(hash: string): string | null {
  const params = hashParams(hash)
  const code = (params.get(COCKPIT_CODE_HASH_KEY) ?? '').trim()
  if (code === '' || code.length > 200) return null
  return code
}

/** 抹掉 hash 里的 `code`（其它参数与 hash 路由路径原样保留）。 */
export function stripCockpitCode(hash: string): string {
  if (hash === '' || hash === '#') return ''
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const queryAt = raw.indexOf('?')
  // 没有 `?` 但带 `=` 的 hash（`#code=abc`）整段都是查询串；否则前半是 hash 路由路径。
  const path = queryAt >= 0 ? raw.slice(0, queryAt) : raw.includes('=') ? '' : raw
  const query = queryAt >= 0 ? raw.slice(queryAt + 1) : raw.includes('=') ? raw : ''
  const params = new URLSearchParams(query)
  if (!params.has(COCKPIT_CODE_HASH_KEY)) return hash
  params.delete(COCKPIT_CODE_HASH_KEY)
  const rest = params.toString()
  if (path === '') return rest === '' ? '' : `#${rest}`
  return rest === '' ? `#${path}` : `#${path}?${rest}`
}

function hashParams(hash: string): URLSearchParams {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const queryAt = raw.indexOf('?')
  if (queryAt >= 0) return new URLSearchParams(raw.slice(queryAt + 1))
  return new URLSearchParams(raw.includes('=') ? raw : '')
}

// ── postMessage 桥（docs/24 §6 的全部消息 + docs/26 §5 的增补）───────────────

/**
 * `cockpit.ready` 里的能力声明（docs/26 §5）：**只有 `theme=console` 才带**。
 * 父页面据此知道「这个 iframe 会发 cockpit.status、认 cockpit.layout」；
 * 老 App 不带 `caps`，Hub 走「收到 ready 就算 ready」的老逻辑。
 */
export const COCKPIT_CONSOLE_CAPS: readonly string[] = ['status', 'layout', 'console']

/** `cockpit.status` 的阶段（docs/26 §4.1/§5）。 */
export type CockpitStatusPhase =
  | 'auth'
  | 'waking'
  | 'connecting'
  | 'ready'
  | 'offline'
  | 'blocked'

/** 子 → 父：已经进入嵌入模式并把桥挂好了。 */
export type CockpitOutgoingMessage =
  /** `caps` 可选（WP58）：只有 theme=console 才带 `['status','layout','console']` */
  | { type: 'cockpit.ready'; caps?: string[] }
  /** `title` 可选（2026-10-30 追加）：两舷铭牌显示会话标题，老父页面忽略它 */
  | { type: 'cockpit.session'; sessionId: string | null; title?: string }
  | { type: 'cockpit.auth-expired' }
  /** 点了「⟶ 已投放左舷/右舷：…」：让父页面闪烁并滚动到那张卡（docs/24 §1/§6）。 */
  | { type: 'cockpit.focus-canvas'; id: string }
  | { type: 'cockpit.focus-proposal'; id: number }
  /** 回合开始/结束：父页面据此区分「本回合投放的卡」（docs/24 §6）。 */
  | { type: 'cockpit.turn'; running: boolean }
  /** 加载阶段（docs/26 §5）：变化时才发（同一 phase 不重复发），`message` 是给人看的中文。 */
  | { type: 'cockpit.status'; phase: CockpitStatusPhase; message?: string }

/** 会话列表形态（docs/26 §3.3）：`docked` = 常驻左栏，`menu` = 保持下拉。 */
export type CockpitLayoutSessions = 'docked' | 'menu'

/** 父 → 子。 */
export type CockpitIncomingMessage =
  | { type: 'cockpit.focus-session'; sessionId: string }
  | { type: 'cockpit.prefill'; text: string }
  | { type: 'cockpit.handoff'; code: string }
  /** 档位与布局（docs/26 §5）：App 用 zoom 应用 scale，并切换会话列表形态。 */
  | { type: 'cockpit.layout'; scale: number; sessions: CockpitLayoutSessions }

/**
 * `cockpit.ready` 的内容（WP58）：控制台主题才带 `caps`，其它主题与以前完全一致（只有 type）。
 * 抽成纯函数是为了能单测「老主题不带 caps、console 带三个能力」这一条。
 */
export function cockpitReadyMessage(consoleTheme: boolean): CockpitOutgoingMessage {
  return consoleTheme
    ? { type: 'cockpit.ready', caps: [...COCKPIT_CONSOLE_CAPS] }
    : { type: 'cockpit.ready' }
}

/** 可以 `postMessage` / 监听 message 的窗口最小形状（单测注入）。 */
export interface CockpitWindowLike {
  postMessage(message: unknown, targetOrigin: string): void
  addEventListener(type: 'message', handler: (event: CockpitMessageEventLike) => void): void
  removeEventListener(type: 'message', handler: (event: CockpitMessageEventLike) => void): void
}

/** `MessageEvent` 的最小形状（`origin` / `data` / `source`）。 */
export interface CockpitMessageEventLike {
  data: unknown
  origin: string
  source?: unknown
}

/** 文本类字段的上限（防御性：父页面也可能给出超长内容）。 */
const MAX_PREFILL_TEXT = 8_000
const MAX_SESSION_ID = 200
const MAX_CODE = 200

function textOf(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '' || text.length > max) return null
  return text
}

/** 缩放范围（docs/26 §5）：父页面传什么都夹在 1–1.5，避免把界面缩成一条缝或放大到溢出。 */
export const COCKPIT_SCALE_MIN = 1
export const COCKPIT_SCALE_MAX = 1.5

/** 把父页面给的 scale 夹到 1–1.5；非法值当作 1（不缩放）。 */
export function clampCockpitScale(value: unknown): number {
  const scale = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(scale)) return COCKPIT_SCALE_MIN
  const clamped = Math.min(COCKPIT_SCALE_MAX, Math.max(COCKPIT_SCALE_MIN, scale))
  // 三位小数够用（Hub 的档位只有 1 / 1.125 / 1.25）：别把浮点尾巴带进 zoom
  return Math.round(clamped * 1000) / 1000
}

/** 会话列表形态只认这两个值（其它一律当不合法的消息丢掉）。 */
export function readCockpitLayoutSessions(value: unknown): CockpitLayoutSessions | null {
  return value === 'docked' || value === 'menu' ? value : null
}

/**
 * 校验并归一化父页面发来的消息（纯函数）。**不合法就返回 null**（静默丢弃，不抛错）。
 *
 * 只认 docs/24 §6 里的三条 + docs/26 §5 新增的 `cockpit.layout`；
 * 别的 `type` 一律忽略 —— 父页面以后加消息不该让 iframe 报错。
 */
export function parseCockpitIncoming(data: unknown): CockpitIncomingMessage | null {
  if (data === null || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  switch (record.type) {
    case 'cockpit.focus-session': {
      const sessionId = textOf(record.sessionId, MAX_SESSION_ID)
      return sessionId === null ? null : { type: 'cockpit.focus-session', sessionId }
    }
    case 'cockpit.prefill': {
      const text = textOf(record.text, MAX_PREFILL_TEXT)
      return text === null ? null : { type: 'cockpit.prefill', text }
    }
    case 'cockpit.handoff': {
      const code = textOf(record.code, MAX_CODE)
      return code === null ? null : { type: 'cockpit.handoff', code }
    }
    case 'cockpit.layout': {
      // 形状不对就整条丢掉（宁可不缩放，也不要按半个消息把布局切坏）
      const sessions = readCockpitLayoutSessions(record.sessions)
      if (sessions === null) return null
      if (typeof record.scale !== 'number' && typeof record.scale !== 'string') return null
      const scale = Number(record.scale)
      if (!Number.isFinite(scale)) return null
      return { type: 'cockpit.layout', scale: clampCockpitScale(scale), sessions }
    }
    default:
      return null
  }
}

/**
 * 同源 iframe 的双向消息桥。
 *
 * 规则（docs/24 §6）：
 *  - 两个方向都校验 `event.origin === location.origin`（非同源一律丢弃）；
 *  - 发送用 `targetOrigin = location.origin`（不是 `'*'`：别把会话 id 发给任何人）；
 *  - **父页面不存在时不报错**（用户直接用浏览器打开 `/m/?embed=cockpit` 也一样能用）；
 *  - 额外挡一层 `event.source === parentWindow`：同一个 origin 的别的窗口也发不进来。
 */
export class CockpitBridge {
  private readonly selfWindow: CockpitWindowLike | null
  private readonly parentWindow: CockpitWindowLike | null
  private readonly origin: string
  private readonly onMessage: (message: CockpitIncomingMessage) => void
  private started = false
  private readonly handler = (event: CockpitMessageEventLike): void => this.handleMessage(event)

  constructor(options: {
    selfWindow: CockpitWindowLike | null
    parentWindow: CockpitWindowLike | null
    origin: string
    onMessage: (message: CockpitIncomingMessage) => void
  }) {
    this.selfWindow = options.selfWindow
    this.parentWindow = options.parentWindow
    this.origin = options.origin
    this.onMessage = options.onMessage
  }

  /** 有没有父页面（顶层打开 / 父页面就是自己 = 没有）。 */
  get attached(): boolean {
    return (
      this.parentWindow !== null && this.selfWindow !== null && this.parentWindow !== this.selfWindow
    )
  }

  /** 发一条消息给父页面；没有父页面 / 发送失败都返回 false（**不抛错**）。 */
  post(message: CockpitOutgoingMessage): boolean {
    if (!this.attached || this.parentWindow === null) return false
    try {
      this.parentWindow.postMessage(message, this.origin)
      return true
    } catch {
      return false
    }
  }

  /** 开始监听父页面消息（重复调用无副作用）。 */
  start(): void {
    if (this.started || this.selfWindow === null) return
    this.started = true
    this.selfWindow.addEventListener('message', this.handler)
  }

  stop(): void {
    if (!this.started || this.selfWindow === null) return
    this.started = false
    this.selfWindow.removeEventListener('message', this.handler)
  }

  /** 单测直接喂事件（真实路径是 `start()` 之后的 message 事件）。 */
  handleMessage(event: CockpitMessageEventLike): void {
    if (event.origin !== this.origin) return
    if (!this.attached) return
    if (event.source !== undefined && event.source !== this.parentWindow) return
    const message = parseCockpitIncoming(event.data)
    if (message === null) return
    this.onMessage(message)
  }
}

// ── 界面小工具 ──────────────────────────────────────────────────────────────

/**
 * 会话行上的「发起人」（docs/24 §10 第 4 条：多个管理员共享同一个座舱会话列表）。
 *
 * Hub 侧的字段名还没最终定，core 的 `withCockpitSessionInitiators` 已经把原始帧里的
 * 几个候选键（`initiator` / `owner` / `createdBy` / `startedBy`）归一化成 `initiator`。
 * 这里再容错读一次（历史缓存里的行可能来自别的版本），读不到就返回 null —— 不显示，也不编造。
 */
export function sessionInitiatorOf(row: unknown): string | null {
  if (row === null || typeof row !== 'object') return null
  const record = row as Record<string, unknown>
  for (const key of COCKPIT_INITIATOR_KEYS) {
    const text = cockpitInitiatorText(record[key])
    if (text !== null) return text
  }
  return null
}

/**
 * 方案/投放这类结果类型与文案都在 core 的 `cockpit/embed.ts`（`opsCallProposalOf` /
 * `canvasActionOf` / `cockpitActionText`），UI 只 import，不自己拼文案。
 * 这里只做一个顺手转发，方便组件层只从 `@/lib/cockpit` 取。
 */
export type { OpsCallProposal } from '@dsh-hub/mobile-core'
