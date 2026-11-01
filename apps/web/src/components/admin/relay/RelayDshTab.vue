<script setup lang="ts">
import type { JobSummary, RelayDshModel, RelayDshResponse } from '@dsh-hub/shared'
import {
  NAlert,
  NButton,
  NCheckbox,
  NDataTable,
  NInput,
  NModal,
  NRadio,
  NSwitch,
  useMessage,
  type DataTableColumns,
} from 'naive-ui'
import { computed, h, ref, watch } from 'vue'
import { onBeforeRouteLeave, RouterLink, useRouter } from 'vue-router'

import { getJob, jobEventsUrl } from '@/api/admin-jobs'
import { getRelayDsh, updateRelayDsh } from '@/api/admin-relay'
import { describeError } from '@/api/errors'
import type { AdminPlatform } from '@/composables/admin-platform'
import JobProgress from '@/components/admin/JobProgress.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import EmptyState from '@/components/base/EmptyState.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { thinkingLevelLabel } from '@/components/admin/thinking-levels'
import { modelDeliveryLocation } from '@/composables/delivery-draft'
import { useAsyncData } from '@/composables/useAsyncData'
import { formatDateTime, fromNow } from '@/composables/useFormat'
import { JOB_STATUS_TONE, isJobActive, jobTypeText } from '@/composables/job-meta'
import { useSse } from '@/composables/useSse'
import { JOB_STATUS_TEXT } from '@/composables/useInstanceStatus'
import { flattenDshRoutes, type DshRouteRow } from '@/utils/pinned-models'
import { formatPrice } from '@/utils/points'
import { formatRate } from '@/utils/rate'

/**
 * 模型 · 模型配置（12 §7.0、16 §6.3、docs/22 §3）。
 *
 * WP20 起按**路由**（模型 × 渠道）选：平铺成一行一个「模型@标识」，勾选框 / 渠道名 + 倍率 /
 * 协议 / 默认思考 / 不能下发原因 /「设为默认」单选；保存发 `routeIds` + `defaultRouteId`。
 * 页头显示「默认：模型@标识」。后端没给 `routes` 时退回按模型选择的老界面，保存发
 * `modelIds` + `defaultModelId`（16 §6.3 的兼容要求）。
 *
 * docs/22 §3：同一个组件读写**两个平台的系统预设** —— `platform='cloud'`（实例，缺省）
 * 走 `/api/admin/relay/dsh`，`desktop` 走 `?platform=desktop`；其余标签两平台共用。
 * 保存只保存，不下发：下发统一进入 `/admin/rollouts`（只预选当前平台 + 模型与 API 配置）。
 * 有未保存改动时点下发先提示保存；切 Tab / 切平台 / 路由离开时弹确认。
 */
const props = withDefaults(
  defineProps<{
    platform?: AdminPlatform
    /**
     * WP57：嵌在下发流程的「配置」步里 —— 不显示本卡的「下发」按钮和底部保存条，
     * 由流程的「下一步」调用 `save()`（有改动才保存）。
     */
    embedded?: boolean
  }>(),
  { platform: 'cloud', embedded: false },
)

const emit = defineEmits<{ 'open-channels': [] }>()

const message = useMessage()
const router = useRouter()

const { data, loading, error, reload } = useAsyncData(() => getRelayDsh(props.platform))

const models = computed<RelayDshModel[]>(() => data.value?.models ?? [])
const warnings = computed(() => data.value?.warnings ?? [])
const pending = computed(() => data.value?.pending ?? false)
const platformText = computed(() => (props.platform === 'desktop' ? '桌面端' : '云端'))

/** 桌面「上次下发」：最近一次写入桌面模型片段的清单版本（docs/22 §3；null = 还没下发过） */
const lastDelivery = computed(() => data.value?.lastDelivery ?? null)

/** 新数据（后端给了 routes）用「模型@标识」一行一个；字段缺省时退回老界面（16 §6.3） */
const hasRouteData = computed(() => models.value.some((model) => model.routes !== undefined))
const routeRows = computed<DshRouteRow[]>(() => flattenDshRoutes(models.value))

// ── 草稿（选中集合 + 默认） ─────────────────────────────────────────────────

const draftIds = ref<number[]>([])
const draftDefault = ref<number | null>(null)
const draftRouteIds = ref<number[]>([])
const draftDefaultRouteId = ref<number | null>(null)
const baseline = ref({
  ids: [] as number[],
  defaultId: null as number | null,
  routeIds: [] as number[],
  defaultRouteId: null as number | null,
})

