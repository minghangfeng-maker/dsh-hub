<script setup lang="ts">
import { NConfigProvider, NDialogProvider, NMessageProvider, dateZhCN, zhCN } from 'naive-ui'
import { computed, defineAsyncComponent, watchEffect, type Component } from 'vue'
import { useRoute } from 'vue-router'

import type { LayoutName } from '@/router'
import WelcomeGuide from '@/components/base/WelcomeGuide.vue'
import { markWelcomeSeen, welcomePending } from '@/composables/useWelcomeGuide'
import { useSiteStore } from '@/stores/site'
import { themeOverrides } from '@/styles/naive-theme'

/**
 * 布局按需加载：与路由懒加载一致，首屏只加载命中的那一个外壳。
 * meta.layout 缺省为 auth（登录/注册/404 这类无壳页面）。
 */
const layouts: Record<LayoutName, Component> = {
  auth: defineAsyncComponent(() => import('@/layouts/AuthLayout.vue')),
  user: defineAsyncComponent(() => import('@/layouts/UserLayout.vue')),
  admin: defineAsyncComponent(() => import('@/layouts/AdminLayout.vue')),
  blank: defineAsyncComponent(() => import('@/layouts/BlankLayout.vue')),
}

const route = useRoute()
const site = useSiteStore()
const layout = computed(() => layouts[route.meta.layout ?? 'auth'])

// 页面标题：`登录 · DSH Hub`（国际惯例是「页面 · 站点」，中文也适配）
// 公开主页的 title 就是站点名本身（WP36），不要拼成「DSH Hub · DSH Hub」
watchEffect(() => {
  const page = typeof route.meta.title === 'string' ? route.meta.title : ''
  document.title = page && page !== site.site.name ? `${page} · ${site.site.name}` : site.site.name
})

/** 注册成功后的 3 步欢迎引导（07 §5.2）：由注册页请求，关掉即记为已看过 */
function onWelcomeShow(visible: boolean): void {
  if (!visible) markWelcomeSeen()
}
</script>

<template>
  <NConfigProvider :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN">
    <NMessageProvider>
      <NDialogProvider>
        <RouterView v-slot="{ Component: RouteComponent }">
          <component :is="layout">
            <Transition name="route-fade" mode="out-in" appear>
              <component :is="RouteComponent" />
            </Transition>
          </component>
        </RouterView>

        <WelcomeGuide :show="welcomePending" @update:show="onWelcomeShow" />
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

<!--
  路由切换过渡的样式在 src/styles/motion.css（07 §2.5：淡入 + 上移 8px，220ms，
  prefers-reduced-motion 下只留 ≤120ms 淡入），这里不再重复定义。
-->
