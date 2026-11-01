<script setup lang="ts">
import type { RelaySettings, RelaySettingsResponse } from '@dsh-hub/shared'
import { NAlert, NButton, NForm, NFormItem, NInput, NInputNumber, NSwitch, useMessage } from 'naive-ui'
import { computed, ref, watch } from 'vue'

import { getRelaySettings, updateRelaySettings } from '@/api/admin-relay'
import { describeError } from '@/api/errors'
import CopyText from '@/components/base/CopyText.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { useAsyncData } from '@/composables/useAsyncData'
import { microToPointsInput, pointsToMicro } from '@/utils/points'

/**
 * 中转站 · 设置（12 §10）：`RelaySettings` 表单（赠送积分按「积分」录入）+ 只读的内部 / 公网地址。
 */
const message = useMessage()

const { data, loading, reload } = useAsyncData(() => getRelaySettings())

const form = ref<RelaySettings>({
  enabled: true,
  signupBonusMicro: 0,
  dailyBonusMicro: 0,
  defaultMaxConcurrency: 4,
  maxAttempts: 3,
  keyCooldownSeconds: 60,
  channelFailureThreshold: 5,
  channelCooldownSeconds: 60,
  logRetentionDays: 90,
})
const bonusText = ref('0')
const dailyBonusText = ref('0')
const saving = ref(false)
const errorText = ref('')

const addresses = computed<RelaySettingsResponse | null>(() => data.value ?? null)

watch(
  () => data.value,
  (settings) => {
    if (!settings) return
    form.value = { ...settings.settings }
    bonusText.value = microToPointsInput(settings.settings.signupBonusMicro)
    dailyBonusText.value = microToPointsInput(settings.settings.dailyBonusMicro)
  },
  { immediate: true },
)

async function save(): Promise<void> {
  const bonus = pointsToMicro(bonusText.value)
  const dailyBonus = pointsToMicro(dailyBonusText.value)
  if (bonus === null) {
    errorText.value = '赠送积分填得不对：填数字，最多 6 位小数'
    return
  }
  if (dailyBonus === null) {
    errorText.value = '每日赠送填得不对：填数字，最多 6 位小数'
    return
  }
  errorText.value = ''
  saving.value = true
  try {
    const result = await updateRelaySettings({
      ...form.value,
      signupBonusMicro: bonus,
      dailyBonusMicro: dailyBonus,
    })
    form.value = { ...result.settings }
    bonusText.value = microToPointsInput(result.settings.signupBonusMicro)
    dailyBonusText.value = microToPointsInput(result.settings.dailyBonusMicro)
    message.success('设置已保存')
    await reload()
  } catch (error) {
    errorText.value = describeError(error).message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="relay-settings">
    <SoftCard title="总开关与默认值">
      <template #extra>
        <NButton size="tiny" quaternary :loading="loading" @click="reload">刷新</NButton>
      </template>

      <NForm label-placement="left" label-width="180" size="small" class="relay-settings__form">
        <NFormItem>
          <template #label>
            启用中转站
            <InfoTip text="关掉后 `/v1` 一律 503，用户的「积分与用量」页也会隐藏。" />
          </template>
          <div class="relay-settings__inline">
            <NSwitch v-model:value="form.enabled" size="small" />
          </div>
        </NFormItem>

        <NFormItem label="注册赠送（积分）">
          <NInput v-model:value="bonusText" class="relay-settings__number" placeholder="0" />
        </NFormItem>

        <NFormItem>
          <template #label>
            每日赠送（积分）
            <InfoTip text="每天首次登录发放；次日作废未用完的部分，不累计。0 = 关闭。" />
          </template>
          <NInput v-model:value="dailyBonusText" class="relay-settings__number" placeholder="0" data-testid="relay-daily-bonus" />
        </NFormItem>

        <NFormItem label="默认并发上限">
          <NInputNumber
            v-model:value="form.defaultMaxConcurrency"
            size="small"
            :min="1"
            :max="64"
            :show-button="false"
            class="relay-settings__number"
          />
        </NFormItem>

        <NFormItem label="最多尝试候选数">
          <NInputNumber
            v-model:value="form.maxAttempts"
            size="small"
            :min="1"
            :max="10"
            :show-button="false"
            class="relay-settings__number"
          />
        </NFormItem>

        <NFormItem label="密钥 429 冷却（秒）">
          <NInputNumber
            v-model:value="form.keyCooldownSeconds"
            size="small"
            :min="1"
            :max="3600"
            :show-button="false"
            class="relay-settings__number"
          />
        </NFormItem>

        <NFormItem label="渠道熔断阈值（次）">
          <NInputNumber
            v-model:value="form.channelFailureThreshold"
            size="small"
            :min="1"
            :max="100"
            :show-button="false"
            class="relay-settings__number"
          />
        </NFormItem>

        <NFormItem label="渠道熔断时长（秒）">
          <NInputNumber
            v-model:value="form.channelCooldownSeconds"
            size="small"
            :min="1"
            :max="3600"
            :show-button="false"
            class="relay-settings__number"
          />
        </NFormItem>

        <NFormItem label="用量记录保留（天）">
          <NInputNumber
            v-model:value="form.logRetentionDays"
            size="small"
            :min="7"
            :max="3650"
            :show-button="false"
            class="relay-settings__number"
          />
        </NFormItem>
      </NForm>

      <NAlert v-if="errorText" type="error" :bordered="false" class="relay-settings__alert">{{ errorText }}</NAlert>

      <div class="relay-settings__actions">
        <NButton size="small" type="primary" :loading="saving" @click="save">保存设置</NButton>
      </div>
    </SoftCard>

    <SoftCard title="地址（只读）">
      <div class="relay-settings__addresses">
        <CopyText
          v-if="addresses?.internalBaseUrl"
          :text="addresses.internalBaseUrl"
          label="容器内 DSH 用"
        />
        <p v-else class="relay-settings__hint">内部监听器没开（或用户网络网关查不到），用户的 DSH 暂时接不上。</p>
        <CopyText v-if="addresses" :text="addresses.publicBaseUrl" label="外部工具用" />
      </div>
    </SoftCard>
  </div>
</template>

<style scoped>
.relay-settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.relay-settings__form {
  max-width: 640px;
}

.relay-settings__number {
  width: 140px;
}

.relay-settings__inline {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.relay-settings__hint {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.relay-settings__alert {
  margin-top: var(--space-2);
  border-radius: var(--radius-control);
}

.relay-settings__actions {
  margin-top: var(--space-3);
}

.relay-settings__addresses {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
</style>
