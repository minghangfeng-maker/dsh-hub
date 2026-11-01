<script setup lang="ts">
import type { DeliveryCreatedResponse, DeliveryPreviewResponse } from '@dsh-hub/shared'
import { NAlert, NButton, NDataTable, type DataTableColumns } from 'naive-ui'
import { computed, h } from 'vue'
import { RouterLink } from 'vue-router'

import MiniTag from '@/components/admin/MiniTag.vue'
import EmptyState from '@/components/base/EmptyState.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import {
  DELIVERY_PLATFORM_TEXT,
  groupPreviewRows,
  previewSummaryText,
  type DeliveryDraft,
} from '@/composables/delivery-draft'

/**
 * 向导第 4 步：**预览与确认**（docs/21 §1 ①）。
 *
 * - 按平台分组：实例按用户一行，桌面按设备一行；跳过的行灰显并给原因；
 * - 顶部一句摘要 + 警告（NAlert）+ 截断提示；
 * - 提交后这里换成交付结果：实例侧每个内容项一个任务链接、桌面侧新清单版本。
 */
const props = defineProps<{
  draft: DeliveryDraft
  preview: DeliveryPreviewResponse | null
  previewing: boolean
  previewError: string
  submitting: boolean
  created: DeliveryCreatedResponse | null
  actionText: string
  targetText: string
  /** 预览里至少有一行会执行（全是跳过时不能提交：后端会 400，什么都不会发生） */
  runnable: boolean
}>()

const emit = defineEmits<{ refresh: []; submit: []; reset: [] }>()

type Row = DeliveryPreviewResponse['rows'][number]

const groups = computed(() => groupPreviewRows(props.preview?.rows ?? []))

const summaryText = computed(() =>
  props.preview ? previewSummaryText(props.preview.summary, props.draft.platforms) : '',
)

/**
 * 预览阶段的「整项跳过」（契约 d12d925：`DeliveryPreviewResponse.skippedItems`）：
 * 提交后会跳过的内容项在**预览**就要看到，样式与文案跟提交结果的「整项跳过」一致。
 */
const previewSkipped = computed(() => props.preview?.skippedItems ?? [])

const showInstance = computed(() => props.draft.platforms.includes('instance'))
const showDesktop = computed(() => props.draft.platforms.includes('desktop'))

const arrow = (): ReturnType<typeof h> =>
  h('span', { class: 'i-ph-arrow-right preview__arrow', 'aria-hidden': 'true' })

const instanceColumns: DataTableColumns<Row> = [
  { title: '用户', key: 'username', width: 170, ellipsis: { tooltip: true } },
  { title: '内容项', key: 'itemLabel', minWidth: 170, ellipsis: { tooltip: true } },
  { title: '当前', key: 'current', minWidth: 120, ellipsis: { tooltip: true } },
  { title: '', key: 'arrow', width: 32, render: arrow },
  { title: '之后', key: 'after', minWidth: 120, ellipsis: { tooltip: true } },
  {
    title: '重启',
    key: 'needsRestart',
    width: 92,
    render: (row) =>
      h(MiniTag, {
        text: row.needsRestart ? '会重启' : '不需要',
        tone: row.needsRestart ? 'butter' : 'neutral',
        size: 'sm',
      }),
  },
  {
    title: '跳过原因',
    key: 'skipReason',
    minWidth: 120,
    render: (row) => (row.skipReason === null ? '' : row.skipReason),
  },
]

const desktopColumns: DataTableColumns<Row> = [
  { title: '设备', key: 'deviceName', minWidth: 190, ellipsis: { tooltip: true } },
  { title: '用户', key: 'username', width: 150, ellipsis: { tooltip: true } },
  { title: '内容项', key: 'itemLabel', minWidth: 170, ellipsis: { tooltip: true } },
  { title: '当前', key: 'current', minWidth: 110, ellipsis: { tooltip: true } },
  { title: '', key: 'arrow', width: 32, render: arrow },
  { title: '之后', key: 'after', minWidth: 150, ellipsis: { tooltip: true } },
  {
    title: '重启桌面端',
    key: 'needsRestart',
    width: 110,
    render: (row) =>
      h(MiniTag, {
        text: row.needsRestart ? '需要' : '不需要',
        tone: row.needsRestart ? 'butter' : 'neutral',
        size: 'sm',
      }),
  },
  {
    title: '跳过原因',
    key: 'skipReason',
    minWidth: 120,
    render: (row) => (row.skipReason === null ? '' : row.skipReason),
  },
]

function rowClass(row: Row): string {
  return row.skipReason === null ? '' : 'preview__row--skipped'
}
</script>

