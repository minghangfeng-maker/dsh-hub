<script setup lang="ts">
import { computed } from 'vue'

import { TONE_VARS, type AdminTone } from '@/components/admin/tone'

/**
 * 小标签（插件策略、bundle、角色…）：胶囊形状 + 令牌配色。
 */
const props = withDefaults(
  defineProps<{
    text: string
    tone?: AdminTone
    icon?: string
    /**
     * `lg` 给「本身就是数据、又要按正文字号展示」的标签（例：实例卡片的会话状态），
     * 避免被 07 §2.7 的小字走查当成说明文字（WP32d）。
     */
    size?: 'sm' | 'md' | 'lg'
  }>(),
  { tone: 'neutral', icon: undefined, size: 'md' },
)

const tone = computed(() => TONE_VARS[props.tone])
</script>

<template>
  <span
    class="mini-tag"
    :class="`mini-tag--${size}`"
    :style="{ '--tag-color': tone.ink, '--tag-soft': tone.soft }"
  >
    <span v-if="icon" :class="icon" aria-hidden="true" />
    {{ text }}
  </span>
</template>

<style scoped>
.mini-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  /* 07 §2.8：状态胶囊 / 标签文字不从中间断开，换行只能发生在两个胶囊之间 */
  white-space: nowrap;
  border-radius: var(--radius-pill);
  background: var(--tag-soft);
  color: var(--tag-color);
  font-weight: var(--fw-semibold);
  line-height: 1.5;
  white-space: nowrap;
}

.mini-tag--md {
  padding: 2px var(--space-3);
  font-size: var(--fs-12);
}

.mini-tag--sm {
  padding: 0 var(--space-2);
  font-size: var(--fs-12);
}

.mini-tag--lg {
  padding: 2px var(--space-3);
  font-size: var(--fs-14);
}
</style>
