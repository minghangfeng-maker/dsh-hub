<script setup lang="ts">
/**
 * App 更新提示（0.2.16 起；0.3.1 改成 App 内下载 + 系统安装器）。
 *
 * 数据来自 `bootstrap.app`：Hub 把「管理端设置」与「最新 APK 发布记录」取大者下发，
 * 所以上传一个新包，旧版 App 回前台拉 bootstrap 时就会知道有新版本，管理员不用再手填。
 *
 *  - `latestVersionCode > 本机`：可更新 → 启动/回前台弹一次，点「稍后」本次运行不再弹；
 *  - `minVersionCode > 本机`：强更 → 不可关闭（老协议可能连不上新 Hub，静默坏掉更糟），
 *    只能去下载或重新检查；**下载中同样不可关闭，但允许取消下载**。
 *
 * 0.3.0 及以前把 APK 地址交给 Chrome（Custom Tab）下载：真机上永远停在
 * 「已下载 8.52 MB，共 8.52 MB」收不了尾（APK 安全扫描要连 Google，国内不通）。
 * 0.3.1 起改由 App 自己下（WebView 里 fetch 流式读，下载域名只有浏览器内核能过旁路），
 * 写完 Cache 再调系统安装器；Web 端（非原生）仍是原来的「打开链接」。
 *
 * 手机网页版（WP54 / C7）：网页构建里**没有** APK 强更/下载这回事（那段整块折掉），
 * 只有 `webUpdateAvailable` 时在底部给一条轻提示「有新版本，点此刷新」（点一下刷新页面）。
 */
import { computed, ref } from 'vue'
import { formatBytes } from '@dsh-hub/mobile-core'
import AppIcon from './AppIcon.vue'
import { HUB_ORIGIN, IS_WEB_BUILD } from '@/lib/app-info'
import { isNative, openExternal } from '@/lib/storage'
import { useAppUpdateStore } from '@/stores/app-update'
import { useUiStore } from '@/stores/ui'
import { useWebUpdate } from '@/lib/web-update'

const appUpdate = useAppUpdateStore()
const ui = useUiStore()
/** 网页版的新版本提示（W1 的 webUpdateAvailable，见 lib/web-update）。 */
const webUpdate = useWebUpdate()
/** 用户点过关闭：本次运行不再提示（刷新页面后自然消失）。 */
const webHintDismissed = ref(false)

const visible = computed(() => appUpdate.updateRequired || appUpdate.updateAvailable)
const downloadUrl = computed(() => appUpdate.updateDownloadUrl)
const versionLabel = computed(() => appUpdate.updateVersionLabel)
const required = computed(() => appUpdate.updateRequired)
const phase = computed(() => appUpdate.downloadPhase)
const progress = computed(() => appUpdate.downloadProgress)
const errorText = computed(() => appUpdate.downloadError)
const nativeApp = isNative()

const downloading = computed(() => phase.value === 'downloading')
const installing = computed(() => phase.value === 'installing')
/** 下载中/打开安装器时不给「稍后」：先取消，避免用户以为还在后台下。 */
const canDismiss = computed(() => !downloading.value && !installing.value)

const percentText = computed(() =>
  progress.value.percent === null ? null : `${progress.value.percent}%`,
)
const sizeText = computed(() => {
  const received = formatBytes(progress.value.received)
  const total = progress.value.total
  return total && total > 0 ? `${received} / ${formatBytes(total)}` : received
})

/** 立即更新：原生走 App 内下载 + 安装器；Web 打开下载链接（老行为）。 */
async function download(): Promise<void> {
  const url = downloadUrl.value
  if (url === null) {
    // 没配下载地址：退到 Hub 主页（网页上有下载入口）
    try {
      await openExternal(HUB_ORIGIN)
    } catch {
      ui.toast('打不开浏览器，请稍后重试')
    }
    return
  }
  await appUpdate.startUpdateDownload()
}

async function recheck(): Promise<void> {
  const result = await appUpdate.checkAppUpdate()
  if (result === 'latest') ui.toast('已是最新版本')
}

function later(): void {
  appUpdate.dismissAppUpdate()
}
</script>

