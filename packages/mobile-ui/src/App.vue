<script setup lang="ts">
/**
 * 应用壳：登录闸门后的编排。
 *
 * 启动顺序（文档 §6.3 第 6 条）：
 *   令牌恢复 → 首页立即可用（会话列表来自缓存）→ bootstrap → 自动唤醒 → 连通道。
 * 这里只做「谁在什么时候调用谁」，具体状态机在 stores/auth、stores/chat 里。
 */

import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { RouterView, useRouter } from 'vue-router'
import { prefetchSettingsView } from './router'
import AppDrawer from '@/components/AppDrawer.vue'
import ModelSheet from '@/components/ModelSheet.vue'
import EffortSheet from '@/components/EffortSheet.vue'
import PlusSheet from '@/components/PlusSheet.vue'
import ImageViewer from '@/components/ImageViewer.vue'
import SessionActionSheet from '@/components/SessionActionSheet.vue'
import SessionMenu from '@/components/SessionMenu.vue'
import SidePanel from '@/components/SidePanel.vue'
import UsagePanel from '@/components/UsagePanel.vue'
import DiagnosticsPanel from '@/components/DiagnosticsPanel.vue'
import UpdateNotice from '@/components/UpdateNotice.vue'
import { useAppUpdateStore } from '@/stores/app-update'
import { useAuthStore } from '@/stores/auth'
import { useBackendStore } from '@/stores/backend'
import { useCockpitStore } from '@/stores/cockpit'
import { useChatStore } from '@/stores/chat'
import { useFilesStore } from '@/stores/files'
import { useModelsStore } from '@/stores/models'
import { useUiStore } from '@/stores/ui'
import { useTtsStore } from '@/stores/tts'
import { useHubOriginStore } from '@/stores/hub-origin'
import { prefs } from '@/lib/instance'
import { LastSessionRestorer, clearLastSession, loadLastSession } from '@/lib/last-session'
import { recordDiag } from '@/lib/diagnostics'
import { APP_VERSION, IS_WEB_BUILD } from '@/lib/app-info'
import CockpitNavLog from '@/components/CockpitNavLog.vue'
import CockpitSessionRail from '@/components/CockpitSessionRail.vue'
import {
  ensureBackGuard,
  initWebShell,
  minimizeApp,
  onAppStateChange,
  onBackButton,
} from '@/lib/platform'
import { startKeyboardViewport } from '@/composables/use-keyboard-viewport'
import { sidePanelTitle } from '@/lib/side-panel'
import { warmupShiki } from '@/lib/highlight'
import { warmupRenderer } from '@/lib/markdown'

const router = useRouter()
const auth = useAuthStore()
const backend = useBackendStore()
const cockpit = useCockpitStore()
const appUpdate = useAppUpdateStore()
const chat = useChatStore()
const files = useFilesStore()
const models = useModelsStore()
const ui = useUiStore()
const tts = useTtsStore()
const hubOrigin = useHubOriginStore()

const booting = computed(() => auth.phase === 'boot')
const cleanups: Array<() => void> = []

/** 右侧全屏面板的标题（种类在关闭后保留，离场动画期间内容不会先变空）。 */
const panelTitle = computed(() => sidePanelTitle(ui.sidePanelKind))

/**
 * 嵌入座舱（WP56d / docs/24 §1「舰桥布局」）：中控台 = 这个 iframe 的全部可视区域，
 * 会话列表收进顶部的「航行日志」下拉，不再占一栏。APK 里 `cockpit.embed` 恒 false。
 */
const cockpitLog = computed(() => cockpit.embed && cockpit.logOpen)

// 诊断：每次 App 启动记一条（跨重启保留，排查「又要登录 / 又报错」的起点）
recordDiag('boot', APP_VERSION)

/**
 * 手机网页版（WP54 / W2）：给 `<html>` 打 `is-web`，网页版专属的全局样式按它生效
 * （整页回弹/下拉刷新、输入框字号、长按选择），APK 构建里这一行什么都不做。
 */
initWebShell()

