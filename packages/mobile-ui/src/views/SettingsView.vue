<script setup lang="ts">
/**
 * 设置页（§1.4 第 5 条 / §6.2）：
 *   账号（用户名、积分余额、退出、吊销本设备）· 外观 · 朗读 · 语音识别 · 关于和版本 · 隐私说明。
 * **没有**服务器地址，也**没有**默认模型 —— 这两项已经从这一版删除。
 *
 * 0.4.5：去掉所有说明性文字（灰色描述、分组脚注、隐私长段、「当前引擎」那一行）；
 * 运行环境/包名这类调试信息挪到「连接诊断」里。页面只剩标题、数据值与按钮。
 *
 * 手机网页版（WP54）：
 *  - 版本区显示「手机网页版 0.4.11」（没有 versionCode），有新版时多一行「有新版本，点此刷新」；
 *  - **没有** APK 的「检查更新 / 下载安装」（网页版的更新就是刷新页面，C7）；
 *  - 新增「下载 App」（取 Hub 现在的安卓 APK 地址）与「电脑版」（`/?view=desktop`）入口；
 *  - 退出登录/吊销本设备行为不变（同样吊销本设备令牌并清本地令牌）。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from '@/components/AppIcon.vue'
import { useAppUpdateStore } from '@/stores/app-update'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { useSettingsStore } from '@/stores/settings'
import { TTS_PREVIEW_KEY, useTtsStore } from '@/stores/tts'
import { APP_VERSION, APP_VERSION_CODE, IS_WEB_BUILD, webPage } from '@/lib/app-info'
import { openExternal } from '@/lib/storage'
import { isSpeechUsable, loadSpeechAvailability, type SpeechAvailability } from '@/lib/speech-native'
import { resolveVoiceEngine, type VoiceEnginePreference } from '@/lib/voice-input'
import { desktopPageUrl, fetchAppDownloadUrl, hubPageTarget, webVersionText } from '@/lib/web-ui'
import { useWebUpdate } from '@/lib/web-update'

const router = useRouter()
const auth = useAuthStore()
const appUpdate = useAppUpdateStore()
const ui = useUiStore()
const settings = useSettingsStore()
const tts = useTtsStore()

const checkingUpdate = ref(false)

// ── 手机网页版（WP54）────────────────────────────────────────────────────────

/** 网页版的新版本状态（W1 的 `webUpdateAvailable` / `reloadToUpdate`，见 lib/web-update）。 */
const webUpdate = useWebUpdate()
/** 版本区文案：网页版是「手机网页版 0.4.11」，APK 仍是 `0.4.11 (51)`。 */
const versionText = IS_WEB_BUILD ? webVersionText() : `${APP_VERSION} (${APP_VERSION_CODE})`
/** 电脑版入口（C8）：`/?view=desktop`；mock 开发版没有网页入口时为 null（不显示这一行）。 */
const desktopUrl = IS_WEB_BUILD ? desktopPageUrl() : null
/** 正在取 APK 下载地址（点「下载 App」时现取，地址随发布变）。 */
const openingDownload = ref(false)

/**
 * 「下载 App」：现取 Hub 当前的安卓 APK 地址再跳过去（同源匿名接口，见 lib/web-ui）。
 * 不直接链 Hub 主页 —— 手机 UA 访问 `/` 会被 302 回 /m/，等于原地打转。
 */
async function openDownloadApp(): Promise<void> {
  if (openingDownload.value) return
  openingDownload.value = true
  try {
    const url = await fetchAppDownloadUrl()
    if (url === null) {
      ui.toast('暂时没有可下载的 App，请稍后再试')
      return
    }
    location.assign(url)
  } finally {
    openingDownload.value = false
  }
}

/**
 * 语音识别（0.4.2）：分段控件就是偏好本身（自动 / 服务器 / 手机），
 * 解析结果挂在 `data-voice-engine-active` 上给排查用，界面上不再多写一行「当前：…」。
 *
 * 可用性检查（原生插件调用）**放到首帧之后**（0.4.5）：进设置页的第一帧不再被它挡住。
 * 只查一次（lib/speech-native 有缓存），不会因为进出设置页反复问系统。
 */
