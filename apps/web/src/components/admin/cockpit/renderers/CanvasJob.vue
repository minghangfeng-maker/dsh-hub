<script setup lang="ts">
import { computed } from 'vue'

import { getJob } from '@/api/admin-jobs'
import JobProgress from '@/components/admin/JobProgress.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import { JOB_STATUS_TONE } from '@/composables/job-meta'
import { useAsyncData } from '@/composables/useAsyncData'
import { JOB_STATUS_TEXT } from '@/composables/useInstanceStatus'

/**
 * `job` 卡（docs/24 §3）：复用任务中心的进度条，3 秒轮询（与任务详情页 SSE 同口径的兜底）。
 * 点击进任务详情页看逐 task 日志。
 */
const props = defineProps<{ jobId: number }>()

const { data, loading, error } = useAsyncData(() => getJob(props.jobId), { pollMs: 3000 })

const job = computed(() => data.value?.job ?? null)
const statusText = computed(() => (job.value ? (JOB_STATUS_TEXT[job.value.status] ?? job.value.status) : ''))
const tone = computed(() => (job.value ? (JOB_STATUS_TONE[job.value.status] ?? 'neutral') : 'neutral'))
</script>

<template>
  <div class="canvas-job">
    <p v-if="error" class="canvas-job__hint canvas-job__hint--error">{{ error.message }}</p>
    <p v-else-if="!job" class="canvas-job__hint">{{ loading ? '正在读取任务…' : '任务不存在' }}</p>

    <template v-else>
      <div class="canvas-job__head">
        <RouterLink :to="`/admin/jobs/${job.id}`" class="canvas-job__title">{{ job.title }}</RouterLink>
        <MiniTag :text="statusText" :tone="tone" />
      </div>
      <JobProgress :total="job.total" :done="job.done" :failed="job.failed" size="sm" />
      <p class="canvas-job__meta">
        <span>#{{ job.id }}</span>
        <span>{{ job.done }} / {{ job.total }}</span>
        <span v-if="job.failed > 0" class="canvas-job__failed">失败 {{ job.failed }}</span>
      </p>
    </template>
  </div>
</template>

<style scoped>
.canvas-job {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.canvas-job__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.canvas-job__title {
  min-width: 0;
  overflow: hidden;
  color: var(--c-text);
  font-size: var(--fs-14);
  font-weight: var(--fw-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.canvas-job__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  color: var(--c-text-3);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.canvas-job__failed {
  color: var(--c-danger-ink);
}

.canvas-job__hint {
  color: var(--c-text-3);
  font-size: var(--fs-13);
}

.canvas-job__hint--error {
  color: var(--c-danger-ink);
}
</style>
