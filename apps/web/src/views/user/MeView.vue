<script setup lang="ts">
import { NTabPane, NTabs } from 'naive-ui'
import { computed, defineAsyncComponent } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import PageHeader from '@/components/base/PageHeader.vue'

/**
 * 个人中心 `/me`（15 §2.4，取代 07 §6.2 的四 Tab）：只保留「资料」「安全」两个标签。
 *
 * 旧地址兼容：`/me?tab=plugins` → `/home#plugins`、`/me?tab=exports` → `/home#data`，
 * 用 `router.replace` 跳走（不留下会再触发的历史项），落到工作台后由路由的 scrollBehavior 滚到锚点。
 *
 * WP8b P2：Tab 组件仍按需懒加载，非当前 Tab 不渲染。
 */
const route = useRoute()
const router = useRouter()

const ProfileTab = defineAsyncComponent(() => import('@/components/user/me/ProfileTab.vue'))
const SecurityTab = defineAsyncComponent(() => import('@/components/user/me/SecurityTab.vue'))

const TABS = ['profile', 'security'] as const
type TabName = (typeof TABS)[number]

const TAB_META: Record<TabName, { label: string; icon: string }> = {
  profile: { label: '资料', icon: 'i-ph-user' },
  security: { label: '安全', icon: 'i-ph-shield-check' },
}

/** 15 §2.4：旧 Tab → 工作台锚点 */
const LEGACY_TABS: Record<string, string> = { plugins: '#plugins', exports: '#data' }

const legacyHash = computed(() => {
  const raw = Array.isArray(route.query.tab) ? route.query.tab[0] : route.query.tab
  return typeof raw === 'string' ? (LEGACY_TABS[raw] ?? null) : null
})

if (legacyHash.value) void router.replace({ path: '/home', hash: legacyHash.value })

function isTabName(value: unknown): value is TabName {
  return typeof value === 'string' && (TABS as readonly string[]).includes(value)
}

const activeTab = computed<TabName>(() => (isTabName(route.query.tab) ? route.query.tab : 'profile'))

function selectTab(value: string): void {
  if (!isTabName(value) || value === activeTab.value) return
  void router.replace({ query: { ...route.query, tab: value } })
}
</script>

<template>
  <div v-if="!legacyHash">
    <PageHeader title="个人中心" />

    <NTabs :value="activeTab" type="line" animated display-directive="show:lazy" @update:value="selectTab">
      <NTabPane v-for="name in TABS" :key="name" :name="name" :tab="TAB_META[name].label">
        <template #tab>
          <span class="flex items-center gap-1.5" :data-testid="`tab-${name}`">
            <span :class="TAB_META[name].icon" aria-hidden="true" />
            {{ TAB_META[name].label }}
          </span>
        </template>

        <div class="pt-2">
          <ProfileTab v-if="name === 'profile'" />
          <SecurityTab v-else />
        </div>
      </NTabPane>
    </NTabs>
  </div>
</template>
