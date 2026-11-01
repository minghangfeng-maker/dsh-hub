<script setup lang="ts">
import type { Strategy } from '@dsh-hub/shared'
import { NForm, NFormItem, NInputNumber, NSelect } from 'naive-ui'
import { computed } from 'vue'

import InfoTip from '@/components/base/InfoTip.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import type { DeliveryDraft } from '@/composables/delivery-draft'

/**
 * 向导第 3 步：**策略**（docs/21 §1 ①）。只影响实例侧；只选了桌面端时整步跳过，
 * 两个平台都选时用 InfoTip 说明「只对实例生效」（不常驻小字，07 §2.7）。
 */
const props = defineProps<{ draft: DeliveryDraft }>()

const emit = defineEmits<{ 'update:draft': [DeliveryDraft] }>()

function setStrategy(partial: Partial<Strategy>): void {
  emit('update:draft', { ...props.draft, strategy: { ...props.draft.strategy, ...partial } })
}

const concurrency = computed({
  get: () => props.draft.strategy.concurrency,
  set: (value: number | null) => setStrategy({ concurrency: value ?? 1 }),
})

const canary = computed({
  get: () => props.draft.strategy.canary,
  set: (value: number | null) => setStrategy({ canary: value ?? 0 }),
})

const maxFailureRatio = computed({
  get: () => props.draft.strategy.maxFailureRatio,
  set: (value: number | null) => setStrategy({ maxFailureRatio: value ?? 0 }),
})

const restart = computed({
  get: () => props.draft.strategy.restart,
  set: (value: Strategy['restart']) => setStrategy({ restart: value }),
})
</script>

<template>
  <SoftCard>
    <template #header>
      <h3 class="strategy__title">策略</h3>
      <InfoTip
        label="执行顺序说明"
        :text="`先串行执行前 ${props.draft.strategy.canary} 个金丝雀用户，任一失败会暂停任务等你决定；其余用户按并发 ${props.draft.strategy.concurrency} 执行，失败比例超过 ${Math.round(props.draft.strategy.maxFailureRatio * 100)}% 自动暂停。`"
      />
      <InfoTip
        v-if="props.draft.platforms.includes('desktop')"
        label="策略适用范围"
        text="这些策略只对实例生效；桌面端按设备心跳拉取清单，不受并发与金丝雀影响。"
      />
    </template>

    <NForm label-placement="top" size="small" class="strategy__form">
      <NFormItem label="并发数（1–8）">
        <NInputNumber v-model:value="concurrency" :min="1" :max="8" data-testid="delivery-concurrency" />
      </NFormItem>
      <NFormItem label="金丝雀数量（0–5）">
        <NInputNumber v-model:value="canary" :min="0" :max="5" data-testid="delivery-canary" />
      </NFormItem>
      <NFormItem label="失败暂停阈值（0–1）">
        <NInputNumber
          v-model:value="maxFailureRatio"
          :min="0"
          :max="1"
          :step="0.05"
          data-testid="delivery-failure-ratio"
        />
      </NFormItem>
      <NFormItem label="重启时机">
        <NSelect
          v-model:value="restart"
          :options="[
            { label: '立即重启（now）', value: 'now' },
            { label: '下次启动时生效（next-start）', value: 'next-start' },
          ]"
          data-testid="delivery-restart"
        />
      </NFormItem>
    </NForm>
  </SoftCard>
</template>

<style scoped>
.strategy__title {
  color: var(--c-text);
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}

.strategy__form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-2) var(--space-4);
}
</style>
