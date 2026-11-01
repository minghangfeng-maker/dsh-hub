<script setup lang="ts">
import type { RelayChannel, RelayScope } from '@dsh-hub/shared'
import { NButton, NDataTable, NModal, NSwitch, useMessage, type DataTableColumns } from 'naive-ui'
import { computed, h, ref, watch } from 'vue'

import {
  deleteRelayChannel,
  listRelayChannels,
  testRelayChannel,
  updateRelayChannel,
} from '@/api/admin-relay'
import { describeError } from '@/api/errors'
import { isHubApiError } from '@/api/http'
import MiniTag from '@/components/admin/MiniTag.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import AddChannelDialog from '@/components/admin/relay/AddChannelDialog.vue'
import ChannelDrawer from '@/components/admin/relay/ChannelDrawer.vue'
import RelayModelPickerDialog from '@/components/admin/relay/RelayModelPickerDialog.vue'
import type { AdminTone } from '@/components/admin/tone'
import SoftCard from '@/components/base/SoftCard.vue'
import { useAsyncData } from '@/composables/useAsyncData'
import { isReauthCanceled, sensitive } from '@/composables/useReauth'
import { formatRate } from '@/utils/rate'

/**
 * 模型 · 渠道（12 §10）：表格（名称 + 备注、地址、协议胶囊、倍率、模型数、密钥、健康、启用开关，
 * 操作：编辑 / 选择模型 / 测试 / 删除）+「添加渠道」两步弹窗 + 编辑抽屉 + 模型选择器。
 *
 * 删除有路由引用的渠道会被拒绝（`CONFLICT`，details 里带模型名），这里把模型名列出来。
 */
const props = withDefaults(
  defineProps<{
    focusChannelId?: number | null
    /** 18 §6：只看这个作用域的渠道；缺省 = DSH（「模型」页行为不变） */
    scope?: RelayScope
  }>(),
  { focusChannelId: null, scope: 'dsh' },
)

const emit = defineEmits<{ 'focus-consumed': []; changed: [] }>()

const message = useMessage()

const { data, loading, error, reload } = useAsyncData(() => listRelayChannels(props.scope))
const channels = computed<RelayChannel[]>(() => data.value ?? [])

const showDrawer = ref(false)
const editing = ref<RelayChannel | null>(null)

const showAdd = ref(false)
const showPicker = ref(false)
const picking = ref<RelayChannel | null>(null)

const testResults = ref<{
  channelName: string
  results: {
    keyId: number
    last4: string
    ok: boolean
    latencyMs: number
    httpStatus: number | null
    error?: string
  }[]
} | null>(null)

const API_TEXT: Record<string, string> = {
  'openai-completions': 'OpenAI 兼容',
  'openai-responses': 'Responses',
  'anthropic-messages': 'Anthropic',
}

const HEALTH_TEXT: Record<RelayChannel['health'], string> = {
  ok: '正常',
  cooling: '冷却中',
  'no-key': '没有可用密钥',
  disabled: '已停用',
}

const HEALTH_TONE: Record<RelayChannel['health'], AdminTone> = {
  ok: 'success',
  cooling: 'butter',
  'no-key': 'danger',
  disabled: 'neutral',
}

function reloadAll(): void {
  void reload()
  emit('changed')
}

function editChannel(channel: RelayChannel): void {
  editing.value = channel
  showDrawer.value = true
}

function pickModels(channel: RelayChannel): void {
  picking.value = channel
  showPicker.value = true
}

/** 概览 / 告警里点「去处理」：切到这个 Tab 并直接打开该渠道的抽屉 */
watch(
  [() => props.focusChannelId, channels],
  ([id]) => {
    if (id === null || id === undefined) return
    const channel = channels.value.find((item) => item.id === id)
    if (channel) {
      editChannel(channel)
      emit('focus-consumed')
    }
  },
  { immediate: true },
)

async function toggleEnabled(channel: RelayChannel, enabled: boolean): Promise<void> {
  try {
    await updateRelayChannel(channel.id, { enabled })
    message.success(enabled ? `已启用渠道 ${channel.name}` : `已停用渠道 ${channel.name}`)
    reloadAll()
  } catch (cause) {
    message.error(describeError(cause).message)
    reloadAll()
  }
}

