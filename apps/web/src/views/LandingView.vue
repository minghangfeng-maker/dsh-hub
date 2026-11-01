<script setup lang="ts">
import type { PublicAndroidDownloadResponse, PublicDesktopDownloadItem } from '@dsh-hub/shared'
import { nextTick, computed, onMounted, ref } from 'vue'

import { fetchPublicAndroidDownload, fetchPublicDesktopDownload } from '@/api/public-desktop'
import androidChatShot from '@/assets/landing/android-chat.webp'
import androidHomeShot from '@/assets/landing/android-home.webp'
import cloudShot from '@/assets/landing/cloud-web.webp'
import desktopShot from '@/assets/landing/desktop-win.webp'
import BrandMark from '@/components/base/BrandMark.vue'
import MobileWebBar from '@/components/base/MobileWebBar.vue'
import StarfieldBackdrop from '@/components/landing/StarfieldBackdrop.vue'
import { useAuthStore } from '@/stores/auth'
import { useSiteStore } from '@/stores/site'
import { detectLandingPlatform, type LandingPlatform } from '@/utils/landing-platform'

/**
 * 公开主页 `/`（WP36 起；WP42 三模式 Tab；WP43 换成真实截图、文案收到最少）。
 *
 * 一句标题（WP53：「DSH Hub 连通万物」，去掉副标题与免费/限时字样），下面三个 Tab：云上模式（默认、主推）/ 桌面端 / 安卓端。
 * 每个面板左边只有「标题 · 一句话 · 按钮 · 一行小字」，右边是**真实截图**：
 * 同一个真实会话（让 DSH 分析一份销售表、出图出简报）分别在网页版、Windows 客户端、安卓 App 里打开的样子。
 * 截图来源与复现方法：见仓库外的走查记录（未随开源版发布）。
 * `?platform=cloud|desktop|android` 可强制默认 Tab（验收/分享用）。
 * WP44：顶栏与页脚加「使用文档」入口（`/docs`）。
 * WP54c：手机 UA 停在电脑版（C8 的 `hub_view=desktop`）时，顶部一条「切到手机版」→ `/?view=mobile`；
 *        安卓端面板多一行「手机浏览器直接打开网页版」的入口。
 */

const auth = useAuthStore()
const site = useSiteStore()

const windows = ref<PublicDesktopDownloadItem | null>(null)
/** 安卓：有已发布 APK 时的卡片数据；`null` = 还没发版（显示「即将上线」） */
const android = ref<PublicAndroidDownloadResponse['app']>(null)
const variant = ref<'installer' | 'portable'>('installer')
const tab = ref<LandingPlatform>(detectLandingPlatform())

/** Tab 顺序与默认模式：云上模式固定第一位、默认选中（主推） */
const TABS: readonly LandingPlatform[] = ['cloud', 'desktop', 'android']
const tabIndex = computed(() => Math.max(0, TABS.indexOf(tab.value)))

/** 云上模式的 CTA：登录了进工作台，注册开着去注册，否则去登录 */
const cloudCta = computed(() => {
  if (auth.isLoggedIn) {
    return { to: '/home', label: '进入我的云上 DSH', hint: '已登录，直接开工' }
  }
  if (site.registrationOpen) {
    return { to: '/register', label: '注册使用云上 DSH', hint: '注册后即可开通' }
  }
  return { to: '/login', label: '登录使用云上 DSH', hint: '登录后即可开通' }
})

/** 当前选中的下载物：没挂免安装包时永远是安装器 */
const windowsFile = computed(() => {
  const release = windows.value
  if (!release) return null
  if (variant.value === 'portable' && release.portable) return release.portable
  return { fileName: release.fileName, bytes: release.bytes, url: release.url }
})

const portableSelected = computed(() => variant.value === 'portable' && windows.value?.portable != null)

