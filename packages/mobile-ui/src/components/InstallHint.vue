<script setup lang="ts">
/**
 * 首页「添加到桌面」引导（WP54 / W5 手机网页版）。
 *
 * 只在**网页构建**（`VITE_TARGET=web`，`IS_WEB_BUILD`）且**不是**从桌面图标打开
 * （standalone）时出现；APK 里永远不会显示（`IS_WEB_BUILD` 是构建期常量 false）。
 *
 * 三种情况按 `installTargetOf()` 分：
 *   · Android Chrome —— 拿得到 beforeinstallprompt 就给「安装到桌面」按钮（调 prompt()），
 *     拿不到就退回「菜单 → 添加到主屏幕」的说明（不装、或系统已经装过时事件不会再来）；
 *   · iOS Safari —— 没有 API，给「分享按钮 → 添加到主屏幕」的图文说明；
 *   · 其它（微信/QQ 内置浏览器、iOS 上的非 Safari）—— 提示换浏览器打开。
 *
 * 关掉后 30 天不再出现（存 `dsh-hub:install-hint:v1`，见 lib/pwa-install.ts）。
 * 放在首页而不是登录页：登录后才打扰，首次登录流程不受影响。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from '@/components/AppIcon.vue'
import { IS_WEB_BUILD } from '@/lib/app-info'
import { prefs } from '@/lib/instance'
import {
  INSTALL_HINT_KEY,
  consumeInstallPrompt,
  currentInstallPrompt,
  hintSuppressed,
  installHintCopy,
  installTargetOf,
  isStandaloneMode,
  onInstallPrompt,
  serializeHintDismissal,
  type BeforeInstallPromptEvent,
  type InstallTarget,
} from '@/lib/pwa-install'

const target = ref<InstallTarget>('none')
const hasPrompt = ref(currentInstallPrompt() !== null)
const shown = ref(false)

const copy = computed(() => installHintCopy(target.value, hasPrompt.value))

const cleanups: Array<() => void> = []

function standaloneNow(): boolean {
  const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches ?? false
  const fullscreen = window.matchMedia?.('(display-mode: fullscreen)')?.matches ?? false
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
  return isStandaloneMode({ standalone, fullscreen, iosStandalone })
}

/** 关掉（或装好了）：这次记住 30 天，别一直挂着。写失败不影响界面，下次还会提示。 */
async function remember(): Promise<void> {
  try {
    await prefs.set(INSTALL_HINT_KEY, serializeHintDismissal(Date.now()))
  } catch {
    /* ignore：偏好写不进去（隐私模式配额满）时只是下次还会提示 */
  }
}

function close(): void {
  shown.value = false
  void remember()
}

async function installToHome(): Promise<void> {
  const event: BeforeInstallPromptEvent | null = consumeInstallPrompt()
  if (!event) return
  try {
    await event.prompt()
    const choice = await event.userChoice
    if (choice.outcome === 'accepted') {
      shown.value = false
      await remember()
      return
    }
    // 用户在系统弹窗里点了取消：事件已用掉，卡片留下来改教菜单路径
    hasPrompt.value = false
  } catch {
    hasPrompt.value = false
  }
}

/** 决定要不要出现：已经全屏（standalone）不出现；桌面浏览器/内置浏览器按目标判断；关过的不出现。 */
async function refresh(): Promise<void> {
  // 兜底：APK 构建里这个组件不该出现（HomeView 已经用 v-if 挡了），这里再挡一次
  if (!IS_WEB_BUILD) {
    shown.value = false
    return
  }
  if (standaloneNow()) {
    shown.value = false
    return
  }
  target.value = installTargetOf(navigator.userAgent, navigator.maxTouchPoints ?? 0)
  if (target.value === 'none') {
    shown.value = false
    return
  }
  let raw: string | null = null
  try {
    raw = (await prefs.get(INSTALL_HINT_KEY)) ?? null
  } catch {
    raw = null
  }
  shown.value = !hintSuppressed(raw, Date.now())
}

onMounted(() => {
  // 已经装好了（appinstalled）就直接收掉；prompt 事件可能在组件挂载前就到了，
  // 由 lib/pwa-install.ts 在模块加载时就拦住并存着，这里只订阅后续到达的。
  const onInstalled = (): void => close()
  window.addEventListener('appinstalled', onInstalled)
  cleanups.push(() => window.removeEventListener('appinstalled', onInstalled))
  cleanups.push(
    onInstallPrompt(() => {
      hasPrompt.value = true
    }),
  )
  // 从浏览器标签页装到桌面后 display-mode 会变，卡片要立刻消失
  const standaloneQuery = window.matchMedia?.('(display-mode: standalone)')
  const onDisplayMode = (): void => {
    if (standaloneNow()) shown.value = false
  }
  standaloneQuery?.addEventListener?.('change', onDisplayMode)
  cleanups.push(() => standaloneQuery?.removeEventListener?.('change', onDisplayMode))
  void refresh()
})

onBeforeUnmount(() => {
  cleanups.forEach((fn) => fn())
  cleanups.length = 0
})
</script>

<template>
  <aside
    v-if="shown"
    class="install-hint"
    :data-target="target"
    role="note"
    aria-live="polite"
  >
    <span class="install-hint__glyph" aria-hidden="true">
      <!-- iOS 的「分享」是方框里一支向上的箭头；Android 用下载图标，其它用地球 -->
      <svg
        v-if="target === 'ios-safari'"
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M12 3.5v11" />
        <path d="M8 7 12 3l4 4" />
        <path d="M5.5 11v8.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V11" />
      </svg>
      <AppIcon v-else-if="target === 'android-chrome'" name="download" :size="18" />
      <AppIcon v-else name="globe" :size="18" />
    </span>

    <div class="install-hint__body">
      <p class="install-hint__title">{{ copy.title }}</p>
      <p class="install-hint__text">{{ copy.body }}</p>
    </div>

    <button
      v-if="copy.action"
      class="install-hint__install"
      type="button"
      @click="installToHome()"
    >
      {{ copy.action }}
    </button>

    <button
      class="install-hint__close"
      type="button"
      aria-label="关闭添加到桌面提示"
      @click="close()"
    >
      <AppIcon name="close" :size="15" />
    </button>
  </aside>
</template>

<style scoped>
.install-hint {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  /* 与输入卡同一套留白：左右 12px，下方 8px 让输入卡和它不粘在一起 */
  margin: 0 12px 8px;
  padding: 11px 8px 11px 12px;
  border-radius: 20px;
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-card);
}
.install-hint__glyph {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.install-hint__body {
  flex: 1;
  min-width: 0;
}
.install-hint__title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--text);
}
.install-hint__text {
  margin-top: 2px;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--text-2);
}
.install-hint__install {
  flex: 0 0 auto;
  height: 32px;
  padding: 0 14px;
  border-radius: var(--radius-pill);
  background: var(--btn);
  color: var(--btn-ink);
  font-size: 12.5px;
  font-weight: 600;
  transition: opacity 0.14s ease, transform 0.14s ease;
}
.install-hint__install:active {
  transform: scale(0.96);
  opacity: 0.86;
}
.install-hint__close {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  color: var(--text-3);
}
.install-hint__close:active {
  background: var(--surface-2);
}
</style>
