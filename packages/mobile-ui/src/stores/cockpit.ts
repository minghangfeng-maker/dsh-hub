/**
 * 嵌入座舱（WP56d）的界面状态与 postMessage 编排。
 *
 * 分工：
 *  - `lib/cockpit-embed.ts`  进程级事实（是不是嵌入模式、待用交接码、桥实例、舰桥主题）；
 *  - `lib/cockpit.ts`        纯逻辑（入口解析、消息校验、发起人）；
 *  - `stores/auth.ts`        令牌（sessionStorage 的 cockpit 键）与「等父页面交接」；
 *  - 本 store                 父页面的消息落到界面上（切会话 / 预填）、状态回传给父页面
 *                            （会话、回合、投放/方案聚焦）、以及「航行日志」面板的开关。
 *
 * docs/24 §6 的消息一栏是唯一契约：
 *   子 → 父  cockpit.ready / cockpit.session / cockpit.auth-expired /
 *           cockpit.focus-canvas / cockpit.focus-proposal / cockpit.turn
 *   父 → 子  cockpit.focus-session / cockpit.prefill / cockpit.handoff
 *
 * 布局（docs/24 §1，2026-10-29「舰桥」定调）：中控台 = 这个 iframe 的**全部**可视区域，
 * 会话列表不占栏，收进顶部的「航行日志」下拉（`logOpen`）。
 */

import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { cockpitReadyMessage, sessionInitiatorOf } from '@/lib/cockpit'
import type { CockpitLayoutSessions, CockpitStatusPhase } from '@/lib/cockpit'
import {
  DEFAULT_COCKPIT_LAYOUT,
  applyCockpitZoom,
  cockpitLayoutState,
  dockedRailWidth,
} from '@/lib/cockpit-layout'
import { CockpitStatusTracker } from '@/lib/cockpit-status'
import {
  adoptCockpitBridge,
  currentCockpitBridge,
  installCockpitEntryWatcher,
  isCockpitBridgeTheme,
  isCockpitConsoleTheme,
  isCockpitEmbed,
  openCockpitBridge,
  postCockpitMessage,
  resetCockpitEmbedForTests,
} from '@/lib/cockpit-embed'
import type { CockpitIncomingMessage } from '@/lib/cockpit'
import { recordDiag } from '@/lib/diagnostics'
import { router } from '@/router'
import { useAuthStore } from './auth'
import { useBackendStore } from './backend'
import { useChatStore } from './chat'
import { useModelsStore } from './models'
import { useUiStore } from './ui'