const windowsMeta = computed(() => {
  if (!windows.value || !windowsFile.value) return ''
  return `v${windows.value.version} · ${formatInstallerSize(windowsFile.value.bytes)}`
})

const androidMeta = computed(() => {
  if (!android.value) return ''
  return `v${android.value.version} · ${formatInstallerSize(android.value.bytes)} · Android 8+`
})

onMounted(() => {
  void site.load()
  void loadDownload()
  void loadAndroid()
})

async function loadDownload(): Promise<void> {
  try {
    const download = await fetchPublicDesktopDownload()
    windows.value = download.windows
  } catch {
    // 主页不因为接口失败而报错：按钮停在「安装包准备中」，其余内容照常
    windows.value = null
  }
}

async function loadAndroid(): Promise<void> {
  try {
    const download = await fetchPublicAndroidDownload()
    android.value = download.app
  } catch {
    // 与 Windows 一致：接口失败不影响主页其余内容，按钮停在「即将上线」
    android.value = null
  }
}

function selectTab(next: LandingPlatform): void {
  tab.value = next
}

/** 键盘左右键在 Tab 之间切换（WAI-ARIA tabs 习惯用法），焦点跟着走 */
function onTabKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  const step = event.key === 'ArrowRight' ? 1 : -1
  const nextIndex = (tabIndex.value + step + TABS.length) % TABS.length
  const next = TABS[nextIndex] ?? 'cloud'
  selectTab(next)
  void nextTick(() => document.getElementById(`landing-tab-${next}`)?.focus())
}

/** 截图下方的一行说明：三张图是同一个真实会话在三端打开的样子 */
const SHOT_CAPTIONS: Record<LandingPlatform, string> = {
  cloud: '真实截图 · 一句话让 DSH 分析销售表，2 分 36 秒出图出简报',
  desktop: '真实截图 · Windows 客户端打开同一个会话',
  android: '真实截图 · 安卓 App 里接着看同一个会话',
}

function formatInstallerSize(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}
</script>

