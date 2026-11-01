<script setup lang="ts">
import { computed, toRef } from 'vue'

import { PASSWORD_LEVEL_TEXT, usePasswordStrength } from '@/composables/usePasswordStrength'

/**
 * 密码强度条（07 §5.2）：三段渐变 珊瑚 → 琥珀 → 水绿。
 * 评分规则与后端一致（见 composables/usePasswordStrength.ts），不满足的规则就地列出（读屏可读）。
 */
const props = withDefaults(
  defineProps<{
    password: string
    /** 用户名：用于「不能与用户名相同」检查 */
    username?: string
    /** 是否列出不满足的规则 */
    showReasons?: boolean
  }>(),
  { username: undefined, showReasons: true },
)

const { score, level, reasons } = usePasswordStrength(toRef(props, 'password'), toRef(props, 'username'))

const levelText = computed(() => PASSWORD_LEVEL_TEXT[level.value])
/** 三段颜色固定：珊瑚 / 琥珀 / 水绿 */
const SEGMENT_COLORS = ['var(--c-danger)', 'var(--c-warning)', 'var(--c-success)'] as const
</script>

<template>
  <!-- 没开始输入时不显示强度与规则，避免干扰（07 §5.2） -->
  <div v-if="password.length > 0" class="password-strength">
    <div class="password-strength__row">
      <div class="password-strength__segments" aria-hidden="true">
        <span
          v-for="(color, index) in SEGMENT_COLORS"
          :key="color"
          class="password-strength__segment"
          :style="{
            background: index < score ? color : 'var(--c-border)',
          }"
        />
      </div>
      <span class="password-strength__level" :class="`password-strength__level--${level}`">
        强度：{{ levelText }}
      </span>
    </div>

    <ul v-if="showReasons && reasons.length > 0" class="password-strength__reasons" aria-live="polite">
      <li v-for="reason in reasons" :key="reason" class="password-strength__reason">
        <span class="i-ph-info" aria-hidden="true" />
        {{ reason }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
.password-strength {
  margin-top: var(--space-2);
}

.password-strength__row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.password-strength__segments {
  display: flex;
  flex: 1;
  gap: var(--space-1);
}

.password-strength__segment {
  height: 6px;
  flex: 1;
  border-radius: var(--radius-pill);
  transition: background-color var(--duration-base) var(--ease-out-soft);
}

.password-strength__level {
  flex: none;
  color: var(--c-text-2);
  font-size: var(--fs-12);
}

.password-strength__level--medium {
  color: var(--c-text);
}

.password-strength__level--strong {
  color: var(--c-success-ink);
}

.password-strength__reasons {
  margin-top: var(--space-1);
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.password-strength__reason {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
</style>
