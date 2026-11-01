/**
 * 账号 store：登录 / 令牌 / 静默登录 / bootstrap（**只做这些**）。
 *
 * WP46 C 拆分：原来这一个 store 混了登录、后端与唤醒、模型目录与选择、App 更新检查，
 * 而且 chat store 反过来写它（`applyFeatures` / `applyServerModels` / `presetId`）。
 * 现在：
 *   - `stores/backend.ts`  后端列表的选择、离线回退、唤醒；
 *   - `stores/models.ts`   模型目录/选择/思考程度/features/preset；
 *   - `stores/app-update.ts` App 更新检查（强更地板、稍后、手动检查）；
 *   - 本 store 只留登录态与 bootstrap 快照（backends / instance / points / serverTime /
 *     appRelease），并且**不 import** 任何下游 store —— 依赖方向永远是 downstream → auth。
 *     下游靠 `watch(auth.xxx)` 自己响应（bootstrap 刷新、退出登录），不需要 auth 反向调用。
 *
 * 启动顺序（开发文档 §6.3 第 6 条 / §2.1）：先让界面可用（令牌在本地就先进首页、先显示缓存），
 * 再去拉 bootstrap；实例没运行由 backend store 自动唤醒，期间输入框照样能打字
 * （消息进 core 的发送队列，就绪后自动发出）。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  accountKeyOf,
  COCKPIT_NODE_ID,
  errorMessage,
  exchangeCockpitHandoff,
  isAuthLostCode,
  HubApiError,
  type AppVersionInfo,
  type AuthUser,
  type AuthTokens,
  type Backend,
  type BootstrapInstance,
  type BootstrapVoice,
  type Points,
} from '@dsh-hub/mobile-core'
import { HUB_ORIGIN, IS_MOCK, IS_WEB_BUILD } from '@/lib/app-info'
import { getInstallId } from '@/lib/install-id'
import { gateway, prefs, rememberedLogin, selectionStore, sessionCache, tokenStore } from '@/lib/instance'
import { clearLastSession } from '@/lib/last-session'
import { recordDiag } from '@/lib/diagnostics'
import { issueFromError, type UiIssue } from '@/lib/issue'
import {
  isCockpitEmbed,
  notifyCockpitAuthExpired,
  setCockpitCode,
  takeCockpitCode,
} from '@/lib/cockpit-embed'
import {
  currentPlatform,
  deviceName,
  isSecureStorageAvailable,
  restoreTokensWithBackoff,
  secureStoreReadStatus,
} from '@/lib/storage'
import {
  decideSilentLogin,
  isAccountProblemCode,
  isReplayOrRotatedCode,
  isRetryableLoginError,
  runAutoLoginRetries,
  shouldClearCredentials,
  shouldSuppressAutoLogin,
  type SavedCredentials,
} from '@/lib/remembered-login'

export type AuthPhase = 'boot' | 'anonymous' | 'authenticated'
export type { UiIssue } from '@/lib/issue'
export type { WakeState } from './backend'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 冷启动读「记住的口令」的重试间隔（毫秒）：SecureStorage 插件就绪慢时读到空，
 * 总窗口约 2.6s。只用于自动登录回退，不阻塞已恢复令牌的正常启动。
 */
const AUTO_LOGIN_CREDENTIAL_RETRY_DELAYS: readonly number[] = [200, 400, 800, 1_200]

