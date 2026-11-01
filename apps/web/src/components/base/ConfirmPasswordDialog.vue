<script setup lang="ts">
import { NButton, NInput, NModal } from 'naive-ui'
import { ref, watch } from 'vue'

import { reauth } from '@/api/auth'
import { describeError } from '@/api/errors'

/**
 * 二次密码确认弹窗（04 §0.2 `REAUTH_REQUIRED`）：管理员重置密码、删除用户、
 * 下发任务、改模型密钥等敏感操作前置调用。
 *
 * 组件自己调用 `POST /api/auth/reauth`（刷新会话 reauth_at），成功后 `confirm` 事件交给业务继续。
 */
const props = withDefaults(
  defineProps<{
    show: boolean
    title?: string
    description?: string
    confirmText?: string
    /** 确认按钮的语义色 */
    type?: 'primary' | 'error' | 'warning'
  }>(),
  {
    title: '请再输入一次密码',
    description: '这是敏感操作，为了确认是你本人。',
    confirmText: '确认',
    type: 'primary',
  },
)

const emit = defineEmits<{
  'update:show': [value: boolean]
  confirm: []
  cancel: []
}>()

const password = ref('')
const loading = ref(false)
const errorText = ref('')

watch(
  () => props.show,
  (visible) => {
    if (!visible) {
      password.value = ''
      errorText.value = ''
      loading.value = false
    }
  },
)

function close(): void {
  emit('update:show', false)
  emit('cancel')
}

async function submit(): Promise<void> {
  if (!password.value) {
    errorText.value = '请输入当前密码'
    return
  }

  loading.value = true
  errorText.value = ''
  try {
    await reauth(password.value)
    emit('update:show', false)
    emit('confirm')
  } catch (error) {
    errorText.value = describeError(error).message
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    class="confirm-password-dialog"
    :title="title"
    :style="{ maxWidth: '420px' }"
    :mask-closable="!loading"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <p class="confirm-password-dialog__desc">{{ description }}</p>

    <NInput
      v-model:value="password"
      type="password"
      show-password-on="click"
      placeholder="当前密码"
      autofocus
      :input-props="{ autocomplete: 'current-password', 'aria-label': '当前密码' }"
      @keyup.enter="submit"
    />

    <p v-if="errorText" class="confirm-password-dialog__error" role="alert" aria-live="polite">
      {{ errorText }}
    </p>

    <template #footer>
      <div class="confirm-password-dialog__footer">
        <NButton :disabled="loading" @click="close">取消</NButton>
        <NButton :type="type" :loading="loading" @click="submit">{{ confirmText }}</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.confirm-password-dialog__desc {
  margin-bottom: var(--space-3);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.confirm-password-dialog__error {
  margin-top: var(--space-2);
  color: var(--c-danger);
  font-size: var(--fs-13);
}

.confirm-password-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
