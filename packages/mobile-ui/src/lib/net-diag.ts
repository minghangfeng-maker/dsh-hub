/**
 * 登录页「网络检测」（0.4.9）：把「登录报网络失败」拆成三种完全不同的原因。
 *
 * 用户的困惑：手机上登录报「网络连接失败，请检查网络后重试」，但分不清是
 *  ① 手机压根没连网；
 *  ② App 被系统/ROM 禁止联网（MIUI 联网控制、ColorOS「WLAN 与移动数据」、vivo 联网权限、
 *     省流量/后台联网限制……）；
 *  ③ 服务器那边连不上（历史真凶：域名未备案被云厂商拦截，HTTP 403 HTML / TLS 被 RST）。
 *
 * 检测三件事（每步 ≤5 秒，总时长 ≤10 秒，②③ 并行）：
 *  ① 手机网络：原生 ConnectivityManager + NetworkCapabilities（`validated` = 系统确认这条网能上网）；
 *  ② 对照站点：国内稳定的 HTTPS 地址，任一通即算「互联网可用」；
 *  ③ DSH Hub：对当前登录用的 Hub 地址发一次轻量 GET（未鉴权也会得到 401，能证明「服务器回答了」）。
 *
 * 关键事实（别做成「弹窗申请网络权限」）：Android 的 INTERNET 是安装时自动授予的普通权限，
 * **没有运行时弹窗**。真正掐断 App 联网的是国产 ROM 的单 App 联网开关，App 只能跳到
 * 「应用详情页」让用户自己打开。所以设置类动作只有 openAppSettings / openNetworkSettings。
 *
 * 平台封装：原生（装了 NetworkDiag 插件）走插件；浏览器/开发环境退回 navigator.onLine + fetch
 * （no-cors，只能区分「到达/没到达」）。设置类按钮在非原生环境不显示。
 *
 * e2e 需要能覆盖对照站点（CI 里连不上外网）：运行时设
 * `window.__dshNetDiagControlSites = ['http://127.0.0.1:PORT/__test/health']`，
 * 或构建期 `VITE_NET_DIAG_CONTROL_SITES`（逗号分隔）。运行时优先。
 *
 * 0.4.11 / WP52：Hub 有多个入口（广州首选 / 新加坡备用）。检测页除了「当前入口通不通」，
 * 还要分别显示**每个入口**的连通性与延迟，并标出当前在用哪个（`hubs` 字段 / `HubTarget`）。
 *
 * 手机网页版（WP54 / C4）：网页版**只有一个入口**（`location.origin`），没有多入口列表与切换；
 * 浏览器里也不存在「App 被 ROM 禁止联网」这种故障，所以 `web: true` 时不给那个结论，
 * 第一行从「手机网络」改叫「本机网络」。
 */

import { Capacitor, registerPlugin } from '@capacitor/core'
import { HUB_ORIGIN } from './app-info'
import { recordDiag } from './diagnostics'

// ── 类型 ────────────────────────────────────────────────────────────────────

export type NetTransport = 'wifi' | 'cellular' | 'ethernet' | 'other' | 'none'

/** 系统对「当前默认网络」的看法（Java 侧 NetworkCapabilities 一一对应）。 */
export interface NetStatus {
  connected: boolean
  transport: NetTransport
  /** NET_CAPABILITY_VALIDATED：系统自己确认这条网能上网。 */
  validated: boolean
  metered: boolean
  /** 后台流量被系统限制（RESTRICT_BACKGROUND_STATUS_ENABLED）。 */
  restrictBackground: boolean
}

export type ProbeErrorKind = 'dns' | 'timeout' | 'refused' | 'tls' | 'reset' | 'blocked' | 'other'

export interface ProbeResult {
  /**
   * 是否「到达」了目标：拿到 HTTP 响应就算到达（401/403/404 都算——服务器回答了）。
   * 只有连接层失败、或明确是拦截页（403 HTML 含「备案」）时才是 false。
   */
  ok: boolean
  /** HTTP 状态码；连接层失败 / 浏览器 no-cors 的 opaque 响应为 null。 */
  status: number | null
  ms: number
  errorKind: ProbeErrorKind | null
  /** 响应前 2KB 命中的拦截页标记（如 `icp`）；只回短标记，绝不回传整页。 */
  bodyHint: string | null
}

