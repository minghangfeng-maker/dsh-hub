<script setup lang="ts">
import { computed } from 'vue'

import { STATUS_TONE_VARS, instanceStatusMeta } from '@/composables/useInstanceStatus'

/**
 * 实例状态胶囊（07 §2.1）：运行中带涟漪扩散的光点，启动/停止中带旋转细环。
 * 颜色只来自状态色调令牌，不写死色值。
 */
const props = withDefaults(
  defineProps<{
    /** 实例状态（04 §0.1 InstanceStatus） */
    status: string
    /** 覆盖文案（例如「未启动」） */
    label?: string
    size?: 'sm' | 'md'
    /** 是否显示左侧图标/光点 */
    showIcon?: boolean
  }>(),
  { label: undefined, size: 'md', showIcon: true },
)

const meta = computed(() => instanceStatusMeta(props.status))
const tone = computed(() => STATUS_TONE_VARS[meta.value.tone])
const text = computed(() => props.label ?? meta.value.text)
</script>

<template>
  <span
    class="status-pill"
    :class="[`status-pill--${size}`, `status-pill--${meta.tone}`]"
    :style="{ '--pill-color': tone.color, '--pill-soft': tone.soft }"
    role="status"
  >
    <span v-if="showIcon" class="status-pill__icon" aria-hidden="true">
      <span v-if="meta.spinner" class="status-pill__ring ring-spin" />
      <span
        v-else
        class="status-pill__dot"
        :class="{ breathe: meta.breathe, 'status-pill__dot--icon': !meta.breathe }"
      />
    </span>
    <span class="status-pill__text">{{ text }}</span>
  </span>
</template>

<style scoped>
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  border-radius: var(--radius-pill);
  background: var(--pill-soft);
  color: var(--pill-color);
  font-weight: var(--fw-semibold);
  line-height: 1.4;
  white-space: nowrap;
}

.status-pill--md {
  padding: 3px var(--space-3);
  font-size: var(--fs-13);
}

.status-pill--sm {
  padding: 1px var(--space-2);
  font-size: var(--fs-12);
}

.status-pill__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 10px;
  height: 10px;
}

.status-pill__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--pill-color);
}

/* 运行中：状态点向外扩散涟漪（2.4s，见 styles/motion.css），涟漪颜色跟随状态色 */
.status-pill__dot.breathe {
  --breathe-color: var(--pill-color);

  animation-name: breathe;
  animation-duration: var(--duration-breathe);
  animation-timing-function: ease-out;
  animation-iteration-count: infinite;
}

/* 其它状态：实心点 */
.status-pill__dot--icon {
  opacity: 0.85;
}

.status-pill__ring {
  width: 9px;
  height: 9px;
  border: 2px solid var(--pill-color);
  border-top-color: transparent;
  border-radius: 50%;
}

.status-pill__text {
  letter-spacing: 0.2px;
}

/* 减少动态效果：呼吸/旋转关闭（styles/motion.css 的全局规则已覆盖，这里再兜一层） */
@media (prefers-reduced-motion: reduce) {
  .status-pill__dot.breathe,
  .status-pill__ring {
    animation: none;
  }
}
</style>
