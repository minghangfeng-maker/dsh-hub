<script setup lang="ts">
import type { PluginCard } from '@dsh-hub/shared'
import { computed } from 'vue'

/**
 * 插件图标（07 §6.2 卡片网格）：`icon` 是图片地址时用 `<img>`，
 * 否则退回「首字 + 柔和底色」或通用拼图图标。颜色只用令牌，禁止写死（CONTRIBUTING.md 的工程约定）。
 */
const props = withDefaults(defineProps<{ plugin: PluginCard; size?: number }>(), { size: 40 })

const isImage = computed(() => /^(https?:)?\/\//.test(props.plugin.icon ?? '') || (props.plugin.icon ?? '').startsWith('data:image/'))

const initial = computed(() => {
  const source = props.plugin.displayName.trim()
  const [first] = Array.from(source)
  return (first ?? '?').toUpperCase()
})
</script>

<template>
  <span
    class="plugin-icon"
    :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px` }"
    :aria-label="plugin.displayName"
  >
    <img v-if="isImage" :src="plugin.icon ?? ''" :alt="plugin.displayName" class="plugin-icon__img" />
    <template v-else-if="plugin.displayName">{{ initial }}</template>
    <span v-else class="i-ph-puzzle-piece" aria-hidden="true" />
  </span>
</template>

<style scoped>
.plugin-icon {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
  font-weight: var(--fw-semibold);
}

.plugin-icon__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