export type DiagVerdict = 'ok' | 'offline' | 'blocked' | 'limited' | 'server'
export type DiagAction = 'relogin' | 'retry' | 'openAppSettings' | 'openNetworkSettings'

export interface DiagInput {
  status: NetStatus | null
  /** 对照站点（至少两个）的结果，任一 ok 即算互联网可达。 */
  control: ProbeResult[]
  hub: ProbeResult | null
  /**
   * 是不是手机网页版（WP54）。浏览器里没有「App 被 ROM 禁止联网」这回事
   * （页面里也没有应用详情页可以去开权限），所以网页版不给这个结论；
   * 默认 false = APK，行为与 0.4.11 完全一致。
   */
  web?: boolean
}

export interface DiagOutcome {
  verdict: DiagVerdict
  /** 结论一句话（标题）。 */
  title: string
  /** 跟结论配套的一行说明（不给用户讲原理）。 */
  detail: string
  /** 只有「App 被禁止联网」才给一句指路（在应用详情里打开哪个开关）。 */
  hint: string
  actions: DiagAction[]
  cause: ProbeErrorKind | 'http' | 'blocked-page' | null
  controlOk: boolean
  hubOk: boolean
}

export type NetDiagStepKey = 'phone' | 'internet' | 'hub'
export type NetDiagStepState = 'pending' | 'running' | 'ok' | 'fail'

export interface NetDiagStep {
  key: NetDiagStepKey
  state: NetDiagStepState
  /** 一行短说明（进行中时为空）。 */
  note: string
}

/** 一个 Hub 入口的探测目标（0.4.11：两个入口各自一行）。 */
export interface HubTarget {
  origin: string
  url: string
  /** 是不是当前正在用的入口。 */
  current: boolean
}

/** 一个入口的探测结果（`origin` 给界面认行，`result` 与单入口时同构）。 */
export interface HubProbeEntry {
  origin: string
  current: boolean
  result: ProbeResult
}

export interface NetDiagRun {
  status: NetStatus | null
  control: ProbeResult[]
  /** 当前入口的探测结果（判定用；多入口时是 `hubs` 里 current 那一条）。 */
  hub: ProbeResult | null
  /** 全部入口的探测结果（顺序与候选一致；单入口时长度为 1）。 */
  hubs: HubProbeEntry[]
  outcome: DiagOutcome
  steps: NetDiagStep[]
}

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 国内稳定的对照站点：任一通即算互联网可达。 */
export const DEFAULT_CONTROL_SITES: readonly string[] = ['https://www.baidu.com', 'https://www.qq.com']

/** 单个探测的超时（任务要求每步 ≤5 秒）。 */
export const STEP_TIMEOUT_MS = 5_000
/** 整次检测的时间上限（任务要求 ≤10 秒）。 */
export const TOTAL_BUDGET_MS = 10_000
/** 系统状态查询的预算：原生调用是本地查询，慢成这样基本是插件出问题了。 */
export const STATUS_TIMEOUT_MS = 3_000
/**
 * 「瞬间失败」阈值：一次连接在 300ms 内直接失败（连握手都没有），通常不是网络慢，
 * 而是请求在发出前就被系统挡掉（国产 ROM 的单 App 联网开关就是这个特征）。
 */
export const INSTANT_FAIL_MS = 300

/** Hub 探测地址：bootstrap 是最轻的业务接口，未鉴权时回 401，足够证明「服务器回答了」。 */
const HUB_PROBE_PATH = '/api/mobile/bootstrap'

const ERROR_KIND_LABELS: Record<ProbeErrorKind, string> = {
  dns: '域名解析失败',
  timeout: '超时',
  refused: '连接被拒绝',
  tls: 'TLS 握手失败',
  reset: '连接被重置',
  blocked: '被系统拦截',
  other: '网络错误',
}

const TRANSPORT_LABELS: Record<NetTransport, string> = {
  wifi: 'Wi-Fi',
  cellular: '移动数据',
  ethernet: '以太网',
  other: '网络',
  none: '网络',
}

const ACTIONS: Record<DiagAction, string> = {
  relogin: '重新登录',
  retry: '重新检测',
  openAppSettings: '去设置',
  openNetworkSettings: '打开网络设置',
}