<template>
  <div class="landing" data-testid="landing">
    <StarfieldBackdrop />

    <MobileWebBar kind="switch" />

    <header class="landing__top">
      <RouterLink to="/" class="landing__brand" aria-label="DSH Hub 首页">
        <BrandMark :size="30" />
        <span>DSH <span class="landing__brand-hub">Hub</span></span>
      </RouterLink>

      <nav class="landing__auth" aria-label="账号">
        <RouterLink to="/docs" class="landing__docs-link" data-testid="landing-docs">使用文档</RouterLink>
        <RouterLink
          v-if="auth.isLoggedIn"
          to="/home"
          class="landing__btn landing__btn--primary"
          data-testid="landing-workbench"
        >
          进入工作台
        </RouterLink>
        <template v-else>
          <RouterLink to="/login" class="landing__btn landing__btn--ghost" data-testid="landing-login">
            登录
          </RouterLink>
          <RouterLink
            v-if="site.registrationOpen"
            to="/register"
            class="landing__btn landing__btn--primary"
            data-testid="landing-register"
          >
            注册
          </RouterLink>
        </template>
      </nav>
    </header>

    <main class="landing__main">
      <h1 class="landing__title">DSH Hub <span class="landing__accent">连通万物</span></h1>

      <section class="landing__showcase" aria-label="使用方式">
        <div
          class="landing__tabs"
          role="tablist"
          aria-label="选择使用方式"
          data-testid="landing-tabs"
          @keydown="onTabKeydown"
        >
          <span
            class="landing__tabs-glider"
            :style="{ transform: `translateX(${tabIndex * 100}%)` }"
            aria-hidden="true"
          />
          <button
            id="landing-tab-cloud"
            type="button"
            role="tab"
            class="landing__tab"
            :class="{ 'landing__tab--active': tab === 'cloud' }"
            :aria-selected="tab === 'cloud'"
            :tabindex="tab === 'cloud' ? 0 : -1"
            aria-controls="landing-pane"
            data-testid="landing-tab-cloud"
            @click="selectTab('cloud')"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M6.5 19a4.5 4.5 0 0 1-.6-8.96 6 6 0 0 1 11.7-1.3A4 4 0 0 1 17.5 19z" />
            </svg>
            云上模式
          </button>
          <button
            id="landing-tab-desktop"
            type="button"
            role="tab"
            class="landing__tab"
            :class="{ 'landing__tab--active': tab === 'desktop' }"
            :aria-selected="tab === 'desktop'"
            :tabindex="tab === 'desktop' ? 0 : -1"
            aria-controls="landing-pane"
            data-testid="landing-tab-desktop"
            @click="selectTab('desktop')"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path
                d="M3 5.1 10.4 4v7.1H3zM11.3 3.9 21 2.5v8.6h-9.7zM3 12h7.4v7.1L3 18zM11.3 12H21v8.6l-9.7-1.4z"
              />
            </svg>
            桌面端
          </button>
          <button
            id="landing-tab-android"
            type="button"
            role="tab"
            class="landing__tab"
            :class="{ 'landing__tab--active': tab === 'android' }"
            :aria-selected="tab === 'android'"
            :tabindex="tab === 'android' ? 0 : -1"
            aria-controls="landing-pane"
            data-testid="landing-tab-android"
            @click="selectTab('android')"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path
                d="M7.2 9.5h9.6v7.8a1.2 1.2 0 0 1-1.2 1.2h-.8v2.3a1.2 1.2 0 0 1-2.4 0v-2.3h-1.6v2.3a1.2 1.2 0 0 1-2.4 0v-2.3h-.8a1.2 1.2 0 0 1-1.2-1.2zM5 9.6a1.2 1.2 0 0 1 2.4 0v5a1.2 1.2 0 0 1-2.4 0zM16.6 9.6a1.2 1.2 0 0 1 2.4 0v5a1.2 1.2 0 0 1-2.4 0zM7.3 8.6a4.8 4.4 0 0 1 9.4 0zM8.6 3.4l1 1.6M15.4 3.4l-1 1.6"
                stroke="currentColor"
                stroke-width=".9"
                stroke-linecap="round"
              />
            </svg>
            安卓端
          </button>
        </div>

        <Transition name="pane-swap" mode="out-in">
          <div
            id="landing-pane"
            :key="tab"
            class="landing__stage"
            role="tabpanel"
            :aria-labelledby="`landing-tab-${tab}`"
            :data-testid="`landing-pane-${tab}`"
          >
            <!-- 左：标题 · 一句话 · 按钮 · 一行小字 -->
            <div class="landing__info">
              <template v-if="tab === 'cloud'">
                <h2 class="landing__pane-title">云上模式</h2>
                <p class="landing__pane-pitch" data-testid="landing-cloud-pitch">
                  2核4G 私有 DSH，7×24 小时在线，<br />打开浏览器就能用。
                </p>
                <RouterLink :to="cloudCta.to" class="landing__download" data-testid="landing-cloud-cta">
                  {{ cloudCta.label }}
                  <svg
                    class="landing__download-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.1"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </RouterLink>
                <p class="landing__note" data-testid="landing-cloud-note">{{ cloudCta.hint }} · 无需安装</p>
              </template>

              <template v-else-if="tab === 'desktop'">
                <h2 class="landing__pane-title">
                  Windows 客户端
                  <span v-if="windows?.prerelease" class="landing__tag" data-testid="landing-prerelease">
                    预览版
                  </span>
                </h2>
                <p class="landing__pane-pitch">文件留在本机，登录即同步模型与插件。</p>
                <a
                  v-if="windowsFile"
                  :href="windowsFile.url"
                  class="landing__download"
                  data-testid="landing-download"
                >
                  <svg
                    class="landing__download-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.1"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
                  </svg>
                  {{ portableSelected ? '下载免安装版' : '下载 Windows 安装包' }}
                  <span class="landing__download-size">{{ formatInstallerSize(windowsFile.bytes) }}</span>
                </a>
                <span
                  v-else
                  class="landing__download landing__download--disabled"
                  aria-disabled="true"
                  data-testid="landing-download-disabled"
                >
                  安装包准备中
                </span>
                <div
                  v-if="windows?.portable"
                  class="landing__variant"
                  role="radiogroup"
                  aria-label="Windows 版本类型"
                  data-testid="landing-variant"
                >
                  <button
                    type="button"
                    role="radio"
                    class="landing__variant-option"
                    :class="{ 'landing__variant-option--active': !portableSelected }"
                    :aria-checked="!portableSelected"
                    data-testid="landing-variant-installer"
                    @click="variant = 'installer'"
                  >
                    安装版
                  </button>
                  <button
                    type="button"
                    role="radio"
                    class="landing__variant-option"
                    :class="{ 'landing__variant-option--active': portableSelected }"
                    :aria-checked="portableSelected"
                    data-testid="landing-variant-portable"
                    @click="variant = 'portable'"
                  >
                    免安装版
                  </button>
                </div>
                <p v-if="windows" class="landing__meta" data-testid="landing-windows-meta">
                  {{ windowsMeta }}
                </p>
                <p class="landing__note" data-testid="landing-windows-sub">
                  Windows 10/11 · {{ portableSelected ? '解压即用，不自动升级' : '安装后用 Hub 账号登录' }}
                </p>
              </template>

              <template v-else>
                <h2 class="landing__pane-title">
                  安卓 App
                  <span
                    v-if="android?.prerelease"
                    class="landing__tag"
                    data-testid="landing-android-prerelease"
                  >
                    预览版
                  </span>
                  <span v-else-if="!android" class="landing__tag landing__tag--muted">敬请期待</span>
                </h2>
                <p class="landing__pane-pitch">在手机上看进度、接着聊，结果随手打开。</p>
                <a
                  v-if="android"
                  :href="android.url"
                  class="landing__download"
                  :download="android.fileName"
                  data-testid="landing-android-download"
                >
                  <svg
                    class="landing__download-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.1"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
                  </svg>
                  下载安卓 App
                  <span class="landing__download-size">{{ formatInstallerSize(android.bytes) }}</span>
                </a>
                <span
                  v-else
                  class="landing__download landing__download--disabled"
                  aria-disabled="true"
                  data-testid="landing-android-soon"
                >
                  即将上线
                </span>
                <p v-if="android" class="landing__meta" data-testid="landing-android-meta">
                  {{ androidMeta }}
                </p>
                <p class="landing__note" data-testid="landing-android-sub">
                  {{ android ? '安装后用 Hub 账号登录' : '先用网页版，浏览器里直接用' }}
                </p>
                <!-- WP54c：手机网页版的入口（不想装 App 的人有第二条路；`/?view=mobile` 由服务端 302 到 /m/） -->
                <p class="landing__note" data-testid="landing-android-web">
                  不想装 App？
                  <a href="/?view=mobile" class="landing__web-link" data-testid="landing-android-web-link">
                    手机浏览器直接打开网页版
                  </a>
                </p>
              </template>
            </div>

            <!-- 右：真实截图（同一个会话在三端打开的样子） -->
            <figure
              class="landing__shot"
              :class="`landing__shot--${tab}`"
              :data-testid="`landing-shot-${tab}`"
            >
              <div v-if="tab === 'cloud'" class="frame frame--browser">
                <div class="frame__bar" aria-hidden="true">
                  <span class="frame__dots"><i /><i /><i /></span>
                  <span class="frame__url">hub.example.com/home</span>
                </div>
                <img
                  :src="cloudShot"
                  width="1600"
                  height="841"
                  alt="网页版 DSH：让它分析一份销售表，它画出了各产品月度销售额趋势图"
                />
              </div>

              <div v-else-if="tab === 'desktop'" class="frame frame--window">
                <div class="frame__bar" aria-hidden="true">
                  <span class="frame__title"><BrandMark :size="14" />DSH Hub</span>
                  <span class="frame__controls"><i class="min" /><i class="max" /><i class="close" /></span>
                </div>
                <img
                  :src="desktopShot"
                  width="1600"
                  height="1028"
                  alt="Windows 客户端打开同一个会话：用户的需求、分析过程和趋势图"
                />
              </div>

              <div v-else class="phones">
                <div class="frame frame--phone frame--phone-back">
                  <img :src="androidHomeShot" width="640" height="1385" alt="安卓 App 首页" />
                </div>
                <div class="frame frame--phone">
                  <img
                    :src="androidChatShot"
                    width="640"
                    height="1385"
                    alt="安卓 App 里打开同一个会话：需求、执行步骤和趋势图"
                  />
                </div>
              </div>

              <figcaption class="landing__caption">
                <span class="landing__caption-dot" aria-hidden="true" />
                {{ SHOT_CAPTIONS[tab] }}
              </figcaption>
            </figure>
          </div>
        </Transition>
      </section>
    </main>

    <footer class="landing__footer">
      <span>© 2026 DSH Hub</span>
      <RouterLink to="/docs">使用文档</RouterLink>
      <RouterLink to="/desktop/privacy">隐私说明</RouterLink>
      <span>Powered by xdedmi</span>
    </footer>
  </div>
