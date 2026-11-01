<script setup lang="ts">
/**
 * 小云朵睡觉（07 §2.6）：实例已停止用。天空蓝云朵 + 主色 Zzz。
 * `animated` 时缓慢呼吸（减少动态效果下自动关闭）。
 */
withDefaults(defineProps<{ size?: number; animated?: boolean; title?: string }>(), {
  size: 120,
  animated: false,
  title: '睡觉的云朵插画',
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
    :class="{ 'ill-sleep': animated }"
  >
    <path
      d="M38 82a16 16 0 0 1-2-31.9A22 22 0 0 1 78 46a15 15 0 0 1 4 29.5"
      stroke="var(--c-sky)"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      fill="var(--c-sky-soft)"
    />
    <path
      d="M44 68h8M64 68h8"
      stroke="var(--c-sky)"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M50 78c3 2.5 7 2.5 10 0"
      stroke="var(--c-sky)"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M86 30h10l-10 10h10M98 48h7l-7 7h7"
      stroke="var(--c-primary)"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>
