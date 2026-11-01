<script setup lang="ts">
import { currentIsMobileUserAgent, MOBILE_VIEW_HREF, MOBILE_WEB_HREF } from '@/utils/mobile-ua'

/**
 * 手机 UA 才出现的顶部细条（WP54c）——「手机网页版」与电脑网页之间的**单向往返入口**。
 *
 * - `kind="back"`：App 会外链到 Hub 的网页（注册 / 找回密码 / 改密码 / 隐私说明），
 *   在手机浏览器里打开后要能一键回到手机网页版（`/m/`，C2 的 `MOBILE_WEB_BASE_PATH`）；
 * - `kind="switch"`：手机 UA 却停在电脑版（`hub_view=desktop`，C8）时给一条回手机版的路（`/?view=mobile`）。
 *
 * 两个链接都用普通 `<a>` 整页跳转：目标由服务端决定（`/m/` 是另一个 SPA，`/?view=mobile` 要清 cookie 再 302），
 * 交给路由器会绕开这套逻辑。电脑 UA 下组件渲染为空，不占位。
 */
withDefaults(defineProps<{ kind?: 'back' | 'switch' }>(), { kind: 'back' })

const mobile = currentIsMobileUserAgent()
</script>

<template>
  <div v-if="mobile" class="mobile-web-bar" :class="`mobile-web-bar--${kind}`">
    <a
      :href="kind === 'switch' ? MOBILE_VIEW_HREF : MOBILE_WEB_HREF"
      class="mobile-web-bar__link"
      :data-testid="kind === 'switch' ? 'mobile-view-switch' : 'mobile-web-back'"
    >
      <span v-if="kind === 'switch'" class="i-ph-device-mobile" aria-hidden="true" />
      <span v-else class="i-ph-arrow-left" aria-hidden="true" />
      {{ kind === 'switch' ? '切到手机版' : '返回手机版' }}
    </a>
  </div>
</template>

<style scoped>
.mobile-web-bar {
  /* 细条自带 44px 高度与可点区域：手指点得准，视觉上只有一行 13px 的字 */
  display: flex;
  min-height: 44px;
  align-items: center;
  padding-inline: var(--space-4);
}

/* 「切到手机版」是「你正停在电脑版」的状态提示，给一层极浅的主色底把它和内容分开 */
.mobile-web-bar--switch {
  border-bottom: var(--border-width) solid var(--c-border);
  background: var(--c-primary-soft);
}

.mobile-web-bar__link {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  gap: var(--space-1);
  color: var(--c-text-2);
  font-size: var(--fs-13);
  text-decoration: none;
  transition: color var(--duration-base) var(--ease-out-soft);
}

.mobile-web-bar__link:hover {
  color: var(--c-primary-press);
}

.mobile-web-bar__link .i-ph-arrow-left,
.mobile-web-bar__link .i-ph-device-mobile {
  font-size: var(--fs-16);
}
</style>