const speechAvailability = ref<SpeechAvailability | null>(null)

function afterFirstPaint(fn: () => void): void {
  if (document.hidden || typeof requestAnimationFrame !== 'function') {
    setTimeout(fn, 0)
    return
  }
  requestAnimationFrame(() => setTimeout(fn, 0))
}

onMounted(() => {
  afterFirstPaint(() => {
    void loadSpeechAvailability().then((availability) => {
      speechAvailability.value = availability
    })
  })
})

const serverEnabled = computed(() => auth.voice?.asr === true)

/** 当前会用的引擎（与按住说话时的选择逻辑同一份代码）：服务器 / 手机系统 / 不可用。 */
const engine = computed(() =>
  resolveVoiceEngine({
    preference: settings.voiceEngine,
    serverEnabled: serverEnabled.value,
    nativeUsable: isSpeechUsable(speechAvailability.value),
  }),
)

/** 偏好选项：主题三段与引擎三段都不换行（标签短、按内容排版，系统字体放大也放得下）。 */
const ENGINE_OPTIONS: Array<{ value: VoiceEnginePreference; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'server', label: '服务器' },
  { value: 'native', label: '手机' },
]

function chooseEngine(value: VoiceEnginePreference): void {
  settings.setVoiceEngine(value)
}

// ── 朗读（0.4.3）────────────────────────────────────────────────────────────

/** 试听按钮：正在试听 → 停止；否则用当前音色读一句固定示例。 */
const previewing = computed(() => tts.isReading(TTS_PREVIEW_KEY))

function togglePreview(): void {
  if (previewing.value) tts.stop('user')
  else tts.preview()
}

function chooseVoice(id: string): void {
  tts.setVoice(id)
}

/**
 * 手动检查更新：拉到新版本时由全局 UpdateNotice 弹提示（与启动时同一个弹层、
 * 同一套「App 内下载 + 系统安装器」流程，0.3.1）；没有就提示已最新。
 */
async function checkUpdate(): Promise<void> {
  if (checkingUpdate.value) return
  checkingUpdate.value = true
  try {
    const result = await appUpdate.checkAppUpdate()
    if (result === 'latest') ui.toast('已是最新版本')
    else ui.toast('发现新版本，请按提示更新')
  } finally {
    checkingUpdate.value = false
  }
}

async function doLogout(): Promise<void> {
  if (!window.confirm('退出登录后需要重新输入密码，确定退出吗？')) return
  await auth.logout()
  await router.replace('/login')
}

async function doRevoke(): Promise<void> {
  if (!window.confirm('吊销本设备后，这台手机上的登录会立即失效，需要重新登录。继续吗？')) return
  await auth.revokeDevice()
  await router.replace('/login')
}

async function openPrivacy(): Promise<void> {
  const url = webPage('/desktop/privacy')
  if (!url) {
    ui.toast('开发版（mock）没有网页入口')
    return
  }
  try {
    // 网页版同源：同页跳转（返回即回设置页）；开发/e2e 跨源仍走新标签
    if (hubPageTarget(url) === 'same') {
      location.assign(url)
      return
    }
    await openExternal(url)
  } catch {
    ui.toast('打不开浏览器，请稍后重试')
  }
}
</script>

