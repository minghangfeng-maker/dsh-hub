<script setup lang="ts">
import { computed } from 'vue'

/**
 * `logs` 卡（docs/24 §3）：只读日志尾巴，等宽、按行。
 * 行的形状由 DSH 决定（`{ time, level, line }` 是常见形态），这里做宽容读取。
 */
const props = withDefaults(
  defineProps<{
    rows: Record<string, unknown>[]
    loading?: boolean
    error?: string | null
    maxLines?: number
  }>(),
  { loading: false, error: null, maxLines: 40 },
)

interface LogLine {
  key: string
  time: string
  level: string
  text: string
}

function textOf(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

const lines = computed<LogLine[]>(() =>
  props.rows.slice(-props.maxLines).map((row, index) => ({
    key: `${String(index)}-${textOf(row['time'] ?? row['ts'] ?? '')}`,
    time: textOf(row['time'] ?? row['ts'] ?? row['at']),
    level: textOf(row['level'] ?? '').toLowerCase(),
    // 真后端的日志行可能叫 line / text / message
    text: textOf(row['line'] ?? row['text'] ?? row['message'] ?? row),
  })),
)

function levelClass(level: string): string {
  if (level === 'error' || level === 'fatal') return 'canvas-logs__line--error'
  if (level === 'warn' || level === 'warning') return 'canvas-logs__line--warn'
  return ''
}
</script>

<template>
  <div class="canvas-logs">
    <p v-if="error" class="canvas-logs__hint" role="alert">{{ error }}</p>
    <p v-else-if="lines.length === 0" class="canvas-logs__hint">
      {{ loading ? '正在读取…' : '没有日志' }}
    </p>

    <ol v-else class="canvas-logs__list">
      <li v-for="line in lines" :key="line.key" class="canvas-logs__line" :class="levelClass(line.level)">
        <span v-if="line.time" class="canvas-logs__time">{{ line.time }}</span>
        <span class="canvas-logs__text">{{ line.text }}</span>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.canvas-logs {
  display: flex;
  flex-direction: column;
}

.canvas-logs__list {
  max-height: 260px;
  overflow-y: auto;
  padding: var(--space-2);
  border-radius: var(--radius-control);
  background: var(--c-bg);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
}

.canvas-logs__line {
  display: flex;
  gap: var(--space-2);
  padding: 1px 0;
  color: var(--c-text-2);
  /* 日志可以换行（07 §2.8：允许换行的只有段落/错误信息） */
  overflow-wrap: anywhere;
}

.canvas-logs__time {
  flex: none;
  color: var(--c-text-3);
  white-space: nowrap;
}

.canvas-logs__line--warn {
  color: var(--c-butter-ink);
}

.canvas-logs__line--error {
  color: var(--c-danger-ink);
}

.canvas-logs__hint {
  padding: var(--space-4) 0;
  color: var(--c-text-3);
  font-size: var(--fs-13);
  text-align: center;
}
</style>
