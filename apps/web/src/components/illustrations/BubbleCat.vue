<script setup lang="ts">
/**
 * 圆滚滚小猫探头（07 §2.6）：404 用。主色轮廓 + 樱花粉耳朵内衬。
 * `animated` 时轻轻探头（减少动态效果下自动关闭）。
 */
withDefaults(defineProps<{ size?: number; animated?: boolean; title?: string }>(), {
  size: 120,
  animated: false,
  title: '探头的小猫插画',
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
    :class="{ 'ill-peek': animated }"
  >
    <path
      d="M36 48 30 26l20 10M84 48l6-22-20 10"
      stroke="var(--c-primary)"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      fill="var(--c-sakura-soft)"
    />
    <path
      d="M60 34c17 0 29 12 29 28s-12 28-29 28-29-12-29-28 12-28 29-28Z"
      stroke="var(--c-primary)"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      fill="var(--c-primary-soft)"
    />
    <path
      d="M48 58h6M66 58h6"
      stroke="var(--c-primary)"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M56 68c2.5 2 5.5 2 8 0"
      stroke="var(--c-sakura)"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M32 74h-8M36 82l-7 4M88 74h8M84 82l7 4"
      stroke="var(--c-status-stopped)"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>
