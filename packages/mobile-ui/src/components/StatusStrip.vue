<script setup lang="ts">
/**
 * 首页/对话页顶部的细状态条。
 *
 * 文案与语气全部由 stores/chat 的 `connectionBanner` 决定（0.4.1 起走 lib/connection-banner.ts
 * 的纯函数：宽限期内根本不挂载），组件本身不做业务判断；有可执行动作时
 * （暂时连不上 → 重试 / 唤醒失败 → 重试）才显示按钮。
 *
 * `tone`：info 中性（正在连接/正在唤醒）、warn 警示（暂时连不上）、error 不可重试的明确原因；
 * `ready` 是其它细提示（例如「有 N 个对话在等你回答」）沿用的中性样式。
 */
withDefaults(
  defineProps<{
    text: string
    tone?: 'info' | 'warn' | 'error' | 'ready'
    actionLabel?: string
  }>(),
  { tone: 'info', actionLabel: '' },
)

const emit = defineEmits<{ action: [] }>()
</script>

<template>
  <div class="wake-strip" :class="`wake-strip--${tone}`" role="status">
    <span class="wake-strip__dot" />
    <span class="wake-strip__text">{{ text }}</span>
    <button v-if="actionLabel" class="wake-strip__action" type="button" @click="emit('action')">
      {{ actionLabel }}
    </button>
  </div>
</template>

<style scoped>
.wake-strip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  height: 26px;
  margin: 0 12px 2px;
  padding: 0 12px;
  min-width: 0;
  overflow: hidden;
  border-radius: 9px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 11.5px;
  letter-spacing: 0.01em;
  flex: 0 0 auto;
}
.wake-strip__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wake-strip__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  animation: wake-pulse 1.4s ease-in-out infinite;
}
.wake-strip__action {
  flex: 0 0 auto;
  margin-left: 2px;
  padding: 2px 8px;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.55);
  color: inherit;
  font-size: 11.5px;
  font-weight: 600;
}
/* warn：4 秒后还在连 / 15 秒以上的警示（琥珀）。dot 停跳，别在「连不上」时还假装在忙。 */
.wake-strip--warn {
  background: rgba(224, 158, 45, 0.14);
  color: #b1761a;
}
.wake-strip--warn .wake-strip__dot {
  animation: none;
  background: currentColor;
}
/* error：不可重试的明确原因（未开通 / 积分不足等），用危险色。 */
.wake-strip--error {
  background: rgba(214, 81, 58, 0.1);
  color: var(--danger);
}
.wake-strip--error .wake-strip__dot {
  animation: none;
  background: currentColor;
}
@keyframes wake-pulse {
  0%,
  100% {
    opacity: 0.3;
    transform: scale(0.8);
  }
  50% {
    opacity: 1;
    transform: scale(1.15);
  }
}
</style>