const ERROR_KINDS: readonly ProbeErrorKind[] = [
  'dns',
  'timeout',
  'refused',
  'tls',
  'reset',
  'blocked',
  'other',
]

// ── 平台封装 ────────────────────────────────────────────────────────────────

/** NetworkDiag 插件的方法签名（与 NetworkDiagPlugin.java 一一对应）。 */
interface NetworkDiagPlugin {
  status(): Promise<NetStatus>
  probe(options: { url: string; timeoutMs?: number }): Promise<ProbeResult>
  openAppSettings(): Promise<void>
  openNetworkSettings(): Promise<void>
}

const NetworkDiag = registerPlugin<NetworkDiagPlugin>('NetworkDiag')

/** 原生桥（Web / 壳里没注册插件时为 null，绝不盲调）。 */
export interface NetDiagBridge {
  status(): Promise<NetStatus>
  probe(url: string, timeoutMs?: number): Promise<ProbeResult>
  openAppSettings(): Promise<void>
  openNetworkSettings(): Promise<void>
}

export function createNetDiagBridge(): NetDiagBridge | null {
  if (!Capacitor.isNativePlatform()) return null
  if (!Capacitor.isPluginAvailable('NetworkDiag')) return null
  return {
    status: () => NetworkDiag.status(),
    probe: (url, timeoutMs) => NetworkDiag.probe({ url, timeoutMs }),
    openAppSettings: () => NetworkDiag.openAppSettings(),
    openNetworkSettings: () => NetworkDiag.openNetworkSettings(),
  }
}

/** 浏览器/开发环境的系统状态回退：只有 navigator.onLine，其余字段取保守值。 */
export function browserStatus(): NetStatus {
  const online = typeof navigator === 'undefined' ? true : navigator.onLine !== false
  return {
    connected: online,
    transport: online ? 'other' : 'none',
    // 浏览器没有「系统确认这条网能上网」的概念：这里如实给 false。
    // 若冒充 true，开发环境断网就会被误判成「App 被禁止联网」。
    validated: false,
    metered: false,
    restrictBackground: false,
  }
}

/**
 * 浏览器回退探测：no-cors + AbortController。
 *
 * 只能区分「到达 / 没到达」：opaque 响应读不到状态码与正文，所以 status/bodyHint 恒为 null。
 * 失败原因在浏览器里也分不清（连接被拒、DNS、TLS 一律 TypeError），统一记 `other`；
 * 只有我们自己 abort 掉的才算 `timeout`。
 */