function adopt(value: RelayDshResponse): void {
  const rows = flattenDshRoutes(value.models)
  const selectedRoutes = rows.filter((row) => row.route.selected).map((row) => row.key)
  let defaultRoute = value.defaultRouteId ?? null
  if (defaultRoute === null && selectedRoutes.length > 0) {
    defaultRoute =
      rows.find((row) => row.route.selected && row.blockedReason === null)?.key ?? selectedRoutes[0] ?? null
  }

  baseline.value = {
    ids: value.models.filter((model) => model.selected).map((model) => model.id),
    defaultId: value.defaultModelId,
    routeIds: selectedRoutes,
    defaultRouteId: defaultRoute,
  }
  draftIds.value = [...baseline.value.ids]
  draftDefault.value = baseline.value.defaultId
  draftRouteIds.value = [...selectedRoutes]
  draftDefaultRouteId.value = defaultRoute
}

function sameIds(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false
  const sorted = [...right].sort((a, b) => a - b)
  return [...left].sort((a, b) => a - b).every((id, index) => id === sorted[index])
}

const dirty = computed(() =>
  hasRouteData.value
    ? !sameIds(draftRouteIds.value, baseline.value.routeIds) ||
      draftDefaultRouteId.value !== baseline.value.defaultRouteId
    : !sameIds(draftIds.value, baseline.value.ids) || draftDefault.value !== baseline.value.defaultId,
)

// 服务端数据变了（首次加载 / 保存后 / 任务完成后）：没有未保存改动就整体采纳
watch(
  data,
  (value) => {
    if (!value) return
    if (!dirty.value) adopt(value)
  },
  { immediate: true },
)

// 切平台 = 换一套系统预设：清掉上一套的草稿再拉新的（父组件切之前已经问过未保存改动）
watch(
  () => props.platform,
  () => {
    data.value = null
    baseline.value = { ids: [], defaultId: null, routeIds: [], defaultRouteId: null }
    draftIds.value = []
    draftDefault.value = null
    draftRouteIds.value = []
    draftDefaultRouteId.value = null
    void reload()
  },
)

// ── 老界面（没有 routes）的选中与默认 ──────────────────────────────────────

const selectedRows = computed(() => models.value.filter((model) => draftIds.value.includes(model.id)))
const deliverableRows = computed(() => selectedRows.value.filter((model) => model.blockedReason === null))
const defaultRow = computed(() => models.value.find((model) => model.id === draftDefault.value) ?? null)

function firstDeliverableId(): number | null {
  const row = models.value.find((model) => draftIds.value.includes(model.id) && model.blockedReason === null)
  return row ? row.id : null
}

function toggleSelected(row: RelayDshModel, checked: boolean): void {
  if (checked) {
    if (row.blockedReason !== null) return
    if (!draftIds.value.includes(row.id)) draftIds.value = [...draftIds.value, row.id]
    return
  }
  draftIds.value = draftIds.value.filter((id) => id !== row.id)
  if (draftDefault.value === row.id) draftDefault.value = firstDeliverableId()
}

function setDefault(row: RelayDshModel): void {
  if (row.blockedReason !== null || !draftIds.value.includes(row.id)) return
  draftDefault.value = row.id
}

// ── 新界面（routes）的选中与默认 ───────────────────────────────────────────

const selectedRouteRows = computed(() =>
  routeRows.value.filter((row) => draftRouteIds.value.includes(row.key)),
)
const deliverableRouteRows = computed(() =>
  selectedRouteRows.value.filter((row) => row.blockedReason === null),
)

function firstDeliverableRouteId(ids: number[] = draftRouteIds.value): number | null {
  const row = routeRows.value.find((item) => ids.includes(item.key) && item.blockedReason === null)
  return row ? row.key : null
}

function toggleRoute(row: DshRouteRow, checked: boolean): void {
  if (checked) {
    if (row.blockedReason !== null) return
    if (!draftRouteIds.value.includes(row.key)) draftRouteIds.value = [...draftRouteIds.value, row.key]
    return
  }
  const next = draftRouteIds.value.filter((id) => id !== row.key)
  draftRouteIds.value = next
  if (draftDefaultRouteId.value === row.key) {
    draftDefaultRouteId.value = firstDeliverableRouteId(next)
  }
}

function setDefaultRoute(row: DshRouteRow): void {
  if (row.blockedReason !== null || !draftRouteIds.value.includes(row.key)) return
  draftDefaultRouteId.value = row.key
}