</template>

<style scoped>
.landing {
  position: relative;
  display: flex;
  min-height: 100vh;
  flex-direction: column;
  overflow-x: hidden;
  background: var(--c-surface);
}

/* ---------- 顶栏 ---------- */
.landing__top {
  position: relative;
  z-index: 2;
  display: flex;
  width: 100%;
  max-width: 1200px;
  align-items: center;
  justify-content: space-between;
  margin: 0 auto;
  padding: 22px 32px;
}

.landing__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--c-text);
  font-size: var(--fs-18);
  font-weight: var(--fw-semibold);
  letter-spacing: 0.2px;
  white-space: nowrap;
}

.landing__brand:hover {
  color: var(--c-text);
}

.landing__brand-hub {
  color: var(--c-primary);
}

.landing__auth {
  display: flex;
  align-items: center;
  gap: 10px;
}

.landing__docs-link {
  padding: 0 6px;
  color: var(--c-text-2);
  font-size: var(--fs-14);
  white-space: nowrap;
}

.landing__docs-link:hover {
  color: var(--c-primary-press);
}

.landing__btn {
  display: inline-flex;
  height: 36px;
  align-items: center;
  justify-content: center;
  padding: 0 16px;
  border: 1px solid transparent;
  border-radius: var(--radius-control-sm);
  color: var(--c-text);
  font-size: var(--fs-14);
  font-weight: var(--fw-semibold);
  text-decoration: none;
  white-space: nowrap;
  transition:
    background var(--duration-base),
    box-shadow var(--duration-base);
}

