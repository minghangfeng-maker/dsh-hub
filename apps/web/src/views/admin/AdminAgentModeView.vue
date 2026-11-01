<script setup lang="ts">
import type { RelayAgentMode } from '@dsh-hub/shared'
import { AGENT_MODE_LABEL } from '@dsh-hub/shared'
import { NAlert, NButton, NTabPane, NTabs } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'

import { getAgentMode } from '@/api/admin-agent-modes'
import { listRelayChannels } from '@/api/admin-relay'
import AdminErrorNotice from '@/components/admin/AdminErrorNotice.vue'
import AdminPage from '@/components/admin/AdminPage.vue'
import PlatformSwitch from '@/components/admin/PlatformSwitch.vue'
import AgentModeDeliverTab from '@/components/admin/agent-modes/AgentModeDeliverTab.vue'
import AgentModeDesktopFragments from '@/components/admin/agent-modes/AgentModeDesktopFragments.vue'
import RelayChannelsTab from '@/components/admin/relay/RelayChannelsTab.vue'
import RelayModelsTab from '@/components/admin/relay/RelayModelsTab.vue'
import RelayUsageTab from '@/components/admin/relay/RelayUsageTab.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { useAdminPlatform } from '@/composables/admin-platform'
import { useAsyncData } from '@/composables/useAsyncData'

/**
 * Claude Code / Codex 管理页（18 §6、docs/22 §1.3）：两个地址共用一个视图，`mode` 由路由传入。
 *
 * - 云端：四个标签（下发 · 渠道 · 模型与价格 · 用量），`?tab=` 同步；只管自己这个作用域；
 * - 桌面：只编辑对应 pilot 的 `hubMode` 配置片段（`claude-pilot` / `codex-pilot`），
 *   走 `PUT /api/admin/desktop/config`（只改这个条目的 hubMode，别的片段原样保留）。
 */
const props = defineProps<{ mode: RelayAgentMode }>()

const route = useRoute()
const router = useRouter()

/** docs/22 §1.2：页标题下方的「云端 | 桌面」切换（缺省跟上次选择） */
const { platform } = useAdminPlatform()

const TABS = ['deliver', 'channels', 'models', 'usage'] as const
type TabName = (typeof TABS)[number]

const TAB_META: Record<TabName, { label: string; icon: string }> = {
  deliver: { label: '下发', icon: 'i-ph-paper-plane-tilt' },
  channels: { label: '渠道', icon: 'i-ph-hard-drives' },
  models: { label: '模型与价格', icon: 'i-ph-cube' },
  usage: { label: '用量', icon: 'i-ph-chart-bar' },
}

function normalizeTab(value: unknown): TabName {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' && (TABS as readonly string[]).includes(raw) ? (raw as TabName) : 'deliver'
}

const activeTab = ref<TabName>(normalizeTab(route.query['tab']))

watch(
  () => route.query['tab'],
  (value) => {
    const next = normalizeTab(value)
    if (next !== activeTab.value) activeTab.value = next
  },
)

watch(activeTab, (tab) => {
  if (normalizeTab(route.query['tab']) === tab) return
  const query: LocationQueryRaw = { ...route.query, tab }
  void router.replace({ query })
})

function changeTab(next: string): void {
  const tab = normalizeTab(next)
  if (tab === activeTab.value) return
  activeTab.value = tab
}

const {
  data: state,
  loading: stateLoading,
  error: stateError,
  reload: reloadState,
} = useAsyncData(() => getAgentMode(props.mode))

const {
  data: channelList,
  error: channelError,
  reload: reloadChannels,
} = useAsyncData(() => listRelayChannels(props.mode))
const channels = computed(() => channelList.value ?? [])

const errors = computed(() => [stateError.value, channelError.value].filter((item) => item !== null))

function reloadAll(): void {
  void reloadState()
  void reloadChannels()
}

// 两个页面共用同一个组件实例：切模式时把这一页的数据重新拉一遍
watch(
  () => props.mode,
  () => {
    reloadAll()
  },
)
</script>

<template>
  <AdminPage :title="AGENT_MODE_LABEL[mode]" :platform="platform">
    <template v-if="platform === 'cloud'" #actions>
      <NButton size="small" :loading="stateLoading" data-testid="agent-mode-refresh" @click="reloadAll">
        <template #icon><span class="i-ph-arrows-clockwise" aria-hidden="true" /></template>
        刷新
      </NButton>
    </template>

    <template #platform>
      <PlatformSwitch v-model="platform" />
    </template>

    <AgentModeDesktopFragments v-if="platform === 'desktop'" :key="mode" :mode="mode" />

    <template v-if="platform === 'cloud'">
      <AdminErrorNotice
        v-for="(item, index) in errors"
        :key="index"
        :error="item"
        :title="`${AGENT_MODE_LABEL[mode]}页加载失败`"
        @retry="reloadAll"
      />

      <!-- 18 §6：warnings 用顶部告警条列出（默认模型兜底、内部监听器没开、插件库里没有…） -->
      <NAlert
        v-for="(warning, index) in state?.warnings ?? []"
        :key="index"
        type="warning"
        :bordered="false"
        class="agent-mode__warning"
        data-testid="agent-mode-warning"
      >
        {{ warning }}
      </NAlert>

      <NTabs :value="activeTab" type="line" animated @update:value="changeTab">
      <NTabPane v-for="name in TABS" :key="name" :name="name" :tab="TAB_META[name].label">
        <template #tab>
          <span class="flex items-center gap-1.5" :data-testid="`agent-mode-tab-${name}`">
            <span :class="TAB_META[name].icon" aria-hidden="true" />
            {{ TAB_META[name].label }}
          </span>
        </template>

        <div class="pt-2">
          <template v-if="name === 'deliver'">
            <AgentModeDeliverTab v-if="state" :state="state" :loading="stateLoading" @changed="reloadAll" />
            <SoftCard v-else>
              <p class="text-2">正在读取配置…</p>
            </SoftCard>
          </template>
          <RelayChannelsTab v-else-if="name === 'channels'" :scope="mode" @changed="reloadAll" />
          <RelayModelsTab
            v-else-if="name === 'models'"
            :channels="channels"
            :scope="mode"
            :mode-rate-permille="state?.settings.ratePermille"
            @changed="reloadAll"
          />
          <RelayUsageTab v-else :channels="channels" :scope="mode" />
        </div>
        </NTabPane>
      </NTabs>
    </template>
  </AdminPage>
</template>

<style scoped>
.agent-mode__warning {
  margin-bottom: var(--space-3);
  border-radius: var(--radius-control);
}
</style>