export const useCockpitStore = defineStore('cockpit', () => {
  const auth = useAuthStore()
  const backend = useBackendStore()
  const chat = useChatStore()
  const models = useModelsStore()
  const ui = useUiStore()

  /** 这次运行是不是「嵌入座舱」（构建期常量 + 入口参数的组合，只有网页构建可能为 true）。 */
  const embed = ref(isCockpitEmbed())
  /** 舰桥主题（`theme=bridge`）：深色 + 透明背景（docs/24 §1/§6）。 */
  const bridgeTheme = ref(isCockpitBridgeTheme())
  /** 控制台主题（`theme=console`）：浅色 + 桌面控件 + 可缩放（docs/26 §3）。 */
  const consoleTheme = ref(isCockpitConsoleTheme())
  /** 桥已挂上（父页面存在）。顶层打开 `/m/?embed=cockpit` 时是 false，界面照常可用。 */
  const attached = ref(false)
  /** `cockpit.ready` 已发（只发一次）。 */
  const readySent = ref(false)
  /** 「航行日志」下拉（会话列表 + 新会话）是否打开。 */
  const logOpen = ref(false)

  /**
   * 布局（docs/26 §5 的 `cockpit.layout`）：默认不缩放 + 会话列表走下拉，
   * 父页面发来之后才知道该不该常驻左栏、放大多少。非控制台主题一律保持默认。
   */
  const layoutScale = ref(DEFAULT_COCKPIT_LAYOUT.scale)
  const layoutSessions = ref<CockpitLayoutSessions>(DEFAULT_COCKPIT_LAYOUT.sessions)
  /** 会话列表是否常驻左栏（`sessions='docked'`，L 档及以上）。 */
  const sessionsDocked = computed(() => consoleTheme.value && layoutSessions.value === 'docked')
  /** 常驻左栏宽度（缩放前的 CSS px，248/264/280 由 scale 决定）。 */
  const railWidth = computed(() => dockedRailWidth(layoutScale.value))
  /** 当前阶段（诊断 / 单测看；界面不直接用）。 */
  const statusPhase = ref<CockpitStatusPhase | null>(null)

  let stopEntryWatcher: (() => void) | null = null
  let stopWatchActive: (() => void) | null = null
  let stopWatchAuth: (() => void) | null = null
  let stopWatchTurn: (() => void) | null = null
  let stopWatchTitle: (() => void) | null = null
  let stopWatchStatus: (() => void) | null = null
  /** 上一次报告的回合态（只在变化时发，docs/24 §6 的 `cockpit.turn`）。 */
  let lastRunning: boolean | null = null
  /** `cockpit.status` 的去重器（同一 phase 不重复发）。 */
  const statusTracker = new CockpitStatusTracker()

  /**
   * 把 App 的状态拍平成「给父页面看的一拍」（见 lib/cockpit-status.ts 的判据顺序）。
   *
   * `modelsReady`：通道 hello 之后 `models.features` 才到；Hub 上报了 `models` 能力时还要
   * 等目录里真有模型（否则发消息会被 App 排队）。老 Hub 没有 models 能力 → 视为已就绪。
   */
  const statusSnapshot = computed(() => ({
    authenticated: auth.isAuthenticated,
    wakeState: backend.wakeState,
    connectable: backend.canUseCloud,
    link: chat.link,
    modelsReady:
      chat.link === 'connected' &&
      (!models.features.includes('models') || models.catalog.items.length > 0),
    blockedReason: auth.issue?.message ?? null,
  }))

  /** 等父页面重新交接（`cockpit.auth-expired` 之后）。 */
  const waiting = computed(() => embed.value && auth.cockpitWaiting)
  /** 会话行上的发起人（接口给了才有）。 */
  const initiatorOf = sessionInitiatorOf

  // ── 生命周期 ────────────────────────────────────────────────────────────

  /**
   * 启动（App.vue 在 `auth.init()` 之后调用一次）。
   *
   * 顺序有讲究：桥要先挂上，`cockpit.ready` 才有意义；而父页面拿到 ready 后可能**立刻**
   * 发 `cockpit.prefill` / `cockpit.focus-session`，所以监听必须在 ready 之前装好。
   */
  function start(): void {
    if (!embed.value) return
    // 父页面也可能**不重载 iframe**、只把 `#code=…` 写进 hash（同文档导航）：
    // 两条路都认，见到码就抹掉并交给 auth 去换令牌。
    stopEntryWatcher = installCockpitEntryWatcher((code) => {
      recordDiag('cockpit:handoff', 'hash')
      void auth.cockpitHandoff(code)
    })
    const bridge = openCockpitBridge(handleMessage)
    attached.value = bridge !== null && bridge.attached
    if (attached.value) {
      recordDiag('cockpit:bridge', 'attached')
      // 父页面可能在桥挂上之前就发过 handoff（极端时序）：auth 那边已经在等，补喊一次。
      if (auth.cockpitWaiting) postCockpitMessage({ type: 'cockpit.auth-expired' })
      sendReady()
      reportSession(chat.activeId)
      reportTurn(chat.turnRunning)
      // 控制台主题才报阶段（老父页面不认识也只会忽略；但没必要多说话）
      if (consoleTheme.value) {
        statusTracker.reset()
        reportStatus()
      }
    } else {
      recordDiag('cockpit:bridge', 'standalone')
    }
    // 阶段变化：登录 → 等容器 → 连通道 → 就绪，断了再报 offline（去重在 tracker 里）。
    // 非控制台主题不装：`cockpit.status` 是 docs/26 §5 新增的可选消息。
    if (consoleTheme.value) {
      stopWatchStatus = watch(statusSnapshot, () => reportStatus(), { immediate: false })
    }
    stopWatchActive = watch(
      () => chat.activeId,
      (sessionId) => {
        reportSession(sessionId)
        // 换会话 = 上一个回合的「本回合」卡结束：把回合态归零再按实际值报一次。
        lastRunning = null
        reportTurn(chat.turnRunning)
      },
      { immediate: false },
    )
    // 会话标题晚到（首回合后生成 / 改名）：只补报 session，不动回合态
    stopWatchTitle = watch(
      () => chat.activeSession?.title ?? '',
      (title, previous) => {
        if (title !== previous) reportSession(chat.activeId)
      },
    )
    // 回合开始/结束：父页面据此区分「本回合投放的卡」（docs/24 §6）。
    stopWatchTurn = watch(() => chat.turnRunning, (running) => reportTurn(running), {
      immediate: false,
    })
    // 交接成功后补发一次 ready：父页面据此知道「现在可以发 focus-session / prefill 了」。
    stopWatchAuth = watch(
      () => auth.isAuthenticated,
      (ok) => {
        if (!ok) return
        if (!readySent.value) sendReady()
        reportSession(chat.activeId)
      },
    )
  }

  function stop(): void {
    stopEntryWatcher?.()
    stopEntryWatcher = null
    stopWatchActive?.()
    stopWatchActive = null
    stopWatchTurn?.()
    stopWatchTurn = null
    stopWatchTitle?.()
    stopWatchTitle = null
    stopWatchAuth?.()
    stopWatchAuth = null
    stopWatchStatus?.()
    stopWatchStatus = null
    const bridge = currentCockpitBridge()
    if (bridge !== null) {
      bridge.stop()
      adoptCockpitBridge(null)
    }
    attached.value = false
    readySent.value = false
    logOpen.value = false
    lastRunning = null
    statusTracker.reset()
    statusPhase.value = null
    // 布局回到默认（不缩放、下拉）：下一次挂桥由父页面重新发 cockpit.layout
    applyLayout(1, 'menu')
  }

  function sendReady(): void {
    if (readySent.value) return
    // docs/26 §5：控制台主题额外声明能力（status / layout / console）。
    // 其它主题**不带 caps**——老行为一字不改（见 lib/cockpit.ts 的 cockpitReadyMessage）。
    if (postCockpitMessage(cockpitReadyMessage(consoleTheme.value))) readySent.value = true
  }

  // ── 子 → 父 ────────────────────────────────────────────────────────────

  /** 切换/新建会话：把当前会话 id 告诉父页面（两舷的卡跟着切）。 */
  function reportSession(sessionId: string | null): void {
    if (!attached.value) return
    // 标题可选：两舷铭牌显示它（没有就显示短 id）；标题是首回合后才生成的，下面单独 watch 再报一次
    const title = sessionId !== null && chat.activeSession?.sessionId === sessionId ? chat.activeSession.title : ''
    postCockpitMessage(
      title ? { type: 'cockpit.session', sessionId, title } : { type: 'cockpit.session', sessionId },
    )
  }

  /** 回合开始/结束（只在变化时报，避免刷屏）。 */
  function reportTurn(running: boolean): void {
    if (!attached.value) return
    if (lastRunning === running) return
    lastRunning = running
    postCockpitMessage({ type: 'cockpit.turn', running })
  }

  /**
   * 报一次阶段（docs/26 §5 的 `cockpit.status`）：由 tracker 去重，
   * 有变化才发。`message` 是给人看的一句中文。
   */
  function reportStatus(): void {
    if (!attached.value) return
    const update = statusTracker.take(statusSnapshot.value)
    if (update === null) return
    statusPhase.value = update.phase
    recordDiag('cockpit:status', update.phase)
    postCockpitMessage({ type: 'cockpit.status', phase: update.phase, message: update.message })
  }

  /**
   * 应用父页面的布局（docs/26 §5 的 `cockpit.layout`）：缩放 + 会话列表形态。
   *
   * 缩放写在 `<html>` 的 inline `zoom` 上（`document.documentElement.style.zoom`）：
   * Hub **不给 iframe 的祖先加 zoom**，所以这里只放大对话区一次，不会叠加。
   * 非控制台主题不缩放（bridge 的版式是定死的舰桥中控台）。
   */
  function applyLayout(scale: number, sessions: CockpitLayoutSessions): void {
    const next = cockpitLayoutState(scale, sessions)
    layoutScale.value = next.scale
    layoutSessions.value = next.sessions
    if (typeof document !== 'undefined' && consoleTheme.value) {
      applyCockpitZoom(next.scale, document.documentElement)
    }
    recordDiag('cockpit:layout', `${next.scale}/${next.sessions}`)
  }

  /** 过程行里的「⟶ 方案 #N」被点：让父页面滚到右舷那张方案卡。 */
  function focusProposal(id: number): void {
    if (!Number.isInteger(id) || id <= 0) return
    recordDiag('cockpit:focus-proposal', String(id))
    postCockpitMessage({ type: 'cockpit.focus-proposal', id })
  }

  /** 过程行里的「⟶ 已投放左舷/右舷：…」被点：让父页面闪烁并滚到那张卡。 */
  function focusCanvas(id: string): void {
    const value = id.trim()
    if (value === '' || value.length > 200) return
    recordDiag('cockpit:focus-canvas', value)
    postCockpitMessage({ type: 'cockpit.focus-canvas', id: value })
  }

  // ── 父 → 子 ────────────────────────────────────────────────────────────

  function handleMessage(message: CockpitIncomingMessage): void {
    switch (message.type) {
      case 'cockpit.focus-session':
        recordDiag('cockpit:focus-session', message.sessionId)
        void focusSession(message.sessionId)
        return
      case 'cockpit.prefill':
        // 画布「问 DSH」/「追问这一行」：把上下文填进输入框，用户自己按发送。
        ui.requestPrefill(message.text)
        return
      case 'cockpit.handoff':
        recordDiag('cockpit:handoff', 'received')
        void auth.cockpitHandoff(message.code)
        return
      case 'cockpit.layout':
        // 父页面给的档位与布局（docs/26 §5）：缩放 + 会话列表形态
        applyLayout(message.scale, message.sessions)
        return
    }
  }

  async function focusSession(sessionId: string): Promise<void> {
    const known = chat.sessions.some((session) => session.sessionId === sessionId)
    if (!known) {
      // 父页面的画布可能指向一个还没拉到的会话：先刷新列表再试一次。
      chat.refreshSessions()
      recordDiag('cockpit:focus-session', 'unknown')
      return
    }
    await chat.openSession(sessionId)
    if (router.currentRoute.value.name !== 'conversation') {
      await router.push(`/c/${sessionId}`).catch(() => undefined)
    }
  }

  // ── 航行日志（会话列表下拉，docs/24 §1/§6）────────────────────────────────

  function openLog(): void {
    logOpen.value = true
  }
  function closeLog(): void {
    logOpen.value = false
  }
  function toggleLog(): void {
    logOpen.value = !logOpen.value
  }

  /** 日志里点一个会话：关面板 + 打开会话（父页面会收到 `cockpit.session`）。 */
  async function openSessionFromLog(sessionId: string): Promise<void> {
    closeLog()
    await focusSession(sessionId)
  }

  /** 日志里的「+ 新会话」。 */
  function newSessionFromLog(): void {
    closeLog()
    chat.newSession()
    if (router.currentRoute.value.name !== 'home') void router.push('/')
  }

  /** 单测用：把 store 的运行时状态复位。 */
  function resetForTests(): void {
    stop()
    resetCockpitEmbedForTests()
    embed.value = false
    bridgeTheme.value = false
    consoleTheme.value = false
    layoutScale.value = DEFAULT_COCKPIT_LAYOUT.scale
    layoutSessions.value = DEFAULT_COCKPIT_LAYOUT.sessions
    statusPhase.value = null
  }

  return {
    embed,
    bridgeTheme,
    consoleTheme,
    attached,
    readySent,
    logOpen,
    waiting,
    initiatorOf,
    layoutScale,
    layoutSessions,
    sessionsDocked,
    railWidth,
    statusPhase,
    start,
    stop,
    sendReady,
    reportSession,
    reportTurn,
    reportStatus,
    applyLayout,
    focusProposal,
    focusCanvas,
    handleMessage,
    focusSession,
    openLog,
    closeLog,
    toggleLog,
    openSessionFromLog,
    newSessionFromLog,
    resetForTests,
  }
})
