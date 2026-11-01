<script setup lang="ts">
/**
 * 柔和卡片（07 §2.3）：白色面 + 16px 圆角 + 主色倾向的浅阴影。
 * `hoverable` 时鼠标悬浮上浮 2px、阴影加深（180ms，07 §2.5）。
 */
withDefaults(
  defineProps<{
    title?: string
    /** 悬浮上浮（列表卡片用） */
    hoverable?: boolean
    /** 是否带内边距（表格类内容可关掉） */
    padded?: boolean
    /** 紧凑一些（次级卡片） */
    compact?: boolean
  }>(),
  { title: undefined, hoverable: false, padded: true, compact: false },
)
</script>

<template>
  <section
    class="soft-card"
    :class="{ 'soft-card--hoverable lift press': hoverable, 'soft-card--compact': compact }"
    :style="{ padding: padded ? undefined : '0' }"
  >
    <header v-if="title || $slots.header || $slots.extra || $slots['title-extra']" class="soft-card__header">
      <slot name="header">
        <h3 class="soft-card__title">{{ title }}</h3>
        <!-- 标题后的 InfoTip 之类（07 §2.7：说明收进「ⓘ」，不常驻在页面上） -->
        <slot name="title-extra" />
      </slot>
      <div v-if="$slots.extra" class="soft-card__extra">
        <slot name="extra" />
      </div>
    </header>

    <slot />

    <footer v-if="$slots.footer" class="soft-card__footer">
      <slot name="footer" />
    </footer>
  </section>
</template>

<style scoped>
.soft-card {
  padding: var(--space-6);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-card);
  background: var(--c-surface);
  box-shadow: var(--shadow-card);
}

.soft-card--compact {
  padding: var(--space-4);
}

.soft-card__header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.soft-card__title {
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
  color: var(--c-text);
}

.soft-card__extra {
  margin-left: auto;
}

.soft-card__footer {
  margin-top: var(--space-4);
  padding-top: var(--space-4);
  border-top: var(--border-width) solid var(--c-border);
}
</style>