async function runTest(channel: RelayChannel): Promise<void> {
  try {
    const result = await testRelayChannel(channel.id)
    testResults.value = { channelName: channel.name, results: result.results }
    if (!result.ok) message.warning('有密钥没通过测试，看看弹窗里每一行的原因')
  } catch (cause) {
    message.error(describeError(cause).message)
  }
}

async function removeChannel(channel: RelayChannel): Promise<void> {
  try {
    await sensitive(() => deleteRelayChannel(channel.id), {
      title: `删除渠道 ${channel.name}`,
      description: '有模型路由引用它时会被拒绝，先在「选择模型」里把模型从本渠道移除。',
      confirmText: '删除',
      type: 'error',
    })
    message.success('渠道已删除')
    reloadAll()
  } catch (cause) {
    if (isReauthCanceled(cause)) return
    if (isHubApiError(cause) && cause.code === 'CONFLICT') {
      const models = cause.details['models']
      const names = Array.isArray(models) ? models.map(String) : []
      message.error(
        names.length > 0
          ? `这些模型还在用这个渠道，先从它们的「选择模型」里去掉：${names.join('、')}`
          : describeError(cause).message,
      )
      return
    }
    message.error(describeError(cause).message)
  }
}

const columns = computed<DataTableColumns<RelayChannel>>(() => [
  {
    title: '渠道',
    key: 'name',
    minWidth: 130,
    render: (row) =>
      h('div', { class: 'channels__cell' }, [
        h('span', { class: 'channels__name', title: row.name }, row.name),
        row.note ? h('span', { class: 'channels__note' }, row.note) : null,
      ]),
  },
  {
    title: '标识',
    key: 'slug',
    width: 120,
    render: (row) => h('span', { class: 'channels__slug', title: row.slug ?? '—' }, row.slug ?? '—'),
  },
  {
    title: '地址',
    key: 'baseUrl',
    minWidth: 140,
    // 07 §2.8：URL 这种标识符要么够宽、要么省略 + 悬停看全，不能从中间断开
    ellipsis: { tooltip: true },
    render: (row) => h('span', { class: 'channels__url' }, row.baseUrl),
  },
  {
    title: '协议',
    key: 'apis',
    width: 110,
    render: (row) =>
      h(
        'div',
        { class: 'channels__apis' },
        row.apis.map((api) => h(MiniTag, { text: API_TEXT[api] ?? api, tone: 'sky', size: 'sm' })),
      ),
  },
  {
    title: () =>
      h('span', { class: 'channels__th' }, [
        '倍率',
        h(InfoTip, { text: '这条渠道上的费用 = 模型价格 × 倍率，倍率在 0–100 之间、最多 3 位小数。' }),
      ]),
    key: 'ratePermille',
    width: 96,
    render: (row) =>
      h(MiniTag, {
        text: formatRate(row.ratePermille),
        tone: row.ratePermille === 1000 ? 'neutral' : 'butter',
        size: 'sm',
      }),
  },
  {
    title: '模型数',
    key: 'modelCount',
    width: 60,
    align: 'right',
    render: (row) =>
      h(
        NButton,
        { size: 'tiny', quaternary: true, onClick: () => pickModels(row), title: '选择模型' },
        { default: () => `${row.modelCount} 个` },
      ),
  },
  {
    // 列标题不断行（07 §2.8）；「可用 / 总」的口径看数字就知道
    title: () => h('span', { class: 'channels__th' }, '密钥 可用 / 总'),
    key: 'keys',
    width: 100,
    align: 'right',
    render: (row) => `${row.keys.filter((key) => key.state === 'active').length} / ${row.keys.length}`,
  },
  {
    title: '健康',
    key: 'health',
    width: 84,
    render: (row) => h(MiniTag, { text: HEALTH_TEXT[row.health], tone: HEALTH_TONE[row.health], size: 'sm' }),
  },
  {
    title: '启用',
    key: 'enabled',
    width: 56,
    render: (row) =>
      h(NSwitch, {
        value: row.enabled,
        size: 'small',
        'aria-label': `启用渠道 ${row.name}`,
        'onUpdate:value': (value: boolean) => void toggleEnabled(row, value),
      }),
  },
  {
    title: '操作',
    key: 'actions',
    width: 210,
    fixed: 'right',
    render: (row) =>
      h('div', { class: 'channels__actions' }, [
        h(NButton, { size: 'tiny', onClick: () => editChannel(row) }, { default: () => '编辑' }),
        h(NButton, { size: 'tiny', onClick: () => pickModels(row) }, { default: () => '选择模型' }),
        h(
          NButton,
          { size: 'tiny', quaternary: true, onClick: () => void runTest(row) },
          { default: () => '测试' },
        ),
        h(
          NButton,
          { size: 'tiny', type: 'error', ghost: true, onClick: () => void removeChannel(row) },
          { default: () => '删除' },
        ),
      ]),
  },
])
</script>