export async function browserProbe(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<ProbeResult> {
  const started = now()
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), Math.max(1, timeoutMs)) : null
  const elapsed = (): number => Math.max(0, Math.round(now() - started))
  try {
    await fetchImpl(url, {
      mode: 'no-cors',
      cache: 'no-store',
      redirect: 'follow',
      credentials: 'omit',
      ...(controller ? { signal: controller.signal } : {}),
    })
    return { ok: true, status: null, ms: elapsed(), errorKind: null, bodyHint: null }
  } catch {
    const timedOut = controller?.signal.aborted === true
    return {
      ok: false,
      status: null,
      ms: elapsed(),
      errorKind: timedOut ? 'timeout' : 'other',
      bodyHint: null,
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 打开本 App 的系统详情页（原生才能用；浏览器返回 false）。 */
export async function openAppSettings(bridge: NetDiagBridge | null = createNetDiagBridge()): Promise<boolean> {
  if (!bridge) return false
  try {
    await bridge.openAppSettings()
    return true
  } catch {
    return false
  }
}

/** 打开系统网络设置（原生才能用；浏览器返回 false）。 */
export async function openNetworkSettings(
  bridge: NetDiagBridge | null = createNetDiagBridge(),
): Promise<boolean> {
  if (!bridge) return false
  try {
    await bridge.openNetworkSettings()
    return true
  } catch {
    return false
  }
}

// ── 地址 ────────────────────────────────────────────────────────────────────

function isHttpUrl(value: string): boolean {
  return /^http:\/\/[^\s]+$/i.test(value) || /^https:\/\/[^\s]+$/i.test(value)
}

/** 对照站点：运行时注入 > 构建参数 > 默认（国内稳定站点）。 */
export function controlSites(): string[] {
  const injected = (globalThis as { __dshNetDiagControlSites?: unknown }).__dshNetDiagControlSites
  if (Array.isArray(injected)) {
    const list = injected.filter((item): item is string => typeof item === 'string' && isHttpUrl(item))
    if (list.length > 0) return list
  }
  const env = import.meta.env.VITE_NET_DIAG_CONTROL_SITES
  if (typeof env === 'string' && env.trim().length > 0) {
    const list = env
      .split(',')
      .map((item) => item.trim())
      .filter((item) => isHttpUrl(item))
    if (list.length > 0) return list
  }
  return [...DEFAULT_CONTROL_SITES]
}

/** Hub 探测地址；`mock`（进程内假 Hub）没有真实地址，返回 null。 */
export function hubProbeUrl(origin: string = HUB_ORIGIN): string | null {
  if (!/^https?:\/\//i.test(origin)) return null
  return `${origin.replace(/\/+$/, '')}${HUB_PROBE_PATH}`
}

/** 多入口的探测目标（网络检测页每行一个；非法/`mock` 地址直接跳过）。 */
export function hubTargetsOf(
  origins: readonly string[],
  current: string | null,
): HubTarget[] {
  const out: HubTarget[] = []
  for (const origin of origins) {
    const url = hubProbeUrl(origin)
    if (url === null || out.some((item) => item.url === url)) continue
    out.push({ origin, url, current: origin === current })
  }
  return out
}

// ── 结论（纯函数，单测的主战场） ────────────────────────────────────────────

function instantFail(result: ProbeResult): boolean {
  return !result.ok && result.status === null && result.errorKind !== 'timeout' && result.ms < INSTANT_FAIL_MS
}

function blockedEvidence(
  status: NetStatus | null,
  control: ProbeResult[],
  hub: ProbeResult | null,
): { blocked: boolean; detail: string } {
  const probes = hub ? [...control, hub] : [...control]
  // 拦截页（bodyHint）是「远处有人挡」，不是「本机不让 App 联网」，别混进 blocked 证据
  const hasBlockedKind = probes.some((item) => item.errorKind === 'blocked' && !item.bodyHint)
  const allInstant = probes.length > 0 && probes.every((item) => instantFail(item))
  const validated = status?.validated === true
  const restricted = status?.restrictBackground === true

  if (hasBlockedKind) {
    return {
      blocked: true,
      detail: restricted ? '联网权限被关闭，后台流量也受限' : '系统禁止这个 App 联网',
    }
  }
  if (validated && allInstant) {
    return {
      blocked: true,
      detail: restricted ? '请求立刻被挡回，后台流量也受限' : '系统说网络正常，但请求立刻被挡回',
    }
  }
  return { blocked: false, detail: '' }
}

function serverCause(hub: ProbeResult | null): DiagOutcome['cause'] {
  if (!hub) return null
  if (hub.bodyHint) return 'blocked-page'
  // 原生探测把 5xx 记成 errorKind=other，这里要给「服务器自己出错」更具体的标签
  if (hub.status !== null && hub.status >= 500) return 'http'
  if (hub.errorKind) return hub.errorKind
  return 'other'
}

function serverDetail(hub: ProbeResult | null): string {
  const cause = serverCause(hub)
  switch (cause) {
    case 'blocked-page':
      return '被拦截页挡住，疑似域名未备案'
    case 'dns':
      return '域名解析失败'
    case 'timeout':
      return '服务器长时间没响应'
    case 'refused':
      return '服务器拒绝了连接'
    case 'tls':
      return 'TLS 握手失败或被重置'
    case 'reset':
      return '连接被重置'
    case 'blocked':
      return '请求被挡住，像是被拦截了'
    case 'http':
      return hub?.status ? `服务器返回 ${hub.status}` : '服务器出错了'
    default:
      return '服务器暂时没有响应'
  }
}

/** 三行结果 → 结论。任何组合都会给出一句非空结论（不出现「检测中」卡死）。 */
export function diagnose(input: DiagInput): DiagOutcome {
  const status = input.status
  const control = input.control ?? []
  const hub = input.hub ?? null
  const controlOk = control.some((item) => item.ok)
  const hubOk = hub?.ok === true
  const base = { controlOk, hubOk }
  // status === null：拿不到系统状态（插件异常）。按「已连接」处理，结论交给探测结果。
  const connected = status?.connected !== false

  if (!connected) {
    return {
      verdict: 'offline',
      title: '手机没有连上网络',
      detail: '打开 Wi-Fi 或移动数据后再试',
      hint: '',
      actions: ['openNetworkSettings', 'retry'],
      cause: null,
      ...base,
    }
  }

  if (hubOk) {
    return {
      verdict: 'ok',
      title: '网络正常',
      detail: controlOk ? '网络和 DSH Hub 都通' : '能连上 DSH Hub',
      hint: '',
      actions: ['relogin', 'retry'],
      cause: null,
      ...base,
    }
  }

  // 对照站点通、Hub 不通：问题在服务器那边，不是手机
  if (controlOk) {
    return {
      verdict: 'server',
      title: '服务器暂时连不上，不是手机的问题',
      detail: serverDetail(hub),
      hint: '',
      actions: ['retry'],
      cause: serverCause(hub),
      ...base,
    }
  }

  // 两边都不通：先看有没有「App 被禁止联网」的证据
  // （网页版跳过：浏览器里不存在单 App 联网开关，这个结论只会误导用户）
  const blocked = blockedEvidence(status, control, hub)
  if (blocked.blocked && input.web !== true) {
    return {
      verdict: 'blocked',
      title: 'App 可能被禁止联网',
      detail: blocked.detail,
      hint: '在应用详情里打开 联网 / WLAN与移动数据 权限',
      actions: ['openAppSettings', 'retry'],
      cause: 'blocked',
      ...base,
    }
  }

  return {
    verdict: 'limited',
    title: '网络受限，上不了网',
    detail:
      status?.validated === false
        ? '已经连上网络，但这条网不能上网'
        : '网络不通，先换个网络再试',
    hint: '',
    actions: ['openNetworkSettings', 'retry'],
    cause: hub?.errorKind ?? control.find((item) => item.errorKind)?.errorKind ?? null,
    ...base,
  }
}

// ── 三行检测项的文案（纯函数） ──────────────────────────────────────────────

export function transportLabel(transport: NetTransport): string {
  return TRANSPORT_LABELS[transport] ?? '网络'
}

const STEP_LABELS: Record<NetDiagStepKey, string> = {
  phone: '手机网络',
  internet: '互联网',
  hub: 'DSH Hub',
}

/** 三行检测项的标题（网页版把「手机网络」叫「本机网络」：浏览器只知道在线/离线）。 */
export function stepLabel(key: NetDiagStepKey, web = false): string {
  if (web && key === 'phone') return '本机网络'
  return STEP_LABELS[key]
}

export function errorKindLabel(kind: ProbeErrorKind | null): string {
  return kind ? (ERROR_KIND_LABELS[kind] ?? '网络错误') : '网络错误'
}

/** 手机网络的短说明。 */
export function phoneNote(status: NetStatus | null): string {
  if (!status) return '读不到网络状态'
  if (!status.connected) return '没有连接网络'
  return `已连接${transportLabel(status.transport)}`
}

/** 对照站点的短说明。 */
export function internetNote(results: ProbeResult[]): string {
  const ok = results.find((item) => item.ok)
  if (ok) return '对照站点可达'
  const failed = results.find((item) => !item.ok) ?? null
  return `对照站点不通（${errorKindLabel(failed?.errorKind ?? null)}）`
}

/** Hub 的短说明。 */
export function hubNote(result: ProbeResult | null): string {
  if (!result) return '没有可检测的服务器地址'
  if (result.ok) return '已连上服务器'
  if (result.bodyHint) return '被拦截页挡住'
  return `连不上服务器（${errorKindLabel(result.errorKind)}）`
}

/**
 * 多入口的 Hub 行说明（0.4.11）：
 *  - 当前入口通：正常；
 *  - 当前入口不通但备用通：说明「有备用可用」（不会让用户以为全挂了）；
 *  - 都不通：照旧。
 *
 * 网页版（WP54）只有一个入口（C4），没有「当前/备用」之分，直接用单入口的文案。
 */
export function hubSummaryNote(hubs: HubProbeEntry[], web = false): string {
  if (hubs.length === 0) return hubNote(null)
  const current = hubs.find((item) => item.current) ?? hubs[0]!
  if (web) return hubNote(current.result)
  if (current.result.ok) return '当前入口已连上'
  const fallback = hubs.find((item) => item.origin !== current.origin && item.result.ok)
  if (fallback) return '当前入口不通，备用入口可用'
  return hubNote(current.result)
}

export function actionLabel(action: DiagAction): string {
  return ACTIONS[action] ?? '重试'
}

export type DiagTone = 'ok' | 'warn' | 'bad'

export function verdictTone(verdict: DiagVerdict): DiagTone {
  if (verdict === 'ok') return 'ok'
  if (verdict === 'server') return 'warn'
  return 'bad'
}

/** 诊断摘要（进本地诊断事件；**不含** URL / 主机名 / 任何隐私信息）。 */
export function diagSummary(run: NetDiagRun): string {
  const controlOk = run.control.filter((item) => item.ok).length
  const hubState = run.hub ? (run.hub.ok ? 'ok' : `fail:${run.hub.errorKind ?? 'http'}`) : 'skip'
  const net = run.status
    ? `${run.status.transport}${run.status.validated ? '+v' : ''}${run.status.restrictBackground ? '+r' : ''}`
    : 'unknown'
  // 多入口：只记每个入口的状态与顺序（不记 host），够定位「切没切 / 哪个通」。
  const hubs = run.hubs.map((item) => (item.result.ok ? 'ok' : `fail:${item.result.errorKind ?? 'http'}`))
  return `verdict=${run.outcome.verdict} net=${net} control=${controlOk}/${run.control.length} hub=${hubState} hubs=${hubs.join(',') || 'skip'}`
}

// ── 检测编排 ────────────────────────────────────────────────────────────────

export interface NetDiagOptions {
  /** 原生桥；显式传 null 表示强制走浏览器回退（单测/e2e 用）。不传则自动判定。 */
  bridge?: NetDiagBridge | null
  fetchImpl?: typeof fetch
  controlSites?: string[]
  /** 单入口兼容（旧调用方/测试）：只测这一个地址。 */
  hubUrl?: string | null
  /** 多入口（0.4.11）：每个入口各一行；与 `hubUrl` 二选一，给了它就忽略 `hubUrl`。 */
  hubTargets?: HubTarget[]
  /** 手机网页版（WP54）：只影响文案与结论口径（见 `DiagInput.web`）。 */
  web?: boolean
  onProgress?: (steps: NetDiagStep[]) => void
  now?: () => number
  /** 是否写本地诊断事件（默认写；单测里可关掉）。 */
  record?: boolean
}

/** 在 ms 内没结果就用 fallback（原生调用卡住也不能让界面一直转）。 */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (ms <= 0) return Promise.resolve(fallback)
  return new Promise<T>((resolve) => {
    let settled = false
    const finish = (value: T): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(fallback), ms)
    promise.then(
      (value) => finish(value),
      () => finish(fallback),
    )
  })
}

const TIMEOUT_PROBE: ProbeResult = {
  ok: false,
  status: null,
  ms: STEP_TIMEOUT_MS,
  errorKind: 'timeout',
  bodyHint: null,
}

function normalizeStatus(raw: NetStatus | null | undefined): NetStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const transport = (['wifi', 'cellular', 'ethernet', 'other', 'none'] as const).includes(
    raw.transport as NetTransport,
  )
    ? (raw.transport as NetTransport)
    : 'other'
  return {
    connected: raw.connected === true,
    transport,
    validated: raw.validated === true,
    metered: raw.metered === true,
    restrictBackground: raw.restrictBackground === true,
  }
}

