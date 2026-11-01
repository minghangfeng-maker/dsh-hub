<script setup lang="ts">
/**
 * 叶子钥匙（07 §2.6）：登录页用。竖版钥匙（好认）+ 环上长出的樱花粉叶子。
 * 两种色相、线条 2px 圆端点；`animated` 时轻微摇晃（减少动态效果下自动关闭）。
 */
withDefaults(defineProps<{ size?: number; animated?: boolean; title?: string }>(), {
  size: 120,
  animated: false,
  title: '叶子钥匙插画',
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
    <!-- 钥匙环 -->
    <circle
      cx="68"
      cy="40"
      r="17"
      stroke="var(--c-primary)"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      fill="var(--c-primary-soft)"
    />
    <!-- 钥匙杆与两个齿 -->
    <path
      d="M68 57v47M68 88h13M68 100h10"
      stroke="var(--c-primary)"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <!-- 环上长出的叶子（带一条叶脉） -->
    <path
      d="M54 30c-2-11-11-18-22-19 0 12 10 20 22 19Z"
      stroke="var(--c-sakura)"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      fill="var(--c-sakura-soft)"
    />
    <path
      d="M32 11c7 6 15 12 22 19"
      stroke="var(--c-sakura)"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>