const defaultRouteRow = computed(
  () => routeRows.value.find((row) => row.key === draftDefaultRouteId.value) ?? null,
)

const deliverableCount = computed(() =>
  hasRouteData.value ? deliverableRouteRows.value.length : deliverableRows.value.length,
)

/** 页头 / 保存条里的默认项：新界面是「模型@标识」，老界面是显示名 */
const defaultLabel = computed(() => {
  if (hasRouteData.value) return defaultRouteRow.value?.name ?? '未设置'
  return defaultRow.value?.displayName ?? '未设置'
})

// ── 搜索 / 只看已选 / 全选可下发的 ──────────────────────────────────────────

const keyword = ref('')
const selectedOnly = ref(false)

function matchesKeyword(text: string): boolean {
  const lowered = keyword.value.trim().toLowerCase()
  return lowered.length === 0 || text.toLowerCase().includes(lowered)
}

const filteredRouteRows = computed(() =>
  routeRows.value.filter((row) => {
    if (selectedOnly.value && !draftRouteIds.value.includes(row.key)) return false
    return matchesKeyword(`${row.name} ${row.model.name} ${row.model.displayName}`)
  }),
)

const filteredModels = computed(() =>
  models.value.filter((model) => {
    if (selectedOnly.value && !draftIds.value.includes(model.id)) return false
    return matchesKeyword(`${model.name} ${model.displayName}`)
  }),
)

const deliverableRouteIds = computed(() =>
  routeRows.value.filter((row) => !row.blockedReason).map((row) => row.key),
)
const allDeliverableSelected = computed(() =>
  hasRouteData.value
    ? deliverableRouteIds.value.length > 0 &&
      deliverableRouteIds.value.every((id) => draftRouteIds.value.includes(id))
    : deliverableIdsOfModels().length > 0 &&
      deliverableIdsOfModels().every((id) => draftIds.value.includes(id)),
)

function deliverableIdsOfModels(): number[] {
  return models.value.filter((model) => !model.blockedReason).map((model) => model.id)
}

function selectAllDeliverable(): void {
  if (hasRouteData.value) {
    // 已选中、后来被阻断的保留（勾选框禁用，用户取消不掉，12 §7.0）
    const blockedSelected = draftRouteIds.value.filter(
      (id) => routeRows.value.find((row) => row.key === id)?.blockedReason != null,
    )
    draftRouteIds.value = [...new Set([...blockedSelected, ...deliverableRouteIds.value])]
    if (draftDefaultRouteId.value === null || !draftRouteIds.value.includes(draftDefaultRouteId.value)) {
      draftDefaultRouteId.value = firstDeliverableRouteId()
    }
    return
  }

  const blockedSelected = draftIds.value.filter(
    (id) => models.value.find((model) => model.id === id)?.blockedReason != null,
  )
  draftIds.value = [...new Set([...blockedSelected, ...deliverableIdsOfModels()])]
  if (draftDefault.value === null || !draftIds.value.includes(draftDefault.value)) {
    draftDefault.value = firstDeliverableId()
  }
}

// ── 保存（只保存，不下发） ──────────────────────────────────────────────────

const saving = ref(false)

function revert(): void {
  draftIds.value = [...baseline.value.ids]
  draftDefault.value = baseline.value.defaultId
  draftRouteIds.value = [...baseline.value.routeIds]
  draftDefaultRouteId.value = baseline.value.defaultRouteId
}

async function save(): Promise<boolean> {
  saving.value = true
  try {
    const response = hasRouteData.value
      ? await updateRelayDsh(
          {
            routeIds: [...draftRouteIds.value],
            defaultRouteId: draftDefaultRouteId.value,
          },
          props.platform,
        )
      : await updateRelayDsh(
          {
            modelIds: [...draftIds.value],
            defaultModelId: draftDefault.value,
          },
          props.platform,
        )
    data.value = response
    adopt(response)
    message.success(props.embedded ? '模型配置已保存' : '模型配置已保存，点「下发」应用到用户。')
    return true
  } catch (cause) {
    message.error(describeError(cause).message)
    void reload()
    return false
  } finally {
    saving.value = false
  }
}

// ── 下发：保存后进入统一向导（本页不创建任务） ──────────────────────────────

const saveHint = ref(false)

/** 页头与配置卡共用：有未保存改动 / 没有可下发模型时只提示，不跳走 */
function openDelivery(): void {
  if (dirty.value) {
    saveHint.value = true
    message.warning('有还没保存的改动，先点「保存」再下发')
    return
  }
  if (deliverableCount.value === 0) {
    message.warning('还没有可下发的模型，先勾选一个')
    return
  }
  saveHint.value = false
  void router.push(modelDeliveryLocation(props.platform))
}

