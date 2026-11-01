<script setup lang="ts">
import type { RelayWalletRow } from '@dsh-hub/shared'
import { NAlert, NButton, NForm, NFormItem, NInput, NModal, useMessage } from 'naive-ui'
import { computed, ref, watch } from 'vue'

import { adjustRelayWallet } from '@/api/admin-relay'
import { describeError } from '@/api/errors'
import { formatPoints, pointsToMicro } from '@/utils/points'

/**
 * 加 / 扣积分弹窗（12 §10）：金额可正可负（界面按「积分」填），
 * 二次确认里显示调整后的余额；提交后写流水与审计（服务端）。
 *
 * 管理端「积分」Tab 与用户详情的「积分」小卡共用这一个组件。
 */
const props = defineProps<{
  show: boolean
  wallet: RelayWalletRow | null
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  saved: [wallet: RelayWalletRow]
}>()

const message = useMessage()

const step = ref<'form' | 'confirm'>('form')
const amountText = ref('')
const note = ref('')
const submitting = ref(false)
const errorText = ref('')

watch(
  () => props.show,
  (visible) => {
    if (!visible) return
    step.value = 'form'
    amountText.value = ''
    note.value = ''
    errorText.value = ''
  },
)

const amountMicro = computed(() => pointsToMicro(amountText.value))
const amountProblem = computed(() => {
  if (!amountText.value.trim()) return '填一个金额（正数加、负数扣）'
  if (amountMicro.value === null) return '金额得是数字，最多 6 位小数'
  if (amountMicro.value === 0) return '金额不能是 0'
  if (Math.abs(amountMicro.value) > 1_000_000 * 1_000_000) return '单次最多 100 万积分'
  return ''
})

/** 确认步骤里的「调整后余额」 */
const balanceAfter = computed(() => (props.wallet?.balanceMicro ?? 0) + (amountMicro.value ?? 0))

const signedAmount = computed(() => {
  const micro = amountMicro.value ?? 0
  return `${micro > 0 ? '+' : ''}${formatPoints(micro)}`
})

function quick(value: string): void {
  amountText.value = value
}

function toConfirm(): void {
  if (amountProblem.value) {
    errorText.value = amountProblem.value
    return
  }
  errorText.value = ''
  step.value = 'confirm'
}

async function submit(): Promise<void> {
  const wallet = props.wallet
  const micro = amountMicro.value
  if (!wallet || micro === null || micro === 0) return

  submitting.value = true
  try {
    const updated = await adjustRelayWallet(wallet.userId, { amountMicro: micro, note: note.value.trim() })
    message.success(
      `${micro > 0 ? '已加' : '已扣'} ${formatPoints(Math.abs(micro))} 积分，现在余额 ${formatPoints(updated.balanceMicro)}`,
    )
    emit('saved', updated)
    emit('update:show', false)
  } catch (error) {
    errorText.value = describeError(error).message
    step.value = 'form'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    :title="step === 'form' ? '加 / 扣积分' : '确认调整'"
    :style="{ maxWidth: '480px' }"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <p v-if="wallet" class="adjust__user">
      {{ wallet.displayName || wallet.username }}（@{{ wallet.username }}）· 当前余额
      <strong>{{ formatPoints(wallet.balanceMicro) }}</strong> 积分
    </p>

    <template v-if="step === 'form'">
      <NForm label-placement="top" size="small">
        <NFormItem label="金额（积分）">
          <NInput v-model:value="amountText" placeholder="10 或 -5" @keyup.enter="toConfirm" />
        </NFormItem>
        <div class="adjust__quick">
          <NButton size="tiny" quaternary @click="quick('10')">+10</NButton>
          <NButton size="tiny" quaternary @click="quick('50')">+50</NButton>
          <NButton size="tiny" quaternary @click="quick('100')">+100</NButton>
          <NButton size="tiny" quaternary @click="quick('-10')">-10</NButton>
        </div>
        <NFormItem label="备注">
          <NInput v-model:value="note" maxlength="200" placeholder="为什么加 / 扣，以后好对账" />
        </NFormItem>
      </NForm>
    </template>

    <template v-else>
      <dl class="adjust__confirm">
        <div>
          <dt>当前余额</dt>
          <dd>{{ formatPoints(wallet?.balanceMicro ?? 0) }} 积分</dd>
        </div>
        <div>
          <dt>本次调整</dt>
          <dd :class="(amountMicro ?? 0) > 0 ? 'adjust__plus' : 'adjust__minus'">{{ signedAmount }} 积分</dd>
        </div>
        <div class="adjust__after">
          <dt>调整后余额</dt>
          <dd>{{ formatPoints(balanceAfter) }} 积分</dd>
        </div>
      </dl>
      <p v-if="note.trim()" class="adjust__hint">备注：{{ note.trim() }}</p>
    </template>

    <NAlert v-if="errorText" type="error" :bordered="false" class="adjust__alert">{{ errorText }}</NAlert>

    <template #footer>
      <div class="adjust__footer">
        <NButton v-if="step === 'confirm'" size="small" @click="step = 'form'">返回修改</NButton>
        <NButton size="small" @click="emit('update:show', false)">取消</NButton>
        <NButton v-if="step === 'form'" size="small" type="primary" @click="toConfirm">下一步</NButton>
        <NButton v-else size="small" type="primary" :loading="submitting" @click="submit">确认调整</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.adjust__user {
  margin-bottom: var(--space-3);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.adjust__quick {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
  margin-bottom: var(--space-3);
}

.adjust__hint {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.adjust__confirm {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  font-size: var(--fs-13);
}

.adjust__confirm > div {
  display: flex;
  gap: var(--space-2);
}

.adjust__confirm dt {
  width: 88px;
  flex: none;
  color: var(--c-text-3);
}

.adjust__confirm dd {
  color: var(--c-text);
  font-family: var(--font-mono);
}

.adjust__after dd {
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
}

.adjust__plus {
  color: var(--c-success-ink);
}

.adjust__minus {
  color: var(--c-danger-ink);
}

.adjust__alert {
  margin-top: var(--space-3);
  border-radius: var(--radius-control);
}

.adjust__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
