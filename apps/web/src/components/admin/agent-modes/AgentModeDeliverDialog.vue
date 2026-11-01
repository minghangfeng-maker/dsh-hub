<script setup lang="ts">
import type { DeliverAgentModeRequest } from '@dsh-hub/shared'
import { NButton, NCheckbox, NModal, NRadio, NRadioGroup } from 'naive-ui'
import { ref, watch } from 'vue'

/**
 * 下发确认弹窗（18 §4.2 §6）：重启时机 + 是否自动装插件；点确认后由父组件先过 `ReauthGate`。
 * 后果（影响多少用户、会不会中断对话）写在弹窗里，不放到页面上当常驻小字（07 §2.7）。
 */
const props = defineProps<{
  show: boolean
  /** 这次会处理多少位用户 */
  users: number
  submitting: boolean
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  confirm: [payload: Required<DeliverAgentModeRequest>]
}>()

const restart = ref<DeliverAgentModeRequest['restart']>('now')
const installPlugin = ref(true)

watch(
  () => props.show,
  (visible) => {
    if (!visible) return
    restart.value = 'now'
    installPlugin.value = true
  },
)

function confirm(): void {
  emit('confirm', {
    restart: restart.value === 'next-start' ? 'next-start' : 'now',
    installPlugin: installPlugin.value,
  })
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="下发配置"
    :style="{ width: 'calc(100vw - 24px)', maxWidth: '540px' }"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <p class="agent-deliver__summary">
      会处理
      <span class="agent-deliver__num">{{ users }}</span>
      位用户：写入容器环境变量、给没装插件的用户装插件。
    </p>

    <div class="agent-deliver__block">
      <p class="agent-deliver__label">什么时候生效</p>
      <NRadioGroup v-model:value="restart" data-testid="agent-deliver-restart">
        <NRadio value="now">立即重启（会中断对话）</NRadio>
        <NRadio value="next-start">下次启动生效</NRadio>
      </NRadioGroup>
    </div>

    <NCheckbox v-model:checked="installPlugin" data-testid="agent-deliver-install">
      没装插件的用户自动安装最新版本
    </NCheckbox>

    <template #footer>
      <div class="agent-deliver__footer">
        <NButton size="small" @click="emit('update:show', false)">取消</NButton>
        <NButton
          size="small"
          type="primary"
          :loading="submitting"
          data-testid="agent-deliver-confirm"
          @click="confirm"
        >
          确认下发
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.agent-deliver__summary {
  margin-bottom: var(--space-4);
  color: var(--c-text-2);
  font-size: var(--fs-14);
}

.agent-deliver__num {
  color: var(--c-text);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}

.agent-deliver__block {
  margin-bottom: var(--space-4);
}

.agent-deliver__label {
  margin-bottom: var(--space-2);
  color: var(--c-text);
  font-size: var(--fs-13);
  font-weight: var(--fw-semibold);
}

.agent-deliver__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