/**
 * 网页版的浏览器返回 = APK 返回键：每次路由导航结束后把「历史守卫」补回栈顶。
 *
 * 守卫是一条 URL 相同的占位历史记录（`lib/platform.ts` 的 `ensureBackGuard`）：浏览器
 * 返回 / 侧滑返回 / Android 系统返回都会先落在它上面，交给 `handleBack` 分层关闭，
 * 而不是直接把页面退出去。抽屉、弹层、设置页打开时**不需要**另压历史记录
 * （× 关掉后也不会越积越多、更不会多退一步）。APK 里 `ensureBackGuard` 是空操作。
 */
router.afterEach(() => {
  ensureBackGuard()
})

/**
 * 当前有没有「会被返回键关掉」的层（抽屉、弹层、全屏面板、对话框、图片查看器）。
 * 只用来看「打开层时历史栈顶是不是还压着守卫」。
 */
const anyOverlayOpen = computed(() => {
  const snapshot = ui.overlaySnapshot()
  return (
    snapshot.imageViewer ||
    snapshot.sidePanel ||
    snapshot.sessionMenu ||
    snapshot.dialog ||
    snapshot.drawer ||
    snapshot.bottomSheet
  )
})

/**
 * 网页版：打开任何一层时再确认一次守卫在栈顶。
 *
 * 正常路径上 `afterEach` 已经保证了（打开层本身不再压记录，× 关掉也就不会越积越多）；
 * 这里兜住「守卫被别的历史记录盖住」的情况（例如用户手动改地址栏的 hash），
 * 让「打开层 → 返回先关层」始终成立。APK 里 `ensureBackGuard` 是空操作。
 */
watch(anyOverlayOpen, (open) => {
  if (open) ensureBackGuard()
})

/**
 * Android 返回键分层（0.4.0 §1.4）：
 *   全屏图片 → 右侧面板 → ⋮ 菜单 → 菜单/对话框 → 抽屉 → 底部弹层
 *   → 对话页回首页 → 首页退到桌面（不杀进程）
 * 层的顺序在 `lib/overlay-stack.ts`（单测锁住），`ui.consumeOverlay()` 只负责关掉选中那层。
 *
 * 网页版（WP54 / W2）：同一个函数也接浏览器返回（`popstate`），返回值告诉平台层
 * 「这次是不是真的关掉了一层」——`false` 表示已经到根页面，平台层会把历史守卫补回去，
 * 停在首页不离开 `/m/`。
 */
async function handleBack(): Promise<boolean> {
  if (ui.consumeOverlay()) return true
  const route = router.currentRoute.value
  if (route.name !== 'home' && route.name !== 'login') {
    try {
      await router.replace('/')
    } catch {
      /* 导航被取消/重复（例如浏览器返回已经先把它换掉了）：不影响返回语义 */
    }
    return true
  }
  if (IS_WEB_BUILD) {
    // 网页版没有「退到桌面」（APK 的 minimizeApp）：停在首页，给一句和 APK 位置一致的提示。
    ui.toast('已经在首页了')
    return false
  }
  await minimizeApp()
  return false
}

/**
 * 冷启动接着展示上一次对话（0.2.9 起；0.2.14 修「冷启动回首页」）。
 *
 * 旧实现的两个坑：
 *  1) 只等会话列表 4 秒；云容器冷启动唤醒 ~11s，必然超时 —— 而 `restoredLastConversation`
 *     在进入函数时就置位（成功与否都不再重试），于是本次运行一直停在首页；
 *  2) 只在「认证状态变 true」时触发一次；那一刻路由可能还是登录页/还没 resolve，
 *     直接 return 之后就再也没人触发。
 *
 * 现在：等待窗口 60s，会话列表更新 / 唤醒就绪 / 回前台 / 路由回首页都会重新触发；
 * 成功或取消后本次运行不再重复打开；用户手动导航走了就取消（不把人拽回旧会话）。
 */
function canOpenSessionForRestore(): boolean {
  // 控制器还没建（后端未选/切换中）时 openSession 会被丢掉，等下一次轮询。
  return !!backend.selectedBackendId && chat.backendId === backend.selectedBackendId
}

function createLastSessionRestorer(): LastSessionRestorer {
  return new LastSessionRestorer({
    loadRecord: () => loadLastSession(prefs),
    clearRecord: () => clearLastSession(prefs),
    isAuthenticated: () => auth.isAuthenticated,
    routeName: () => router.currentRoute.value.name,
    selectedBackendId: () => backend.selectedBackendId,
    findSession: (sessionId) =>
      chat.sessions.find((session) => session.sessionId === sessionId) ?? null,
    canOpenSession: () => canOpenSessionForRestore(),
    openSession: (sessionId) => chat.openSession(sessionId),
    navigate: async (sessionId) => {
      if (router.currentRoute.value.name === 'home') await router.replace(`/c/${sessionId}`)
    },
    isCanceled: () => false,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onEvent: (name, detail) => recordDiag(name, detail ?? ''),
  })
}

