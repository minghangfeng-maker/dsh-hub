<script setup lang="ts">
import type { TestToolChannelResponse, ToolChannel, ToolChannelHealth } from '@dsh-hub/shared'
import { NButton, NDataTable, NModal, NSwitch, useMessage, type DataTableColumns } from 'naive-ui'
import { computed, h, ref } from 'vue'

import { deleteToolChannel, listToolChannels, testToolChannel, updateToolChannel } from '@/api/tools'
import { describeError } from '@/api/errors'
import MiniTag from '@/components/admin/MiniTag.vue'
import type { AdminTone } from '@/components/admin/tone'
import SoftCard from '@/components/base/SoftCard.vue'
import ToolChannelDrawer from '@/components/admin/search/ToolChannelDrawer.vue'
import { useAsyncData } from '@/composables/useAsyncData'
import { isReauthCanceled, sensitive } from '@/composables/useReauth'
import { countToolKeys, toolChannelKindText } from '@/utils/tool-keys'

/**
 * 中转站 · 搜索池 · 渠道（14 §3.2 §7）：列表（类型、名称、优先级/权重、健康、密钥统计、启用开关）
 * + 新建/编辑抽屉 + 「测试」（显示耗时与结果数/错误）+ 删除。
 */
const message = useMessage()

const { data, loading, error, reload } = useAsyncData(() => listToolChannels())
const channels = computed<ToolChannel[]>(() => data.value ?? [])

const showDrawer = ref(false)
const editing = ref<ToolChannel | null>(null)

const testResult = ref<{ channelName: string; result: TestToolChannelResponse } | null>(null)

const HEALTH_TEXT: Record<ToolChannelHealth, string> = {
  ok: '正常',
  cooling: '冷却中',
  'no-key': '没有可用密钥',
  disabled: '已停用',
}

const HEALTH_TONE: Record<ToolChannelHealth, AdminTone> = {
  ok: 'success',
  cooling: 'butter',
  'no-key': 'danger',
  disabled: 'neutral',
}

function reloadAll(): void {
  void reload()
}

function openCreate(): void {
  editing.value = null
  showDrawer.value = true
}

function openEdit(channel: ToolChannel): void {
  editing.value = channel
  showDrawer.value = true
}

async function toggleEnabled(channel: ToolChannel, enabled: boolean): Promise<void> {
  try {
    await updateToolChannel(channel.id, { enabled })
    message.success(enabled ? `已启用渠道 ${channel.name}` : `已停用渠道 ${channel.name}`)
    reloadAll()
  } catch (cause) {
    message.error(describeError(cause).message)
    reloadAll()
  }
}

async function runTest(channel: ToolChannel): Promise<void> {
  try {
    const result = await testToolChannel(channel.id)
    testResult.value = { channelName: channel.name, result }
    if (!result.ok) message.warning('测试没通过，看看弹窗里的原因')
  } catch (cause) {
    message.error(describeError(cause).message)
  }
}

async function removeChannel(channel: ToolChannel): Promise<void> {
  try {
    await sensitive(() => deleteToolChannel(channel.id), {
      title: `删除渠道 ${channel.name}`,
      description: '删掉后这把池子上的密钥也一起消失，用户会换到其它候选。',
      confirmText: '删除',
      type: 'error',
    })
    message.success('渠道已删除')
    reloadAll()
  } catch (cause) {
    if (isReauthCanceled(cause)) return
    message.error(describeError(cause).message)
  }
}

