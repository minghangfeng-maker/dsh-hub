<script setup lang="ts">
import { NButton, NTabPane, NTabs } from 'naive-ui'
import { computed, ref, shallowRef, watch, type ComponentPublicInstance } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'

import { getRelayOverview, listRelayChannels } from '@/api/admin-relay'
import AdminErrorNotice from '@/components/admin/AdminErrorNotice.vue'
import AdminPage from '@/components/admin/AdminPage.vue'
import PlatformSwitch from '@/components/admin/PlatformSwitch.vue'
import RelayChannelsTab from '@/components/admin/relay/RelayChannelsTab.vue'
import RelayDshTab from '@/components/admin/relay/RelayDshTab.vue'
import RelayModelsTab from '@/components/admin/relay/RelayModelsTab.vue'
import RelayOverviewTab from '@/components/admin/relay/RelayOverviewTab.vue'
import RelaySettingsTab from '@/components/admin/relay/RelaySettingsTab.vue'
import RelayUsageTab from '@/components/admin/relay/RelayUsageTab.vue'
import RelayWalletsTab from '@/components/admin/relay/RelayWalletsTab.vue'
import { useAdminPlatform, type AdminPlatform } from '@/composables/admin-platform'
import { modelDeliveryLocation } from '@/composables/delivery-draft'
import { useAsyncData } from '@/composables/useAsyncData'

/**
 * 模型 `/admin/models`（12 §10、docs/22 §1.3 §3）：一页七个 Tab ——
 * 概览 · 渠道 · 模型与价格 · 模型配置 · 积分 · 用量记录 · 设置，`?tab=` 同步。
 *
 * 「模型配置」（`?tab=dsh`）是同一个组件读写**两个平台**的系统预设：页头的「云端 | 桌面」
 * 只影响这个 Tab（`GET/PUT /api/admin/relay/dsh?platform=`），其余 Tab 两平台共用。
 * WP12 起「提供方 / 预设」不再出现在界面上，提供方与预设由后端自动维护（12 §7.0）。
 * WP19b 起「搜索池」独立成页 `/admin/search`（15 §1），本页不再有 `?tab=tools`：
 * 旧地址由路由层直接跳过去，不会落到模型概览。
 *
 * 概览与渠道列表在这一层拉（多个 Tab 都要用：概览的告警、模型的渠道筛选与胶囊、用量的渠道下拉）；
 * 「只看未定价」用 `?unpriced=1` 同步，概览的 `models-unpriced` 告警点一下就切到模型 Tab 并打开它。
 *
 * WP13：「模型配置」的「默认思考 → 改」跳 `?tab=models&edit=<id>`，这个 Tab 自动打开对应模型的定价弹窗；
 * `edit` 一直留到弹窗关闭，所以刷新 / 分享这个地址都能用。
 */
const route = useRoute()
const router = useRouter()

/** 云端 / 桌面（docs/22 §1.2）：只有「模型配置」Tab 与用量默认筛选、下发预选用它 */
const { platform } = useAdminPlatform()

const TABS = ['overview', 'channels', 'models', 'dsh', 'wallets', 'usage', 'settings'] as const
type TabName = (typeof TABS)[number]

const TAB_META: Record<TabName, { label: string; icon: string }> = {
  overview: { label: '概览', icon: 'i-ph-squares-four' },
  channels: { label: '渠道', icon: 'i-ph-hard-drives' },
  models: { label: '模型与价格', icon: 'i-ph-cube' },
  dsh: { label: '模型配置', icon: 'i-ph-sliders-horizontal' },
  wallets: { label: '积分', icon: 'i-ph-coins' },
  usage: { label: '用量记录', icon: 'i-ph-chart-bar' },
  settings: { label: '设置', icon: 'i-ph-gear-six' },
}

/** 旧「模型」页的 Tab 名（12 §10：`?tab=providers|presets` → `dsh`） */
const LEGACY_TABS: Record<string, TabName> = { providers: 'dsh', presets: 'dsh' }

