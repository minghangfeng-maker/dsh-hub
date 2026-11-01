<script setup lang="ts">
import { computed } from 'vue'

import type { AdminPlatform } from '@/composables/admin-platform'

/**
 * 「云端 | 桌面端」分段切换（docs/22 §1.2，WP57 改版）。
 *
 * WP57：两个端各有自己的颜色（云端 = 品牌蓝、桌面端 = 紫罗兰，令牌 `--c-plat-*`），
 * 选中块是一个**滑块**，切换时从一侧滑到另一侧并换色；页面内容的滑入由 `AdminPage` 的 `platform` 属性负责。
 * 值与地址栏 `?platform=`、记忆值的同步都由 `useAdminPlatform()` 负责，组件本身只发事件。
 * 只有存在桌面对应物的页面才显示它 —— 没有的页面连这个组件都不挂，记忆值也不会被改。
 */
const props = withDefaults(
  defineProps<{
    modelValue: AdminPlatform
    /** 大号：下发流程「选端」那一步以外的地方都用默认尺寸 */
    size?: 'small' | 'medium'
  }>(),
  { size: 'small' },
)
const emit = defineEmits<{ 'update:modelValue': [AdminPlatform] }>()

const OPTIONS: { value: AdminPlatform; label: string; icon: string }[] = [
  { value: 'cloud', label: '云端', icon: 'i-ph-cloud' },
  { value: 'desktop', label: '桌面端', icon: 'i-ph-desktop' },
]

const index = computed(() => Math.max(0, OPTIONS.findIndex((option) => option.value === props.modelValue)))

function select(value: AdminPlatform): void {
  if (value !== props.modelValue) emit('update:modelValue', value)
}

/** 方向键在两个端之间切（radiogroup 的键盘约定） */
function onKeydown(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
  event.preventDefault()
  const next = OPTIONS[(index.value + 1) % OPTIONS.length]
  if (next) select(next.value)
  const host = event.currentTarget as HTMLElement | null
  host?.querySelector<HTMLButtonElement>(`[data-value="${next?.value ?? ''}"]`)?.focus()
}
</script>

<template>
  <div
    class="platform-switch"
    :class="[`platform-switch--${modelValue}`, `platform-switch--${size}`]"
    role="radiogroup"
    aria-label="云端或桌面端"
    data-testid="platform-switch"
    @keydown="onKeydown"
  >
    <span class="platform-switch__thumb" :style="{ transform: `translateX(${index * 100}%)` }" aria-hidden="true" />
    <button
      v-for="option in OPTIONS"
      :key="option.value"
      type="button"
      role="radio"
      class="platform-switch__option"
      :class="{ 'platform-switch__option--active': option.value === modelValue }"
      :aria-checked="option.value === modelValue"
      :tabindex="option.value === modelValue ? 0 : -1"
      :data-value="option.value"
      :data-testid="`platform-${option.value}`"
      @click="select(option.value)"
    >
      <span :class="option.icon" class="platform-switch__icon" aria-hidden="true" />
      {{ option.label }}
    </button>
  </div>
</template>

<style scoped>
.platform-switch {
  --switch-cell: 92px;
  --switch-h: 32px;

  position: relative;
  display: inline-grid;
  grid-template-columns: repeat(2, var(--switch-cell));
  padding: 3px;
  border: var(--border-width) solid var(--c-border);
  border-radius: 999px;
  background: var(--c-surface);
  box-shadow: inset 0 1px 2px color-mix(in srgb, var(--c-text) 6%, transparent);
}

.platform-switch--medium {
  --switch-cell: 120px;
  --switch-h: 40px;
}

.platform-switch__thumb {
  position: absolute;
  top: 3px;
  left: 3px;
  width: var(--switch-cell);
  height: var(--switch-h);
  border-radius: 999px;
  background: var(--c-plat-cloud);
  box-shadow: 0 4px 12px color-mix(in srgb, var(--c-plat-cloud) 35%, transparent);
  transition:
    transform 320ms var(--ease-out-soft),
    background-color 320ms var(--ease-out-soft),
    box-shadow 320ms var(--ease-out-soft);
}

.platform-switch--desktop .platform-switch__thumb {
  background: var(--c-plat-desktop);
  box-shadow: 0 4px 12px color-mix(in srgb, var(--c-plat-desktop) 35%, transparent);
}

.platform-switch__option {
  position: relative;
  z-index: 1;
  display: inline-flex;
  height: var(--switch-h);
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 var(--space-3);
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--c-text-2);
  cursor: pointer;
  font: inherit;
  font-size: var(--fs-13);
  white-space: nowrap;
  transition: color 240ms var(--ease-out-soft);
}

.platform-switch--medium .platform-switch__option {
  font-size: var(--fs-14);
}

.platform-switch__option:hover:not(.platform-switch__option--active) {
  color: var(--c-text);
}

.platform-switch__option:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--c-primary) 25%, transparent);
}

.platform-switch__option--active {
  color: var(--c-plat-on);
  font-weight: var(--fw-semibold);
}

.platform-switch__icon {
  font-size: 1.1em;
}

@media (prefers-reduced-motion: reduce) {
  .platform-switch__thumb,
  .platform-switch__option {
    transition-duration: var(--duration-press);
  }
}
</style>
