<script setup lang="ts">
import type { ExportEstimateResponse, ExportFormat, ExportItem, ExportPart } from '@dsh-hub/shared'
import { EXPORT_PARTS } from '@dsh-hub/shared'
import { useIntervalFn } from '@vueuse/core'
import { NButton, NCheckbox, NPopconfirm, NRadio, NRadioGroup, useMessage } from 'naive-ui'
import { computed, onMounted, ref } from 'vue'

import { describeError } from '@/api/errors'
import { createExport, estimateExport, exportDownloadUrl, listExports, removeExport } from '@/api/exports'
import SoftCard from '@/components/base/SoftCard.vue'
import ExportProgressCard from '@/components/user/ExportProgressCard.vue'
import {
  EXPORT_FORMAT_META,
  EXPORT_PART_META,
  describeExportParts,
  exportStatusMeta,
} from '@/composables/useExportStatus'
import { formatBytes, formatDateTime, formatDuration } from '@/composables/useFormat'

/**
 * 工作台「我的数据」（16 §7）：放进 `SoftCard`，头部右侧是最近一次可下载的导出；内容是
 * 四个横排勾选块 → 一行操作（格式 / 预计大小 / 开始打包）→ 嵌入式进度 → 紧凑历史表
 * （默认最近 3 条，可展开全部）。手机单列、按钮占满整行。
 *
 * 进度复用 `ExportProgressCard` 的 SSE / 完成态逻辑，只把外层卡片样式换成嵌入卡片里的进度条。
 */
const message = useMessage()

const selected = ref<ExportPart[]>(['workspace', 'sessions'])
const format = ref<ExportFormat>('zip')
const estimate = ref<ExportEstimateResponse | null>(null)
const estimating = ref(false)
const estimateError = ref<string | null>(null)

const items = ref<ExportItem[]>([])
const loading = ref(true)
const listError = ref<string | null>(null)
const creating = ref(false)
const activeId = ref<number | null>(null)
const showAll = ref(false)

const now = ref(Date.now())
useIntervalFn(() => {
  now.value = Date.now()
}, 30_000)

const activeItem = computed(() => items.value.find((item) => item.id === activeId.value) ?? null)

/** 头部「上次导出」：最近一份已完成且还能下载的导出 */
const lastExport = computed(
  () => items.value.find((item) => item.status === 'ready' && item.expiresAt) ?? null,
)

const visibleItems = computed(() => (showAll.value ? items.value : items.value.slice(0, 3)))
const canExpand = computed(() => items.value.length > 3)

const totalBytes = computed(() => {
  if (!estimate.value) return null
  return selected.value.reduce((sum, part) => sum + (estimate.value?.parts[part]?.bytes ?? 0), 0)
})

const canSubmit = computed(() => selected.value.length > 0 && !creating.value)

function togglePart(part: ExportPart, checked: boolean): void {
  const next = new Set(selected.value)
  if (checked) next.add(part)
  else next.delete(part)
  // 保持 04 §3.3 的枚举顺序，提交时更好读
  selected.value = EXPORT_PARTS.filter((item) => next.has(item))
}

/**
 * 估算**全部分区**（每个勾选块都要显示大小），总大小只累加勾选项；
 * 服务端对估算有 60 秒缓存（04 §3.3），多勾几次不会真的反复 du。
 */
async function loadEstimate(): Promise<void> {
  estimating.value = true
  try {
    estimate.value = await estimateExport(EXPORT_PARTS)
    estimateError.value = null
  } catch (error) {
    estimateError.value = describeError(error).message
  } finally {
    estimating.value = false
  }
}

async function loadList(): Promise<void> {
  loading.value = true
  try {
    const response = await listExports()
    items.value = response.items
    listError.value = null
    // 刷新/换设备回到这个页面时，进行中的导出也要继续显示进度（SSE 会接着推）
    if (activeId.value === null) {
      const running = response.items.find((item) => item.status === 'running' || item.status === 'queued')
      if (running) activeId.value = running.id
    }
  } catch (error) {
    listError.value = describeError(error).message
  } finally {
    loading.value = false
  }
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return
  creating.value = true
  try {
    const response = await createExport({ parts: selected.value, format: format.value })
    items.value = [response.export, ...items.value]
    activeId.value = response.export.id
    message.success('开始打包了，完成后会出现在下面')
  } catch (error) {
    message.error(describeError(error).message)
  } finally {
    creating.value = false
  }
}

