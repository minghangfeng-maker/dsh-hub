<script setup lang="ts">
import type { RelayWalletRow } from '@dsh-hub/shared'
import { NAlert, NButton, NForm, NFormItem, NInput, NInputNumber, NModal, NSwitch, useMessage } from 'naive-ui'
import { ref, watch } from 'vue'

import { updateRelayWallet } from '@/api/admin-relay'
import { describeError } from '@/api/errors'
import InfoTip from '@/components/base/InfoTip.vue'
import { microToPointsInput, pointsToMicro } from '@/utils/points'

/**
 * 钱包设置弹窗（12 §10）：计费倍率（%）、并发上限、日上限积分、启用。
 * 并发留空 = 用设置里的默认值；日上限留空 = 不限。
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

const ratePercent = ref(100)
const maxConcurrency = ref<number | null>(null)
const dailyLimitText = ref('')
const enabled = ref(true)
const saving = ref(false)
const errorText = ref('')

watch(
  () => props.show,
  (visible) => {
    if (!visible) return
    const wallet = props.wallet
    ratePercent.value = wallet?.ratePercent ?? 100
    maxConcurrency.value = wallet?.maxConcurrency ?? null
    dailyLimitText.value = wallet?.dailyLimitMicro === null || wallet?.dailyLimitMicro === undefined
      ? ''
      : microToPointsInput(wallet.dailyLimitMicro)
    enabled.value = wallet?.enabled ?? true
    errorText.value = ''
  },
)

async function save(): Promise<void> {
  const wallet = props.wallet
  if (!wallet) return

  let dailyLimitMicro: number | null = null
  if (dailyLimitText.value.trim()) {
    dailyLimitMicro = pointsToMicro(dailyLimitText.value)
    if (dailyLimitMicro === null) {
      errorText.value = '日上限填得不对：填数字，最多 6 位小数；留空 = 不限'
      return
    }
  }

  saving.value = true
  try {
    const updated = await updateRelayWallet(wallet.userId, {
      ratePercent: ratePercent.value,
      maxConcurrency: maxConcurrency.value,
      dailyLimitMicro,
      enabled: enabled.value,
    })
    message.success('钱包设置已保存')
    emit('saved', updated)
    emit('update:show', false)
  } catch (error) {
    errorText.value = describeError(error).message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="钱包设置"
    :style="{ maxWidth: '480px' }"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <p v-if="wallet" class="wallet-settings__user">
      {{ wallet.displayName || wallet.username }}（@{{ wallet.username }}）
    </p>

    <NForm label-placement="top" size="small">
      <NFormItem label="计费倍率（%）">
        <NInputNumber v-model:value="ratePercent" size="small" :min="0" :max="1000" :show-button="false" />
      </NFormItem>

      <NFormItem label="并发上限">
        <NInputNumber
          v-model:value="maxConcurrency"
          size="small"
          :min="1"
          :max="64"
          :show-button="false"
          placeholder="留空 = 用全局默认"
        />
      </NFormItem>

      <NFormItem label="日上限（积分）">
        <NInput v-model:value="dailyLimitText" placeholder="留空 = 不限" />
      </NFormItem>

      <NFormItem>
        <template #label>
          启用
          <InfoTip text="停用后这个用户的所有请求都会被挡（403），但余额和记录都保留。" />
        </template>
        <NSwitch v-model:value="enabled" size="small" />
      </NFormItem>
    </NForm>

    <NAlert v-if="errorText" type="error" :bordered="false" class="wallet-settings__alert">{{ errorText }}</NAlert>

    <template #footer>
      <div class="wallet-settings__footer">
        <NButton size="small" @click="emit('update:show', false)">取消</NButton>
        <NButton size="small" type="primary" :loading="saving" @click="save">保存</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.wallet-settings__user {
  margin-bottom: var(--space-3);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.wallet-settings__alert {
  margin-top: var(--space-2);
  border-radius: var(--radius-control);
}

.wallet-settings__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
