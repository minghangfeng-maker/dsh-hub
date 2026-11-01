<script setup lang="ts">
import type { ToolSettings, ToolSettingsResponse, UpdateToolSettingsRequest } from '@dsh-hub/shared'
import { NAlert, NButton, NForm, NFormItem, NInput, NInputNumber, NSwitch, useMessage } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import { getToolSettings, updateToolSettings } from '@/api/tools'
import { describeError } from '@/api/errors'
import CopyText from '@/components/base/CopyText.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { useAsyncData } from '@/composables/useAsyncData'
import { microToPointsInput, pointsToMicro } from '@/utils/points'

/**
 * 中转站 · 搜索池 · 设置（14 §3.2 §7）：总开关、下发到 DSH、每月免费次数、两种单价（按「积分」录入）、
 * 每分钟限流、最多尝试数、冷却秒数；下方只读显示容器内 / 公网地址。
 *
 * 保存只提交**改动过的字段**（04 §8 的 PATCH 语义），免得把并发编辑的别的字段覆盖回去。
 */
const message = useMessage()

const { data, loading, reload } = useAsyncData(() => getToolSettings())

const form = ref<ToolSettings>({
  enabled: false,
  deliverToDsh: false,
  freeCallsPerMonth: 100,
  searchPriceMicro: 10_000,
  fetchPriceMicro: 10_000,
  perUserPerMinute: 30,
  maxAttempts: 3,
  keyCooldownSeconds: 60,
})
const searchPriceText = ref('0.01')
const fetchPriceText = ref('0.01')
const saving = ref(false)
const errorText = ref('')

const addresses = computed<ToolSettingsResponse | null>(() => data.value ?? null)

watch(
  () => data.value,
  (response) => {
    if (!response) return
    form.value = { ...response.settings }
    searchPriceText.value = microToPointsInput(response.settings.searchPriceMicro)
    fetchPriceText.value = microToPointsInput(response.settings.fetchPriceMicro)
  },
  { immediate: true },
)

/** 只把与已加载设置不同的字段拼进请求体（价格要先从「积分」文本换算成微积分） */
function buildPatch(): UpdateToolSettingsRequest | null {
  const loaded = data.value?.settings
  if (!loaded) return null

  const searchMicro = pointsToMicro(searchPriceText.value)
  const fetchMicro = pointsToMicro(fetchPriceText.value)
  if (searchMicro === null || fetchMicro === null) return null

  const patch: UpdateToolSettingsRequest = {}
  if (form.value.enabled !== loaded.enabled) patch.enabled = form.value.enabled
  if (form.value.deliverToDsh !== loaded.deliverToDsh) patch.deliverToDsh = form.value.deliverToDsh
  if (form.value.freeCallsPerMonth !== loaded.freeCallsPerMonth) {
    patch.freeCallsPerMonth = form.value.freeCallsPerMonth
  }
  if (searchMicro !== loaded.searchPriceMicro) patch.searchPriceMicro = searchMicro
  if (fetchMicro !== loaded.fetchPriceMicro) patch.fetchPriceMicro = fetchMicro
  if (form.value.perUserPerMinute !== loaded.perUserPerMinute) {
    patch.perUserPerMinute = form.value.perUserPerMinute
  }
  if (form.value.maxAttempts !== loaded.maxAttempts) patch.maxAttempts = form.value.maxAttempts
  if (form.value.keyCooldownSeconds !== loaded.keyCooldownSeconds) {
    patch.keyCooldownSeconds = form.value.keyCooldownSeconds
  }

  return Object.keys(patch).length > 0 ? patch : null
}