function onProgressDone(updated: ExportItem): void {
  items.value = items.value.map((item) => (item.id === updated.id ? updated : item))
  message.success('打包完成，可以下载了')
}

async function remove(id: number): Promise<void> {
  try {
    await removeExport(id)
    items.value = items.value.filter((item) => item.id !== id)
    if (activeId.value === id) activeId.value = null
    message.success('已删除')
  } catch (error) {
    message.error(describeError(error).message)
  }
}

/** 历史行的过期倒计时（仅 ready 且未过期时有用） */
function expiryText(item: ExportItem): string {
  if (item.status !== 'ready' || !item.expiresAt) return '—'
  const ms = Date.parse(item.expiresAt) - now.value
  if (Number.isNaN(ms)) return '—'
  return ms <= 0 ? '已过期' : `${formatDuration(ms)}后过期`
}

function formatSize(item: ExportItem): string {
  return item.sizeBytes ? formatBytes(item.sizeBytes) : '—'
}

onMounted(() => {
  void loadEstimate()
  void loadList()
})
</script>

<template>
  <SoftCard title="我的数据">
    <template #extra>
      <span v-if="lastExport" class="data__last" data-testid="last-export">
        上次导出：{{ formatDateTime(lastExport.createdAt) }} · {{ formatSize(lastExport) }} ·
        <a class="hub-link" :href="exportDownloadUrl(lastExport.id)">下载</a>
      </span>
    </template>

    <!-- 打包内容：四个横排的可勾选块（桌面一行四个，手机两列） -->
    <div class="export-builder" data-testid="export-builder">
      <p class="data__section">打包内容</p>
      <ul class="export-builder__parts">
        <li
          v-for="part in EXPORT_PARTS"
          :key="part"
          class="export-builder__part"
          :data-testid="`export-part-${part}`"
        >
          <NCheckbox
            :checked="selected.includes(part)"
            :label="EXPORT_PART_META[part].label"
            @update:checked="(checked: boolean) => togglePart(part, checked)"
          />
          <span class="export-builder__size">
            <template v-if="estimate?.parts[part]">
              {{ formatBytes(estimate.parts[part]?.bytes) }} · {{ estimate.parts[part]?.files }} 个文件
            </template>
            <template v-else>—</template>
          </span>
        </li>
      </ul>

      <!-- 一行操作：格式 / 预计大小 / 开始打包 -->
      <div class="export-builder__actions">
        <NRadioGroup v-model:value="format" size="small" data-testid="export-format">
          <NRadio value="zip">{{ EXPORT_FORMAT_META.zip.label }}</NRadio>
          <NRadio value="tar.gz">{{ EXPORT_FORMAT_META['tar.gz'].label }}</NRadio>
        </NRadioGroup>
        <span class="export-builder__total" data-testid="export-total">
          预计大小
          <strong>{{ estimating ? '估算中…' : totalBytes !== null ? formatBytes(totalBytes) : '—' }}</strong>
        </span>
        <span class="export-builder__spacer" />
        <NButton
          type="primary"
          size="small"
          class="export-builder__submit"
          :disabled="!canSubmit"
          :loading="creating"
          data-testid="export-submit"
          @click="submit"
        >
          开始打包
        </NButton>
      </div>
      <p v-if="estimateError" class="text-[12px] text-danger" role="alert">{{ estimateError }}</p>
      <p v-if="selected.length === 0" class="text-[12px] text-3">至少勾选一项内容</p>

      <!-- 进度：复用 ExportProgressCard 的逻辑，样式嵌在卡片里 -->
      <ExportProgressCard
        v-if="activeItem"
        embedded
        :item="activeItem"
        @done="onProgressDone"
        @failed="(text: string) => message.error(text)"
      />
    </div>

    <!-- 历史导出：紧凑表格，默认最近 3 条 -->
    <div class="data__history">
      <div class="data__history-head">
        <p class="data__section">历史导出</p>
        <NButton
          v-if="canExpand"
          size="tiny"
          quaternary
          data-testid="export-show-all"
          @click="showAll = !showAll"
        >
          {{ showAll ? '收起' : '查看全部' }}
        </NButton>
        <span class="data__spacer" />
        <NButton size="tiny" quaternary :loading="loading" @click="loadList">刷新</NButton>
      </div>

      <p v-if="loading" class="hub-muted">正在读取…</p>
      <p v-else-if="listError" class="text-[13px] text-2" role="alert">{{ listError }}</p>
      <p v-else-if="items.length === 0" class="data__empty">还没有导出过，勾选上面的内容就能打包。</p>

      <div v-else class="data__table-wrap">
        <table class="data__table">
          <thead>
            <tr>
              <th>时间</th>
              <th>包含内容</th>
              <th>大小</th>
              <th>状态</th>
              <th>剩余有效期</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in visibleItems" :key="item.id" data-testid="export-row">
              <td class="data__nowrap">{{ formatDateTime(item.createdAt) }}</td>
              <td class="data__parts" :title="describeExportParts(item.parts)">
                {{ describeExportParts(item.parts) }}
              </td>
              <td class="data__nowrap data__mono">{{ formatSize(item) }}</td>
              <td class="data__nowrap">
                <span class="data__status" :class="`data__status--${exportStatusMeta(item.status).tone}`">
                  {{ exportStatusMeta(item.status).text }}
                </span>
              </td>
              <td class="data__nowrap data__muted">{{ expiryText(item) }}</td>
              <td class="data__nowrap">
                <a v-if="item.status === 'ready'" class="hub-btn-ghost" :href="exportDownloadUrl(item.id)">
                  <span class="i-ph-download-simple" aria-hidden="true" />
                  下载
                </a>
                <NPopconfirm
                  v-if="item.status !== 'running' && item.status !== 'queued'"
                  @positive-click="remove(item.id)"
                >
                  <template #trigger>
                    <NButton size="tiny" quaternary aria-label="删除这份导出">
                      <template #icon><span class="i-ph-trash" aria-hidden="true" /></template>
                    </NButton>
                  </template>
                  删除这份导出？删了就找不回来了。
                </NPopconfirm>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </SoftCard>
