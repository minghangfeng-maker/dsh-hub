<script setup lang="ts">
/**
 * 纸飞机（07 §2.6）：导出完成用。主色机身 + 天空蓝尾迹虚线。
 * `animated` 时上下轻飘（减少动态效果下自动关闭）。
 */
withDefaults(defineProps<{ size?: number; animated?: boolean; title?: string }>(), {
  size: 120,
  animated: false,
  title: '纸飞机插画',
})
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 120 120"
    fill="none"
    role="img"
    :aria-label="title"
    class="ill"
    :class="{ 'ill-float': animated }"
  >
    <path
      d="M96 26 30 62l24 8 6 24 36-68Z"
      stroke="var(--c-primary)"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      fill="var(--c-primary-soft)"
    />
    <path
      d="m54 70 42-44"
      stroke="var(--c-primary)"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M22 76c-6 6-8 12-8 20M40 92c-4 4-5 8-6 14"
      stroke="var(--c-sky)"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-dasharray="4 6"
    />
  </svg>
</template>
