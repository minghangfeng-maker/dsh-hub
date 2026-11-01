<script setup lang="ts">
import type { DesktopChannelPolicy, DesktopReleaseChannel } from '@dsh-hub/shared'
import { NButton, NInput, NSwitch, useMessage } from 'naive-ui'
import { computed, ref, watch } from 'vue'

import { deliverDesktopApp } from '@/api/admin-desktop'
import { describeError } from '@/api/errors'
import MiniTag from '@/components/admin/MiniTag.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { isReauthCanceled, withReauth } from '@/composables/useReauth'
import {
  channelDraftOf,
  channelLabel,
  channelRequest,
  validateChannelDraft,
  type ChannelDraft,
} from '@/utils/desktop-delivery'

/**
 * 一个渠道的版本策略（D3 §7.3）：目标版本 / 最低版本 / 硬地板 / 灰度百分比。
 *
 * 灰度按 `sha256('desktop-rollout:'+deviceId)` 前 8 位取模 100 分桶，是**纯函数**：
 * 同一台设备永远落在同一个桶里（所以「50%」是稳定的一半，不是每次拉取重新掷骰子）。
 */
const props = defineProps<{
  channel: DesktopReleaseChannel
  policy: DesktopChannelPolicy | null
  /** 覆盖项的数量（0 = 渠道级策略对所有人生效） */
  overrideCount: number
}>()

const emit = defineEmits<{ changed: [] }>()

const message = useMessage()

const draft = ref<ChannelDraft>(channelDraftOf(props.policy ?? {
  targetVersion: null,
  minVersion: null,
  minVersionHard: false,
  rolloutPercent: 100,
}))
const errors = ref<Record<string, string>>({})
const saving = ref(false)

watch(
  () => props.policy,
  (policy) => {
    if (!policy) return
    draft.value = channelDraftOf(policy)
    errors.value = {}
  },
  { immediate: true },
)

const percentHint = computed(() => {
  const text = draft.value.rolloutPercent.trim()
  const percent = Number(text)
  if (text === '' || !Number.isFinite(percent)) return ''
  return percent >= 100 ? '所有设备' : `${String(percent)}% 的设备`
})

async function save(): Promise<void> {
  errors.value = validateChannelDraft(draft.value)
  if (Object.keys(errors.value).length > 0) return
  saving.value = true
  try {
    const result = await withReauth(() =>
      deliverDesktopApp(channelRequest(props.channel, draft.value)),
    )
    message.success(`${channelLabel(props.channel)}渠道已保存，新 revision r${String(result.revision)}`)
    emit('changed')
  } catch (cause) {
    if (!isReauthCanceled(cause)) message.error(describeError(cause).message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SoftCard data-testid="desk-channel-card">
    <template #header>
      <h3 class="channel__title">{{ channelLabel(channel) }}渠道</h3>
      <span class="channel__key">{{ channel }}</span>
    </template>
    <template #extra>
      <InfoTip
        text="灰度百分比按设备稳定分桶：同一台设备永远在同一个桶里，调大百分比只会让更多设备看到目标版本。"
      />
      <MiniTag
        v-if="overrideCount > 0"
        :text="`${String(overrideCount)} 条覆盖`"
        tone="sky"
        size="sm"
      />
    </template>

    <div class="channel__grid">
      <label class="channel__field">
        <span class="channel__label">目标版本</span>
        <NInput v-model:value="draft.targetVersion" size="small" placeholder="0.2.2" :data-testid="`desk-target-version-${channel}`" />
      </label>
      <label class="channel__field">
        <span class="channel__label">最低版本</span>
        <NInput v-model:value="draft.minVersion" size="small" placeholder="0.2.1" :data-testid="`desk-min-version-${channel}`" />
      </label>
      <label class="channel__field channel__field--switch">
        <span class="channel__label">硬地板</span>
        <NSwitch v-model:value="draft.minVersionHard" size="small" :data-testid="`desk-min-hard-${channel}`" />
      </label>
      <label class="channel__field channel__field--percent">
        <span class="channel__label">灰度</span>
        <span class="channel__percent">
          <NInput
            v-model:value="draft.rolloutPercent"
            size="small"
            placeholder="0–100"
            :data-testid="`desk-rollout-${channel}`"
          />
          <span class="channel__percent-unit">%</span>
        </span>
      </label>
    </div>

    <p v-if="errors['targetVersion']" class="channel__error" role="alert">{{ errors['targetVersion'] }}</p>
    <p v-if="errors['minVersion']" class="channel__error" role="alert">{{ errors['minVersion'] }}</p>
    <p v-if="errors['rolloutPercent']" class="channel__error" role="alert">{{ errors['rolloutPercent'] }}</p>

    <div class="channel__footer">
      <span class="channel__percent-scope">{{ percentHint }}</span>
      <NButton size="small" type="primary" :loading="saving" :data-testid="`desk-channel-save-${channel}`" @click="save">
        保存
      </NButton>
    </div>
  </SoftCard>
</template>

<style scoped>
.channel__title {
  color: var(--c-text);
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}

.channel__key {
  color: var(--c-text-3);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.channel__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: var(--space-3);
}

.channel__field {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-1);
}

.channel__field--switch {
  justify-content: flex-start;
}

.channel__field--percent {
  max-width: 150px;
}

.channel__percent {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.channel__percent-unit {
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.channel__label {
  color: var(--c-text-2);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.channel__error {
  margin-top: var(--space-2);
  color: var(--c-danger-ink);
  font-size: var(--fs-13);
}

.channel__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-top: var(--space-4);
}

.channel__percent-scope {
  color: var(--c-text-2);
  font-size: var(--fs-12);
  white-space: nowrap;
}
</style>