</template>

<style scoped>
.data__last {
  color: var(--c-text-3);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.data__section {
  color: var(--c-text);
  font-size: var(--fs-14);
  font-weight: var(--fw-semibold);
}

.export-builder {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.export-builder__parts {
  display: grid;
  gap: var(--space-2);
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.export-builder__part {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2) var(--space-3);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
  background: var(--c-bg);
}

.export-builder__size {
  color: var(--c-text-3);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.export-builder__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.export-builder__total {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-2);
  color: var(--c-text-2);
  font-size: var(--fs-13);
  white-space: nowrap;
}

.export-builder__total strong {
  color: var(--c-text);
  font-variant-numeric: tabular-nums;
  font-weight: var(--fw-semibold);
}

.export-builder__spacer {
  flex: 1;
}

.export-builder__submit {
  min-width: 120px;
}

.data__history {
  margin-top: var(--space-5);
  padding-top: var(--space-4);
  border-top: var(--border-width) solid var(--c-border);
}

.data__history-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.data__spacer {
  flex: 1;
}

.data__empty {
  margin-top: var(--space-3);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.data__table-wrap {
  margin-top: var(--space-2);
  overflow-x: auto;
}

.data__table {
  width: 100%;
  min-width: 720px;
  border-collapse: collapse;
  font-size: var(--fs-12);
}

.data__table th {
  padding: var(--space-2) var(--space-2);
  border-bottom: var(--border-width) solid var(--c-border);
  color: var(--c-text-3);
  font-weight: var(--fw-normal);
  text-align: left;
  white-space: nowrap;
}

.data__table td {
  padding: var(--space-2) var(--space-2);
  border-bottom: var(--border-width) solid var(--c-border);
  color: var(--c-text);
}

.data__table tr:last-child td {
  border-bottom: 0;
}

.data__nowrap {
  white-space: nowrap;
}

.data__mono {
  font-family: var(--font-mono);
}

.data__muted {
  color: var(--c-text-3);
}

.data__parts {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.data__status {
  padding: 1px var(--space-2);
  border-radius: var(--radius-pill);
  white-space: nowrap;
}

.data__status--running {
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
}

.data__status--progress {
  background: var(--c-sky-soft);
  color: var(--c-sky-ink);
}

.data__status--idle {
  background: var(--c-bg);
  color: var(--c-text-2);
}

.data__status--error {
  background: var(--c-danger-soft);
  color: var(--c-danger-ink);
}

/* 手机：单列、勾选块两列、按钮占满整行（16 §7） */
@media (max-width: 720px) {
  .export-builder__parts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .export-builder__spacer {
    display: none;
  }

  .export-builder__submit {
    width: 100%;
  }

  .data__last {
    display: none;
  }
}
</style>
