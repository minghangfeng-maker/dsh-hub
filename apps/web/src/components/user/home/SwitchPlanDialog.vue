<script setup lang="ts">
import type { MyComputeResponse } from '@dsh-hub/shared'
import { NModal, useDialog } from 'naive-ui'
import { computed } from 'vue'

import ComputePlans from '@/components/user/compute/ComputePlans.vue'

/**
 * 切换配置弹窗（15 §2.1）：点主卡片上的「切换配置」打开，里面是现有的规格卡片与联系文案。
 *
 * 行为与改版前一致：停止中选中即记住；运行中先弹 13 §7 的确认框（「将按新规格重启，并开始按新价格计费」），
 * 确认后才发请求。弹窗自己的关闭交给父组件（请求成功后关闭，失败时保留以便重试）。
 */
const props = withDefaults(
  defineProps<{
    show: boolean
    compute: MyComputeResponse
    /** 实例是否运行中（运行中换规格 = 按新规格重启） */
    running?: boolean
    /** 选规格请求进行中 */
    busy?: boolean
  }>(),
  { running: false, busy: false },
)

const emit = defineEmits<{
  'update:show': [value: boolean]
  select: [planId: string]
}>()

const dialog = useDialog()

const plans = computed(() => props.compute.plans)

function close(): void {
  emit('update:show', false)
}

function onSelect(planId: string): void {
  if (props.busy) return
  if (!props.running) {
    emit('select', planId)
    return
  }
  dialog.warning({
    title: '切换配置',
    content: '将按新规格重启，并开始按新价格计费。正在执行的任务会中断，对话、文件和插件都会保留。',
    positiveText: '切换并重启',
    negativeText: '再想想',
    onPositiveClick: () => emit('select', planId),
  })
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="切换配置"
    class="switch-plan-dialog"
    :style="{ maxWidth: '680px' }"
    :mask-closable="!busy"
    data-testid="switch-plan-dialog"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <p v-if="plans.length === 0" class="switch-plan-dialog__empty" data-testid="switch-plan-empty">
      管理员还没配置可用规格，请联系管理员。
    </p>
    <ComputePlans
      v-else
      :plans="plans"
      :selected-plan-id="compute.selectedPlanId"
      :contact-text="compute.contactText"
      :busy="busy"
      @select="onSelect"
    />

    <template #footer>
      <div class="switch-plan-dialog__footer">
        <span v-if="running" class="switch-plan-dialog__hint">运行中切换会按新规格重启</span>
        <button type="button" class="hub-btn-ghost" :disabled="busy" @click="close">关闭</button>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.switch-plan-dialog__empty {
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.switch-plan-dialog__footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.switch-plan-dialog__hint {
  margin-right: auto;
  color: var(--c-text-3);
  font-size: var(--fs-12);
}
</style>