.landing__btn--ghost:hover {
  color: var(--c-primary-press);
  background: var(--c-primary-soft);
}

.landing__btn--primary {
  color: var(--c-surface);
  background: var(--c-primary);
  box-shadow: 0 6px 16px -6px color-mix(in srgb, var(--c-primary) 55%, transparent);
}

.landing__btn--primary:hover {
  color: var(--c-surface);
  background: var(--c-primary-hover);
}

/* 星野只做氛围：压淡，别和截图抢 */
.landing :deep(.starfield) {
  opacity: 0.45;
}

/* ---------- 标题 ---------- */
.landing__main {
  position: relative;
  z-index: 1;
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  padding: 18px 24px 32px;
  text-align: center;
}

.landing__title {
  color: var(--c-text);
  font-size: var(--fs-display);
  font-weight: var(--fw-bold);
  line-height: 1.12;
  letter-spacing: -1px;
}

.landing__accent {
  background: linear-gradient(120deg, var(--c-primary), var(--c-sky));
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
}

/* ---------- Tab ---------- */
.landing__showcase {
  display: flex;
  width: 100%;
  max-width: 1160px;
  flex-direction: column;
  align-items: center;
  gap: 26px;
  margin-top: 30px;
}

.landing__tabs {
  position: relative;
  display: grid;
  width: 420px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  padding: 4px;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--c-surface) 78%, transparent);
  box-shadow: 0 14px 30px -22px color-mix(in srgb, var(--c-primary) 65%, transparent);
  backdrop-filter: var(--blur-glass);
}

