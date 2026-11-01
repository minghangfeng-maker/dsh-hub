<script setup lang="ts">
import type { ExportItem, ExportProgress } from '@dsh-hub/shared'
import { useIntervalFn } from '@vueuse/core'
import { NProgress } from 'naive-ui'
import { computed, ref, watch } from 'vue'

import { exportDownloadUrl, exportEventsUrl } from '@/api/exports'
import CheckDraw from '@/components/base/CheckDraw.vue'
import PaperPlane from '@/components/illustrations/PaperPlane.vue'
import { useSse, type SseSourceFactory } from '@/composables/useSse'
import { describeExportParts } from '@/composables/useExportStatus'
import { formatBytes, formatDuration } from '@/composables/useFormat'

/**
 * 导出进度卡（07 §6.2）：订阅 `GET /api/me/exports/:id/events`（04 §3.3 的
 * `progress` / `done` / `failed` 三个事件），完成后显示纸飞机动画 + 下载 + 过期倒计时。
 */
const props = withDefaults(
  defineProps<{
    item: ExportItem
    /** 测试注入 EventSource */
    sseFactory?: SseSourceFactory
    /** 倒计时刷新间隔 */
    tickMs?: number
    now?: number
    /** 嵌在「我的数据」卡片里：去掉自己的卡片边框与阴影（16 §7） */
    embedded?: boolean
  }>(),
  { sseFactory: undefined, tickMs: 30_000, now: () => Date.now(), embedded: false },
)

const emit = defineEmits<{
  done: [item: ExportItem]
  failed: [message: string]
}>()

const progress = ref<ExportProgress | null>(props.item.progress ?? null)
const finished = ref<ExportItem | null>(props.item.status === 'ready' ? props.item : null)
const failedText = ref<string | null>(props.item.error ?? null)
const now = ref(props.now)

/**
 * 父组件刷新列表后会换一个新的 item 对象：跟着它同步状态，
 * 这样「刷新页面时导出已经完成」也能显示下载按钮（不依赖 must-have 收到 done 事件）。
 */
watch(
  () => props.item,
  (next) => {
    progress.value = next.progress ?? null
    if (next.status === 'ready') {
      finished.value = next
      failedText.value = null
      return
    }
    finished.value = null
    failedText.value = next.status === 'failed' ? (next.error ?? '打包失败了，稍后再试试') : null
  },
)

/** 只有还没结束时才订阅（已完成/失败的直接展示结果） */
const live = computed(() => finished.value === null && failedText.value === null)
const url = computed(() => (live.value ? exportEventsUrl(props.item.id) : ''))

useSse(url, {
  events: {
    progress: (payload) => {
      progress.value = payload as ExportProgress
    },
    done: (payload) => {
      const data = payload as { export?: ExportItem }
      if (data.export) {
        finished.value = data.export
        progress.value = data.export.progress ?? progress.value
        emit('done', data.export)
      }
    },
    failed: (payload) => {
      const data = payload as { error?: { message?: string } }
      failedText.value = data.error?.message ?? '打包失败了，稍后再试试'
      emit('failed', failedText.value)
    },
  },
  ...(props.sseFactory ? { factory: props.sseFactory } : {}),
})

const percent = computed(() => {
  const current = progress.value
  if (!current || current.filesTotal <= 0) return 0
  return Math.min(100, Math.round((current.filesDone / current.filesTotal) * 100))
})

const remainingText = computed(() => {
  const expiresAt = finished.value?.expiresAt
  if (!expiresAt) return null
  const ms = Date.parse(expiresAt) - now.value
  if (Number.isNaN(ms)) return null
  return ms <= 0 ? '已经过期了' : `${formatDuration(ms)}后过期`
})

/** 过期倒计时每 30 秒走一下（07 §6.2「显示过期时间倒计时」） */
useIntervalFn(
  () => {
    now.value = Date.now()
  },
  () => props.tickMs,
)
</script>

