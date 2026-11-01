<script setup lang="ts">
/**
 * 小节标题：图标 + 标题 + 说明 + 右侧操作（页面里成块内容的开头）。
 */
withDefaults(
  defineProps<{
    title: string
    description?: string
    /** Uno 图标类名，如 `i-ph-puzzle-piece` */
    icon?: string
    /** 标题层级（默认 h2） */
    level?: 2 | 3
  }>(),
  { description: undefined, icon: undefined, level: 2 },
)
</script>

<template>
  <div class="section-title">
    <span v-if="icon" :class="icon" class="section-title__icon" aria-hidden="true" />
    <div class="section-title__body">
      <component :is="`h${level}`" class="section-title__text">{{ title }}</component>
      <p v-if="description" class="section-title__desc">{{ description }}</p>
    </div>
    <div v-if="$slots.extra" class="section-title__extra">
      <slot name="extra" />
    </div>
  </div>
</template>

<style scoped>
.section-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.section-title__icon {
  color: var(--c-primary);
  font-size: 18px;
}

.section-title__body {
  min-width: 0;
}

.section-title__text {
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
  color: var(--c-text);
}

.section-title__desc {
  margin-top: 2px;
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.section-title__extra {
  margin-left: auto;
}
</style>