let lastSessionRestorer = createLastSessionRestorer()

/** 任一「可能已经就绪」的时机都可触发；进行中/已有结论时内部自动去重。 */
function maybeRestoreLastConversation(trigger: string): void {
  if (!auth.isAuthenticated) return
  // 嵌入座舱（WP56d）：会话由父页面（两舷的卡 / 航行日志）驱动，不自动跳「上次的会话」——
  // 那条记录属于普通 /m/ 登录（同一个 localStorage 键），在座舱里恢复它是错的。
  if (cockpit.embed) return
  const route = router.currentRoute.value.name
  // 已经不在首页（用户自己打开的会话/设置等）就不打扰；启动初期路由未 resolve 时先跑起来等。
  if (route !== undefined && route !== null && route !== '' && route !== 'home') return
  if (lastSessionRestorer.settled || lastSessionRestorer.busy) return
  recordDiag('restore:trigger', trigger)
  void lastSessionRestorer.restore()
}

/** 退出登录/账号切换：取消进行中的恢复，给下一次登录准备全新的状态机。 */
function resetLastSessionRestorer(): void {
  lastSessionRestorer.cancel()
  lastSessionRestorer = createLastSessionRestorer()
}

/** 账号可用后：接上当前后端；唤醒就绪再连通道。 */
async function syncSession(): Promise<void> {
  if (!auth.isAuthenticated) {
    chat.reset()
    return
  }
  if (backend.selectedBackendId) {
    await chat.switchBackend(backend.selectedBackendId)
  }
  if (backend.wakeState === 'ready' || backend.canUseCloud) {
    await chat.ensureConnected()
  }
}