// ── 任务进度（任务中心同一套：SSE + 2 秒轮询兜底） ──────────────────────────

const jobId = ref<number | null>(null)
let settledJobId: number | null = null

const { data: jobDetail, reload: reloadJob } = useAsyncData(
  async () => (jobId.value === null ? null : getJob(jobId.value)),
  { pollMs: 2000 },
)

const rolloutJob = computed<JobSummary | null>(() => jobDetail.value?.job ?? null)

/** 有任务在跑：状态卡不再显示「还没下发 / 已一致」，免得和进度条自相矛盾 */
const jobRunning = computed(() =>
  rolloutJob.value ? isJobActive(rolloutJob.value.status) : jobId.value !== null,
)

const { close: closeJobStream } = useSse(() => (jobId.value === null ? '' : jobEventsUrl(jobId.value)), {
  events: {
    job: (payload) => {
      const event = payload as { job?: JobSummary } | null
      if (event?.job && jobDetail.value) jobDetail.value = { ...jobDetail.value, job: event.job }
    },
  },
})

// 页面一进来就有一个跑着的模型下发任务（如刚在别的会话点过下发）→ 直接接着看进度
watch(
  data,
  (value) => {
    if (!value || jobId.value !== null) return
    const last = value.lastRollout
    if (last && isJobActive(last.status)) jobId.value = last.jobId
  },
  { immediate: true },
)

watch(rolloutJob, (job) => {
  if (!job || isJobActive(job.status) || settledJobId === job.id) return
  settledJobId = job.id
  closeJobStream()
  void reloadJob()
  void reload()
  message.success(
    job.status === 'succeeded'
      ? '实例下发完成，模型配置已经更新'
      : '下发任务已结束，点「查看任务详情」看结果',
  )
})

// ── 离开页面有未保存改动 → 提示（切 Tab 由父组件调 confirmLeave） ────────────

const leaveOpen = ref(false)
let leaveResolve: ((ok: boolean) => void) | null = null

function confirmLeave(): Promise<boolean> {
  if (!dirty.value) return Promise.resolve(true)
  leaveOpen.value = true
  return new Promise<boolean>((resolve) => {
    leaveResolve = resolve
  })
}

function settleLeave(ok: boolean): void {
  leaveOpen.value = false
  const resolve = leaveResolve
  leaveResolve = null
  resolve?.(ok)
}

onBeforeRouteLeave(async () => confirmLeave())

defineExpose({ confirmLeave, dirty, reload, openDelivery, save, deliverableCount, defaultLabel })

// ── 表格 ────────────────────────────────────────────────────────────────────

const API_TEXT: Record<string, string> = {
  'openai-completions': 'OpenAI 兼容',
  'anthropic-messages': 'Anthropic',
  'openai-responses': 'Responses',
}

/** 默认思考列（两个模式共用）：只读档位 + 跳到定价弹窗的「改」 */
function thinkingCell(model: RelayDshModel, testId: string) {
  return h('div', { class: 'relay-dsh__thinking' }, [
    model.defaultThinking
      ? h(
          'span',
          {
            class: 'relay-dsh__thinking-level',
            title: thinkingLevelLabel(model.defaultThinking),
            'data-testid': testId,
          },
          model.defaultThinking,
        )
      : h('span', { class: 'relay-dsh__muted', 'data-testid': testId }, '—'),
    h(
      RouterLink,
      {
        class: 'relay-dsh__link',
        to: `/admin/models?tab=models&edit=${model.id}`,
        'data-testid': `${testId}-edit`,
      },
      { default: () => '改' },
    ),
  ])
}

const thinkingColumn = {
  // 这段说明只有想弄明白「为什么 DSH 里有几个同名分组」的人才需要（07 §2.7 第 5 条）
  title: () =>
    h('span', { class: 'relay-dsh__th' }, [
      '默认思考',
      h(InfoTip, {
        text: '用户在 DSH 里看到的提供方都叫「DSH\u00A0Hub」，档位在「模型与价格」里设置；默认档位不同的模型在 DSH 的模型列表里会分在几个同名分组下。',
      }),
    ]),
  key: 'defaultThinking',
  width: 148,
}