<template>
  <header class="app-header">
    <div class="app-header__side">
      <button class="icon-btn" type="button" aria-label="返回" @click="router.back()">
        <AppIcon name="arrowLeft" />
      </button>
    </div>
    <div class="app-header__title">设置</div>
    <div class="app-header__side" />
  </header>

  <div class="page">
    <p class="page__label">账号</p>
    <div class="page__group">
      <div class="page__row">
        <span>{{ auth.user?.displayName ?? auth.user?.username ?? '未登录' }}</span>
        <span v-if="auth.user && auth.user.displayName !== auth.user.username" class="page__row-value">
          @{{ auth.user.username }}
        </span>
      </div>
      <div v-if="auth.pointsVisible" class="page__row">
        积分余额
        <span class="page__row-value">{{ auth.pointsText }}</span>
      </div>
      <button class="page__row page__row--action" type="button" @click="doLogout">
        退出登录
        <AppIcon name="chevronRight" :size="16" />
      </button>
      <button class="page__row page__row--action" type="button" @click="doRevoke">
        吊销本设备
        <AppIcon name="chevronRight" :size="16" />
      </button>
    </div>

    <p class="page__label">外观</p>
    <div class="page__group">
      <div class="page__row">
        主题
        <div class="page__seg" data-theme-seg>
          <button :class="{ 'is-on': settings.theme === 'system' }" @click="settings.setTheme('system')">
            系统
          </button>
          <button :class="{ 'is-on': settings.theme === 'light' }" @click="settings.setTheme('light')">
            浅色
          </button>
          <button :class="{ 'is-on': settings.theme === 'dark' }" @click="settings.setTheme('dark')">
            深色
          </button>
        </div>
      </div>
    </div>

    <p class="page__label">朗读</p>
    <div class="page__group" data-tts-settings>
      <template v-if="tts.available">
        <div
          v-for="voice in tts.voices"
          :key="voice.id"
          class="page__row page__row--voice"
          :data-tts-voice="voice.id"
        >
          <button
            class="tts-voice"
            type="button"
            role="radio"
            :aria-checked="tts.voiceId === voice.id ? 'true' : 'false'"
            @click="chooseVoice(voice.id)"
          >
            <span class="tts-voice__radio" :class="{ 'is-on': tts.voiceId === voice.id }" aria-hidden="true" />
            <span class="tts-voice__name">{{ voice.name }}</span>
          </button>
          <button
            class="tts-preview"
            type="button"
            data-tts-preview
            :aria-label="previewing ? '停止试听' : `试听 ${voice.name}`"
            @click="togglePreview"
          >
            {{ previewing ? '停止' : '试听' }}
          </button>
        </div>
        <div class="page__row page__row--switch">
          <span class="tts-switch__label">自动朗读新回复</span>
          <button
            class="tts-switch"
            type="button"
            role="switch"
            :aria-checked="tts.autoRead ? 'true' : 'false'"
            data-tts-autoread
            @click="tts.toggleAutoRead()"
          >
            <span class="tts-switch__knob" />
          </button>
        </div>
      </template>
      <div v-else class="page__row page__row--disabled" data-tts-unavailable>
        音色
        <span class="page__row-value">{{ tts.unavailableHint }}</span>
      </div>
    </div>

    <p class="page__label">语音识别</p>
    <div class="page__group" data-voice-setting>
      <div class="page__row page__row--seg" :data-voice-engine-active="engine">
        <div class="page__seg" role="group" aria-label="语音识别引擎">
          <button
            v-for="option in ENGINE_OPTIONS"
            :key="option.value"
            type="button"
            :data-engine="option.value"
            :class="{ 'is-on': settings.voiceEngine === option.value }"
            :aria-pressed="settings.voiceEngine === option.value ? 'true' : 'false'"
            @click="chooseEngine(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
    </div>

    <p class="page__label">关于和版本</p>
    <div class="page__group">
      <div class="page__row">
        版本<span class="page__row-value" data-version>{{ versionText }}</span>
      </div>
      <!-- 网页版（C7）：有新版本就刷新页面；没有「检查更新 / 下载安装」这回事 -->
      <button
        v-if="IS_WEB_BUILD && webUpdate.available"
        class="page__row page__row--action"
        type="button"
        data-web-update-row
        @click="webUpdate.reload()"
      >
        有新版本，点此刷新
        <AppIcon name="chevronRight" :size="16" />
      </button>
      <button
        v-if="!IS_WEB_BUILD"
        class="page__row page__row--action"
        type="button"
        :disabled="checkingUpdate"
        @click="checkUpdate"
      >
        {{ checkingUpdate ? '检查更新…' : '检查更新' }}
        <AppIcon name="chevronRight" :size="16" />
      </button>
    </div>

    <!-- 网页版专属：换到别的形态（APK 用户不需要这两行，整组不渲染） -->
    <template v-if="IS_WEB_BUILD">
      <p class="page__label">其他</p>
      <div class="page__group">
        <button
          class="page__row page__row--action"
          type="button"
          data-web-download-app
          :disabled="openingDownload"
          @click="openDownloadApp"
        >
          {{ openingDownload ? '正在打开…' : '下载 App' }}
          <AppIcon name="chevronRight" :size="16" />
        </button>
        <a
          v-if="desktopUrl"
          class="page__row page__row--action page__row--link"
          data-web-desktop
          :href="desktopUrl"
        >
          电脑版
          <AppIcon name="chevronRight" :size="16" />
        </a>
      </div>
    </template>

    <p class="page__label">隐私说明</p>
    <div class="page__group">
      <button class="page__row page__row--action" type="button" @click="openPrivacy">
        完整隐私说明
        <AppIcon name="chevronRight" :size="16" />
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 0.4.3 朗读分组：音色单选（左侧圆点）+ 右侧「试听」 */
.page__row--voice {
  align-items: center;
  gap: 10px;
}
.tts-voice {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  flex: 1;
  min-width: 0;
  text-align: left;
  padding: 2px 0;
}
.tts-voice__radio {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  border-radius: 50%;
  border: 1.6px solid var(--border-strong);
  position: relative;
  transition: border-color 0.14s ease;
}
.tts-voice__radio.is-on {
  border-color: var(--accent-ink);
}
.tts-voice__radio.is-on::after {
  content: '';
  position: absolute;
  inset: 3px;
  border-radius: 50%;
  background: var(--accent-ink);
}
.tts-voice__name {
  font-size: 15px;
  color: var(--text);
  white-space: nowrap;
}
.tts-preview {
  flex: 0 0 auto;
  padding: 5px 11px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 12.5px;
}
.tts-preview:active {
  background: var(--surface);
}
.page__row--switch {
  gap: 10px;
}
.tts-switch__label {
  font-size: 15px;
}
.tts-switch {
  margin-left: auto;
  flex: 0 0 auto;
  width: 46px;
  height: 28px;
  border-radius: 999px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  position: relative;
  transition: background 0.16s ease, border-color 0.16s ease;
}
.tts-switch__knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--bg-elev);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
  transition: transform 0.16s ease;
}
.tts-switch[aria-checked='true'] {
  background: var(--accent-ink);
  border-color: var(--accent-ink);
}
.tts-switch[aria-checked='true'] .tts-switch__knob {
  transform: translateX(18px);
}
.page__row--disabled {
  color: var(--text-2);
}
.page__row--seg {
  display: block;
  padding-top: 6px;
  padding-bottom: 6px;
}
/* 语音识别：分段控件占满整行、三段均分（0.4.5 去掉了下面那行「当前：…」） */
.page__row--seg .page__seg {
  margin-left: 0;
}
.page__row--seg .page__seg button {
  flex: 1 1 0;
  height: 32px;
}
.page__row--action {
  width: 100%;
  background: none;
  text-align: left;
  color: var(--text);
  border-bottom: 1px solid var(--border);
}
/* 网页版「电脑版」是真链接：保留行的外观，去掉链接的下划线与蓝色 */
.page__row--link {
  text-decoration: none;
  color: var(--text);
  box-sizing: border-box;
}
/* 卡片最后一行不画分隔线（action 行自带下边框，盖过了全局 :last-child 规则） */
.page__row--action:last-child {
  border-bottom: 0;
}
.page__row--action .icon {
  margin-left: auto;
  color: var(--text-3);
}
</style>
