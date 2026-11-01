<script setup lang="ts">
import type { UserPluginRow } from '@dsh-hub/shared'
import { NButton, NDataTable, useMessage, type DataTableColumns } from 'naive-ui'
import { computed, h, ref } from 'vue'
import { useRouter } from 'vue-router'

import { createRollout } from '@/api/admin-rollouts'
import { describeError } from '@/api/errors'
import MiniTag from '@/components/admin/MiniTag.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { formatDateTime } from '@/composables/useFormat'
import { USER_PLUGIN_STATE_TEXT } from '@/composables/useInstanceStatus'
import { isReauthCanceled, sensitive } from '@/composables/useReauth'

/**
 * 用户详情 · 插件（07 §7.3）：该用户的插件表（期望/实际/状态/错误），可单独安装 / 卸载。
 * 单个用户的安装卸载走下发任务引擎（06 §5），完成后跳任务详情看进度。
 */
const props = defineProps<{
  userId: number
  username: string
  /** 04 §10.2：行里直接带 packageName/displayName */
  rows: UserPluginRow[]
}>()

const emit = defineEmits<{ changed: [] }>()

const message = useMessage()
const router = useRouter()
const busy = ref(false)

function nameOf(row: UserPluginRow): { display: string; pkg: string } {
  return { display: row.displayName || `插件 #${row.pluginId}`, pkg: row.packageName }
}

function stateTone(state: string): 'success' | 'butter' | 'danger' | 'neutral' {
  if (state === 'synced') return 'success'
  if (state === 'pending') return 'butter'
  if (state === 'failed') return 'danger'
  return 'neutral'
}

const columns = computed<DataTableColumns<UserPluginRow>>(() => [
  {
    title: '插件',
    key: 'plugin',
    width: 220,
    render: (row) => {
      const info = nameOf(row)
      return h('div', { class: 'user-plugins__name' }, [
        h('span', { class: 'user-plugins__display' }, info.display),
        // 包名是标识符：单行 + 省略，完整值在 title 里（07 §2.8）
        h('span', { class: 'user-plugins__pkg', title: info.pkg }, info.pkg),
      ])
    },
  },
  {
    title: '期望',
    key: 'desired',
    width: 90,
    render: (row) =>
      h(MiniTag, {
        text: row.desired === 'installed' ? '安装' : '不安装',
        tone: row.desired === 'installed' ? 'primary' : 'neutral',
        size: 'sm',
      }),
  },
  {
    title: '实际版本',
    key: 'actualVersion',
    width: 110,
    render: (row) => row.actualVersion ?? '—',
  },
  {
    title: '状态',
    key: 'state',
    width: 100,
    render: (row) =>
      h(MiniTag, {
        text: USER_PLUGIN_STATE_TEXT[row.state] ?? row.state,
        tone: stateTone(row.state),
        size: 'sm',
      }),
  },
  {
    title: '来源',
    key: 'source',
    width: 90,
    render: (row) => (row.source === 'admin' ? '管理员' : row.source === 'user' ? '用户自装' : '策略'),
  },
  {
    title: '错误',
    key: 'error',
    minWidth: 160,
    ellipsis: { tooltip: true },
    render: (row) => row.error ?? '—',
  },
  {
    title: '更新时间',
    key: 'updatedAt',
    width: 150,
    render: (row) => formatDateTime(row.updatedAt),
  },
  {
    title: '操作',
    key: 'actions',
    width: 110,
    fixed: 'right',
    render: (row) =>
      h(
        NButton,
        {
          size: 'tiny',
          type: row.desired === 'installed' ? 'default' : 'primary',
          loading: busy.value,
          onClick: () => void toggle(row),
        },
        { default: () => (row.desired === 'installed' ? '卸载' : '安装') },
      ),
  },
])

/**
 * 为单个用户安装 / 卸载（06 §5）。
 *
 * 不传 `versionId`：由服务端按插件目录的最新版本解析（04 §4.8 里它是可选的）；
 * 「必装插件不能卸载」这类策略判断也交给服务端（前端拿不到 policy，且不应重复实现规则）。
 */
async function toggle(row: UserPluginRow): Promise<void> {
  const install = row.desired !== 'installed'
  busy.value = true
  try {
    const created = await sensitive(
      () =>
        createRollout({
          kind: 'plugin',
          action: install ? 'install' : 'uninstall',
          pluginId: row.pluginId,
          targets: { userIds: [props.userId] },
          strategy: { concurrency: 1, canary: 0, maxFailureRatio: 0, restart: 'now' },
        }),
      {
        title: install ? '为单个用户安装插件' : '为单个用户卸载插件',
        description: `目标：${props.username} · ${row.displayName || `插件 #${row.pluginId}`}`,
        confirmText: install ? '安装' : '卸载',
        type: install ? 'primary' : 'warning',
      },
    )
    message.success('已创建任务，正在跳转到任务详情')
    emit('changed')
    await router.push(`/admin/jobs/${created.jobId}`)
  } catch (error) {
    if (!isReauthCanceled(error)) message.error(describeError(error).message)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <SoftCard title="该用户的插件" :padded="false">
    <template #extra>
      <span class="text-3 text-[12px]">共 {{ rows.length }} 项</span>
    </template>

    <NDataTable
      class="user-plugins__table"
      :columns="columns"
      :data="rows"
      :row-key="(row: UserPluginRow) => `${row.pluginId}`"
      :scroll-x="960"
      size="small"
      :pagination="false"
    />
  </SoftCard>
</template>

<style scoped>
.user-plugins__table {
  padding: var(--space-2) var(--space-3);
}

:deep(.user-plugins__name) {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
}

:deep(.user-plugins__display) {
  color: var(--c-text);
  font-weight: var(--fw-semibold);
}

:deep(.user-plugins__pkg) {
  overflow: hidden;
  color: var(--c-text-3);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
