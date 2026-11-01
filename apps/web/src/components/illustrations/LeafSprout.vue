<script setup lang="ts">
/**
 * 新芽（07 §2.6）：空列表用。主色叶子 + 樱花粉嫩芽 + 灰色土壤。
 * 线条 2px、圆端点；`animated` 时轻轻摇摆（减少动态效果下自动关闭）。
 */
withDefaults(defineProps<{ size?: number; animated?: boolean; title?: string }>(), {
  size: 120,
  animated: false,
  title: '新芽插画',
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
    :class="{ 'ill-sway': animated }"
  >
    <path
      d="M60 96V58"
      stroke="var(--c-primary)"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M60 70c0-12-9-20-22-22 0 13 8 22 22 22Z"
      stroke="var(--c-primary)"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      fill="var(--c-primary-soft)"
    />
    <path
      d="M60 56c0-10 7-17 18-19 0 11-7 19-18 19Z"
      stroke="var(--c-sakura)"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      fill="var(--c-sakura-soft)"
    />
    <path
      d="M34 96h52"
      stroke="var(--c-status-stopped)"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>
