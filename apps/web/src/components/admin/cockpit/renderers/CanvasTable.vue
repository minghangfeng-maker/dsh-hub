<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import type { CanvasColumnFormat } from '@/api/admin-cockpit'
import { formatCanvasCell, tableBarMax, tableBarRatio } from '@/utils/cockpit'

/**
 * `table` 卡（docs/24 §3）：列定义来自 DSH，数据来自 Hub 数据源或 DSH 内联。
 * 每行末尾有「追问这一行」——把该行的关键字段预填进对话输入框（`cockpit.prefill`）。
 *
 * WP56h：表格只在「必须逐行看/追问」的地方用，所以它要做两件小事——
 * 1. 行数 ≤20 时，数值列在单元格背后画一条数据条（天空色低透明度、按列最大值归一），
 *    舷侧表格很窄，一眼能看出谁多谁少；
 * 2. 空数据不再留一个空表头：默认一句「没有数据」，特定来源可以给更具体的话
 *    （「一切正常」「没有待确认的操作」，由 `CanvasSpecView` 按数据源决定）。
 */
export interface CanvasTableColumn {
  key: string
  label: string
  format?: CanvasColumnFormat
}

const props = withDefaults(
  defineProps<{
    columns: CanvasTableColumn[]
    rows: Record<string, unknown>[]
    loading?: boolean
    error?: string | null
    /** 列多时可横向滚动（07 §2.8：不要把标识符挤成两三行） */
    compact?: boolean
    /** 没有行时显示的一句话（缺省「没有数据」） */
    emptyText?: string
  }>(),
  { loading: false, error: null, compact: false, emptyText: undefined },
)

const emit = defineEmits<{ ask: [row: Record<string, unknown>] }>()

/**
 * 右边还有没露出来的列（窄栏里横向滚动条不显眼，用户不知道能往右拖）：
 * 给固定在右侧的「追问」列左缘加一道阴影，滚到最右就消失。
 */
const scrollRef = ref<HTMLElement | null>(null)
const moreRight = ref(false)

function measure(): void {
  const el = scrollRef.value
  moreRight.value = el !== null && el.scrollWidth - el.clientWidth - el.scrollLeft > 1
}

let observer: ResizeObserver | null = null
onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined' && scrollRef.value) {
    observer = new ResizeObserver(measure)
    observer.observe(scrollRef.value)
  }
})
onBeforeUnmount(() => observer?.disconnect())
watch(
  () => [props.rows, props.columns],
  () => void nextTick(measure),
)

/** 编号类列（id、xxxId、方案号、任务号）是标识不是度量，不画数据条 */
const ID_COLUMN_RE = /(^id$|Id$|_id$)/u
const ID_LABELS = new Set(['方案', '任务', '编号', 'ID', 'id', '#'])

/** 画数据条的列：数值型（number / credits / bytes）的度量列，行数 2–20（一行没得比，太多就糊了） */
const barMax = computed(() => {
  const map = new Map<string, number>()
  if (props.rows.length < 2 || props.rows.length > 20) return map
  for (const column of props.columns) {
    const format = column.format ?? 'text'
    if (format !== 'number' && format !== 'credits' && format !== 'bytes') continue
    if (ID_COLUMN_RE.test(column.key) || ID_LABELS.has(column.label)) continue
    const max = tableBarMax(props.rows, column.key)
    if (max > 0) map.set(column.key, max)
  }
  return map
})

const cells = computed(() =>
  props.rows.map((row) =>
    props.columns.map((column) => {
      const max = barMax.value.get(column.key)
      const value = Number(row[column.key])
      return {
        key: column.key,
        text: formatCanvasCell(row[column.key], column.format ?? 'text'),
        format: column.format ?? 'text',
        barRatio: max === undefined || !Number.isFinite(value) ? 0 : tableBarRatio(value, max),
      }
    }),
  ),
)

const showEmpty = computed(() => !props.loading && props.rows.length === 0 && !props.error)
</script>