onMounted(async () => {
  // 多入口（0.4.11）：必须在第一次请求之前挂上订阅 —— HubClient 会在首个请求前恢复
  // 「上次可用入口」，这里同步把状态接上（不阻塞启动，读存储失败也不影响）。
  hubOrigin.init()
  // 嵌入座舱（WP56d）：没有登录页。桥要尽早挂上（父页面拿到 cockpit.ready 后就会发
  // focus-session / prefill）；没有令牌时 auth 已经在等父页面交接，界面盖一层提示。
  //
  // WP58：**必须在 `auth.init()` 之前**调。`cockpit.start()` 里同时开始报 `cockpit.status`
  // （docs/26 §5），第一个阶段是 `auth`——等 init 回来再挂桥的话，那一刻已经 authenticated，
  // Hub 的加载卡就永远看不到「连接中」的第一步（e2e 断言过这个顺序）。
  if (cockpit.embed) cockpit.start()
  // 首次进入：等同一份 init（router guard 里也会触发；现在 init 返回同一个 Promise）
  await auth.init()
  if (cockpit.embed) {
    if (auth.isAuthenticated) {
      await syncSession()
      void backend.ensureAwake()
      // WP56e3：座舱节点此刻可能已经可连接（iframe 重载 / 会话令牌还在）——
      // 主动建通道并等一次 hello；节点还在冷启动时这里直接返回，等 connectable 变 true
      // 的 watcher 再来一次。
      void chat.ensureCockpitChannel()
    }
  } else if (!auth.isAuthenticated) {
    await router.replace('/login')
  } else {
    await syncSession()
    void backend.ensureAwake()
    maybeRestoreLastConversation('mount')
  }

  const offBack = await onBackButton(() => handleBack())
  cleanups.push(offBack)
  // 网页版：首次导航（vue-router 初始化那次是 replaceState）结束后再补一次守卫，
  // 保证「刚打开就按返回」也停在页面里。APK 里这是空操作。
  void router.isReady().then(() => ensureBackGuard())

  const offApp = await onAppStateChange((isActive, source) => {
    // `source` 只进诊断（APK 恒为 native；网页版是 visibility/pageshow/freeze/resume）：
    // 真机上「回前台怎么没重连」时能一眼看出是哪个事件没来。
    recordDiag('lifecycle', `${source}:${isActive ? 'active' : 'inactive'}`)
    chat.recordAppState(isActive)
    if (isActive) {
      // 更新流程：刚才可能去系统设置里开「允许安装未知应用」了，回来接着装（0.3.1）
      void appUpdate.onForeground()
      // 多入口（0.4.11）：停在备用入口时后台静默探首选，通了就切回（切回后 watcher 重连通道）。
      void hubOrigin.ensurePrimary()
      void auth.refreshBootstrap().then(async () => {
        chat.onForeground()
        // 嵌入座舱（WP56e3）：没有唤醒接口，回前台 / 页面重新显示（pageshow、bfcache 恢复）
        // 时若通道已关就直接重建并等一次 hello —— reload 后的首个 pageshow 常常早于生命周期
        // 监听注册（见 boot 诊断），所以这里不能只依赖事件本身。
        if (cockpit.embed) {
          await syncSession()
          await chat.ensureCockpitChannel()
        } else {
          void chat.ensureConnected()
        }
        maybeRestoreLastConversation('foreground')
      })
    } else {
      // 后台不再伪装「还连着」：干净断开，回前台再探活/重连。
      // 网页版同理：切页签/进 bfcache 时先把 WebSocket 干净收掉，pageshow 恢复后再连
      // （Hub 反正 45s 空闲会关，留着也是半边开）。
      chat.pauseConnection()
      // Android WebView 切后台会暂停媒体：朗读统一按「停止」处理（不留在暂停态）
      tts.stop('background')
    }
  })
  cleanups.push(offApp)

  // 网页版的 visibilitychange 已经在 `onAppStateChange` 的网页实现里接到同一套回调上了
  // （还有 pageshow/freeze/resume），挂两条会重复断开/重连，所以网页构建跳过这一段。
  // APK 保留原来的兜底（0.4.1 §1：网页调试态切页签只暂停连接计时）。
  if (!IS_WEB_BUILD) {
    const onVisibility = () => {
      // 网页端切页签 ≈ 切后台：只暂停连接计时（0.4.1 §1），回来时从那一刻重新算。
      if (document.hidden) {
        chat.onHidden()
        // 朗读同理：切走就停（回来后用户再点，不会「莫名其妙继续念」）
        tts.stop('background')
        return
      }
      if (auth.isAuthenticated) {
        // 网页端切回页签 ≈ 回前台：同样给首选入口一次静默探测的机会
        void hubOrigin.ensurePrimary()
        chat.onForeground()
        maybeRestoreLastConversation('visible')
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility))
  }

  // 键盘/可视视口：网页版按 visualViewport 缩壳（输入卡、发送锚定留白、问题导航条一起让开键盘），
  // APK 仍是原来的 --kb-inset 兜底（Keyboard 插件已经 resize 过，这里恒为 0）。
  cleanups.push(startKeyboardViewport())

  // 首屏之后预热代码高亮：Shiki 的首次动态 import/编译是 100ms 级任务，
  // 必须在用户开始流式之前完成，否则会落在关键帧上（§6.3 第 1 条）。
  // 不用 requestIdleCallback：headless/后台标签页里它可能长时间不触发，
  // 结果预热被推迟到正是流式的时候。固定延时更可控：1.5s 已在「可输入」之后。
  setTimeout(() => {
    warmupRenderer()
    warmupShiki()
    // 设置页 chunk 也在这时候预取（0.4.5）：用户从抽屉点「设置」时省掉一次网络往返
    prefetchSettingsView()
  }, 1_500)

  // 真机 chrome://inspect 诊断出口（不暴露令牌；e2e 脚本也按这条路取状态）。
  ;(window as unknown as Record<string, unknown>).__dshHub = {
    auth,
    backend,
    chat,
    files,
    models,
    ui,
    tts,
    hubOrigin,
    cockpit,
    router,
  }
})

watch(
  () => auth.isAuthenticated,
  async (ok) => {
    if (!ok) {
      chat.reset()
      resetLastSessionRestorer()
      // 嵌入座舱没有登录页：令牌过期由 cockpit store 通知父页面重新交接（docs/24 §6）。
      if (cockpit.embed) return
      if (router.currentRoute.value.name !== 'login') await router.replace('/login')
      return
    }
    // 恢复/自动登录成功但路由还停在登录页（启动竞态）：立刻回首页，别让用户再点一次「登录」。
    if (router.currentRoute.value.name === 'login') await router.replace('/')
    await syncSession()
    void backend.ensureAwake()
    maybeRestoreLastConversation('auth')
  },
)

