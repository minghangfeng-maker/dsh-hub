<script setup lang="ts">
import type { RelayChannel, RelayModel, RelayScope } from '@dsh-hub/shared'
import {
  NAlert,
  NButton,
  NDataTable,
  NInput,
  NSelect,
  NSwitch,
  useMessage,
  type DataTableColumns,
} from 'naive-ui'
import { computed, h, ref, watch } from 'vue'

import { deleteRelayModel, listRelayModels, updateRelayModel } from '@/api/admin-relay'
import { describeError } from '@/api/errors'
import MiniTag from '@/components/admin/MiniTag.vue'
import ModelCatalogDrawer from '@/components/admin/ModelCatalogDrawer.vue'
import DefaultThinkingCell from '@/components/admin/relay/DefaultThinkingCell.vue'
import RelayModelPickerDialog from '@/components/admin/relay/RelayModelPickerDialog.vue'
import RelayModelPriceDialog from '@/components/admin/relay/RelayModelPriceDialog.vue'
import EmptyState from '@/components/base/EmptyState.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { modelDeliveryLocation, type DeliveryPlatformChoice } from '@/composables/delivery-draft'
import { useAsyncData } from '@/composables/useAsyncData'
import { channelTagText } from '@/utils/channel-slug'
import { isUnpricedModel } from '@/utils/relay-model'
import { isReauthCanceled, sensitive } from '@/composables/useReauth'
import { formatPrice } from '@/utils/points'
import { applyRate, formatRate } from '@/utils/rate'
import { formatModeRate } from '@/utils/mode-rate'
import { isAgentModeScope } from '@/utils/relay-scope'

/**
 * 模型 · 模型与价格（12 §10）：工具栏（搜索、渠道筛选、「只看未定价」、添加模型）+ 表格
 * （模型、渠道胶囊「渠道名 ×倍率」、五项价格、状态「未定价 / 无渠道」、启用开关、定价 / 删除）。
 *
 * `models-changed` 告警时顶部横幅提示下发，跳统一向导（只预选当前平台 + 模型与 API 配置）；
 * 「只看未定价」由父组件用 `?unpriced=1` 同步。
 *
 * WP13：「默认思考」列的行内下拉（`DefaultThinkingCell`）；「模型配置」的「改」链接带 `?edit=<id>` 进来时
 * 自动打开那个模型的定价弹窗（父组件负责把 `edit` 从地址栏拿掉）。
 */
const props = withDefaults(
  defineProps<{
    channels: RelayChannel[]
    /** 概览告警里有 models-changed */
    modelsChanged?: boolean
    /** 只看未定价（`?unpriced=1`） */
    unpriced?: boolean
    /** `?edit=<id>`：打开这个模型的定价弹窗（刷新也能用） */
    focusModelId?: number | null
    /** 18 §6：只看这个作用域的模型；缺省 = DSH（「模型」页行为不变） */
    scope?: RelayScope
    /** 18 §6：整体倍率（千分比），表格里显示乘它之后的实际单价；缺省 = 不乘 */
    modeRatePermille?: number
    /** docs/22：横幅里的「去下发」预选哪个平台（模型页的云端 / 桌面切换） */
    deliveryPlatform?: DeliveryPlatformChoice
  }>(),
  {
    modelsChanged: false,
    unpriced: false,
    focusModelId: null,
    scope: 'dsh',
    modeRatePermille: undefined,
    deliveryPlatform: 'cloud',
  },
)

/** 对话模式页：价格旁显示乘整体倍率后的单价，并且没有「下发到 DSH」「默认思考」 */
const agentMode = computed(() => isAgentModeScope(props.scope))
const modeRate = computed(() => (agentMode.value ? (props.modeRatePermille ?? null) : null))

const emit = defineEmits<{
  changed: []
  'update:unpriced': [value: boolean]
  'focus-consumed': []
}>()

const message = useMessage()

const { data, loading, reload } = useAsyncData(() => listRelayModels(props.scope))
const models = computed<RelayModel[]>(() => data.value ?? [])