.landing__tabs-glider {
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 4px;
  width: calc((100% - 8px) / 3);
  border: 1px solid color-mix(in srgb, var(--c-primary) 22%, transparent);
  border-radius: var(--radius-pill);
  background: linear-gradient(
    180deg,
    var(--c-surface),
    color-mix(in srgb, var(--c-primary-soft) 62%, var(--c-surface))
  );
  box-shadow: 0 4px 12px -6px color-mix(in srgb, var(--c-primary) 60%, transparent);
  transition: transform 320ms var(--ease-out-soft);
}

.landing__tab {
  position: relative;
  z-index: 1;
  display: flex;
  height: 42px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border: 0;
  border-radius: var(--radius-pill);
  color: var(--c-text-2);
  background: transparent;
  font: inherit;
  font-size: var(--fs-14);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: color var(--duration-base);
}

.landing__tab svg {
  width: 17px;
  height: 17px;
}

.landing__tab:hover,
.landing__tab--active {
  color: var(--c-primary-press);
}

.landing__tab:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: 2px;
}

/* ---------- 面板：左信息 + 右截图 ---------- */
.landing__stage {
  display: grid;
  width: 100%;
  grid-template-columns: 320px minmax(0, 1fr);
  align-items: center;
  gap: 48px;
  text-align: left;
}

.landing__info {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.landing__pane-title {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--c-text);
  font-size: var(--fs-24);
  font-weight: var(--fw-bold);
  line-height: 1.3;
  white-space: nowrap;
}

.landing__pane-pitch {
  color: var(--c-text-2);
  font-size: var(--fs-15);
  line-height: 1.7;
  text-wrap: balance;
}

.landing__tag {
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  color: var(--c-primary-press);
  background: var(--c-primary-soft);
  font-size: var(--fs-12);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}

.landing__tag--muted {
  color: var(--c-text-2);
  background: var(--c-surface-muted);
}

.landing__meta {
  color: var(--c-text-3);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  letter-spacing: -0.3px;
}

.landing__note {
  color: var(--c-text-3);
  font-size: var(--fs-13);
}

/* 行内链接：`padding-block` 只撑大手指可点的范围，不改变行盒高度（WP54c） */
.landing__web-link {
  padding-block: 13px;
  color: var(--c-primary-press);
  text-decoration: none;
}

.landing__web-link:hover {
  color: var(--c-primary-hover);
  text-decoration: underline;
}

/* ---------- 主按钮 ---------- */
.landing__download {
  position: relative;
  display: flex;
  min-height: 50px;
  align-items: center;
  justify-content: center;
  gap: 9px;
  margin-top: 6px;
  overflow: hidden;
  border-radius: var(--radius-control);
  color: var(--c-surface);
  background: linear-gradient(
    135deg,
    var(--c-primary),
    color-mix(in srgb, var(--c-sky) 52%, var(--c-primary))
  );
  box-shadow: 0 16px 30px -18px color-mix(in srgb, var(--c-primary) 85%, transparent);
  font-size: var(--fs-15);
  font-weight: var(--fw-semibold);
  text-decoration: none;
  transition:
    transform var(--duration-base) var(--ease-out-soft),
    box-shadow var(--duration-base);
}