<template>
  <section
    class="export-progress"
    :class="{ 'export-progress--embedded': embedded }"
    data-testid="export-progress"
    aria-live="polite"
  >
    <div class="export-progress__head">
      <div>
        <p class="text-[15px] font-semibold text-1">
          {{ finished ? '打包完成' : failedText ? '打包失败' : '正在打包你的数据' }}
        </p>
        <p class="flex flex-wrap gap-x-2 text-[12px] text-2">
          <span class="whitespace-nowrap">包含：{{ describeExportParts(item.parts) }}</span>
          <span class="whitespace-nowrap">· {{ item.format === 'zip' ? 'ZIP' : 'tar.gz' }}</span>
        </p>
      </div>

      <!-- 完成：纸飞机 + 勾号（07 §2.5 / §6.2） -->
      <div v-if="finished" class="export-progress__done">
        <PaperPlane :size="72" animated />
      </div>
    </div>

    <template v-if="finished">
      <div class="export-progress__row">
        <CheckDraw :size="26" label="打包完成" />
        <span class="flex flex-wrap gap-x-2 text-[13px] text-2">
          <span class="whitespace-nowrap">{{ finished.fileName ?? '导出包已就绪' }}</span>
          <span v-if="finished.sizeBytes" class="whitespace-nowrap"
            >· {{ formatBytes(finished.sizeBytes) }}</span
          >
        </span>
      </div>
      <div class="export-progress__actions">
        <a
          :href="exportDownloadUrl(finished.id)"
          class="export-progress__download"
          data-testid="export-download"
        >
          <span class="i-ph-download-simple" aria-hidden="true" />
          下载
        </a>
        <span v-if="remainingText" class="whitespace-nowrap text-[12px] text-3">{{ remainingText }}</span>
      </div>
    </template>

    <template v-else-if="failedText">
      <p class="text-[13px] text-danger" role="alert">{{ failedText }}</p>
    </template>

    <template v-else>
      <NProgress
        type="line"
        :percentage="percent"
        :height="10"
        :border-radius="6"
        :show-indicator="false"
        color="var(--c-primary)"
        rail-color="var(--c-primary-soft)"
      />
      <p class="export-progress__meta" data-testid="export-progress-meta">
        <span v-if="progress" class="whitespace-nowrap"
          >已处理 {{ progress.filesDone }} / {{ progress.filesTotal }} 个文件</span
        >
        <span v-else>正在准备…</span>
        <span v-if="progress" class="whitespace-nowrap">
          · 已写入 {{ formatBytes(progress.bytesWritten) }}</span
        >
      </p>
    </template>
  </section>
</template>

<style scoped>
.export-progress {
  padding: var(--space-4);
  border: var(--border-width) solid var(--c-border);
  border-left: 3px solid var(--c-primary);
  border-radius: var(--radius-card);
  background: var(--c-surface);
  box-shadow: var(--shadow-card);
}

/* 嵌入「我的数据」卡片：只留一条左侧强调线，不再套第二层卡片（16 §7） */
.export-progress--embedded {
  margin-top: var(--space-1);
  padding: var(--space-3);
  border: 0;
  border-left: 3px solid var(--c-primary);
  border-radius: var(--radius-control);
  background: var(--c-bg);
  box-shadow: none;
}

.export-progress__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}

.export-progress__done {
  flex: none;
}

.export-progress__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.export-progress__actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.export-progress__download {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-control);
  background: var(--c-primary);
  color: var(--c-surface);
  font-size: var(--fs-13);
  transition:
    background var(--duration-base) var(--ease-out-soft),
    transform var(--duration-press) var(--ease-out-soft);
}

.export-progress__download:hover {
  background: var(--c-primary-hover);
  color: var(--c-surface);
}

.export-progress__download:active {
  transform: scale(0.98);
}

.export-progress__meta {
  margin-top: var(--space-2);
  color: var(--c-text-2);
  font-size: var(--fs-12);
}
</style>