const keyword = ref('')
const channelFilter = ref(0)
/** 「模型信息库」入口（WP12 从原提供方一节挪到本 Tab 的工具栏） */
const showCatalog = ref(false)
const showPicker = ref(false)
const showPrice = ref(false)
const editing = ref<RelayModel | null>(null)

const unpricedCount = computed(() => models.value.filter((model) => isUnpricedModel(model)).length)

const channelOptions = computed(() => [
  { label: '全部渠道', value: 0 },
  ...props.channels.map((channel) => ({ label: channel.name, value: channel.id })),
])

const filtered = computed(() => {
  const text = keyword.value.trim().toLowerCase()
  return models.value.filter((model) => {
    if (props.unpriced && !isUnpricedModel(model)) return false
    if (channelFilter.value > 0 && !model.routes.some((route) => route.channelId === channelFilter.value))
      return false
    if (!text) return true
    return model.name.toLowerCase().includes(text) || model.displayName.toLowerCase().includes(text)
  })
})

function reloadAll(): void {
  void reload()
  emit('changed')
}

function openPrice(model: RelayModel): void {
  editing.value = model
  showPrice.value = true
}

/**
 * `?edit=<id>`：模型拉回来之后打开那个弹窗；找不到就静默算了（模型可能已被删）。
 * 地址栏上的 `edit` 保持到弹窗关闭才清掉，所以刷新页面还会打开它。
 */
let openedFor: number | null = null
watch(
  [() => props.focusModelId, models],
  ([id, list]) => {
    if (id === null) {
      openedFor = null
      return
    }
    if (id === openedFor) return
    const model = list.find((item) => item.id === id)
    if (!model) return
    openedFor = id
    openPrice(model)
  },
  { immediate: true },
)

/** 弹窗关闭：把 `?edit=` 从地址栏拿掉（下次点「改」还能再打开） */
function onPriceShow(value: boolean): void {
  showPrice.value = value
  if (value) return
  openedFor = null
  emit('focus-consumed')
}

async function toggleEnabled(model: RelayModel, enabled: boolean): Promise<void> {
  try {
    await updateRelayModel(model.id, { enabled })
    message.success(enabled ? `已启用 ${model.name}` : `已停用 ${model.name}`)
    reloadAll()
  } catch (cause) {
    message.error(describeError(cause).message)
    reloadAll()
  }
}

async function removeModel(model: RelayModel): Promise<void> {
  try {
    await sensitive(() => deleteRelayModel(model.id), {
      title: `删除模型 ${model.name}`,
      description: '删掉后用户就不能再用这个名字调用了（路由一并删除）。',
      confirmText: '删除',
      type: 'error',
    })
    message.success('模型已删除')
    reloadAll()
  } catch (cause) {
    if (!isReauthCanceled(cause)) message.error(describeError(cause).message)
  }
}

/** 价格文本：对话模式页显示乘整体倍率后的实际单价（18 §6），原价放 title */
function priceText(micro: number | null): string {
  if (micro === null) return '同输入'
  const value = modeRate.value === null ? micro : applyRate(micro, modeRate.value)
  return formatPrice(value)
}

function priceTitle(micro: number | null): string | undefined {
  if (micro === null || modeRate.value === null) return undefined
  return `原价 ${formatPrice(micro)} 积分 / 百万 token × 整体倍率 ${formatRate(modeRate.value)}`
}

function priceCell(micro: number | null) {
  return h('span', { class: 'relay-models__price', title: priceTitle(micro) }, priceText(micro))
}