export const useAuthStore = defineStore('auth', () => {
  const phase = ref<AuthPhase>('boot')
  const user = ref<AuthUser | null>(null)
  const points = ref<Points | null>(null)
  const backends = ref<Backend[]>([])
  const instance = ref<BootstrapInstance | null>(null)
  const serverTime = ref<string | null>(null)
  /**
   * 服务端下发的 App 版本信息（bootstrap.app）。
   *
   * 来源是 Hub 的「管理端设置 + 最新 APK 发布记录」取大者：上传一个新包，所有旧版 App
   * 回前台拉 bootstrap 时就会知道「有新版本」，不需要管理员再手填一次。
   */
  const appRelease = ref<AppVersionInfo | null>(null)
  /**
   * 语音能力（0.4.2，bootstrap.voice）：`asr=true` 才能用 Hub 的服务端识别，
   * `maxSeconds` 是单段录音上限。老 Hub 不发这个字段 → null（只能用手机系统识别）。
   */
  const voice = ref<BootstrapVoice | null>(null)
  const bootstrapping = ref(false)
  const lastBootstrapAt = ref(0)
  const issue = ref<UiIssue | null>(null)
  /**
   * 嵌入座舱（WP56d）：正在等父页面重新交接。
   *
   * 嵌入模式里**没有登录页**：令牌要么从 sessionStorage 恢复，要么来自父页面的交接码。
   * 两者都没有（或令牌过期被清掉）时进入这个状态 —— `cockpit.auth-expired` 已经发给父页面，
   * 等它发回 `cockpit.handoff`（新码）后静默续上。App.vue 据此显示「正在连接座舱」而不是登录页。
   */
  const cockpitWaiting = ref(false)
  let initPromise: Promise<void> | null = null
  let autoLoginInflight: Promise<boolean> | null = null
  let recoveryInflight: Promise<boolean> | null = null

  const isMock = IS_MOCK
  /**
   * 账号隔离键用的 Hub 标识：**首选入口**（稳定值），不是「当前入口」。
   *
   * 两个入口是同一个后端、同一个账号，令牌通用（0.4.11 / WP52）：如果这里跟着当前入口变，
   * 切一次入口就会换一份会话缓存 / 发送队列，看起来像换了台机器。当前入口在哪由
   * `stores/hub-origin.ts` 管。
   */
  const origin = HUB_ORIGIN

  const accountKey = computed(() =>
    user.value ? accountKeyOf(origin, user.value.username) : null,
  )

  const pointsVisible = computed(() => !!points.value?.enabled)
  const pointsText = computed(() => {
    if (!points.value?.enabled) return ''
    const value = points.value.balance
    return Number.isInteger(value) ? String(value) : value.toFixed(1)
  })

  const isAuthenticated = computed(() => phase.value === 'authenticated')

  /** 把服务端的版本信息落进快照（判断「要不要提示」在 stores/app-update.ts）。 */
  function applyAppRelease(next: AppVersionInfo): void {
    appRelease.value = next
  }

  /** 全局问题条（登录失败 / 唤醒失败 / 后端不可连接都写这里）。 */
  function setIssue(next: UiIssue): void {
    issue.value = next
  }

  function clearIssue(): void {
    issue.value = null
  }

  // ── 初始化 / 登录 ────────────────────────────────────────────────────────

  /**
   * 启动初始化（每个进程一次）。
   *
   * 注意：**必须返回同一个 Promise**。路由守卫（router.beforeEach）和 App.onMounted 都会调
   * init()；0.2.13 之前用 `inited` 布尔量，第二个调用立刻返回、此时 phase 还是 'boot'，
   * App 就会判定「未登录」先跳登录页 —— 真机表现就是「冷启动停在登录页/闪一下登录页」。
   */
  function init(): Promise<void> {
    if (!initPromise) {
      initPromise = doInit().catch((error: unknown) => {
        recordDiag('auth:init', error instanceof Error ? 'failed' : 'error')
        if (phase.value === 'boot') phase.value = 'anonymous'
      })
    }
    return initPromise
  }

  async function doInit(): Promise<void> {
    gateway.onAuthLost((reason) => {
      void forceLogout('expired', reason)
    })
    // 嵌入座舱（WP56d，docs/24 §6）：没有登录页，令牌只来自 sessionStorage / 父页面交接码。
    if (isCockpitEmbed()) {
      await doInitCockpit()
      return
    }
    const tokens = await restoreTokensWithRetry()
    if (tokens) {
      recordDiag('auth:restore', 'ok')
      await afterAuthenticated(tokens.user)
      return
    }
    recordDiag('auth:restore', 'none')
    // 没有本地令牌：如果「记住账号密码」保存过口令（原生安全存储）且不是刚退出/被吊销，
    // 冷启动直接自动登录，不再让用户点一次「登录」。
    if (await tryAutoLogin('boot')) return
    phase.value = 'anonymous'
  }

  // ── 嵌入座舱（WP56d / docs/24 §6）─────────────────────────────────────────

  /**
   * 嵌入模式的启动：sessionStorage 里的座舱令牌 → 父页面给的交接码 → 都没有就等交接。
   *
   * 顺序是刻意的：刷新同一个 iframe 时 sessionStorage 还在，不该再消耗一个交接码
   * （Hub 的码是一次性的，父页面刷新 iframe 时也不一定发新码）。
   */
  async function doInitCockpit(): Promise<void> {
    const tokens = await restoreTokensWithRetry()
    if (tokens) {
      recordDiag('auth:cockpit-restore', 'ok')
      await afterAuthenticated(tokens.user)
      return
    }
    recordDiag('auth:cockpit-restore', 'none')
    if (await adoptCockpitCode(takeCockpitCode(), 'boot')) return
    enterCockpitWaiting('no-handoff')
  }

  /** 嵌入模式的「等父页面交接」：清干净、不弹登录页，发 `cockpit.auth-expired`。 */
  function enterCockpitWaiting(reason: string): void {
    phase.value = 'anonymous'
    cockpitWaiting.value = true
    issue.value = null
    recordDiag('auth:cockpit-wait', reason)
    notifyCockpitAuthExpired()
  }

  /**
   * 用一个交接码换座舱令牌并进入登录态（启动时与父页面 `cockpit.handoff` 共用）。
   *
   * 码**只会用一次**：调用方传进来（`takeCockpitCode()` 已经把它从待用位置取走了），
   * 失败也不再复用 —— Hub 侧是一次性 + 60 秒，重试同一个码必然失败。
   *
   * @returns 是否成功进入登录态
   */
  async function adoptCockpitCode(
    code: string | null,
    trigger = 'handoff',
  ): Promise<boolean> {
    if (code === null) return false
    if (IS_MOCK) {
      // 进程内假 Hub 没有这条接口；嵌入模式本来就只可能出现在网页构建里。
      recordDiag('auth:cockpit-exchange', `skip:${trigger}`)
      return false
    }
    try {
      const session = await exchangeCockpitHandoff({ origin: HUB_ORIGIN, code })
      await tokenStore.save(session.tokens)
      recordDiag('auth:cockpit-exchange', `ok:${trigger}`)
      cockpitWaiting.value = false
      await afterAuthenticated(session.tokens.user)
      return true
    } catch (error) {
      const code_ = error instanceof HubApiError ? error.code : 'failed'
      recordDiag('auth:cockpit-exchange', `${code_}:${trigger}`)
      return false
    }
  }

  /** 父页面发来新码（`cockpit.handoff`）：静默续上；失败就再喊一次「重新交接」。 */
  async function cockpitHandoff(code: string): Promise<boolean> {
    if (!IS_WEB_BUILD || !isCockpitEmbed()) return false
    const ok = await adoptCockpitCode(code, 'handoff')
    if (!ok) {
      setCockpitCode(null)
      enterCockpitWaiting('handoff-failed')
    }
    return ok
  }

  /** 令牌过期/失效后的嵌入模式收尾：清令牌与本地缓存，等父页面重新交接。 */
  async function expireCockpitSession(): Promise<void> {
    const acc = accountKey.value
    recordDiag('auth:cockpit-expired', 'expired')
    await clearLocalTokens()
    await clearLocalState(acc)
    resetToAnonymous()
    enterCockpitWaiting('expired')
  }

  /** 登录态就绪后的公共收尾（恢复登录 / 自动登录 / 手动登录共用）。 */
  async function afterAuthenticated(nextUser: AuthUser): Promise<void> {
    user.value = nextUser
    phase.value = 'authenticated'
    issue.value = null
    // 0.2.9：启动时顺手合并历史重复设备（老版本每次登录都会新增一条同名设备）。
    // 嵌入座舱的令牌走不了这条手机接口（`scope=cockpit` 只放行通道需要的路径），跳过。
    if (!isCockpitEmbed()) void gateway.consolidateDevices()
    // 首屏不等网络：缓存由 App 交给聊天 store；bootstrap 在后台跑。
    void refreshBootstrap()
  }

  /**
   * 读本地令牌（SecureStorage）。
   *
   * 冷启动最初几十/几百毫秒原生插件可能还没就绪（`getItem` 会抛/回 null），
   * 直接判定「没登录」会让用户每次开 App 都被丢回登录页。现在按指数退避重试到 ~4.5s；
   * 只有「读成功 + 确实没有条目」才只给 1.2s 宽限（首次安装/刚退出时不白等太久）。
   */
  async function restoreTokensWithRetry(): Promise<AuthTokens | null> {
    return restoreTokensWithBackoff<AuthTokens>({
      restore: () => gateway.restore(),
      status: secureStoreReadStatus,
      secureStorage: isSecureStorageAvailable(),
      onEvent: (name, detail) => recordDiag(name, detail),
    })
  }

  /**
   * 冷启动自动登录：只有「原生安全存储里真的有密码」且没被抑制时才尝试。
   * 网络/临时错误在 ~15s 窗口内退避重试（冷启动时网络栈/容器唤醒都要时间）；
   * 口令错/被吊销直接失败。
   */
  async function tryAutoLogin(trigger: string): Promise<boolean> {
    if (autoLoginInflight) return autoLoginInflight
    const tracked = doTryAutoLogin(trigger).finally(() => {
      autoLoginInflight = null
    })
    autoLoginInflight = tracked
    return tracked
  }

  async function doTryAutoLogin(trigger: string): Promise<boolean> {
    try {
      const credentials = await loadAutoLoginCredentials()
      if (!credentials) {
        recordDiag('auth:auto-login', `skip:${trigger}`)
        return false
      }
      return await runSilentLogin(credentials, trigger)
    } catch {
      recordDiag('auth:auto-login', `failed:${trigger}`)
      return false
    }
  }

  /**
   * 读「记住的口令」。冷启动时 SecureStorage 可能还没就绪、读到空（不是没存过）：
   * 原生环境没读到就短重试几次，别把「插件慢」当成「没存口令」直接丢登录页。
   * （已抑制自动登录/Web 环境不重试，避免首次安装或刚退出时白等。）
   */
  async function loadAutoLoginCredentials(): Promise<SavedCredentials | null> {
    const first = await rememberedLogin.autoLoginCredentials()
    if (first) return first
    if (!isSecureStorageAvailable()) return null
    if (await rememberedLogin.isAutoLoginSuppressed()) return null
    // 用户明确取消勾选「记住账号密码」：不必为「插件可能没就绪」再等。
    if (!(await rememberedLogin.load()).remember) return null
    for (const delay of AUTO_LOGIN_CREDENTIAL_RETRY_DELAYS) {
      await sleep(delay)
      const next = await rememberedLogin.autoLoginCredentials()
      if (next) return next
      // 期间用户手动登录/退出：别再读了
      if (phase.value !== 'boot') return null
    }
    return null
  }

  /** 用记住的口令静默登录（退避重试在 runAutoLoginRetries 里，纯逻辑可单测）。 */
  async function runSilentLogin(credentials: SavedCredentials, trigger: string): Promise<boolean> {
    recordDiag('auth:auto-login', `try:${trigger}`)
    const outcome = await runAutoLoginRetries({
      attempt: () => login(credentials.username, credentials.password),
      sleep,
      now: () => Date.now(),
      shouldRetry: isRetryableLoginError,
      aborted: () => phase.value === 'anonymous',
    })
    if (outcome.ok) {
      recordDiag('auth:auto-login', `ok:${trigger}`)
      return true
    }
    const code = outcome.error instanceof HubApiError ? outcome.error.code : 'failed'
    recordDiag('auth:auto-login', `${code}:${trigger}`)
    if (code === 'INVALID_CREDENTIALS') await rememberedLogin.onInvalidCredentials()
    return false
  }

  /**
   * 令牌失效时的静默恢复：只有「过期/失效类」才用记住的口令自动登录回来
   * （重放/轮换、吊销、账号停用一律回登录页，见 lib/remembered-login.ts 的码表）。
   * 返回 true 表示已经恢复成登录态；false 才应该回登录页。
   */
  async function recoverAuth(code: string): Promise<boolean> {
    if (recoveryInflight) return recoveryInflight
    const tracked = doRecoverAuth(code).finally(() => {
      recoveryInflight = null
    })
    recoveryInflight = tracked
    return tracked
  }

  async function doRecoverAuth(code: string): Promise<boolean> {
    try {
      // 令牌已经不可用了：先清本地，别让它下次冷启动再兜一圈（失败也不留坏令牌）。
      await clearLocalTokens()
      const suppressed = await rememberedLogin.isAutoLoginSuppressed()
      const credentials = suppressed ? null : await rememberedLogin.autoLoginCredentials()
      const decision = decideSilentLogin({
        code,
        hasCredentials: credentials !== null,
        suppressed,
      })
      recordDiag('auth:recover', `${code}:${decision.action}:${decision.reason}`)
      if (decision.action === 'silent-login' && credentials !== null) {
        return await runSilentLogin(credentials, 'recover')
      }
      // 回登录页：吊销 / 轮换重放 / 账号停用（以及无法识别的码）都像吊销一样收尾——
      // 抑制下次冷启动的自动登录；前三类再清掉安全存储里的口令（疑似泄露，让用户重输）。
      if (shouldSuppressAutoLogin(decision)) void rememberedLogin.suppressAutoLogin()
      if (shouldClearCredentials(decision)) void rememberedLogin.clearPassword()
      return false
    } catch {
      recordDiag('auth:recover', `${code}:failed`)
      return false
    }
  }

  async function clearLocalTokens(): Promise<void> {
    try {
      await tokenStore.clear()
    } catch {
      /* 本地清理失败不阻断恢复 */
    }
  }

  async function login(username: string, password: string): Promise<void> {
    issue.value = null
    const tokens = await gateway.login({
      username: username.trim(),
      password,
      deviceName: await deviceName(prefs),
      platform: currentPlatform(),
      // 同一安装复用同一条设备记录（0.2.9）：不再每次登录都堆一条「离线设备」
      installId: getInstallId(),
    })
    // 手动登录成功 → 下次冷启动可以继续自动登录
    void rememberedLogin.allowAutoLogin()
    recordDiag('auth:login', 'ok')
    await afterAuthenticated(tokens.user)
    // 手动登录时等一次 bootstrap，让调用方（登录页）拿到最新状态再跳转。
    // 唤醒由 stores/backend.ts 自己在 bootstrap 之后跑（watch 登录态/后端列表）。
    await refreshBootstrap()
  }

  async function logout(): Promise<void> {
    const acc = accountKey.value
    // 主动退出：这次启动别再自动登回去；顺手清掉安全存储里的口令（保留用户名）
    void rememberedLogin.suppressAutoLogin()
    void rememberedLogin.clearPassword()
    void clearLastSession(prefs)
    recordDiag('auth:logout')
    try {
      await gateway.logout()
    } finally {
      await clearLocalState(acc)
      resetToAnonymous()
    }
  }

  /** 「吊销本设备」：契约里 logout 就是吊销本设备。 */
  async function revokeDevice(): Promise<void> {
    await logout()
  }

  /** reason/detail 里出现这些值 = 设备被吊销（明确的权限动作，必须回登录页）。 */
  function isRevokedReason(value: string | undefined): boolean {
    return value === 'revoked' || value === 'device-revoked' || value === 'DEVICE_REVOKED'
  }

  async function forceLogout(reason: string, detail?: string): Promise<void> {
    recordDiag('auth:force-logout', detail === undefined ? reason : `${reason}:${detail}`)
    // 嵌入座舱（WP56d）：没有登录页可回，也不该用「记住的口令」自动登录（那不是管理员的
    // 手机登录）。过期/被吊销一律「告诉父页面重新交接」，界面停在等交接状态。
    if (isCockpitEmbed()) {
      await expireCockpitSession()
      return
    }
    const revoked = isRevokedReason(detail) || isRevokedReason(reason)
    if (revoked) {
      // 设备被吊销：清口令 + 抑制自动登录（这是明确的权限动作）。
      void rememberedLogin.suppressAutoLogin()
      void rememberedLogin.clearPassword()
      void clearLastSession(prefs)
      await finishAnonymous('revoked')
      return
    }
    // 令牌过期/失效（以及轮换重放、账号停用）：如果「记住账号密码」还有口令且这次失效属于
    // 「过期类」，先静默登录回来，用户不必再点一次「登录」；其余情况 recoverAuth 会回登录页
    // （并抑制下次自动登录、必要时清口令）。
    const code = detail ?? reason
    const recovered = await recoverAuth(code)
    if (recovered) {
      issue.value = null
      return
    }
    // 恢复不了：保留记住的口令（下次冷启动还能再试），但本次回登录页。
    // 账号类错误（停用/待审批/必须改密码）把具体原因带给用户，别糊成「登录已过期」。
    await finishAnonymous('expired', isAccountProblemCode(code) ? errorMessage(code) : undefined)
  }

  async function finishAnonymous(kind: 'revoked' | 'expired', message?: string): Promise<void> {
    const acc = accountKey.value
    await clearLocalTokens()
    await clearLocalState(acc)
    resetToAnonymous()
    issue.value = {
      code: 'UNAUTHENTICATED',
      message:
        message ??
        (kind === 'revoked'
          ? '本设备已被移出登录状态，请重新登录'
          : '登录状态已过期，请重新登录'),
      retryable: false,
    }
  }

  async function clearLocalState(acc: string | null): Promise<void> {
    try {
      if (acc) {
        await sessionCache.clearAccount(acc)
        await selectionStore.forgetAccount(acc)
      } else {
        await sessionCache.clearAll()
      }
    } catch {
      /* 缓存清理失败不阻断退出 */
    }
  }

  function resetToAnonymous(): void {
    phase.value = 'anonymous'
    user.value = null
    points.value = null
    backends.value = []
    instance.value = null
    serverTime.value = null
    appRelease.value = null
    voice.value = null
    // 后端/模型/更新的状态由各自 store 的 watch(isAuthenticated) 清（单向依赖）。
  }

  // ── bootstrap / 唤醒 ────────────────────────────────────────────────────

  async function refreshBootstrap(): Promise<void> {
    if (phase.value !== 'authenticated') return
    bootstrapping.value = true
    try {
      const data = await gateway.bootstrap()
      user.value = data.user
      points.value = data.points
      backends.value = data.backends
      instance.value = data.instance
      serverTime.value = data.serverTime
      voice.value = data.voice ?? null
      applyAppRelease(data.app)
      lastBootstrapAt.value = Date.now()
      // 后端选择/离线回退由 stores/backend.ts 的 watch(auth.backends) 自己校正；
      // 模型选择由 stores/models.ts 的 watch(selectedBackendId) 自己重载。
      // 「云实例可用」的口径与 stores/backend.ts 的 canUseCloud 一致：
      // 普通形态 = 云后端可连接 + 实例 running；嵌入座舱（WP56d）固定 `cloud:ops`，
      // 没有「用户自己的实例」这一层 —— 只看节点 connectable（docs/24 §5）。
      const cloud = data.backends.find(
        (backend) => backend.id === (isCockpitEmbed() ? COCKPIT_NODE_ID : 'cloud:self'),
      )
      const canUseCloud = isCockpitEmbed()
        ? cloud?.connectable === true
        : cloud?.connectable === true && data.instance.status === 'running'
      if (data.instance.capacityFull && !canUseCloud) {
        issue.value = {
          code: 'CAPACITY_FULL',
          message: errorMessage('CAPACITY_FULL'),
          retryable: true,
        }
      }
    } catch (error) {
      handleError(error)
    } finally {
      bootstrapping.value = false
    }
  }

  function handleError(error: unknown): void {
    const err = issueFromError(error)
    // DEVICE_TOKEN_INVALID 以前不在 isAuthLostCode 里，但 requestJson/refresh 失败会把它
    // 抛上来：按「令牌失效」处理（先静默恢复，失败再回登录页），别直接给用户看错误条。
    // 账号停用/待审批/必须改密码、以及轮换重放这类码同样要走 forceLogout：
    // 它们**不许**留在「已登录」的假象里，更不许被记住的口令自动登回去（0.2.17）。
    const tokenLost =
      isAuthLostCode(err.code) ||
      err.code === 'DEVICE_TOKEN_INVALID' ||
      isAccountProblemCode(err.code) ||
      isReplayOrRotatedCode(err.code)
    if (tokenLost && err.code !== 'INVALID_CREDENTIALS') {
      void forceLogout(err.code)
      return
    }
    issue.value = err
  }

  return {
    // 状态
    phase,
    user,
    points,
    backends,
    instance,
    serverTime,
    bootstrapping,
    lastBootstrapAt,
    issue,
    appRelease,
    voice,
    cockpitWaiting,
    // 派生
    origin,
    isMock,
    accountKey,
    pointsVisible,
    pointsText,
    isAuthenticated,
    // 动作
    init,
    login,
    logout,
    revokeDevice,
    forceLogout,
    refreshBootstrap,
    cockpitHandoff,
    adoptCockpitCode,
    expireCockpitSession,
    setIssue,
    clearIssue,
  }
})