<template>
  <!-- 提交成功：换成结果，不再显示预览表 -->
  <SoftCard v-if="props.created" title="已提交">
    <div class="preview__result" data-testid="delivery-result">
      <div v-if="props.created.jobs.length > 0" class="preview__jobs">
        <span class="preview__label">实例任务</span>
        <ul class="preview__job-list">
          <li v-for="job in props.created.jobs" :key="job.jobId">
            <RouterLink class="hub-link" :to="`/admin/jobs/${job.jobId}`">
              #{{ job.jobId }} {{ job.itemLabel }}
            </RouterLink>
          </li>
        </ul>
      </div>

      <div v-if="props.created.desktop" class="preview__revision" data-testid="delivery-revision">
        <span class="preview__label">桌面清单版本</span>
        <MiniTag :text="`revision ${props.created.desktop.revision}`" tone="primary" />
        <span class="preview__value">
          {{ props.created.desktop.devices }} 台设备 · {{ props.created.desktop.users }} 人
        </span>
      </div>

      <div v-if="props.created.skippedItems.length > 0" class="preview__skipped" data-testid="delivery-skipped">
        <span class="preview__label">整项跳过</span>
        <ul class="preview__job-list">
          <li v-for="item in props.created.skippedItems" :key="`${item.platform}-${item.itemLabel}`">
            {{ DELIVERY_PLATFORM_TEXT[item.platform] }} · {{ item.itemLabel }}：{{ item.reason }}
          </li>
        </ul>
      </div>
    </div>

    <template #footer>
      <div class="preview__footer">
        <NButton size="small" data-testid="delivery-again" @click="emit('reset')">再下发一次</NButton>
        <RouterLink to="/admin/jobs">
          <NButton size="small" type="primary" data-testid="delivery-to-jobs">去任务中心</NButton>
        </RouterLink>
      </div>
    </template>
  </SoftCard>

  <template v-else>
    <SoftCard title="预览">
      <template #extra>
        <NButton size="tiny" :loading="props.previewing" data-testid="delivery-refresh" @click="emit('refresh')">
          重新预览
        </NButton>
      </template>

      <div class="preview__head">
        <span class="preview__label">动作</span>
        <span class="preview__value">{{ props.actionText }}</span>
        <span class="preview__label">目标</span>
        <span class="preview__value">{{ props.targetText }}</span>
      </div>

      <p v-if="summaryText" class="preview__summary" data-testid="delivery-summary">{{ summaryText }}</p>

      <NAlert v-if="props.previewError" type="error" :bordered="false" class="preview__alert">
        {{ props.previewError }}
      </NAlert>

      <template v-if="props.preview">
        <NAlert
          v-if="!props.runnable"
          type="warning"
          :bordered="false"
          class="preview__alert"
          data-testid="delivery-nothing-to-run"
        >
          每一行都会被跳过，这次没有需要执行的行（不能提交；换一个版本或目标再预览）。
        </NAlert>
        <NAlert v-if="props.preview.warnings.length > 0" type="warning" :bordered="false" class="preview__alert">
          <ul class="preview__warnings" data-testid="delivery-warnings">
            <li v-for="warning in props.preview.warnings" :key="warning">{{ warning }}</li>
          </ul>
        </NAlert>
        <NAlert v-if="props.preview.truncated" type="info" :bordered="false" class="preview__alert" data-testid="delivery-truncated">
          预览只显示前 2000 行，执行仍按完整清单。
        </NAlert>

        <div
          v-if="previewSkipped.length > 0"
          class="preview__skipped"
          data-testid="delivery-preview-skipped"
        >
          <span class="preview__label">整项跳过</span>
          <ul class="preview__job-list">
            <li v-for="item in previewSkipped" :key="`${item.platform}-${item.itemLabel}`">
              {{ DELIVERY_PLATFORM_TEXT[item.platform] }} · {{ item.itemLabel }}：{{ item.reason }}
            </li>
          </ul>
        </div>
      </template>
    </SoftCard>

    <SoftCard v-if="showInstance" title="实例" :padded="false">
      <template #extra>
        <span class="preview__count">{{ groups.instance.length }} 行</span>
      </template>
      <NDataTable
        class="preview__table"
        :columns="instanceColumns"
        :data="groups.instance"
        :loading="props.previewing"
        :row-key="(row: Row) => `${String(row.userId)}-${row.itemLabel}`"
        :row-class-name="rowClass"
        :pagination="{ pageSize: 10 }"
        :scroll-x="920"
        size="small"
        data-testid="delivery-instance-table"
      >
        <template #empty>
          <EmptyState title="实例侧没有要执行的行" illustration="plane" :size="80" />
        </template>
      </NDataTable>
    </SoftCard>

    <SoftCard v-if="showDesktop" title="桌面端" :padded="false">
      <template #extra>
        <span class="preview__count">{{ groups.desktop.length }} 行</span>
      </template>
      <NDataTable
        class="preview__table"
        :columns="desktopColumns"
        :data="groups.desktop"
        :loading="props.previewing"
        :row-key="(row: Row) => `${row.deviceId ?? 'none'}-${row.itemLabel}`"
        :row-class-name="rowClass"
        :pagination="{ pageSize: 10 }"
        :scroll-x="1060"
        size="small"
        data-testid="delivery-desktop-table"
      >
        <template #empty>
          <EmptyState title="桌面端没有要执行的行" illustration="plane" :size="80" />
        </template>
      </NDataTable>
    </SoftCard>
  </template>
</template>

<style scoped>
.preview__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.preview__label {
  color: var(--c-text-3);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.preview__value {
  /* 14px：这是「动作 + 内容项」的数据行，不是说明小字（07 §2.7） */
  color: var(--c-text);
  font-size: var(--fs-14);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}

.preview__summary {
  /* 摘要里的数字是数据本身（07 §2.7 保留），用正文号 */
  margin-top: var(--space-2);
  color: var(--c-text);
  font-size: var(--fs-14);
}

.preview__alert {
  margin-top: var(--space-3);
  border-radius: var(--radius-control);
}

.preview__warnings {
  margin: 0;
  padding-left: var(--space-4);
}

.preview__count {
  color: var(--c-text-2);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.preview__table {
  border-radius: 0 0 var(--radius-card) var(--radius-card);
}

.preview__table :deep(.preview__row--skipped) {
  color: var(--c-text-3);
  opacity: 0.62;
}

.preview__arrow {
  color: var(--c-text-3);
}

.preview__result {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.preview__jobs,
.preview__revision,
.preview__skipped {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.preview__job-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
  /* 跳过项 / 任务链接是**数据行**，用正文字号；13px 会被 audit-ui 当成「常驻小字」（07 §2.7） */
  font-size: var(--fs-14);
}

.preview__footer {
  display: flex;
  gap: var(--space-2);
  justify-content: flex-end;
}
</style>