const columns = computed<DataTableColumns<RelayModel>>(() => [
  {
    title: '模型',
    key: 'name',
    // 对话模式页少了「默认思考」列，收一点宽度让 1440 下不横向滚动（固定列就不会压住「启用」）
    minWidth: agentMode.value ? 160 : 170,
    render: (row) =>
      h('div', { class: 'relay-models__cell' }, [
        h('span', { class: 'relay-models__name', title: row.name }, row.name),
        h('span', { class: 'relay-models__sub' }, row.displayName),
      ]),
  },
  {
    title: '渠道',
    key: 'routes',
    minWidth: agentMode.value ? 150 : 170,
    render: (row) =>
      row.routes.length > 0
        ? h(
            'div',
            { class: 'relay-models__apis' },
            row.routes.map((route) =>
              h(MiniTag, {
                // 16 §5：胶囊显示对用户可见的「标识 ×倍率」，不再暴露渠道名称
                text: channelTagText(route.channelSlug, route.channelRatePermille),
                tone: route.channelRatePermille === 1000 ? 'sky' : 'butter',
                size: 'sm',
              }),
            ),
          )
        : h('span', { class: 'relay-models__sub' }, '—'),
  },
  {
    // 07 §2.7 第 2 条：单位进列标题，页面上不再写「价格单位是…」的说明
    title: () =>
      h('span', { class: 'relay-models__th' }, [
        modeRate.value === null ? '价格 · 积分 / 百万 token' : '实际单价 · 积分 / 百万 token',
        modeRate.value === null
          ? null
          : h(InfoTip, {
              text: `已乘整体倍率 ${formatModeRate(modeRate.value)}；渠道倍率仍按渠道胶囊显示。`,
            }),
      ]),
    key: 'prices',
    align: 'right',
    children: [
      {
        title: '输入',
        key: 'input',
        width: 80,
        align: 'right',
        render: (row) => priceCell(row.price.inputMicro),
      },
      {
        title: '输出',
        key: 'output',
        width: 80,
        align: 'right',
        render: (row) => priceCell(row.price.outputMicro),
      },
      {
        title: '缓存读',
        key: 'cacheRead',
        width: 88,
        align: 'right',
        render: (row) =>
          h(
            'span',
            {
              class: 'relay-models__price',
              title:
                row.price.cacheReadMicro === null
                  ? '留空 = 与输入价相同'
                  : priceTitle(row.price.cacheReadMicro),
            },
            priceText(row.price.cacheReadMicro),
          ),
      },
      {
        title: '缓存写',
        key: 'cacheWrite',
        width: 88,
        align: 'right',
        render: (row) =>
          h(
            'span',
            {
              class: 'relay-models__price',
              title:
                row.price.cacheWriteMicro === null
                  ? '留空 = 与输入价相同'
                  : priceTitle(row.price.cacheWriteMicro),
            },
            priceText(row.price.cacheWriteMicro),
          ),
      },
      {
        // 列标题单行（07 §2.8）：单位写在这里，标题够宽 + nowrap
        title: () => h('span', { class: 'relay-models__th' }, '每次 · 积分 / 次'),
        key: 'perRequestMicro',
        width: 130,
        align: 'right',
        render: (row) => priceCell(row.price.perRequestMicro),
      },
    ],
  },
  ...(agentMode.value
    ? []
    : [
        {
          title: '默认思考',
          key: 'defaultThinking',
          width: 140,
          render: (row: RelayModel) => h(DefaultThinkingCell, { model: row, onChange: () => reloadAll() }),
        },
      ]),
  {
    title: '状态',
    key: 'status',
    width: agentMode.value ? 130 : 150,
    render: (row) => {
      const tags = []
      if (isUnpricedModel(row)) tags.push(h(MiniTag, { text: '未定价', tone: 'butter', size: 'sm' }))
      if (row.routes.length === 0) tags.push(h(MiniTag, { text: '无渠道', tone: 'neutral', size: 'sm' }))
      if (tags.length === 0) tags.push(h('span', { class: 'relay-models__sub' }, '正常'))
      return h('div', { class: 'relay-models__apis' }, tags)
    },
  },
  {
    title: '启用',
    key: 'enabled',
    width: 60,
    render: (row) =>
      h(NSwitch, {
        value: row.enabled,
        size: 'small',
        'aria-label': `启用模型 ${row.name}`,
        'onUpdate:value': (value: boolean) => void toggleEnabled(row, value),
      }),
  },
  {
    title: '操作',
    key: 'actions',
    width: 124,
    fixed: 'right',
    render: (row) =>
      h('div', { class: 'relay-models__actions' }, [
        h(
          NButton,
          { size: 'tiny', type: 'primary', ghost: true, onClick: () => openPrice(row) },
          { default: () => '定价' },
        ),
        h(
          NButton,
          { size: 'tiny', type: 'error', ghost: true, onClick: () => void removeModel(row) },
          { default: () => '删除' },
        ),
      ]),
  },
])
</script>