function rawTab(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

function normalizeTab(value: unknown): TabName {
  const raw = rawTab(value)
  if (raw && (TABS as readonly string[]).includes(raw)) return raw as TabName
  if (raw && LEGACY_TABS[raw]) return LEGACY_TABS[raw]
  return 'overview'
}

const activeTab = ref<TabName>(normalizeTab(route.query['tab']))
const unpricedOnly = ref(route.query['unpriced'] === '1')

// 进来就带旧 Tab 名（或认不出的）时，把地址栏也归一化，免得刷新后又回到旧的
if (rawTab(route.query['tab']) !== undefined && rawTab(route.query['tab']) !== activeTab.value) {
  void router.replace({ query: { ...route.query, tab: activeTab.value } })
}

function setQuery(patch: { tab?: TabName; unpriced?: boolean }): void {
  const query: LocationQueryRaw = { ...route.query }
  if (patch.tab !== undefined) query.tab = patch.tab
  if (patch.unpriced !== undefined) {
    if (patch.unpriced) query.unpriced = '1'
    else delete query.unpriced
  }
  void router.replace({ query })
}

watch(
  () => route.query['tab'],
  (value) => {
    const next = normalizeTab(value)
    if (next !== activeTab.value) activeTab.value = next
  },
)

watch(activeTab, (tab) => {
  // 两个 watch 各写一次地址栏，所以每次都要带上另一半的当前值，否则后跑的那个会把前一个覆盖掉
  if (normalizeTab(route.query['tab']) !== tab) setQuery({ tab, unpriced: unpricedOnly.value })
})

watch(
  () => route.query['unpriced'],
  (value) => {
    const next = value === '1'
    if (next !== unpricedOnly.value) unpricedOnly.value = next
  },
)

watch(unpricedOnly, (value) => {
  if ((route.query['unpriced'] === '1') !== value) setQuery({ tab: activeTab.value, unpriced: value })
})

const {
  data: overview,
  loading: overviewLoading,
  error: overviewError,
  reload: reloadOverview,
} = useAsyncData(() => getRelayOverview(), { pollMs: 20_000 })

const { data: channelList, reload: reloadChannels } = useAsyncData(() => listRelayChannels())
const channels = computed(() => channelList.value ?? [])

/**
 * 「模型配置」Tab 的实例：页头下发、刷新与切 Tab / 切平台前的未保存提示都要用它。
 * Tab 内容在 `v-for` 里渲染，字符串 ref 会收集成数组，所以这里用函数 ref 只留最后一个。
 */
const dshTab = shallowRef<InstanceType<typeof RelayDshTab> | null>(null)

function setDshTab(element: Element | ComponentPublicInstance | null): void {
  dshTab.value = (element as InstanceType<typeof RelayDshTab> | null) ?? null
}

/** 概览的告警 / 渠道健康里点进来：切到渠道 Tab 并打开那个渠道 */
const focusChannelId = ref<number | null>(null)

function openChannel(channelId: number): void {
  focusChannelId.value = channelId
  activeTab.value = 'channels'
}

/** 概览的 `models-unpriced` 告警：切到「模型与价格」并打开「只看未定价」 */
function openUnpriced(): void {
  activeTab.value = 'models'
  unpricedOnly.value = true
  setQuery({ tab: 'models', unpriced: true })
}

/** `?edit=<id>`：切到「模型与价格」并打开该模型的定价弹窗（WP13） */
const editModelId = computed(() => {
  const raw = route.query['edit']
  const value = Array.isArray(raw) ? raw[0] : raw
  const id = Number(value)
  return Number.isFinite(id) && id > 0 ? id : null
})

// 带 `edit` 进来时直接落到「模型与价格」（`?edit=1` 也能用）
if (editModelId.value !== null && activeTab.value !== 'models') activeTab.value = 'models'

function clearEditQuery(): void {
  if (route.query['edit'] === undefined) return
  const query: LocationQueryRaw = { ...route.query }
  delete query.edit
  void router.replace({ query })
}

const focusUserId = computed(() => {
  const raw = route.query['userId']
  const value = Array.isArray(raw) ? raw[0] : raw
  const id = Number(value)
  return Number.isFinite(id) && id > 0 ? id : null
})

const modelsChanged = computed(() =>
  (overview.value?.alerts ?? []).some((alert) => alert.kind === 'models-changed'),
)

function reloadAll(): void {
  void reloadOverview()
  void reloadChannels()
  void dshTab.value?.reload()
}

/**
 * 切 Tab 前先问一句：正在离开「模型配置」且有未保存的勾选时，让那边的确认弹窗说了算
 * （弹窗里选「丢掉改动并离开」才真的切走）。
 */
async function changeTab(next: TabName): Promise<void> {
  if (activeTab.value === next) return
  if (activeTab.value === 'dsh') {
    const ok = (await dshTab.value?.confirmLeave()) ?? true
    if (!ok) return
  }
  activeTab.value = next
}

/** 切平台同理：有未保存改动时先问（切到桌面 / 云端会换一套系统预设）。 */
async function changePlatform(next: AdminPlatform): Promise<void> {
  if (next === platform.value) return
  if (activeTab.value === 'dsh') {
    const ok = (await dshTab.value?.confirmLeave()) ?? true
    if (!ok) return
  }
  platform.value = next
}

/**
 * 页头「下发模型配置」：在「模型配置」Tab 上走配置卡那套检查（未保存 / 没有可下发模型），
 * 其它 Tab 直接进统一向导（只预选当前平台 + 模型与 API 配置）。
 */
function openDelivery(): void {
  if (activeTab.value === 'dsh') {
    dshTab.value?.openDelivery()
    return
  }
  void router.push(modelDeliveryLocation(platform.value))
}
</script>

<template>
  <AdminPage title="模型" :platform="platform">
    <template #actions>
      <NButton size="small" :loading="overviewLoading" @click="reloadAll">
        <template #icon><span class="i-ph-arrows-clockwise" aria-hidden="true" /></template>
        刷新
      </NButton>
      <NButton size="small" type="primary" data-testid="models-rollout-link" @click="openDelivery">
        下发模型配置
      </NButton>
    </template>

    <AdminErrorNotice :error="overviewError" title="模型页加载失败" @retry="reloadAll" />

    <template #platform>
      <div data-testid="models-platform">
        <PlatformSwitch :model-value="platform" @update:model-value="changePlatform" />
      </div>
    </template>

    <NTabs :value="activeTab" type="line" animated @update:value="changeTab">
      <NTabPane v-for="name in TABS" :key="name" :name="name" :tab="TAB_META[name].label">
        <template #tab>
          <span class="flex items-center gap-1.5" :data-testid="`models-tab-${name}`">
            <span :class="TAB_META[name].icon" aria-hidden="true" />
            {{ TAB_META[name].label }}
          </span>
        </template>

        <div class="pt-2">
          <template v-if="name === 'overview'">
            <RelayOverviewTab
              :overview="overview"
              :loading="overviewLoading"
              :delivery-platform="platform"
              @refresh="reloadAll"
              @open-channel="openChannel"
              @open-unpriced="openUnpriced"
            />
          </template>
          <RelayChannelsTab
            v-else-if="name === 'channels'"
            :focus-channel-id="focusChannelId"
            @focus-consumed="focusChannelId = null"
            @changed="reloadAll"
          />
          <RelayModelsTab
            v-else-if="name === 'models'"
            :channels="channels"
            :models-changed="modelsChanged"
            :unpriced="unpricedOnly"
            :focus-model-id="editModelId"
            :delivery-platform="platform"
            @focus-consumed="clearEditQuery"
            @changed="reloadAll"
            @update:unpriced="
              (value: boolean) => {
                unpricedOnly = value
                setQuery({ unpriced: value })
              }
            "
          />
          <RelayDshTab
            v-else-if="name === 'dsh'"
            :ref="setDshTab"
            :platform="platform"
            @open-channels="changeTab('channels')"
          />
          <RelayWalletsTab v-else-if="name === 'wallets'" :focus-user-id="focusUserId" />
          <RelayUsageTab
            v-else-if="name === 'usage'"
            :channels="channels"
            show-source
            :client-kind="platform === 'desktop' ? 'desktop' : undefined"
          />
          <RelaySettingsTab v-else />
        </div>
      </NTabPane>
    </NTabs>
  </AdminPage>
</template>
