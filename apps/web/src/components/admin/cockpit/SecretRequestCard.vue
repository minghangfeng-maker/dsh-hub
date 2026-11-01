<script setup lang="ts">
import { NButton, NInput } from 'naive-ui'
import { computed, ref } from 'vue'

import { cancelSecretRequest, submitSecretRequest, type SecretRequestView } from '@/api/admin-cockpit'
import { describeError } from '@/api/errors'
import MiniTag from '@/components/admin/MiniTag.vue'
import { formatDateTime } from '@/composables/useFormat'

/**
 * 密钥输入卡（docs/24 §3.4、§7）：
 *
 * - 值只发 `POST /api/admin/cockpit/secret-requests/:id`，**不经过对话、不进 SSE、不留在前端**：
 *   提交成功后立刻把输入框清空；
 * - 卡片上写清用途、来源会话与要用它的能力；DSH 拿到的只是一个 `sec_…` 引用号；
 * - 契约里没有「列出密钥请求」的接口（只有 POST/DELETE + SSE `secret.request`），刷新页面后
 *   详情可能同步不到：这时退化成「只知道 requestId 的输入框」，照样能填，不把路堵死。
 */
const props = withDefaults(
  defineProps<{
    /** 卡片自带的 requestId（即使 request 详情没同步到也能填） */
    requestId: string
    request?: SecretRequestView | null
  }>(),
  { request: null },
)

const emit = defineEmits<{ updated: [request: SecretRequestView] }>()

const value = ref('')
const busy = ref<'submit' | 'cancel' | null>(null)
const error = ref<string | null>(null)
const justFilled = ref(false)

const status = computed(() => props.request?.status ?? 'pending')
const purpose = computed(() => props.request?.purpose ?? `密钥请求 ${props.requestId}`)
const hasDetail = computed(() => props.request !== null)
const pending = computed(() => status.value === 'pending')
const title = computed(() => {
  if (status.value === 'filled') return '已填写'
  if (status.value === 'cancelled') return '已取消'
  if (status.value === 'expired') return '已过期'
  return '等待填写'
})

async function submit(): Promise<void> {
  const id = props.request?.id ?? props.requestId
  if (!id || !value.value || busy.value !== null) return

  busy.value = 'submit'
  error.value = null
  try {
    await submitSecretRequest(id, value.value)
    // 值不再留在内存里：提交成功即清空
    value.value = ''
    justFilled.value = true
    emit('updated', {
      ...(props.request ?? {
        id,
        sessionId: '',
        purpose: '',
        capability: '',
        field: '',
        expiresAt: '',
      }),
      status: 'filled',
    })
  } catch (cause) {
    error.value = describeError(cause).message
  } finally {
    busy.value = null
  }
}

async function cancel(): Promise<void> {
  const id = props.request?.id ?? props.requestId
  if (!id || busy.value !== null) return

  busy.value = 'cancel'
  error.value = null
  try {
    await cancelSecretRequest(id)
    value.value = ''
    emit('updated', {
      ...(props.request ?? {
        id,
        sessionId: '',
        purpose: '',
        capability: '',
        field: '',
        expiresAt: '',
      }),
      status: 'cancelled',
    })
  } catch (cause) {
    error.value = describeError(cause).message
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <article class="secret" :data-secret-request-id="requestId">
    <header class="secret__head">
      <span class="i-ph-key secret__icon" aria-hidden="true" />
      <p class="secret__purpose">{{ purpose }}</p>
      <MiniTag
        :text="title"
        :tone="status === 'filled' ? 'success' : status === 'pending' ? 'butter' : 'neutral'"
      />
    </header>

    <dl v-if="hasDetail && request" class="secret__meta">
      <div>
        <dt>来自</dt>
        <dd class="secret__mono" :title="request.sessionId">{{ request.sessionId }}</dd>
      </div>
      <div>
        <dt>用于</dt>
        <dd class="secret__mono">{{ request.capability }} · {{ request.field }}</dd>
      </div>
      <div>
        <dt>有效期至</dt>
        <dd>{{ formatDateTime(request.expiresAt) }}</dd>
      </div>
    </dl>
    <p v-else class="secret__meta secret__meta--missing">详情未同步（编号 {{ requestId }}），仍可直接填写</p>

    <template v-if="pending">
      <NInput
        v-model:value="value"
        type="password"
        show-password-on="click"
        placeholder="粘贴密钥"
        :input-props="{ 'aria-label': '密钥' }"
        :disabled="busy !== null"
        @keyup.enter="submit"
      />
      <p class="secret__error" role="alert">{{ error ?? '' }}</p>
      <div class="secret__actions">
        <NButton size="small" :disabled="busy !== null" :loading="busy === 'cancel'" @click="cancel">
          取消
        </NButton>
        <NButton
          size="small"
          type="primary"
          :disabled="busy !== null || value.length === 0"
          :loading="busy === 'submit'"
          @click="submit"
        >
          提交
        </NButton>
      </div>
    </template>

    <p v-else-if="status === 'filled' || justFilled" class="secret__done">
      <span class="i-ph-check-circle" aria-hidden="true" />
      已交给 Hub，DSH 只会拿到引用号 {{ request?.field === 'apiKey' ? 'sec_…' : '引用号' }}。
    </p>

    <p v-else class="secret__done secret__done--muted">这条请求已经关闭。</p>
  </article>
</template>

<style scoped>
.secret {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.secret__meta--missing {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.secret__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.secret__icon {
  color: var(--c-sakura-ink);
  font-size: 18px;
}

.secret__purpose {
  min-width: 0;
  color: var(--c-text);
  font-size: var(--fs-13);
  font-weight: var(--fw-semibold);
}

.secret__meta {
  display: grid;
  align-items: baseline;
  gap: 2px var(--space-3);
  grid-template-columns: max-content minmax(0, 1fr);
  font-size: var(--fs-12);
}

.secret__meta div {
  display: contents;
}

.secret__meta.secret__meta--missing {
  display: block;
}

.secret__meta dt {
  color: var(--c-text-3);
}

.secret__meta dd {
  min-width: 0;
  overflow: hidden;
  color: var(--c-text-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.secret__mono {
  font-family: var(--font-mono);
}

.secret__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

.secret__error {
  min-height: 18px;
  color: var(--c-danger-ink);
  font-size: var(--fs-12);
}

.secret__done {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--c-success-ink);
  font-size: var(--fs-12);
}

.secret__done--muted {
  color: var(--c-text-3);
}
</style>