/**
 * 入口切换（0.4.11 / WP52）：设备令牌（Bearer）两个入口通用，**不重新登录**；
 * 通道 WebSocket 要换到新入口 —— 复用现有的重连逻辑（断开旧链路 + 退避重连），
 * 不另起一套。切换发生在登录前（第一次请求）时这里什么都不做，登录后由 syncSession 连。
 */
watch(
  () => hubOrigin.current,
  () => {
    if (auth.isAuthenticated) chat.retryConnection()
  },
)

/** 会话列表（含本地缓存）变化 —— 冷启动恢复上次会话最关键的触发点。 */
const sessionsSignature = computed(() =>
  chat.sessions.map((session) => `${session.sessionId}:${session.archived === true ? 1 : 0}`).join(','),
)

watch(sessionsSignature, () => maybeRestoreLastConversation('sessions'))

/**
 * 抽屉一打开就把设置页 chunk 预取掉（0.4.5）：用户接着点「设置」时不用再等网络。
 * 推迟到 300ms（滑入动画 240ms 之后），预取不会和动画抢主线程。
 */
watch(
  () => ui.drawerOpen,
  (open) => {
    if (!open) return
    setTimeout(() => {
      if (auth.isAuthenticated) prefetchSettingsView()
    }, 300)
  },
)

watch(
  () => chat.link,
  (link) => {
    if (link === 'connected') maybeRestoreLastConversation('link')
  },
)

/**
 * 路由变化：
 *  - 回到首页 → 允许再试一次（唤醒/连接完成后会话列表才有内容）；
 *  - 用户自己导航到会话/全部/设置 → 取消本次自动恢复，别把人拽回旧会话。
 *    登录页不算「用户导航走了」：那是登录态问题，由 auth 的 watcher 处理。
 */
watch(
  () => router.currentRoute.value.name,
  (name) => {
    if (name === 'home') {
      maybeRestoreLastConversation('route-home')
      return
    }
    if (name === 'conversation' || name === 'all' || name === 'settings') {
      if (!lastSessionRestorer.settled) lastSessionRestorer.cancel()
    }
  },
)

watch(
  () => backend.wakeState,
  (state) => {
    if (state !== 'ready' || !auth.isAuthenticated) return
    if (chat.workspaceError && chat.link === 'connected') chat.retryOpenSession()
    maybeRestoreLastConversation('wake-ready')
  },
)

watch(
  () => backend.selectedBackendId,
  async (backendId) => {
    if (!backendId || !auth.isAuthenticated) return
    await chat.switchBackend(backendId)
    maybeRestoreLastConversation('backend')
  },
)

watch(
  () => backend.wakeState,
  async (state) => {
    if (state === 'ready') {
      await auth.refreshBootstrap()
      await chat.ensureConnected()
    }
  },
)

/**
 * 嵌入座舱（WP56e3）：`cloud:ops` 变成可连接的那一刻主动建通道，并等一次 hello。
 *
 * 冷启动时序：进入 iframe 时容器还在起 → bootstrap `connectable:false` → App 不连（正确）；
 * 2.5 秒轮询/回前台刷新让 connectable 变 true 后，必须有人把通道建起来。这条 watcher 是
 * 「auth 就绪 + backend connectable」这一条件的唯一触发点（不依赖用户先发一条消息）。
 * 普通 `/m/` 与 APK 完全不变：它们仍由 wakeState / 唤醒流程驱动。
 */
watch(
  () => backend.canUseCloud,
  async (usable) => {
    if (!usable || !auth.isAuthenticated || !cockpit.embed) return
    recordDiag('cockpit:connect', 'can-use-cloud')
    await syncSession()
    await chat.ensureCockpitChannel()
  },
)

onBeforeUnmount(() => {
  cleanups.forEach((fn) => fn())
  cleanups.length = 0
  cockpit.stop()
  chat.reset()
})
</script>

