<script setup lang="ts">
import { NTabPane, NTabs } from 'naive-ui'
import { ref, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'

import AdminPage from '@/components/admin/AdminPage.vue'
import ToolsChannelsPanel from '@/components/admin/search/ToolsChannelsPanel.vue'
import ToolsOverviewPanel from '@/components/admin/search/ToolsOverviewPanel.vue'
import ToolsSettingsPanel from '@/components/admin/search/ToolsSettingsPanel.vue'
import ToolsUsagePanel from '@/components/admin/search/ToolsUsagePanel.vue'

/**
 * 搜索池 `/admin/search`（15 §1）：原「模型 → 搜索池」标签提升为独立页面。
 *
 * 四个一级标签（设置 · 概览 · 渠道 · 用量）与 `?tab=` 双向同步，没带 tab 时默认「概览」；
 * 旧地址 `/admin/models?tab=tools` 在路由层直接跳到这里（不能落到模型概览）。
 */
const route = useRoute()
const router = useRouter()

const TABS = ['settings', 'overview', 'channels', 'usage'] as const
type TabName = (typeof TABS)[number]

const TAB_META: Record<TabName, { label: string; icon: string }> = {
  settings: { label: '设置', icon: 'i-ph-gear-six' },
  overview: { label: '概览', icon: 'i-ph-squares-four' },
  channels: { label: '渠道', icon: 'i-ph-hard-drives' },
  usage: { label: '用量', icon: 'i-ph-chart-bar' },
}

const DEFAULT_TAB: TabName = 'overview'

function rawTab(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

function isTabName(value: unknown): value is TabName {
  return typeof value === 'string' && (TABS as readonly string[]).includes(value)
}

function normalizeTab(value: unknown): TabName {
  const raw = rawTab(value)
  return isTabName(raw) ? raw : DEFAULT_TAB
}

const activeTab = ref<TabName>(normalizeTab(route.query['tab']))

// 带认不出的 tab 进来时把地址栏归一化，刷新后仍然停在默认标签
if (rawTab(route.query['tab']) !== undefined && normalizeTab(route.query['tab']) !== activeTab.value) {
  void router.replace({ query: { ...route.query, tab: activeTab.value } })
}

function setTab(tab: TabName): void {
  const query: LocationQueryRaw = { ...route.query, tab }
  void router.replace({ query })
}

function changeTab(next: string): void {
  if (!isTabName(next) || next === activeTab.value) return
  activeTab.value = next
  setTab(next)
}

watch(
  () => route.query['tab'],
  (value) => {
    const next = normalizeTab(value)
    if (next !== activeTab.value) activeTab.value = next
  },
)

watch(activeTab, (tab) => {
  if (normalizeTab(route.query['tab']) !== tab) setTab(tab)
})
</script>

<template>
  <AdminPage title="搜索池">
    <NTabs :value="activeTab" type="line" animated @update:value="changeTab">
      <NTabPane v-for="name in TABS" :key="name" :name="name" :tab="TAB_META[name].label">
        <template #tab>
          <span class="flex items-center gap-1.5" :data-testid="`search-tab-${name}`">
            <span :class="TAB_META[name].icon" aria-hidden="true" />
            {{ TAB_META[name].label }}
          </span>
        </template>

        <div class="pt-2" :data-testid="`search-panel-${name}`">
          <ToolsSettingsPanel v-if="name === 'settings'" />
          <ToolsOverviewPanel v-else-if="name === 'overview'" />
          <ToolsChannelsPanel v-else-if="name === 'channels'" />
          <ToolsUsagePanel v-else />
        </div>
      </NTabPane>
    </NTabs>
  </AdminPage>
</template>
