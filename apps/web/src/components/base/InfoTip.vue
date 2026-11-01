<script setup lang="ts">
import { NPopover } from 'naive-ui'

/**
 * 「ⓘ」悬停说明（07 §2.7）：页面上不常驻小字，确实需要解释的放进这里。
 * 桌面悬停 / 键盘聚焦打开，触屏（`hover: none`）点一下打开；放在标签或列标题后面。
 * 只放「好奇时才看」的说明；操作后果放确认框，状态放状态本身，单位放输入框后缀或列标题。
 */
withDefaults(
  defineProps<{
    /** 说明文字（也可以用默认插槽） */
    text?: string
    /** 读屏用的按钮名，默认「说明」 */
    label?: string
    width?: number
  }>(),
  { text: undefined, label: '说明', width: 260 },
)

const touch = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches === true
</script>

<template>
  <NPopover :trigger="touch ? 'click' : 'hover'" :width="width" placement="top">
    <template #trigger>
      <button type="button" class="info-tip" :aria-label="label" @click.stop>
        <span class="i-ph-info" aria-hidden="true" />
      </button>
    </template>
    <div class="info-tip__body">
      <slot>{{ text }}</slot>
    </div>
  </NPopover>
</template>

<style scoped>
.info-tip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-left: 4px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--c-text-3);
  font-size: 15px;
  vertical-align: -3px;
  cursor: help;
}

.info-tip:hover,
.info-tip:focus-visible {
  color: var(--c-primary);
}

.info-tip:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: 1px;
}

/*
 * 手机宽度（WP54c）：ⓘ 只有 18px，手指点不准。用伪元素把**可点范围**扩到 44px，
 * 视觉占位仍是 18px（标题、表头不会因此变形）。
 */
@media (max-width: 640px) {
  .info-tip {
    position: relative;
  }

  .info-tip::after {
    position: absolute;
    inset: -13px;
    content: '';
  }
}

.info-tip__body {
  font-size: var(--fs-13);
  line-height: 1.6;
  color: var(--c-text-2);
}
</style>
