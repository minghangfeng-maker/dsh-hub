<script setup lang="ts">
import type { DesktopPolicyOverride, DesktopReleaseChannel } from '@dsh-hub/shared'
import { NButton, NInput, NModal, NSelect, NSwitch, useMessage } from 'naive-ui'
import { computed, reactive, ref, watch } from 'vue'

import { deliverDesktopApp } from '@/api/admin-desktop'
import { describeError } from '@/api/errors'
import DesktopTargetField from '@/components/admin/desktop/DesktopTargetField.vue'
import { isReauthCanceled, withReauth } from '@/composables/useReauth'
import {
  channelLabel,
  scopeText,
  targetDraftOf,
  targetOfDraft,
  validateRolloutPercent,
  validateVersion,
  type TargetDraft,
} from '@/utils/desktop-delivery'

/**
 * 角色 / 用户的版本策略覆盖（D3 §7.3）。
 *
 * 字段留空 = 这一项回到渠道级取值；目标 + 两个版本都留空 = 删掉这条覆盖
 * （契约里 `targetVersion`/`minVersion` 传 null 就是「回到渠道级」）。
 */
const props = defineProps<{
  show: boolean
  /** 编辑已有覆盖时传进来；新建时为 null */
  editing: DesktopPolicyOverride | null
  defaultChannel: DesktopReleaseChannel
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  saved: []
}>()

const message = useMessage()

interface Form {
  channel: DesktopReleaseChannel
  target: TargetDraft
  targetVersion: string
  minVersion: string
  minVersionHard: boolean
  rolloutPercent: string
}

const form = reactive<Form>({
  channel: props.defaultChannel,
  target: { scope: 'role', role: 'user', userId: null },
  targetVersion: '',
  minVersion: '',
  minVersionHard: false,
  rolloutPercent: '',
})

const errors = ref<Record<string, string>>({})
const saving = ref(false)

function reset(): void {
  const editing = props.editing
  form.channel = editing?.channel ?? props.defaultChannel
  form.target = editing
    ? targetDraftOf(editing)
    : { scope: 'role', role: 'user', userId: null }
  form.targetVersion = editing?.targetVersion ?? ''
  form.minVersion = editing?.minVersion ?? ''
  form.minVersionHard = editing?.minVersionHard ?? false
  form.rolloutPercent = editing?.rolloutPercent === null || editing?.rolloutPercent === undefined ? '' : String(editing.rolloutPercent)
  errors.value = {}
}

watch(
  () => props.show,
  (show) => {
    if (show) reset()
  },
  { immediate: true },
)

const channelOptions = computed(() => [
  { label: channelLabel('latest'), value: 'latest' },
  { label: channelLabel('nightly'), value: 'nightly' },
])

/** 两个版本都留空 = 删掉覆盖（只有编辑时有意义） */
const clearing = computed(
  () => props.editing !== null && form.targetVersion.trim() === '' && form.minVersion.trim() === '',
)

async function save(): Promise<void> {
  errors.value = {}
  const target = targetOfDraft(form.target)
  if (!target || target.scope === 'all') {
    errors.value = { target: '覆盖只针对角色或指定用户' }
    return
  }
  const targetError = validateVersion(form.targetVersion, false)
  if (targetError) errors.value = { targetVersion: targetError }
  const minError = validateVersion(form.minVersion, false)
  if (minError) errors.value = { minVersion: minError }
  if (form.rolloutPercent.trim() !== '') {
    const percentError = validateRolloutPercent(form.rolloutPercent)
    if (percentError) errors.value = { rolloutPercent: percentError }
  }
  if (Object.keys(errors.value).length > 0) return

  saving.value = true
  try {
    const result = await withReauth(() =>
      deliverDesktopApp({
        channel: form.channel,
        target,
        targetVersion: form.targetVersion.trim() === '' ? null : form.targetVersion.trim(),
        minVersion: form.minVersion.trim() === '' ? null : form.minVersion.trim(),
        minVersionHard: form.minVersionHard,
        ...(form.rolloutPercent.trim() === '' ? {} : { rolloutPercent: Number(form.rolloutPercent) }),
      }),
    )
    message.success(
      clearing.value
        ? `已删掉这条覆盖，新 revision r${String(result.revision)}`
        : `覆盖已保存，新 revision r${String(result.revision)}`,
    )
    emit('saved')
    emit('update:show', false)
  } catch (cause) {
    if (!isReauthCanceled(cause)) message.error(describeError(cause).message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    class="override-modal"
    :title="editing ? '编辑覆盖' : '新建覆盖'"
    :bordered="false"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <div class="override-modal__body">
      <label class="override-field">
        <span class="override-field__label">渠道</span>
        <NSelect v-model:value="form.channel" size="small" :options="channelOptions" data-testid="desk-override-channel" />
      </label>

      <div class="override-field">
        <span class="override-field__label">目标</span>
        <DesktopTargetField v-model="form.target" :allow-all="false" />
      </div>

      <div class="override-field__row">
        <label class="override-field">
          <span class="override-field__label">目标版本</span>
          <NInput v-model:value="form.targetVersion" size="small" placeholder="留空 = 用渠道的" data-testid="desk-override-target-version" />
        </label>
        <label class="override-field">
          <span class="override-field__label">最低版本</span>
          <NInput v-model:value="form.minVersion" size="small" placeholder="留空 = 用渠道的" data-testid="desk-override-min-version" />
        </label>
      </div>

      <div class="override-field__row">
        <label class="override-field override-field--inline">
          <span class="override-field__label">硬地板</span>
          <NSwitch v-model:value="form.minVersionHard" size="small" data-testid="desk-override-hard" />
        </label>
        <label class="override-field">
          <span class="override-field__label">灰度 %</span>
          <NInput v-model:value="form.rolloutPercent" size="small" placeholder="留空 = 用渠道的" data-testid="desk-override-percent" />
        </label>
      </div>

      <p v-if="errors['target']" class="override-field__error" role="alert">{{ errors['target'] }}</p>
      <p v-if="errors['targetVersion']" class="override-field__error" role="alert">{{ errors['targetVersion'] }}</p>
      <p v-if="errors['minVersion']" class="override-field__error" role="alert">{{ errors['minVersion'] }}</p>
      <p v-if="errors['rolloutPercent']" class="override-field__error" role="alert">{{ errors['rolloutPercent'] }}</p>

      <p v-if="clearing" class="override-field__clear" data-testid="desk-override-clearing">
        保存会删掉「{{ editing ? scopeText(editing) : '' }}」在 {{ channelLabel(form.channel) }} 渠道上的这条覆盖。
      </p>
    </div>

    <template #footer>
      <div class="override-modal__footer">
        <NButton size="small" @click="emit('update:show', false)">取消</NButton>
        <NButton size="small" type="primary" :loading="saving" data-testid="desk-override-save" @click="save">
          保存
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.override-modal {
  width: 520px;
  max-width: calc(100vw - 32px);
}

.override-modal__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.override-field {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: var(--space-1);
}

.override-field--inline {
  flex: 0 0 auto;
  justify-content: flex-start;
}

.override-field__row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.override-field__label {
  color: var(--c-text-2);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.override-field__error {
  color: var(--c-danger-ink);
  font-size: var(--fs-13);
}

.override-field__clear {
  color: var(--c-butter-ink);
  font-size: var(--fs-13);
}

.override-modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