<template>
  <div class="channels">
    <div class="channels__bar">
      <span class="channels__bar-spacer" />
      <NButton size="small" @click="reloadAll">
        <template #icon><span class="i-ph-arrows-clockwise" aria-hidden="true" /></template>
        刷新
      </NButton>
      <NButton size="small" type="primary" data-testid="add-channel" @click="showAdd = true">
        <template #icon><span class="i-ph-plus" aria-hidden="true" /></template>
        添加渠道
      </NButton>
    </div>

    <SoftCard :padded="false">
      <NDataTable
        class="channels__table"
        :columns="columns"
        :data="channels"
        :loading="loading"
        :row-key="(row: RelayChannel) => row.id"
        :scroll-x="1120"
        :pagination="false"
        size="small"
      >
        <template #empty>
          <span class="channels__empty">还没有渠道</span>
        </template>
      </NDataTable>
    </SoftCard>

    <p v-if="error" class="channels__error">{{ error.message }}</p>

    <AddChannelDialog v-model:show="showAdd" :scope="scope" @changed="reloadAll" />
    <ChannelDrawer v-model:show="showDrawer" :channel="editing" :scope="scope" @saved="reloadAll" />
    <RelayModelPickerDialog
      v-model:show="showPicker"
      :channel="picking"
      :channels="channels"
      :scope="scope"
      @changed="reloadAll"
    />

    <NModal
      :show="testResults !== null"
      preset="card"
      :title="`渠道测试结果 · ${testResults?.channelName ?? ''}`"
      :style="{ width: 'calc(100vw - 24px)', maxWidth: '560px' }"
      @update:show="(value: boolean) => (testResults = value ? testResults : null)"
    >
      <ul class="channels__test-list">
        <li v-for="row in testResults?.results ?? []" :key="row.keyId" class="channels__test-row">
          <span class="channels__url">····{{ row.last4 }}</span>
          <MiniTag :text="row.ok ? '连通' : '失败'" :tone="row.ok ? 'success' : 'danger'" size="sm" />
          <span class="channels__hint">{{ row.latencyMs }} ms · HTTP {{ row.httpStatus ?? '—' }}</span>
          <span v-if="row.error" class="channels__test-error">{{ row.error }}</span>
        </li>
        <li v-if="(testResults?.results.length ?? 0) === 0" class="channels__hint">没有可测试的密钥。</li>
      </ul>
    </NModal>
  </div>
</template>

<style scoped>
.channels {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.channels__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.channels__bar-spacer {
  flex: 1;
}

/* 07 §2.8：列标题（含「密钥 可用 / 总」）不从中间断行 */
:deep(.channels__th) {
  white-space: nowrap;
}

.channels__empty {
  color: var(--c-text-3);
  font-size: var(--fs-13);
}

.channels__hint {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.channels__table {
  padding: var(--space-2) var(--space-3);
}

.channels__error {
  color: var(--c-danger-ink);
  font-size: var(--fs-13);
}

.channels__test-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.channels__test-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-13);
}

.channels__test-error {
  color: var(--c-danger-ink);
  font-size: var(--fs-12);
}

:deep(.channels__cell) {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
}

:deep(.channels__name) {
  /* 07 §2.8：渠道名是标识符，单行（放不下就省略，完整名在 title 里），备注照旧换行 */
  overflow: hidden;
  color: var(--c-text);
  font-weight: var(--fw-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.channels__note) {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

:deep(.channels__url) {
  color: var(--c-text-2);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
}

:deep(.channels__slug) {
  overflow: hidden;
  color: var(--c-text);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.channels__apis) {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

:deep(.channels__actions) {
  display: flex;
  gap: 4px;
}
</style>
