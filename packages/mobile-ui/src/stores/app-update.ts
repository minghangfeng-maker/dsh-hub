/**
 * App 更新 store：强更地板 / 可更新提示 / 「稍后」/ 手动检查更新 / 下载与安装（0.3.1）。
 *
 * 从 `auth.ts` 里拆出来（WP46 C）。依赖方向单向：**app-update → auth**。
 * 服务端下发的版本信息本身是 bootstrap 的一部分，跟着 auth 的快照走（`auth.appRelease`）；
 * 这里只做「要不要提示、提示什么、用户点过稍后没有」的判断与动作。
 *
 * 0.3.1 起「下载更新」不再把 APK 地址交给浏览器（Chrome 的下载在真机上永远收不了尾），
 * 改成：WebView 里 fetch 流式下载（lib/update-download）→ 写 Cache（Filesystem）→
 * 本地插件调系统安装器（lib/update-install + AppInstallerPlugin.java）。
 * Web 端（非原生）保持原来的「打开链接」行为。
 *
 * 0.4.11 / WP52：Hub 有两个入口，更新包也有镜像（`bootstrap.app.downloadMirrors`）。
 * 下载按顺序试所有地址（网络失败 / 空闲超时 / 字节数或 sha256 不符就换下一个），
 * 全部失败才报错；老 Hub 没有 downloadMirrors 时退回单个 downloadUrl。
 *
 * WP54（契约 C7）：**手机网页版没有 APK**。网页版分支里：
 *  - 不查 APK、不显示强更（`updateRequired` / `updateAvailable` 恒为 false，W4 的
 *    UpdateNotice 因此在网页版根本不出现）；
 *  - 「检查更新」改成拉一次 `./version.json`（`lib/web-version`）——构建时注入的
 *    `{version, build, builtAt}` 与线上不同就提示刷新；
 *  - 对外只多两个成员：`webUpdateAvailable`（布尔）与 `reloadToUpdate()`（location.reload）。
 *    W4 的 SettingsView 按这两个名字写「有新版本，点此刷新」（接口已冻结，别改名）。
 *
 * 回前台 / 每 30 分钟的轮询由 `lib/web-version` 的 `WebVersionWatch` 自己挂 `visibilitychange`
 * 与定时器（store 初始化时 `start()`），所以**不依赖** App.vue / 平台层再加监听。
 */

import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { APP_VERSION_CODE, BUILD_INFO, IS_WEB_BUILD, versionFromApkUrl } from '@/lib/app-info'
import { resolveDownloadMirrors } from '@dsh-hub/mobile-core'
import { recordDiag } from '@/lib/diagnostics'
import { isNative, openExternal } from '@/lib/storage'
import { WebVersionWatch } from '@/lib/web-version'
import {
  createInstallerBridge,
  createUpdateFileSink,
  updateCachedPath,
} from '@/lib/app-update-native'
import { downloadUpdateMirrors, type UpdateProgress } from '@/lib/update-download'
import { PendingInstall, installUpdate, type AppInstallerBridge } from '@/lib/update-install'
import { useAuthStore } from './auth'

/** 更新流程的状态：界面（UpdateNotice）只按这个状态渲染。 */
export type UpdateDownloadPhase =
  | 'idle'
  | 'downloading'
  | 'installing'
  | 'permission'
  | 'launched'
  | 'failed'