.landing__download:hover {
  color: var(--c-surface);
  box-shadow: 0 20px 36px -18px color-mix(in srgb, var(--c-primary) 95%, transparent);
  transform: translateY(-1px);
}

.landing__download:active {
  transform: scale(0.995);
}

.landing__download--disabled {
  color: var(--c-text-3);
  background: var(--c-surface-muted);
  box-shadow: none;
  cursor: not-allowed;
}

.landing__download--disabled:hover {
  color: var(--c-text-3);
  box-shadow: none;
  transform: none;
}

.landing__download-icon {
  width: 17px;
  height: 17px;
  flex: none;
}

.landing__download-size {
  padding: 2px 7px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--c-surface) 20%, transparent);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  font-weight: var(--fw-normal);
}

/* ---------- 安装版 / 免安装版 ---------- */
.landing__variant {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-control-sm);
  background: var(--c-surface-muted);
}

.landing__variant-option {
  height: 32px;
  border: 0;
  border-radius: calc(var(--radius-control-sm) - 2px);
  color: var(--c-text-2);
  background: transparent;
  font: inherit;
  font-size: var(--fs-13);
  cursor: pointer;
  transition:
    background var(--duration-base),
    color var(--duration-base);
}

.landing__variant-option:hover {
  color: var(--c-primary-press);
}

.landing__variant-option--active {
  color: var(--c-primary-press);
  background: var(--c-surface);
  box-shadow: var(--shadow-card);
  font-weight: var(--fw-semibold);
}

.landing__variant-option:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: 1px;
}

/* ---------- 截图与外框 ---------- */
.landing__shot {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  margin: 0;
}

.landing__shot img {
  display: block;
  width: 100%;
  height: auto;
}

.frame {
  width: 100%;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--c-text) 12%, transparent);
  border-radius: 14px;
  background: var(--c-surface);
  box-shadow:
    0 40px 80px -48px color-mix(in srgb, var(--c-primary) 70%, transparent),
    0 18px 36px -28px color-mix(in srgb, var(--c-text) 45%, transparent);
}

.frame__bar {
  display: flex;
  height: 34px;
  align-items: center;
  gap: 12px;
  padding: 0 14px;
  border-bottom: 1px solid var(--c-border);
  background: var(--c-surface-muted);
}

.frame__dots {
  display: flex;
  gap: 6px;
}

.frame__dots i {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #ff5f57;
}

.frame__dots i:nth-child(2) {
  background: #febc2e;
}

.frame__dots i:nth-child(3) {
  background: #28c840;
}

.frame__url {
  flex: 1;
  max-width: 340px;
  margin: 0 auto;
  padding: 3px 12px;
  border-radius: var(--radius-pill);
  color: var(--c-text-3);
  background: var(--c-surface);
  font-size: var(--fs-12);
  text-align: center;
}

.frame--window {
  border-radius: 8px;
}

/* 桌面截图比网页版高：只露上面这段（需求 + 结果图），和另外两个 Tab 等高 */
.frame--window img {
  aspect-ratio: 1600 / 860;
  object-fit: cover;
  object-position: top;
}

.frame--window .frame__bar {
  height: 30px;
  justify-content: space-between;
  padding: 0 0 0 12px;
  background: var(--c-surface);
}

.frame__title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--c-text-2);
  font-size: var(--fs-12);
}

/* Windows 标题栏的 最小化 / 最大化 / 关闭 */
.frame__controls {
  display: flex;
  height: 100%;
}

.frame__controls i {
  position: relative;
  width: 44px;
  height: 100%;
}

.frame__controls i::before,
.frame__controls i::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  border-color: var(--c-text-2);
}

.frame__controls .min::before {
  width: 10px;
  border-top: 1px solid;
  transform: translate(-50%, -50%);
}