<template>
  <div class="canvas-table">
    <p v-if="error" class="canvas-table__error" role="alert">{{ error }}</p>

    <!-- 空数据不留空表头：一句具体的话（「一切正常」「没有待确认的操作」）比一行列名有用 -->
    <p v-if="showEmpty" class="canvas-table__empty-ok">{{ emptyText ?? '没有数据' }}</p>

    <div
      v-else
      ref="scrollRef"
      class="canvas-table__scroll"
      :class="{ 'canvas-table__scroll--more': moreRight }"
      @scroll.passive="measure"
    >
      <table>
        <thead>
          <tr>
            <th v-for="column in columns" :key="column.key" scope="col" :title="column.label">
              {{ column.label }}
            </th>
            <th scope="col" class="canvas-table__ask-head"><span class="sr-only">追问</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, rowIndex) in cells" :key="rowIndex">
            <td
              v-for="cell in row"
              :key="cell.key"
              :class="[
                `canvas-table__cell--${cell.format}`,
                { 'canvas-table__cell--num': cell.format !== 'text' },
              ]"
              :title="cell.text"
            >
              <!-- 数据条画在文字背后（天空色低透明度，按列最大值归一） -->
              <span
                v-if="cell.barRatio > 0"
                class="canvas-table__bar"
                :style="{ width: `${(cell.barRatio * 100).toFixed(1)}%` }"
                aria-hidden="true"
              />
              <span class="canvas-table__text">{{ cell.text }}</span>
            </td>
            <td class="canvas-table__ask-cell">
              <button
                type="button"
                class="canvas-table__ask press"
                :aria-label="`追问第 ${rowIndex + 1} 行`"
                title="追问这一行"
                @click="emit('ask', rows[rowIndex] ?? {})"
              >
                <span class="i-ph-chat-circle-dots" aria-hidden="true" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-if="loading" class="canvas-table__loading">正在读取…</p>
  </div>
</template>

<style scoped>
.canvas-table {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* 窄画布：横向滚动留在卡片里，不撑破整页 */
.canvas-table__scroll {
  overflow-x: auto;
  border-radius: var(--radius-control);
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-13);
}

th {
  padding: var(--space-2) var(--space-2);
  border-bottom: var(--border-width) solid var(--b-line-strong, var(--c-border));
  background: var(--b-panel-solid, var(--c-bg));
  color: var(--c-text-3);
  font-size: var(--fs-12);
  letter-spacing: 0.04em;
  font-weight: var(--fw-semibold);
  text-align: left;
  white-space: nowrap;
}

td {
  padding: var(--space-2);
  border-bottom: var(--border-width) solid var(--c-border);
  color: var(--c-text);
  /* 07 §2.8：标识符、数字、日期不从中间断开；放不下就单行省略 */
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

tr:last-child td {
  border-bottom: 0;
}

tbody tr:hover td {
  background: var(--c-primary-soft);
}

.canvas-table__cell--num {
  font-family: var(--font-mono);
  text-align: right;
}

.canvas-table__ask-head {
  position: sticky;
  right: 0;
  width: 32px;
  /* 列多时表格内部横向滚动，追问按钮要始终够得着（07 §2.8） */
  background: var(--b-panel-solid, var(--c-bg));
}

.canvas-table__ask-cell {
  position: sticky;
  right: 0;
  width: 32px;
  background: var(--b-panel-solid, var(--c-surface));
  padding-inline: 0;
  text-align: center;
}

/* 右边还有列：追问列左缘一道阴影，提示可以往右拖 */
.canvas-table__scroll--more .canvas-table__ask-head,
.canvas-table__scroll--more .canvas-table__ask-cell {
  box-shadow: -10px 0 10px -8px color-mix(in srgb, var(--c-text) 35%, transparent);
}

.canvas-table__ask {
  display: inline-flex;
  width: 24px;
  height: 24px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--c-text-3);
  cursor: pointer;
  font-size: 14px;
}

.canvas-table__ask:hover,
.canvas-table__ask:focus-visible {
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
}

.canvas-table__empty-ok,
.canvas-table__loading {
  padding: var(--space-3) 0;
  color: var(--c-text-3);
  font-size: var(--fs-12);
  text-align: center;
}

/* 数据条：格子里的背景层，文字浮在它上面 */
.canvas-table__cell--num {
  position: relative;
}

.canvas-table__bar {
  position: absolute;
  top: 4px;
  right: 4px;
  bottom: 4px;
  max-width: calc(100% - 8px);
  border-radius: var(--radius-control-sm);
  background: var(--b-bar-fill);
  pointer-events: none;
}

.canvas-table__text {
  position: relative;
}

.canvas-table__error {
  color: var(--c-danger-ink);
  font-size: var(--fs-12);
}
</style>