<template>
  <!--
    手机网页版（WP54）：没有 APK 强更/下载，只有一条轻提示。
    APK 构建里 `IS_WEB_BUILD` 恒为 false，这段永远不渲染（与 0.4.11 一致）。
  -->
  <div
    v-if="IS_WEB_BUILD && webUpdate.available && !webHintDismissed"
    class="web-update"
    role="region"
    aria-label="新版本提示"
    data-web-update
  >
    <button class="web-update__action" type="button" @click="webUpdate.reload()">
      <AppIcon name="refresh" :size="15" />
      有新版本，点此刷新
    </button>
    <button
      class="web-update__close"
      type="button"
      aria-label="关闭更新提示"
      @click="webHintDismissed = true"
    >
      <AppIcon name="close" :size="14" />
    </button>
  </div>

  <div
    v-if="!IS_WEB_BUILD && visible"
    class="update-overlay"
    :class="{ 'update-overlay--required': required }"
    role="dialog"
    aria-modal="true"
  >
    <div class="update-card">
      <header class="update-card__head">
        <span class="update-card__icon"><AppIcon name="download" :size="17" /></span>
        <span>{{ required ? '需要更新 App' : '发现新版本' }}</span>
      </header>

      <p class="update-card__body">
        <template v-if="required">
          当前版本太旧，更新后才能继续使用
          <template v-if="versionLabel">（最新 {{ versionLabel }}）</template>。
        </template>
        <template v-else>
          <template v-if="versionLabel">新版本 {{ versionLabel }} 已发布。</template>
          <template v-else>有新版本可用。</template>
        </template>
      </p>

      <p v-if="!downloadUrl" class="update-card__hint">
        下载地址未配置：请用电脑打开 Hub 网页的「下载 App」页面获取最新版 APK。
      </p>

      <!-- 下载中：进度条 + 取消（强更也不给关闭，但可以取消这次下载） -->
      <div v-if="downloading" class="update-card__progress">
        <div
          class="update-bar"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="progress.percent ?? undefined"
        >
          <span
            class="update-bar__fill"
            :class="{ 'update-bar__fill--unknown': progress.percent === null }"
            :style="progress.percent === null ? undefined : { width: `${progress.percent}%` }"
          />
        </div>
        <p class="update-card__meta">
          正在下载 {{ sizeText }}<template v-if="percentText">（{{ percentText }}）</template>
        </p>
      </div>

      <p v-else-if="installing" class="update-card__meta">下载完成，正在打开系统安装器…</p>

      <!-- 等待「允许安装未知应用」：已经自动打开过设置页，这里留一个再进一次的入口 -->
      <template v-else-if="phase === 'permission'">
        <p class="update-card__hint">
          需要允许「DSH Hub」安装应用。已为你打开系统设置，开启后回到 App 会自动继续。
        </p>
      </template>

      <p v-else-if="phase === 'launched'" class="update-card__hint">
        已打开系统安装器，请按提示完成安装；安装完成后重新打开 App 即可。
      </p>

      <p v-else-if="phase === 'failed'" class="update-card__error">
        {{ errorText || '更新失败，请重试' }}
      </p>

      <footer class="update-card__actions">
        <!-- 下载中 -->
        <button
          v-if="downloading"
          class="update-btn update-btn--ghost"
          type="button"
          @click="appUpdate.cancelUpdateDownload()"
        >
          取消下载
        </button>

        <!-- 等授权 / 已调起安装器 -->
        <template v-else-if="phase === 'permission'">
          <button v-if="!required" class="update-btn update-btn--ghost" type="button" @click="later">
            稍后
          </button>
          <button class="update-btn update-btn--ghost" type="button" @click="appUpdate.downloadInBrowser()">
            用浏览器下载
          </button>
          <button class="update-btn" type="button" @click="appUpdate.openInstallSettings()">
            打开设置
          </button>
        </template>
        <template v-else-if="phase === 'launched'">
          <button v-if="!required" class="update-btn update-btn--ghost" type="button" @click="later">
            稍后
          </button>
          <button class="update-btn" type="button" @click="appUpdate.reinstallDownloaded()">
            重新安装
          </button>
        </template>

        <!-- 失败：原因已经写在上面的 error 里，这里给重试与浏览器兜底 -->
        <template v-else-if="phase === 'failed'">
          <button v-if="canDismiss && !required" class="update-btn update-btn--ghost" type="button" @click="later">
            稍后
          </button>
          <button
            v-if="nativeApp"
            class="update-btn update-btn--ghost"
            type="button"
            @click="appUpdate.downloadInBrowser()"
          >
            用浏览器下载
          </button>
          <button class="update-btn" type="button" @click="appUpdate.retryUpdateDownload()">重试</button>
        </template>

        <!-- 初始态 / 安装中 -->
        <template v-else>
          <button v-if="!required && canDismiss" class="update-btn update-btn--ghost" type="button" @click="later">
            稍后
          </button>
          <button
            v-if="!downloadUrl"
            class="update-btn update-btn--ghost"
            type="button"
            @click="recheck"
          >
            重新检查
          </button>
          <button class="update-btn" type="button" :disabled="installing" @click="download">
            {{ downloadUrl ? '立即更新' : '去官网下载' }}
          </button>
        </template>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* 网页版（WP54）：底部一条轻提示，不挡住页面 —— 「刷新一下就好」不该看起来像弹窗 */
.web-update {
  position: fixed;
  left: 12px;
  right: 12px;
  bottom: calc(12px + var(--safe-bottom));
  z-index: 300;
  display: flex;
  align-items: stretch;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.22);
}
.web-update__action {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 40px;
  padding: 0 12px;
  border-radius: 11px;
  color: var(--text);
  font-size: 13.5px;
  font-weight: 600;
}
.web-update__action:active {
  background: var(--surface-2);
}
.web-update__close {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  border-radius: 11px;
  color: var(--text-3);
}
.web-update__close:active {
  background: var(--surface-2);
}
.update-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(2px);
}
.update-card {
  width: 100%;
  max-width: 360px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
}
.update-card__head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
}
.update-card__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 9px;
  background: var(--surface-2);
  color: var(--text-2);
}
.update-card__body {
  margin: 10px 0 0;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--text-2);
}
.update-card__hint {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-3);
}
.update-card__error {
  margin: 10px 0 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--danger);
}
.update-card__progress {
  margin: 14px 0 0;
}
.update-card__meta {
  margin: 8px 0 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.update-bar {
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--surface-3);
}
.update-bar__fill {
  display: block;
  height: 100%;
  width: 0;
  border-radius: inherit;
  background: var(--accent);
  transition: width 0.18s linear;
}
/* 服务器没给 Content-Length：不确定进度，用一条来回跑的短条表示还在下 */
.update-bar__fill--unknown {
  width: 38%;
  animation: update-bar-run 1.1s ease-in-out infinite;
}
@keyframes update-bar-run {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(265%);
  }
}
.update-card__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
.update-btn {
  padding: 8px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--text);
  color: var(--bg);
  font-size: 13.5px;
  font-weight: 600;
}
.update-btn--ghost {
  border-color: transparent;
  background: var(--surface-2);
  color: var(--text-2);
  font-weight: 500;
}
.update-btn:disabled {
  opacity: 0.5;
}
</style>