const routeColumns = computed<DataTableColumns<DshRouteRow>>(() => [
  {
    title: '',
    key: 'selected',
    width: 46,
    render: (row) =>
      h('span', { title: row.blockedReason ?? undefined, 'data-testid': `dsh-check-${row.key}` }, [
        h(NCheckbox, {
          checked: draftRouteIds.value.includes(row.key),
          // 已选中但被阻断的行仍可取消勾选（只禁止新勾选）
          disabled: row.blockedReason !== null && !draftRouteIds.value.includes(row.key),
          'aria-label': `下发 ${row.name}`,
          onUpdateChecked: (value: boolean) => toggleRoute(row, value),
        }),
      ]),
  },
  {
    title: '模型',
    key: 'name',
    minWidth: 240,
    render: (row) =>
      h('div', { class: 'relay-dsh__cell' }, [
        h('span', { class: 'relay-dsh__name', 'data-testid': `dsh-route-${row.key}` }, row.name),
        h('span', { class: 'relay-dsh__sub' }, row.model.displayName),
        row.blockedReason
          ? h(
              'span',
              { class: 'relay-dsh__blocked', 'data-testid': `dsh-blocked-${row.key}` },
              row.route.selected
                ? `已选中但${row.blockedReason}，不会下发（可取消勾选）`
                : `不能下发：${row.blockedReason}`,
            )
          : null,
      ]),
  },
  {
    title: '渠道',
    key: 'channel',
    minWidth: 150,
    render: (row) =>
      h(
        'span',
        {
          class: 'relay-dsh__channel',
          title: `${row.route.channelName} ${formatRate(row.route.ratePermille)}`,
        },
        `${row.route.channelName} ${formatRate(row.route.ratePermille)}`,
      ),
  },
  {
    title: '协议',
    key: 'deliverApi',
    width: 124,
    render: (row) =>
      row.route.deliverApi
        ? h('span', { class: 'relay-dsh__api' }, API_TEXT[row.route.deliverApi] ?? row.route.deliverApi)
        : h('span', { class: 'relay-dsh__muted' }, '—'),
  },
  {
    ...thinkingColumn,
    render: (row) => thinkingCell(row.model, `dsh-thinking-${row.key}`),
  },
  {
    title: '默认',
    key: 'default',
    width: 74,
    render: (row) =>
      h(NRadio, {
        checked: draftDefaultRouteId.value === row.key,
        disabled: row.blockedReason !== null || !draftRouteIds.value.includes(row.key),
        'data-testid': `dsh-default-${row.key}`,
        'aria-label': `把 ${row.name} 设为默认模型`,
        onUpdateChecked: () => setDefaultRoute(row),
      }),
  },
])

const modelColumns = computed<DataTableColumns<RelayDshModel>>(() => [
  {
    title: '',
    key: 'selected',
    width: 46,
    render: (row) =>
      h('span', { title: row.blockedReason ?? undefined, 'data-testid': `dsh-check-${row.id}` }, [
        h(NCheckbox, {
          checked: draftIds.value.includes(row.id),
          disabled: row.blockedReason !== null && !draftIds.value.includes(row.id),
          'aria-label': `下发 ${row.displayName}`,
          onUpdateChecked: (value: boolean) => toggleSelected(row, value),
        }),
      ]),
  },
  {
    title: '模型',
    key: 'name',
    minWidth: 190,
    render: (row) =>
      h('div', { class: 'relay-dsh__cell' }, [
        h('span', { class: 'relay-dsh__name' }, row.name),
        h('span', { class: 'relay-dsh__sub' }, row.displayName),
        row.blockedReason
          ? h(
              'span',
              { class: 'relay-dsh__blocked', 'data-testid': `dsh-blocked-${row.id}` },
              row.selected
                ? `已选中但${row.blockedReason}，不会下发（可取消勾选）`
                : `不能下发：${row.blockedReason}`,
            )
          : null,
      ]),
  },
  {
    title: '渠道',
    key: 'channelNames',
    minWidth: 150,
    render: (row) =>
      row.channelNames.length > 0
        ? h(
            'div',
            { class: 'relay-dsh__tags' },
            row.channelNames.map((name) => h(MiniTag, { text: name, tone: 'sky', size: 'sm' })),
          )
        : h('span', { class: 'relay-dsh__muted' }, '—'),
  },
  {
    title: '协议',
    key: 'deliverApi',
    width: 124,
    render: (row) =>
      row.deliverApi
        ? h('span', { class: 'relay-dsh__api' }, API_TEXT[row.deliverApi] ?? row.deliverApi)
        : h('span', { class: 'relay-dsh__muted' }, '—'),
  },
  {
    ...thinkingColumn,
    render: (row) => thinkingCell(row, `dsh-thinking-${row.id}`),
  },
  {
    title: '价格摘要',
    key: 'price',
    minWidth: 190,
    render: (row) =>
      h('div', { class: 'relay-dsh__cell' }, [
        h(
          'span',
          { class: 'relay-dsh__price' },
          `输入 ${formatPrice(row.price.inputMicro)} · 输出 ${formatPrice(row.price.outputMicro)}`,
        ),
        row.priced
          ? null
          : h(MiniTag, { text: '未定价（可以选，但用户侧费用为 0）', tone: 'butter', size: 'sm' }),
      ]),
  },
  {
    title: '默认',
    key: 'default',
    width: 74,
    render: (row) =>
      h(NRadio, {
        checked: draftDefault.value === row.id,
        disabled: row.blockedReason !== null || !draftIds.value.includes(row.id),
        'data-testid': `dsh-default-${row.id}`,
        'aria-label': `把 ${row.displayName} 设为默认模型`,
        onUpdateChecked: () => setDefault(row),
      }),
  },
])
</script>