async function save(): Promise<void> {
  const patch = buildPatch()
  if (patch === null) {
    if (pointsToMicro(searchPriceText.value) === null || pointsToMicro(fetchPriceText.value) === null) {
      errorText.value = '单价填得不对：填数字，最多 6 位小数'
    } else {
      message.info('没有改动')
    }
    return
  }

  errorText.value = ''
  saving.value = true
  try {
    const result = await updateToolSettings(patch)
    data.value = result
    message.success('设置已保存')
  } catch (error) {
    errorText.value = describeError(error).message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="tools-settings">
    <SoftCard title="总开关与计费">
      <template #extra>
        <NButton size="tiny" quaternary :loading="loading" @click="reload">刷新</NButton>
      </template>

      <NForm label-placement="left" label-width="200" size="small" class="tools-settings__form">
        <NFormItem>
          <template #label>
            启用搜索池
            <InfoTip text="关掉后 /v1/tools/* 一律 503，用户端「积分与用量」也不显示搜索卡片。" />
          </template>
          <NSwitch v-model:value="form.enabled" size="small" data-testid="tools-enabled" />
        </NFormItem>

        <NFormItem>
          <template #label>
            下发到 DSH
            <InfoTip
              text="把用户的 web 搜索 / 抓取指向 Hub（插件 @deepseek-ai/dsh-web-deepseek-api）。改完要下发并重启用户实例才生效。"
            />
          </template>
          <div class="tools-settings__inline">
            <NSwitch v-model:value="form.deliverToDsh" size="small" data-testid="tools-deliver" />
            <span v-if="form.deliverToDsh" class="tools-settings__hint">
              需要下发并重启用户实例后生效 ·
              <RouterLink class="hub-link" to="/admin/rollouts/new?kind=models">去下发</RouterLink>
            </span>
          </div>
        </NFormItem>

        <NFormItem label="每月免费次数">
          <NInputNumber
            v-model:value="form.freeCallsPerMonth"
            size="small"
            :min="0"
            :max="100000"
            :show-button="false"
            class="tools-settings__number"
            data-testid="tools-free-calls"
          />
        </NFormItem>

        <NFormItem label="搜索单价（积分 / 次）">
          <NInput
            v-model:value="searchPriceText"
            class="tools-settings__number"
            placeholder="0.01"
            data-testid="tools-search-price"
          />
        </NFormItem>

        <NFormItem label="抓取单价（积分 / 次）">
          <NInput
            v-model:value="fetchPriceText"
            class="tools-settings__number"
            placeholder="0.01"
            data-testid="tools-fetch-price"
          />
        </NFormItem>

        <NFormItem label="每用户每分钟限流">
          <NInputNumber
            v-model:value="form.perUserPerMinute"
            size="small"
            :min="1"
            :max="600"
            :show-button="false"
            class="tools-settings__number"
          />
        </NFormItem>

        <NFormItem label="最多尝试候选数">
          <NInputNumber
            v-model:value="form.maxAttempts"
            size="small"
            :min="1"
            :max="10"
            :show-button="false"
            class="tools-settings__number"
          />
        </NFormItem>

        <NFormItem label="密钥 429 冷却（秒）">
          <NInputNumber
            v-model:value="form.keyCooldownSeconds"
            size="small"
            :min="1"
            :max="3600"
            :show-button="false"
            class="tools-settings__number"
          />
        </NFormItem>
      </NForm>

      <NAlert v-if="errorText" type="error" :bordered="false" class="tools-settings__alert">
        {{ errorText }}
      </NAlert>

      <div class="tools-settings__actions">
        <NButton
          size="small"
          type="primary"
          :loading="saving"
          data-testid="tools-settings-save"
          @click="save"
        >
          保存设置
        </NButton>
      </div>
    </SoftCard>

    <SoftCard title="地址（只读）">
      <div class="tools-settings__addresses">
        <CopyText v-if="addresses?.internalBaseUrl" :text="addresses.internalBaseUrl" label="容器内 DSH 用" />
        <p v-else class="tools-settings__hint">内部监听器没开，用户的 DSH 暂时接不上。</p>
        <CopyText v-if="addresses" :text="addresses.publicBaseUrl" label="外部工具用" />
      </div>
    </SoftCard>
  </div>
</template>

<style scoped>
.tools-settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.tools-settings__form {
  max-width: 680px;
}

.tools-settings__number {
  width: 150px;
}

.tools-settings__inline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.tools-settings__hint {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.tools-settings__alert {
  margin-top: var(--space-2);
  border-radius: var(--radius-control);
}

.tools-settings__actions {
  margin-top: var(--space-3);
}

.tools-settings__addresses {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
</style>
