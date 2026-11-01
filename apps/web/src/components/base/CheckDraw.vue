<script setup lang="ts">
/**
 * 勾号描边动画（07 §2.5）：SVG `stroke-dashoffset` 400ms，注册成功/保存成功用。
 * 动画定义在 styles/motion.css（`.check-circle` / `.check-path`），
 * `prefers-reduced-motion` 下动画时长压到 120ms 并保留结束态。
 */
withDefaults(
  defineProps<{
    size?: number
    /** 无障碍标签（读屏用） */
    label?: string
    /** 描边颜色，默认水绿（成功色） */
    color?: string
  }>(),
  { size: 56, label: '操作成功', color: 'var(--c-success)' },
)
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 52 52"
    fill="none"
    role="img"
    :aria-label="label"
    class="check-draw"
  >
    <circle
      class="check-circle"
      cx="26"
      cy="26"
      r="24"
      :stroke="color"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      class="check-path"
      d="M15 27.5 22.5 35 37 19"
      :stroke="color"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>

<style scoped>
.check-draw {
  display: block;
}
</style>