<template>
  <div class="relay-dsh">
    <SoftCard>
      <template #header>
        <h3 class="relay-dsh__title">模型配置</h3>
        <span class="relay-dsh__plat" :class="`relay-dsh__plat--${platform}`" data-testid="dsh-platform-tag">{{
          platformText
        }}</span>
      </template>
      <template #extra>
        <NButton size="tiny" quaternary data-testid="dsh-refresh" @click="reload">刷新</NButton>
      </template>

      <div class="relay-dsh__status" data-testid="dsh-status">
        <div class="relay-dsh__status-item">
          <span class="relay-dsh__status-label">已选</span>
          <span class="relay-dsh__status-value">{{ deliverableCount }} 个模型</span>
        </div>
        <div class="relay-dsh__status-item">
          <span class="relay-dsh__status-label">默认：</span>
          <span class="relay-dsh__status-value" data-testid="dsh-default-label">{{ defaultLabel }}</span>
        </div>
        <div class="relay-dsh__status-item">
          <span class="relay-dsh__status-label">上次下发</span>
          <!-- 桌面：清单 revision + 时间 + 操作人（系统写入模型基线时没有操作人） -->
          <span
            v-if="platform === 'desktop'"
            class="relay-dsh__status-value"
            data-testid="dsh-last-delivery"
          >
            <template v-if="lastDelivery">
              <MiniTag :text="`清单 #${lastDelivery.revision}`" tone="sky" size="sm" />
              <span :title="formatDateTime(lastDelivery.at)" data-testid="dsh-last-delivery-at">{{
                fromNow(lastDelivery.at)
              }}</span>
              <span class="relay-dsh__muted" data-testid="dsh-last-delivery-by">{{
                lastDelivery.by ? `由 ${lastDelivery.by}` : '系统写入'
              }}</span>
            </template>
            <span v-else class="relay-dsh__muted" data-testid="dsh-last-delivery-empty">还没下发过</span>
          </span>
          <span v-else-if="data?.lastRollout" class="relay-dsh__status-value">
            {{ fromNow(data.lastRollout.createdAt) }}
            <MiniTag
              :text="JOB_STATUS_TEXT[data.lastRollout.status] ?? data.lastRollout.status"
              :tone="JOB_STATUS_TONE[data.lastRollout.status] ?? 'neutral'"
              size="sm"
            />
            <RouterLink
              class="relay-dsh__link"
              :to="`/admin/jobs/${data.lastRollout.jobId}`"
              data-testid="dsh-last-job"
              >任务 #{{ data.lastRollout.jobId }}</RouterLink
            >
          </span>
          <span v-else class="relay-dsh__muted">还没下发过</span>
        </div>
        <span class="relay-dsh__spacer" />
        <NButton
          v-if="!embedded"
          type="primary"
          size="small"
          :disabled="deliverableCount === 0"
          :class="{ 'relay-dsh__primary--pending': pending && !dirty }"
          data-testid="dsh-rollout"
          @click="openDelivery"
        >
          <template #icon><span class="i-ph-paper-plane-tilt" aria-hidden="true" /></template>
          下发
        </NButton>
      </div>

      <NAlert
        v-if="pending && !jobRunning"
        type="warning"
        :bordered="false"
        class="relay-dsh__alert"
        data-testid="dsh-pending"
      >
        {{ platformText }}模型配置有改动，尚未下发。
      </NAlert>
      <NAlert
        v-else-if="deliverableCount > 0 && !jobRunning"
        type="success"
        :bordered="false"
        class="relay-dsh__alert"
        data-testid="dsh-synced"
      >
        已下发的{{ platformText }}模型配置与下面一致。
      </NAlert>

      <NAlert
        v-if="saveHint && dirty"
        type="info"
        :bordered="false"
        class="relay-dsh__alert"
        data-testid="dsh-save-hint"
      >
        下面的勾选还没保存，先点「保存」再下发。
      </NAlert>

      <ul v-if="warnings.length > 0" class="relay-dsh__warnings" data-testid="dsh-warnings">
        <li v-for="warning in warnings" :key="warning">
          <span class="i-ph-warning-circle" aria-hidden="true" />
          {{ warning }}
        </li>
      </ul>

      <!-- 任务进度：SSE 推 + 轮询兜底，完成后自动刷新上面的状态 -->
      <div v-if="jobId !== null" class="relay-dsh__job" data-testid="dsh-job">
        <div class="relay-dsh__job-head">
          <span class="relay-dsh__job-title">
            任务 #{{ jobId }}
            <template v-if="rolloutJob">· {{ jobTypeText(rolloutJob.type) }}</template>
          </span>
          <span data-testid="dsh-job-status">
            <MiniTag
              v-if="rolloutJob"
              :text="JOB_STATUS_TEXT[rolloutJob.status] ?? rolloutJob.status"
              :tone="JOB_STATUS_TONE[rolloutJob.status] ?? 'neutral'"
              size="sm"
            />
            <span v-else class="relay-dsh__hint">正在读取任务状态…</span>
          </span>
          <RouterLink class="relay-dsh__link" :to="`/admin/jobs/${jobId}`" data-testid="dsh-job-link">
            查看任务详情
          </RouterLink>
        </div>
        <JobProgress
          v-if="rolloutJob"
          :total="rolloutJob.total"
          :done="rolloutJob.done"
          :failed="rolloutJob.failed"
          size="sm"
        />
        <p class="relay-dsh__hint">
          <template v-if="rolloutJob && !isJobActive(rolloutJob.status)">
            任务已结束（{{ formatDateTime(rolloutJob.finishedAt) }}）。
          </template>
          <template v-else>正在把模型配置写入用户的 DSH，完成后这里会自动刷新。</template>
        </p>
      </div>
    </SoftCard>

    <EmptyState
      v-if="!loading && models.length === 0"
      data-testid="dsh-empty"
      title="还没有任何对外模型"
      description="先到「渠道」添加一条渠道，把上游模型勾选成对外模型，再回来勾选下发。"
      illustration="cloud"
      action-text="去「渠道」添加"
      @action="emit('open-channels')"
    />
    <template v-else>
      <div class="relay-dsh__bar">
        <NInput
          v-model:value="keyword"
          size="small"
          class="relay-dsh__search"
          placeholder="按模型本名筛选"
          clearable
          data-testid="dsh-search"
        />
        <NButton
          size="small"
          :disabled="allDeliverableSelected"
          data-testid="dsh-select-all"
          @click="selectAllDeliverable"
        >
          全选可下发的
        </NButton>
        <label class="relay-dsh__switch">
          <NSwitch v-model:value="selectedOnly" size="small" data-testid="dsh-selected-only" />
          <span>只看已选（{{ hasRouteData ? draftRouteIds.length : draftIds.length }}）</span>
        </label>
        <span class="relay-dsh__spacer" />
      </div>

      <SoftCard :padded="false">
        <NDataTable
          v-if="hasRouteData"
          class="relay-dsh__table"
          :columns="routeColumns"
          :data="filteredRouteRows"
          :loading="loading"
          :row-key="(row: DshRouteRow) => row.key"
          :scroll-x="1040"
          :pagination="false"
          size="small"
        />
        <NDataTable
          v-else
          class="relay-dsh__table"
          :columns="modelColumns"
          :data="filteredModels"
          :loading="loading"
          :row-key="(row: RelayDshModel) => row.id"
          :scroll-x="1000"
          :pagination="false"
          size="small"
        />
      </SoftCard>
    </template>

    <NAlert v-if="error" type="error" :bordered="false" class="relay-dsh__alert" data-testid="dsh-error">
      {{ error.message }}
      <NButton size="tiny" quaternary @click="reload">重试</NButton>
    </NAlert>

    <!-- 有未保存改动时的底部固定条 -->
    <Transition name="relay-dsh-fade">
      <div v-if="dirty && !embedded" class="relay-dsh__savebar" data-testid="dsh-savebar">
        <span class="relay-dsh__savebar-text">
          已选 {{ hasRouteData ? selectedRouteRows.length : selectedRows.length }} 个 · 默认
          {{ defaultLabel }}
        </span>
        <NButton size="small" data-testid="dsh-cancel" @click="revert">取消</NButton>
        <NButton size="small" type="primary" :loading="saving" data-testid="dsh-save" @click="save"
          >保存</NButton
        >
      </div>
    </Transition>

    <!-- 有未保存改动时离开页面 / 切 Tab 的确认 -->
    <NModal
      v-model:show="leaveOpen"
      preset="card"
      title="有还没保存的改动"
      class="relay-dsh__modal"
      :style="{ width: 'calc(100vw - 24px)', maxWidth: '420px' }"
      @close="settleLeave(false)"
    >
      <p data-testid="dsh-leave-dialog">离开后这些勾选与默认模型的选择会丢掉，确定离开吗？</p>
      <template #footer>
        <div class="relay-dsh__modal-footer">
          <NButton size="small" data-testid="dsh-leave-cancel" @click="settleLeave(false)"
            >留下继续改</NButton
          >
          <NButton size="small" type="warning" data-testid="dsh-leave-discard" @click="settleLeave(true)">
            丢掉改动并离开
          </NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.relay-dsh {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.relay-dsh__plat {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--c-plat-cloud-soft);
  color: var(--c-plat-cloud-ink);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.relay-dsh__plat--desktop {
  background: var(--c-plat-desktop-soft);
  color: var(--c-plat-desktop-ink);
}

.relay-dsh__title {
  color: var(--c-text);
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}

.relay-dsh__status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-6);
}

