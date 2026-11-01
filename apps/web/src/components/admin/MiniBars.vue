<script setup lang="ts">
import { computed } from 'vue'

import type { InstanceStats } from '@dsh-hub/shared'

import { formatBytes, formatCount } from '@/composables/useFormat'

/**
 * 迷你资源条（07 §7.4 实例卡片）：CPU / 内存两条 4px 细条 + 数字。
 * 阈值与 `UsageBar` 一致：> 90% 琥珀、> 100% 珊瑚红。
 */
const props = withDefaults(
  defineProps<{
    stats: InstanceStats | null
    /** 是否显示磁盘条（表格里空间紧张时可以关掉） */
    showDisk?: boolean
  }>(),
  // 注意：布尔 prop 缺省会被 Vue 转成 false，必须显式给默认值
  { showDisk: true },
)

interface Bar {
  key: string
  label: string
  ratio: number
  text: string
}

function barColor(ratio: number): string {
  if (ratio > 1) return 'var(--c-danger)'
  if (ratio > 0.9) return 'var(--c-warning)'
  return 'var(--c-primary)'
}

const bars = computed<Bar[]>(() => {
  const stats = props.stats
  if (!stats) return []

  const cpuRatio = stats.cpuPercent / 100
  const memoryRatio = stats.memoryLimitBytes > 0 ? stats.memoryBytes / stats.memoryLimitBytes : 0

  const list: Bar[] = [
    { key: 'cpu', label: 'CPU', ratio: cpuRatio, text: `${Math.round(stats.cpuPercent)}%` },
    {
      key: 'mem',
      label: '内存',
      ratio: memoryRatio,
      text: `${formatBytes(stats.memoryBytes, 0)} / ${formatBytes(stats.memoryLimitBytes, 0)}`,
    },
  ]

  if (props.showDisk !== false && stats.diskBytes !== null && stats.diskLimitBytes > 0) {
    list.push({
      key: 'disk',
      label: '磁盘',
      ratio: stats.diskBytes / stats.diskLimitBytes,
      text: `${formatBytes(stats.diskBytes, 0)} / ${formatBytes(stats.diskLimitBytes, 0)}`,
    })
  }

  return list
})

const pids = computed(() => (props.stats ? formatCount(props.stats.pids) : '—'))
</script>

<template>
  <div class="mini-bars">
    <p v-if="!stats" class="mini-bars__empty">暂无实时资源数据</p>

    <template v-else>
      <div v-for="bar in bars" :key="bar.key" class="mini-bars__row">
        <span class="mini-bars__label">{{ bar.label }}</span>
        <span
          class="mini-bars__track"
          role="progressbar"
          :aria-valuenow="Math.round(bar.ratio * 100)"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="`${bar.label} ${bar.text}`"
        >
          <span
            class="mini-bars__fill"
            :style="{
              width: `${Math.min(100, Math.max(0, bar.ratio * 100))}%`,
              background: barColor(bar.ratio),
            }"
          />
        </span>
        <span class="mini-bars__text">{{ bar.text }}</span>
      </div>
      <p class="mini-bars__pids">进程数 {{ pids }}</p>
    </template>
  </div>
</template>

<style scoped>
.mini-bars {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mini-bars__empty {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.mini-bars__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-12);
}

.mini-bars__label {
  width: 30px;
  flex: none;
  color: var(--c-text-3);
}

.mini-bars__track {
  height: 5px;
  min-width: 40px;
  flex: 1;
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--c-bg);
}

.mini-bars__fill {
  display: block;
  height: 100%;
  border-radius: var(--radius-pill);
  transition: width var(--duration-base) var(--ease-out-soft);
}

.mini-bars__text {
  min-width: 96px;
  color: var(--c-text-2);
  font-family: var(--font-mono);
  text-align: right;
}

.mini-bars__pids {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}
</style>