const columns = computed<DataTableColumns<ToolChannel>>(() => [
  {
    title: '类型',
    key: 'kind',
    width: 100,
    render: (row) =>
      h(MiniTag, {
        text: toolChannelKindText(row.kind),
        tone: row.kind === 'tavily' ? 'sky' : 'primary',
        size: 'sm',
      }),
  },
  {
    title: '渠道',
    key: 'name',
    minWidth: 170,
    render: (row) =>
      h('div', { class: 'tools-channels__cell' }, [
        h('span', { class: 'tools-channels__name', title: row.name }, row.name),
        row.note ? h('span', { class: 'tools-channels__note' }, row.note) : null,
      ]),
  },
  { title: '优先级', key: 'priority', width: 80, align: 'right' },
  { title: '权重', key: 'weight', width: 70, align: 'right' },
  {
    title: '健康',
    key: 'health',
    width: 110,
    render: (row) =>
      h(MiniTag, { text: HEALTH_TEXT[row.health], tone: HEALTH_TONE[row.health], size: 'sm' }),
  },
  {
    title: '密钥（可用 / 冷却 / 额度用完 / 停用）',
    key: 'keys',
    width: 240,
    render: (row) => {
      const counts = countToolKeys(row.keys)
      return `${counts.active} / ${counts.cooling} / ${counts.exhausted} / ${counts.disabled}`
    },
  },
  {
    title: '启用',
    key: 'enabled',
    width: 64,
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
    width: 170,
    fixed: 'right',
    render: (row) =>
      h('div', { class: 'tools-channels__actions' }, [
        h(NButton, { size: 'tiny', onClick: () => openEdit(row) }, { default: () => '编辑' }),
        h(NButton, { size: 'tiny', quaternary: true, onClick: () => void runTest(row) }, { default: () => '测试' }),
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
  <div class="tools-channels">
    <div class="tools-channels__bar">
      <span class="tools-channels__bar-spacer" />
      <NButton size="small" :loading="loading" @click="reloadAll">
        <template #icon><span class="i-ph-arrows-clockwise" aria-hidden="true" /></template>
        刷新
      </NButton>
      <NButton size="small" type="primary" data-testid="add-tool-channel" @click="openCreate">
        <template #icon><span class="i-ph-plus" aria-hidden="true" /></template>
        添加渠道
      </NButton>
    </div>

    <SoftCard :padded="false">
      <NDataTable
        class="tools-channels__table"
        :columns="columns"
        :data="channels"
        :loading="loading"
        :row-key="(row: ToolChannel) => row.id"
        :scroll-x="1080"
        :pagination="false"
        size="small"
      />
    </SoftCard>

    <p v-if="error" class="tools-channels__error">{{ error.message }}</p>

    <ToolChannelDrawer v-model:show="showDrawer" :channel="editing" @saved="reloadAll" />

    <NModal
      :show="testResult !== null"
      preset="card"
      :title="`渠道测试 · ${testResult?.channelName ?? ''}`"
      :style="{ width: 'calc(100vw - 24px)', maxWidth: '520px' }"
      @update:show="(value: boolean) => (testResult = value ? testResult : null)"
    >
      <div class="tools-channels__test">
        <MiniTag
          :text="testResult?.result.ok ? '连通' : '失败'"
          :tone="testResult?.result.ok ? 'success' : 'danger'"
          size="sm"
        />
        <span>耗时 {{ testResult?.result.durationMs ?? 0 }} ms</span>
        <span>结果 {{ testResult?.result.results ?? '—' }} 条</span>
      </div>
      <p v-if="testResult?.result.error" class="tools-channels__error">{{ testResult.result.error }}</p>
    </NModal>
  </div>
</template>

<style scoped>
.tools-channels {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.tools-channels__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.tools-channels__bar-spacer {
  flex: 1;
}

.tools-channels__table {
  padding: var(--space-2) var(--space-3);
}

.tools-channels__error {
  color: var(--c-danger-ink);
  font-size: var(--fs-13);
}

.tools-channels__test {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--fs-13);
}

:deep(.tools-channels__cell) {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
}

:deep(.tools-channels__name) {
  overflow: hidden;
  color: var(--c-text);
  font-weight: var(--fw-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.tools-channels__note) {
  overflow: hidden;
  color: var(--c-text-3);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.tools-channels__actions) {
  display: flex;
  gap: 4px;
}
</style>