<template>
  <div class="relay-models">
    <NAlert v-if="modelsChanged && !agentMode" type="warning" :bordered="false" class="relay-models__banner">
      <div class="relay-models__banner-body">
        <span>模型列表有变化，通过统一下发同步到用户的实例或桌面端。</span>
        <RouterLink :to="modelDeliveryLocation(props.deliveryPlatform)">
          <NButton size="tiny" type="warning" ghost data-testid="models-go-dsh">去下发</NButton>
        </RouterLink>
      </div>
    </NAlert>

    <div class="relay-models__bar">
      <NInput
        v-model:value="keyword"
        size="small"
        class="relay-models__search"
        placeholder="搜索模型名"
        clearable
        data-testid="models-search"
      />
      <NSelect
        v-model:value="channelFilter"
        size="small"
        class="relay-models__channel"
        :options="channelOptions"
        data-testid="models-channel-filter"
      />
      <label class="relay-models__switch">
        <NSwitch
          :value="unpriced"
          size="small"
          data-testid="models-unpriced"
          @update:value="(value: boolean) => emit('update:unpriced', value)"
        />
        <span>只看未定价（{{ unpricedCount }}）</span>
      </label>
      <NButton size="small" @click="reloadAll">
        <template #icon><span class="i-ph-arrows-clockwise" aria-hidden="true" /></template>
        刷新
      </NButton>
      <NButton size="small" data-testid="models-catalog" @click="showCatalog = true">
        <template #icon><span class="i-ph-books" aria-hidden="true" /></template>
        模型信息库
      </NButton>
      <NButton size="small" type="primary" data-testid="add-model" @click="showPicker = true">
        <template #icon><span class="i-ph-plus" aria-hidden="true" /></template>
        添加模型
      </NButton>
    </div>

    <EmptyState
      v-if="!loading && filtered.length === 0"
      title="还没有对外模型"
      description="在「渠道」里用「选择模型」拉取上游模型并勾选，或者在这里「添加模型」。"
      action-text="添加模型"
      @action="showPicker = true"
    />
    <SoftCard v-else :padded="false">
      <NDataTable
        class="relay-models__table"
        :columns="columns"
        :data="filtered"
        :loading="loading"
        :row-key="(row: RelayModel) => row.id"
        :scroll-x="agentMode ? 1120 : 1292"
        :pagination="false"
        size="small"
      />
    </SoftCard>

    <RelayModelPickerDialog
      v-model:show="showPicker"
      :channel="null"
      :channels="channels"
      :scope="scope"
      @changed="reloadAll"
    />
    <RelayModelPriceDialog
      :show="showPrice"
      :model="editing"
      :channels="channels"
      :show-thinking="!agentMode"
      :mode-rate-permille="modeRate ?? undefined"
      @saved="reloadAll"
      @update:show="onPriceShow"
    />
    <ModelCatalogDrawer v-model:show="showCatalog" />
  </div>
</template>

<style scoped>
.relay-models {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.relay-models__banner {
  border-radius: var(--radius-control);
}

.relay-models__banner-body {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.relay-models__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.relay-models__search {
  max-width: 200px;
}

.relay-models__channel {
  max-width: 220px;
}

.relay-models__switch {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--c-text-2);
  font-size: var(--fs-12);
}

.relay-models__table {
  padding: var(--space-2) var(--space-3);
}

:deep(.relay-models__th) {
  white-space: nowrap;
}

:deep(.relay-models__cell) {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
}

:deep(.relay-models__name) {
  /* 07 §2.8：模型名是标识符，单行 + 省略，完整名在 title 里 */
  overflow: hidden;
  color: var(--c-text);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  font-weight: var(--fw-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.relay-models__sub) {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

:deep(.relay-models__apis) {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

:deep(.relay-models__price) {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
}

:deep(.relay-models__actions) {
  display: flex;
  gap: 4px;
}
</style>
