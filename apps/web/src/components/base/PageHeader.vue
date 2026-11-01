<script setup lang="ts">
import { useRouter } from 'vue-router'

/**
 * 页面标题区（07 §2.2：页面主标题 32px）：
 * 可选返回按钮 + 主标题 + 副标题 + 右侧操作插槽 + 下方附加内容插槽。
 */
withDefaults(
  defineProps<{
    title: string
    subtitle?: string
    /** 显示返回按钮并跳到该路径 */
    backTo?: string
    /** 返回按钮文案 */
    backText?: string
  }>(),
  { subtitle: undefined, backTo: undefined, backText: '返回' },
)

const router = useRouter()

function goBack(to: string): void {
  if (window.history.length > 1) router.back()
  else void router.push(to)
}
</script>

<template>
  <header class="page-header">
    <button v-if="backTo" type="button" class="page-header__back press" @click="goBack(backTo)">
      <span class="i-ph-arrow-left" aria-hidden="true" />
      {{ backText }}
    </button>

    <div class="page-header__row">
      <div class="page-header__body">
        <h1 class="page-header__title">{{ title }}</h1>
        <p v-if="subtitle" class="page-header__subtitle">{{ subtitle }}</p>
      </div>

      <div v-if="$slots.actions" class="page-header__actions">
        <slot name="actions" />
      </div>
    </div>

    <div v-if="$slots.default" class="page-header__extra">
      <slot />
    </div>
  </header>
</template>

<style scoped>
.page-header {
  margin-bottom: var(--space-6);
}

.page-header__back {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  margin-bottom: var(--space-2);
  padding: 2px var(--space-2);
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--c-text-2);
  cursor: pointer;
  font-size: var(--fs-13);
}

.page-header__back:hover {
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
}

.page-header__row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-4);
}

.page-header__title {
  font-size: var(--fs-24);
  font-weight: var(--fw-semibold);
  line-height: var(--lh-base);
  color: var(--c-text);
}

@media (min-width: 960px) {
  .page-header__title {
    font-size: var(--fs-32);
  }
}

.page-header__subtitle {
  margin-top: var(--space-1);
  color: var(--c-text-2);
}

.page-header__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
}

.page-header__extra {
  margin-top: var(--space-4);
}
</style>