<template>
  <div class="app-shell" :class="{ 'app-shell--console': cockpit.consoleTheme }">
    <!-- 控制台主题 + `sessions='docked'`（docs/26 §3.3）：会话列表常驻左栏，宽 248/264/280 -->
    <CockpitSessionRail v-if="cockpit.sessionsDocked" :width="cockpit.railWidth" />
    <div class="app-shell__main">
      <div v-if="booting" class="boot">
        <span class="boot__dot" />
      </div>
      <RouterView v-else />
    </div>
    <!-- 航行日志（WP56d）：嵌入座舱的会话列表入口（标题 / 发起人 / 更新时间 / + 新会话）。 -->
    <CockpitNavLog v-if="cockpitLog" />
    <!-- 等父页面交接（令牌过期后）：没有登录页可回，盖一层轻提示。 -->
    <div v-if="cockpit.embed && cockpit.waiting" class="cockpit-wait" data-testid="cockpit-wait">
      <span class="cockpit-wait__dot" />
      正在连接管理座舱…
    </div>
    <AppDrawer />
    <ModelSheet />
    <EffortSheet />
    <PlusSheet />
    <SessionActionSheet />
    <SessionMenu />
    <!-- 右侧全屏面板（0.4.0 §1.3）：内容按种类挂载，关闭时靠离场动画收走 -->
    <SidePanel :open="ui.sidePanelOpen" :title="panelTitle" @close="ui.closeSidePanel()">
      <UsagePanel v-if="ui.sidePanelKind === 'usage'" />
      <DiagnosticsPanel v-else />
    </SidePanel>
    <ImageViewer />
    <!-- 控制台主题（WP58 / docs/26 §3.4）：桌面面板里不出现「更新提示条」 -->
    <UpdateNotice v-if="!cockpit.consoleTheme" />
    <div v-if="ui.toastText" class="toast">{{ ui.toastText }}</div>
  </div>
</template>

<style scoped>
/* 主区：左栏（docked 会话列表）之外的整块内容。非控制台主题下它是 app-shell 里唯一的
   弹性子项，观感与以前「RouterView 直接当 app-shell 的子项」完全一致。 */
.app-shell__main {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
}
.boot {
  flex: 1;
  display: grid;
  place-items: center;
  background: var(--bg);
}
.boot__dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.5;
  animation: boot-pulse 1.1s ease-in-out infinite;
}
.cockpit-wait {
  position: absolute;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--bg);
  color: var(--text-2);
  font-size: 14px;
}
.cockpit-wait__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.6;
  animation: boot-pulse 1.1s ease-in-out infinite;
}
@keyframes boot-pulse {
  0%,
  100% {
    transform: scale(0.7);
    opacity: 0.3;
  }
  50% {
    transform: scale(1.1);
    opacity: 0.9;
  }
}
</style>

<!--
  手机网页版（WP54 / W2）的全局规则：**只在 `<html class="is-web">` 下生效**
  （`initWebShell()` 在网页构建里加这个类），所以 APK 构建一条都不会命中、行为完全不变。
  放在 App.vue 的**非 scoped** 样式块里，是为了不改 app.css（那边是各页面共用的大文件）。
-->
<style>
/* 整页下拉刷新与橡皮筋回弹：文档滚动容器（html）上的 overscroll-behavior 才管用。
   列表内部的滚动容器（.thread / .drawer__recent / .sheet）自己有 contain，不受影响。 */
html.is-web {
  overscroll-behavior: none;
}

/* 长按会话时不被浏览器的文本选择 / 系统菜单抢走（lib/long-press.ts 按住期间挂这个类）。 */
html.is-web.long-pressing,
html.is-web.long-pressing * {
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
}

/*
  键盘挡住底部时把整壳缩到「看得见的高度」（composables/use-keyboard-viewport.ts 写 --app-height）：
  输入卡、发送锚定的底部留白、问题导航条一起让开键盘。
  index.html 带 interactive-widget=resizes-content 时 innerHeight 自己会缩，这个变量不会被设，
  两种情况下布局都对。APK 不设这个变量 → 还是 100%。
*/
html.is-web .app-shell {
  height: var(--app-height, 100%);
}

/*
  iOS Safari 聚焦字体 < 16px 的输入框会把整页放大：统一抬到 16px（**不**靠 user-scalable=no
  禁止用户缩放）。!important 是为了压过各组件的 scoped 样式（抽屉搜索 14px、重命名 15px 等）。
*/
html.is-web input,
html.is-web textarea,
html.is-web select {
  font-size: 16px !important;
}
</style>