export const useAppUpdateStore = defineStore('app-update', () => {
  const auth = useAuthStore()

  /** 服务端下发的版本信息（bootstrap.app；来源是管理端设置与最新 APK 发布记录取大者）。 */
  const release = computed(() => auth.appRelease)
  /** 用户点过「稍后」：本次运行不再提示同一个版本（强更地板不受影响）。 */
  const updateDismissed = ref(false)

  /** 强更：管理端设的版本地板高于本机。老 App 可能连不上新协议，必须更新后才能继续用。 */
  const updateRequired = computed(
    () =>
      // 网页版没有 APK：刷新即最新，永远不显示强更（C7）。
      !IS_WEB_BUILD && release.value !== null && release.value.minVersionCode > APP_VERSION_CODE,
  )
  /** 可更新：服务端有更新的正式包；点过「稍后」本次运行不再提示。网页版恒 false（见 C7 分支）。 */
  const updateAvailable = computed(
    () =>
      !IS_WEB_BUILD &&
      release.value !== null &&
      !updateRequired.value &&
      release.value.latestVersionCode > APP_VERSION_CODE &&
      !updateDismissed.value,
  )
  /**
   * 全部下载地址（0.4.11）：`downloadMirrors` 原序在前，`downloadUrl` 兜底去重；
   * 老 Hub 只有 downloadUrl 时就是单个地址。
   */
  const updateDownloadUrls = computed<string[]>(() =>
    resolveDownloadMirrors(
      release.value === null
        ? null
        : {
            downloadUrl: release.value.downloadUrl,
            downloadMirrors: release.value.downloadMirrors,
          },
    ),
  )
  const updateDownloadUrl = computed(() => updateDownloadUrls.value[0] ?? null)
  /** 可选的内容校验值（Hub 目前不下发；发了就校验，对不上就换镜像）。 */
  const updateDownloadSha256 = computed(() => release.value?.sha256 ?? null)
  /** 提示里的版本号（从 APK 文件名认，认不出来就是 null，界面不写具体版本）。 */
  const updateVersionLabel = computed(() => versionFromApkUrl(updateDownloadUrl.value))

  // ── 下载/安装状态（0.3.1）────────────────────────────────────────────────

  const downloadPhase = ref<UpdateDownloadPhase>('idle')
  const downloadProgress = ref<UpdateProgress>({ received: 0, total: null, percent: null })
  const downloadError = ref('')
  /** 已经下好、还在 Cache 里的安装包（用户取消安装器后可以「重新安装」）。 */
  const downloadedPath = ref<string | null>(null)

  // ── 手机网页版：线上是不是换了新构建（WP54 / C7）──────────────────────────
  //
  // `webUpdateAvailable` 与 `reloadToUpdate` 是**给 W4 的冻结接口**（SettingsView / UpdateNotice
  // 的「有新版本，点此刷新」）。网页版没有 APK 下载流程，所以这一对就是全部动作。
  /** 线上 `version.json` 与本次构建不同（W4 据此显示「有新版本，点此刷新」）。 */
  const webUpdateAvailable = ref(false)
  let webVersionWatch: WebVersionWatch | null = null

  /**
   * 启动网页版的版本观察（回前台 + 每 30 分钟拉 `./version.json`）。
   *
   * 放在 store 里而不是 App.vue：App.vue 是别的任务的独占文件，而 store 在 `useAppUpdateStore()`
   * 第一次被调用时（App 挂载）就会跑这段，时机一样早。幂等；APK 构建里整段被折掉。
   */
  function startWebVersionWatch(): void {
    if (!IS_WEB_BUILD || webVersionWatch !== null) return
    webVersionWatch = new WebVersionWatch({
      current: BUILD_INFO,
      onUpdate: (remote) => {
        webUpdateAvailable.value = true
        recordDiag('web:version', `update ${remote.version}/${remote.build}`)
      },
      onEvent: (name, detail) => recordDiag(name, detail),
    })
    webVersionWatch.start()
  }

  /** 用户点了「刷新」：整页重载，拿新构建（C7）。 */
  function reloadToUpdate(): void {
    if (typeof location === 'undefined') return
    location.reload()
  }

  startWebVersionWatch()

  if (IS_WEB_BUILD) {
    // 诊断出口（与 App.vue 里给 chrome://inspect 用的 `window.__dshHub` 同类）：
    // App.vue 是别的任务的独占文件，这里自己挂一个只读探针，e2e（web-smoke）才能断言
    // 「回前台出现 webUpdateAvailable」；不暴露任何令牌/地址，网页版专用，APK 里被折掉。
    ;(globalThis as unknown as Record<string, unknown>).__dshHubAppUpdate = {
      get webUpdateAvailable(): boolean {
        return webUpdateAvailable.value
      },
      get watching(): boolean {
        return webVersionWatch !== null
      },
      reloadToUpdate,
    }
  }

  let abortController: AbortController | null = null
  let bridge: AppInstallerBridge | null = null
  let pendingInstall: PendingInstall | null = null

  /** 原生安装器桥接（Web/插件没注册 → null）。懒建一次，之后复用。 */
  function installer(): AppInstallerBridge | null {
    if (!isNative()) return null
    if (bridge === null) bridge = createInstallerBridge()
    return bridge
  }

  function abortActive(): void {
    if (abortController !== null) {
      abortController.abort()
      abortController = null
    }
  }

  /** 回到「什么也没下」的初始态：取消在飞的下载、清掉待装包。 */
  function resetDownload(): void {
    abortActive()
    pendingInstall?.clear()
    pendingInstall = null
    downloadedPath.value = null
    downloadPhase.value = 'idle'
    downloadError.value = ''
    downloadProgress.value = { received: 0, total: null, percent: null }
  }

  /** 「稍后」：本次运行不再弹同一个版本。 */
  function dismissAppUpdate(): void {
    updateDismissed.value = true
    resetDownload()
  }

  /** 下载完成 → 调安装器；没权限就先去设置页并记住待装包。 */
  async function beginInstall(installerBridge: AppInstallerBridge, path: string): Promise<void> {
    downloadPhase.value = 'installing'
    try {
      const outcome = await installUpdate(installerBridge, path)
      if (outcome === 'needs-permission') {
        pendingInstall = new PendingInstall(installerBridge, recordDiag)
        pendingInstall.arm(path)
        downloadPhase.value = 'permission'
        recordDiag('update:install', 'needs-permission')
        return
      }
      downloadPhase.value = 'launched'
      recordDiag('update:install', 'opened')
    } catch (error) {
      downloadPhase.value = 'failed'
      downloadError.value = '打不开系统安装器，请用浏览器下载'
      recordDiag('update:install-fail', errorText(error))
    }
  }

  /** 「立即更新」：原生走 App 内下载 + 系统安装器；Web 保持原来的打开链接。 */
  async function startUpdateDownload(): Promise<void> {
    // 网页版没有 APK：这条路径在网页版永远不该被触发（W4 的界面不显示入口），直接忽略。
    if (IS_WEB_BUILD) return
    const url = updateDownloadUrl.value
    if (!url || downloadPhase.value === 'downloading') return

    if (!isNative()) {
      try {
        await openExternal(url)
      } catch {
        downloadError.value = '打不开浏览器，请稍后重试'
        downloadPhase.value = 'failed'
      }
      return
    }

    const installerBridge = installer()
    if (!installerBridge) {
      downloadPhase.value = 'failed'
      downloadError.value = '当前安装包不支持应用内安装，请用浏览器下载'
      recordDiag('update:install', 'plugin-missing')
      return
    }

    // 重新下载前把上一次的状态（待装包/半截文件）清干净。
    pendingInstall?.clear()
    pendingInstall = null
    abortActive()

    const version = updateVersionLabel.value ?? String(release.value?.latestVersionCode ?? '')
    const path = updateCachedPath(version)
    const controller = new AbortController()
    abortController = controller
    downloadError.value = ''
    downloadProgress.value = { received: 0, total: null, percent: null }
    downloadPhase.value = 'downloading'
    recordDiag('update:download', `start ${updateDownloadUrls.value.length}`)

    const urls = updateDownloadUrls.value
    const sha256 = updateDownloadSha256.value
    const result = await downloadUpdateMirrors({
      urls,
      sink: createUpdateFileSink(version),
      signal: controller.signal,
      ...(sha256 === null ? {} : { expectedSha256: sha256 }),
      // 换下载地址：进度从头算（用户看到的是「又从头下」而不是卡住）。
      onAttempt: ({ index, total }) => {
        if (total > 1) {
          downloadProgress.value = { received: 0, total: null, percent: null }
          recordDiag('update:mirror', `${index + 1}/${total}`)
        }
      },
      onProgress: (progress) => {
        downloadProgress.value = progress
      },
      onEvent: (name, detail) => recordDiag(name, detail),
    })
    if (abortController === controller) abortController = null

    // 用户点过「取消下载」：状态已经在 cancelUpdateDownload 里复位，别再用结果覆盖界面。
    if (controller.signal.aborted) return

    if (!result.ok) {
      if (result.reason === 'canceled') {
        downloadPhase.value = 'idle'
        downloadProgress.value = { received: 0, total: null, percent: null }
        return
      }
      downloadError.value = result.message
      downloadPhase.value = 'failed'
      recordDiag('update:download-fail', result.reason)
      return
    }

    downloadProgress.value = {
      received: result.bytes,
      total: result.total ?? result.bytes,
      percent: 100,
    }
    downloadedPath.value = path
    recordDiag('update:download', `ok ${result.bytes} mirror=${result.attempts}`)
    await beginInstall(installerBridge, path)
  }

  /** 「重新安装」：用户取消了系统安装器又回来时，不用再下一次 8.5MB。 */
  async function reinstallDownloaded(): Promise<void> {
    const path = downloadedPath.value
    if (path === null) return
    const installerBridge = installer()
    if (!installerBridge) {
      downloadPhase.value = 'failed'
      downloadError.value = '当前安装包不支持应用内安装，请用浏览器下载'
      return
    }
    await beginInstall(installerBridge, path)
  }

  /** 「取消下载」：中断 fetch；强更弹层下载中不可关闭，但允许取消。 */
  function cancelUpdateDownload(): void {
    if (downloadPhase.value !== 'downloading') return
    abortActive()
    recordDiag('update:download', 'cancel')
    downloadPhase.value = 'idle'
    downloadError.value = ''
    downloadProgress.value = { received: 0, total: null, percent: null }
  }

  /** 「重试」：等价于重新走一遍下载。 */
  async function retryUpdateDownload(): Promise<void> {
    if (downloadPhase.value === 'downloading') return
    await startUpdateDownload()
  }

  /** 兜底：交给系统默认浏览器下载（原生走插件，Web 走新标签页）。 */
  async function downloadInBrowser(): Promise<void> {
    // 兜底交给系统浏览器：优先第一个地址（本入口的），不行用户自己会换。
    const url = updateDownloadUrl.value
    if (!url) return
    const installerBridge = installer()
    try {
      if (installerBridge) await installerBridge.openInBrowser(url)
      else await openExternal(url)
      recordDiag('update:browser', 'opened')
    } catch (error) {
      downloadError.value = '打不开浏览器，请稍后重试'
      downloadPhase.value = 'failed'
      recordDiag('update:browser-fail', errorText(error))
    }
  }

  /** 「打开设置」：用户可能已经从设置页退回来了，再送他一次。 */
  async function openInstallSettings(): Promise<void> {
    const installerBridge = installer()
    if (!installerBridge) return
    try {
      await installerBridge.openInstallSettings()
    } catch (error) {
      downloadError.value = '打不开系统设置，请用浏览器下载'
      downloadPhase.value = 'failed'
      recordDiag('update:settings-fail', errorText(error))
    }
  }

  /**
   * 回到前台：如果刚才是在等「允许安装未知应用」，现在再查一次权限。
   * 用户还没开就安静地等（不要每次切回来都把他踢回设置页）。
   *
   * 网页版：这里顺手再查一次 `version.json`（W2 的可见性监听也可能调到这里；两次合并成一次）。
   */
  async function onForeground(): Promise<void> {
    if (IS_WEB_BUILD) {
      await webVersionWatch?.checkNow()
      return
    }
    if (pendingInstall === null) return
    try {
      const outcome = await pendingInstall.onForeground()
      if (outcome === 'installer-opened') {
        pendingInstall = null
        downloadPhase.value = 'launched'
      }
    } catch (error) {
      downloadPhase.value = 'failed'
      downloadError.value = '打不开系统安装器，请用浏览器下载'
      recordDiag('update:pending-fail', errorText(error))
    }
  }

  /**
   * 手动「检查更新」：重新拉一次 bootstrap，并在真的有新版本时**重新打开提示**
   * （用户可能之前点过「稍后」）。返回值只用于文案：'latest' 表示已经是最新。
   *
   * 网页版（C7）：没有 APK，等价于「现在就去拉一次 version.json」——
   * 有新构建 → 'available'（界面提示刷新，用 `webUpdateAvailable`/`reloadToUpdate`）。
   */
  async function checkAppUpdate(): Promise<'latest' | 'available'> {
    if (IS_WEB_BUILD) {
      const outdated = (await webVersionWatch?.checkNow()) ?? false
      return outdated || webUpdateAvailable.value ? 'available' : 'latest'
    }
    await auth.refreshBootstrap()
    if (release.value !== null && release.value.latestVersionCode > APP_VERSION_CODE) {
      updateDismissed.value = false
      // 上次失败的提示/待装包别带到这次检查里（正在下载就别打断）。
      if (downloadPhase.value !== 'downloading') resetDownload()
      return 'available'
    }
    return 'latest'
  }

  // 服务端版本号变化 → 记一条诊断（排查「为什么不提示/为什么提示」），
  // 强更地板抬高时把「稍后」清掉（必须让用户看到）。
  watch(
    () => release.value,
    (next, previous) => {
      if (!next) return
      const before = previous?.latestVersionCode ?? 0
      if (next.latestVersionCode !== before) {
        recordDiag(
          'app:release',
          `latest=${String(next.latestVersionCode)} current=${String(APP_VERSION_CODE)}`,
        )
      }
      if (next.minVersionCode > APP_VERSION_CODE) updateDismissed.value = false
    },
  )

  return {
    // 状态
    release,
    updateDismissed,
    // 派生
    updateRequired,
    updateAvailable,
    updateDownloadUrls,
    updateDownloadUrl,
    updateVersionLabel,
    // 下载/安装
    downloadPhase,
    downloadProgress,
    downloadError,
    downloadedPath,
    // 手机网页版（WP54 / C7）：**给 W4 的冻结接口**，别改名
    webUpdateAvailable,
    reloadToUpdate,
    // 动作
    dismissAppUpdate,
    checkAppUpdate,
    startUpdateDownload,
    cancelUpdateDownload,
    retryUpdateDownload,
    downloadInBrowser,
    openInstallSettings,
    reinstallDownloaded,
    onForeground,
    resetDownload,
  }
})

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 80)
  return String(error).slice(0, 80)
}
