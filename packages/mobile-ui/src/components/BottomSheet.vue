<script setup lang="ts">
/**
 * 底部弹层容器（遮罩 + 上滑 + 抓手 + 标题槽）。
 *
 * 模型选择与强度拖动条共用这一层：样式沿用全局 app.css 的 `.sheet*`，
 * 过渡放在这里，避免每个弹层各写一遍（旧 ModelSheet 里的用法已迁过来）。
 */
defineProps<{
  open: boolean
  /** 读屏用的弹层名称（role=dialog 的 aria-label）。 */
  label: string
}>()

const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <Transition name="fade">
    <div v-if="open" class="sheet-mask" @click="emit('close')" />
  </Transition>
  <Transition name="slide">
    <div v-if="open" class="sheet" role="dialog" aria-modal="true" :aria-label="label">
      <div class="sheet__grip" />
      <slot />
    </div>
  </Transition>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
.slide-enter-active,
.slide-leave-active {
  transition: transform 0.22s cubic-bezier(0.32, 0.72, 0, 1);
}
.slide-enter-from,
.slide-leave-to {
  transform: translateY(100%);
}
</style>