.frame__controls .max::before {
  width: 9px;
  height: 9px;
  border: 1px solid;
  transform: translate(-50%, -50%);
}

.frame__controls .close::before,
.frame__controls .close::after {
  width: 12px;
  border-top: 1px solid;
  transform: translate(-50%, -50%) rotate(45deg);
}

.frame__controls .close::after {
  transform: translate(-50%, -50%) rotate(-45deg);
}

.phones {
  position: relative;
  display: flex;
  width: 100%;
  min-height: 520px;
  align-items: center;
  justify-content: center;
}

.frame--phone {
  position: relative;
  z-index: 1;
  width: 250px;
  padding: 7px;
  border: 0;
  border-radius: 38px;
  background: #16181d;
}

.frame--phone img {
  border-radius: 31px;
}

.frame--phone-back {
  z-index: 0;
  width: 215px;
  margin-right: -54px;
  opacity: 0.9;
  transform: translateY(26px) rotate(-5deg);
}

.landing__caption {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--c-text-3);
  font-size: var(--fs-13);
}

.landing__caption-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--c-success);
  box-shadow: 0 0 0 3px var(--c-success-soft);
}

/* ---------- 换 Tab ---------- */
.pane-swap-enter-active {
  transition:
    opacity 0.26s var(--ease-out-soft),
    transform 0.26s var(--ease-out-soft);
}

.pane-swap-leave-active {
  transition:
    opacity 0.12s ease,
    transform 0.12s ease;
}

.pane-swap-enter-from {
  opacity: 0;
  transform: translateY(10px);
}

.pane-swap-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

/* ---------- 页脚 ---------- */
.landing__footer {
  position: relative;
  z-index: 1;
  display: flex;
  height: 58px;
  align-items: center;
  justify-content: center;
  gap: 18px;
  color: var(--c-text-3);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.landing__footer a {
  color: var(--c-text-3);
}

.landing__footer a:hover {
  color: var(--c-primary-press);
}

/* ---------- 窄屏：信息在上、截图在下 ---------- */
@media (max-width: 900px) {
  .landing__stage {
    grid-template-columns: minmax(0, 1fr);
    gap: 28px;
  }

  .landing__info {
    width: 100%;
    max-width: 420px;
    margin: 0 auto;
  }
}

@media (max-width: 720px) {
  .landing__top {
    padding: 18px 20px;
  }

  .landing__main {
    padding: 10px 16px 28px;
  }

  .landing__title {
    font-size: var(--fs-display-sm);
  }

  .landing__accent {
    display: block;
  }

  .landing__showcase {
    gap: 22px;
    margin-top: 24px;
  }

  .landing__tabs {
    width: 100%;
    max-width: 420px;
  }

  .landing__tab {
    gap: 6px;
    font-size: var(--fs-13);
  }

  .landing__pane-title {
    font-size: var(--fs-20);
  }

  .frame__bar {
    height: 26px;
  }

  .frame__dots i {
    width: 8px;
    height: 8px;
  }

  .frame__url {
    font-size: 11px;
  }

  .phones {
    min-height: 0;
  }

  .frame--phone {
    width: 220px;
  }

  .frame--phone-back {
    display: none;
  }

  .landing__caption {
    font-size: var(--fs-12);
    text-align: center;
  }
}

/* ---------- 手机宽度（≤640px）：触屏可点高度（WP54c） ---------- */
@media (max-width: 640px) {
  .landing__btn,
  .landing__tab {
    height: 44px;
  }

  /* 顶栏与页脚的行内文字链接：padding 只扩可点范围，不改变行盒高度 */
  .landing__docs-link,
  .landing__footer a {
    padding-block: 13px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .landing__download,
  .landing__variant-option,
  .landing__tabs-glider,
  .pane-swap-enter-active,
  .pane-swap-leave-active {
    transition: none;
  }

  .landing__download:hover {
    transform: none;
  }
}
</style>