.relay-dsh__status-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-13);
}

.relay-dsh__status-label {
  color: var(--c-text-3);
  white-space: nowrap;
}

.relay-dsh__status-value {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--c-text);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}

.relay-dsh__spacer {
  flex: 1;
}

.relay-dsh__primary--pending {
  box-shadow: 0 0 0 3px var(--c-primary-soft);
}

.relay-dsh__alert {
  margin-top: var(--space-3);
  border-radius: var(--radius-control);
}

.relay-dsh__warnings {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: var(--space-3);
  color: var(--c-butter-ink);
  font-size: var(--fs-12);
}

.relay-dsh__warnings li {
  display: flex;
  align-items: flex-start;
  gap: 4px;
}

.relay-dsh__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.relay-dsh__search {
  max-width: 220px;
}

.relay-dsh__switch {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--c-text-2);
  font-size: var(--fs-12);
}

.relay-dsh__table {
  padding: var(--space-2) var(--space-3);
}

:deep(.relay-dsh__cell) {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  line-height: 1.35;
}

:deep(.relay-dsh__name) {
  overflow: hidden;
  color: var(--c-text);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  font-weight: var(--fw-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.relay-dsh__sub) {
  overflow: hidden;
  color: var(--c-text-3);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.relay-dsh__blocked) {
  color: var(--c-danger-ink);
  font-size: var(--fs-12);
}

:deep(.relay-dsh__channel) {
  overflow: hidden;
  color: var(--c-text-2);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.relay-dsh__api) {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

:deep(.relay-dsh__muted) {
  color: var(--c-text-3);
}

:deep(.relay-dsh__tags) {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

:deep(.relay-dsh__thinking) {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

:deep(.relay-dsh__thinking-level) {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
}

:deep(.relay-dsh__th) {
  white-space: nowrap;
}

:deep(.relay-dsh__link) {
  color: var(--c-primary-press);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.relay-dsh__job {
  margin-top: var(--space-3);
  padding: var(--space-3);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
  background: var(--c-bg);
}

.relay-dsh__job-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.relay-dsh__job-title {
  color: var(--c-text);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  font-weight: var(--fw-semibold);
}

.relay-dsh__hint {
  color: var(--c-text-2);
  font-size: var(--fs-12);
}

.relay-dsh__savebar {
  position: sticky;
  bottom: var(--space-3);
  z-index: 4;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
  background: var(--c-surface);
  box-shadow: var(--shadow-card);
}

.relay-dsh__savebar-text {
  flex: 1;
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.relay-dsh__modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

.relay-dsh-fade-enter-active,
.relay-dsh-fade-leave-active {
  transition: opacity var(--duration-base) var(--ease-out-soft);
}

.relay-dsh-fade-enter-from,
.relay-dsh-fade-leave-to {
  opacity: 0;
}
</style>
