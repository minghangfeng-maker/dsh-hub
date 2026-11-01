<script setup lang="ts">
import type { DesktopDeliveryState, DesktopPolicyOverride, DesktopRelease, DesktopUpdateFloor } from '@dsh-hub/shared'
import { NButton, NDataTable, type DataTableColumns } from 'naive-ui'
import { computed, h, ref } from 'vue'

import { getDesktopUpdateFloor, listDesktopReleases } from '@/api/admin-desktop'
import DesktopChannelPolicyForm from '@/components/admin/desktop/DesktopChannelPolicyForm.vue'
import DesktopFloorPanel from '@/components/admin/desktop/DesktopFloorPanel.vue'
import DesktopOverrideDialog from '@/components/admin/desktop/DesktopOverrideDialog.vue'
import DesktopReleasePanel from '@/components/admin/desktop/DesktopReleasePanel.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import EmptyState from '@/components/base/EmptyState.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { useAsyncData } from '@/composables/useAsyncData'
import { channelLabel, scopeText } from '@/utils/desktop-delivery'

/**
 * 桌面端 · 版本与升级（WP25d 交付物 4）。
 *
 * 四块：每个渠道一行的策略（目标 / 最低 / 硬地板 / 灰度）、按角色和用户的覆盖、
 * 安装包发布与回滚、全局强更地板与弹窗文案预览。
 */
const props = defineProps<{ state: DesktopDeliveryState | null }>()

const emit = defineEmits<{ changed: [] }>()

const { data: releaseResponse, loading: releasesLoading, reload: reloadReleases } = useAsyncData(() =>
  listDesktopReleases(),
)

const { data: floorResponse, reload: reloadFloor } = useAsyncData(() => getDesktopUpdateFloor())

const releases = computed<DesktopRelease[]>(() => releaseResponse.value?.items ?? [])
const floor = computed<DesktopUpdateFloor | null>(() => floorResponse.value?.floor ?? null)

const channels = computed(() => props.state?.app.channels ?? [])
const overrides = computed(() => props.state?.app.overrides ?? [])

function policyOf(channel: 'nightly' | 'latest') {
  return channels.value.find((item) => item.channel === channel) ?? null
}

function overridesOf(channel: 'nightly' | 'latest'): number {
  return overrides.value.filter((item) => item.channel === channel).length
}

// ── 覆盖：新建 / 编辑 ───────────────────────────────────────────────────────

const showOverride = ref(false)
const editingOverride = ref<DesktopPolicyOverride | null>(null)

function openCreate(channel: 'nightly' | 'latest'): void {
  editingOverride.value = null
  defaultChannel.value = channel
  showOverride.value = true
}

function openEdit(row: DesktopPolicyOverride): void {
  editingOverride.value = row
  defaultChannel.value = row.channel
  showOverride.value = true
}

const defaultChannel = ref<'nightly' | 'latest'>('latest')

function reloadAll(): void {
  emit('changed')
  void reloadReleases()
  void reloadFloor()
}

/** 子面板自己改完数据：刷新它自己的那份，同时让页面级数据（期望状态 / 设备 / 发布日志）跟上 */
function onChildChanged(): void {
  void reloadReleases()
  void reloadFloor()
  emit('changed')
}

const overrideColumns = computed<DataTableColumns<DesktopPolicyOverride>>(() => [
  {
    title: '渠道',
    key: 'channel',
    width: 80,
    render: (row) => h(MiniTag, { text: channelLabel(row.channel), tone: row.channel === 'latest' ? 'success' : 'sky', size: 'sm' }),
  },
  {
    title: '目标',
    key: 'scope',
    minWidth: 120,
    render: (row) => h('span', { class: 'override-scope' }, scopeText(row)),
  },
  {
    title: '目标版本',
    key: 'targetVersion',
    width: 120,
    render: (row) => h('span', { class: 'override-mono' }, row.targetVersion ?? '渠道级'),
  },
  {
    title: '最低版本',
    key: 'minVersion',
    width: 120,
    render: (row) => h('span', { class: 'override-mono' }, row.minVersion ?? '渠道级'),
  },
  {
    title: '硬地板',
    key: 'minVersionHard',
    width: 90,
    render: (row) =>
      row.minVersionHard === null
        ? h('span', { class: 'override-mono' }, '渠道级')
        : h(MiniTag, {
            text: row.minVersionHard ? '硬' : '软',
            tone: row.minVersionHard ? 'danger' : 'neutral',
            size: 'sm',
          }),
  },
  {
    title: '灰度',
    key: 'rolloutPercent',
    width: 80,
    render: (row) =>
      h('span', { class: 'override-mono' }, row.rolloutPercent === null ? '渠道级' : `${String(row.rolloutPercent)}%`),
  },
  {
    title: '',
    key: 'actions',
    width: 80,
    render: (row) =>
      h(
        NButton,
        {
          size: 'tiny',
          quaternary: true,
          'data-testid': `desk-override-edit-${row.channel}-${row.scope}-${String(row.userId ?? row.role ?? '')}`,
          onClick: () => openEdit(row),
        },
        { default: () => '编辑' },
      ),
  },
])

function overrideKey(row: DesktopPolicyOverride, index: number): string {
  return `${row.channel}-${row.scope}-${row.userId ?? row.role ?? ''}-${String(index)}`
}
</script>

<template>
  <div class="desk-versions">
    <div class="desk-versions__channels">
      <DesktopChannelPolicyForm
        channel="latest"
        :policy="policyOf('latest')"
        :override-count="overridesOf('latest')"
        @changed="reloadAll"
      />
      <DesktopChannelPolicyForm
        channel="nightly"
        :policy="policyOf('nightly')"
        :override-count="overridesOf('nightly')"
        @changed="reloadAll"
      />
    </div>

    <SoftCard title="按角色 / 用户覆盖" :padded="false">
      <template #extra>
        <div class="desk-versions__override-actions">
          <NButton size="tiny" data-testid="desk-override-create-latest" @click="openCreate('latest')">
            新增稳定渠道覆盖
          </NButton>
          <NButton size="tiny" data-testid="desk-override-create-nightly" @click="openCreate('nightly')">
            新增测试渠道覆盖
          </NButton>
        </div>
      </template>

      <NDataTable
        :columns="overrideColumns"
        :data="overrides"
        :row-key="(row: DesktopPolicyOverride) => overrideKey(row, overrides.indexOf(row))"
        :pagination="false"
        :scroll-x="760"
        size="small"
        data-testid="desk-overrides-table"
      >
        <template #empty>
          <EmptyState title="还没有覆盖" illustration="leaf" :size="96" />
        </template>
      </NDataTable>
    </SoftCard>

    <DesktopReleasePanel :releases="releases" :loading="releasesLoading" @changed="onChildChanged" />

    <DesktopFloorPanel :floor="floor" @changed="onChildChanged" />

    <DesktopOverrideDialog
      v-model:show="showOverride"
      :editing="editingOverride"
      :default-channel="defaultChannel"
      @saved="reloadAll"
    />
  </div>
</template>

<style scoped>
.desk-versions {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.desk-versions__channels {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: var(--space-4);
}

.desk-versions__override-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.override-scope {
  white-space: nowrap;
}

.override-mono {
  font-family: var(--font-mono);
  white-space: nowrap;
}
</style>