function normalizeProbe(raw: ProbeResult | null | undefined, elapsed: number): ProbeResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, status: null, ms: elapsed, errorKind: 'other', bodyHint: null }
  }
  const status = typeof raw.status === 'number' && Number.isFinite(raw.status) ? raw.status : null
  const errorKind =
    typeof raw.errorKind === 'string' && (ERROR_KINDS as readonly string[]).includes(raw.errorKind)
      ? (raw.errorKind as ProbeErrorKind)
      : null
  return {
    ok: raw.ok === true,
    status,
    ms: typeof raw.ms === 'number' && Number.isFinite(raw.ms) && raw.ms >= 0 ? Math.round(raw.ms) : elapsed,
    errorKind: raw.ok === true ? null : errorKind,
    bodyHint: typeof raw.bodyHint === 'string' && raw.bodyHint.length > 0 ? raw.bodyHint.slice(0, 16) : null,
  }
}

/**
 * 跑一次完整检测。
 *
 * 顺序：① 手机网络（本地查询，快）→ ② 对照站点 + ③ Hub（并行）。
 * 每一步都受剩余预算约束；onProgress 每次状态变化都会推一份只读快照给界面。
 */
export async function runNetDiag(options: NetDiagOptions = {}): Promise<NetDiagRun> {
  const now = options.now ?? (() => Date.now())
  const started = now()
  const deadline = started + TOTAL_BUDGET_MS
  const bridge = options.bridge === undefined ? createNetDiagBridge() : options.bridge
  const sites = (options.controlSites ?? controlSites()).slice(0, 3)
  const targets: HubTarget[] = options.hubTargets
    ? options.hubTargets
    : (() => {
        const hubUrl = options.hubUrl === undefined ? hubProbeUrl() : options.hubUrl
        return hubUrl === null ? [] : [{ origin: hubUrl, url: hubUrl, current: true }]
      })()

  const steps: NetDiagStep[] = [
    { key: 'phone', state: 'pending', note: '' },
    { key: 'internet', state: 'pending', note: '' },
    { key: 'hub', state: 'pending', note: '' },
  ]
  const report = (): void => {
    options.onProgress?.(steps.map((step) => ({ ...step })))
  }
  const mark = (key: NetDiagStepKey, state: NetDiagStepState, note = ''): void => {
    const step = steps.find((item) => item.key === key)
    if (!step) return
    step.state = state
    step.note = note
    report()
  }

  report()

  // ① 手机网络
  mark('phone', 'running')
  let status: NetStatus | null = null
  try {
    if (bridge) {
      status = normalizeStatus(await within(bridge.status(), STATUS_TIMEOUT_MS, null))
    } else {
      status = browserStatus()
    }
  } catch {
    status = null
  }
  // 原生状态拿不到时退到 navigator.onLine（至少能判断「有没有连网」）
  if (!status) status = browserStatus()
  mark('phone', status.connected ? 'ok' : 'fail', phoneNote(status))

  // ② 对照站点 + ③ Hub 并行
  const remaining = Math.max(500, deadline - now())
  const probeBudget = Math.min(STEP_TIMEOUT_MS, remaining)

  const probe = async (url: string): Promise<ProbeResult> => {
    const left = Math.min(probeBudget, Math.max(500, deadline - now()))
    const startedAt = now()
    try {
      if (!bridge) return await browserProbe(url, left, options.fetchImpl ?? fetch, now)
      const raw = await within(bridge.probe(url, left), left, TIMEOUT_PROBE)
      return normalizeProbe(raw, Math.max(0, now() - startedAt))
    } catch {
      return { ok: false, status: null, ms: Math.max(0, now() - startedAt), errorKind: 'other', bodyHint: null }
    }
  }

  mark('internet', 'running')
  mark('hub', 'running')
  if (targets.length === 0) mark('hub', 'fail', hubNote(null))

  const controlPromise = Promise.all(sites.map((url) => probe(url)))
  const hubsPromise: Promise<HubProbeEntry[]> =
    targets.length === 0
      ? Promise.resolve([])
      : Promise.all(
          targets.map(async (target) => ({
            origin: target.origin,
            current: target.current,
            result: await probe(target.url),
          })),
        )

  const control = await controlPromise
  mark('internet', control.some((item) => item.ok) ? 'ok' : 'fail', internetNote(control))

  const hubs = await hubsPromise
  const currentEntry = hubs.find((item) => item.current) ?? hubs[0] ?? null
  const hub = currentEntry?.result ?? null
  if (targets.length > 0) {
    mark('hub', hub?.ok === true ? 'ok' : 'fail', hubSummaryNote(hubs, options.web === true))
  }

  const outcome = diagnose({ status, control, hub, web: options.web === true })
  const run: NetDiagRun = {
    status,
    control,
    hub,
    hubs,
    outcome,
    steps: steps.map((step) => ({ ...step })),
  }
  if (options.record !== false) {
    try {
      recordDiag('net:diag', diagSummary(run))
    } catch {
      /* 诊断记录失败不影响检测本身 */
    }
  }
  return run
}
