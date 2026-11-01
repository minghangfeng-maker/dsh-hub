<script setup lang="ts">
import type { SessionItem } from '@dsh-hub/shared'
import { ChangePasswordRequestSchema } from '@dsh-hub/shared'
import { NButton, NInput, NPopconfirm, useMessage } from 'naive-ui'
import { computed, onMounted, reactive, ref } from 'vue'

import { describeError } from '@/api/errors'
import { changePassword, listSessions, revokeOtherSessions, revokeSession } from '@/api/me'
import PasswordStrength from '@/components/base/PasswordStrength.vue'
import CheckDraw from '@/components/base/CheckDraw.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import { fromNow } from '@/composables/useFormat'
import { useAuthStore } from '@/stores/auth'

/**
 * 个人中心 → 安全（07 §6.2）：修改密码（强度条）+ 登录设备列表（本机标记 / 单个下线 / 退出其他设备）。
 */
const auth = useAuthStore()
const message = useMessage()

const form = reactive({ currentPassword: '', newPassword: '', confirmPassword: '' })
const submitting = ref(false)
const changed = ref(false)
const errorText = ref<string | null>(null)

const sessions = ref<SessionItem[]>([])
const sessionsLoading = ref(true)
const sessionsError = ref<string | null>(null)
const revoking = ref<string | null>(null)

const otherSessions = computed(() => sessions.value.filter((item) => !item.current))
const mismatch = computed(
  () => form.confirmPassword.length > 0 && form.newPassword !== form.confirmPassword,
)

async function loadSessions(): Promise<void> {
  sessionsLoading.value = true
  try {
    const response = await listSessions()
    sessions.value = response.items
    sessionsError.value = null
  } catch (error) {
    sessionsError.value = describeError(error).message
  } finally {
    sessionsLoading.value = false
  }
}

async function submit(): Promise<void> {
  errorText.value = null
  changed.value = false

  if (mismatch.value) {
    errorText.value = '两次输入的新密码不一样'
    return
  }

  const parsed = ChangePasswordRequestSchema.safeParse({
    currentPassword: form.currentPassword,
    newPassword: form.newPassword,
  })
  if (!parsed.success) {
    errorText.value = parsed.error.issues[0]?.message ?? '请检查填写内容'
    return
  }

  submitting.value = true
  try {
    await changePassword(parsed.data)
    changed.value = true
    form.currentPassword = ''
    form.newPassword = ''
    form.confirmPassword = ''
    message.success('密码已更新，其他设备已退出登录')
    await loadSessions()
  } catch (error) {
    errorText.value = describeError(error).message
  } finally {
    submitting.value = false
  }
}

async function kick(id: string): Promise<void> {
  revoking.value = id
  try {
    await revokeSession(id)
    sessions.value = sessions.value.filter((item) => item.id !== id)
    message.success('这台设备已下线')
  } catch (error) {
    message.error(describeError(error).message)
  } finally {
    revoking.value = null
  }
}

async function kickOthers(): Promise<void> {
  try {
    const response = await revokeOtherSessions()
    await loadSessions()
    message.success(response.revoked > 0 ? `已退出 ${response.revoked} 台设备` : '没有其他设备在线')
  } catch (error) {
    message.error(describeError(error).message)
  }
}

onMounted(() => void loadSessions())
</script>

<template>
  <div class="grid gap-6 lg:grid-cols-2">
    <section class="flex flex-col gap-4" aria-label="修改密码">
      <h3 class="flex items-center text-[16px] font-semibold text-1">
        修改密码
        <InfoTip label="修改密码说明" text="改完密码后，其他设备上的登录会立即失效。" />
      </h3>

      <label class="flex flex-col gap-1">
        <span class="text-[13px] text-2">当前密码</span>
        <NInput v-model:value="form.currentPassword" type="password" show-password-on="click" placeholder="现在用的密码" />
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-[13px] text-2">新密码</span>
        <NInput v-model:value="form.newPassword" type="password" show-password-on="click" placeholder="至少 10 位，含两类字符" />
        <PasswordStrength :password="form.newPassword" :username="auth.user?.username" />
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-[13px] text-2">确认新密码</span>
        <NInput
          v-model:value="form.confirmPassword"
          type="password"
          show-password-on="click"
          :status="mismatch ? 'error' : undefined"
          placeholder="再输入一次"
        />
      </label>

      <p v-if="errorText" class="text-[13px] text-danger" role="alert" aria-live="polite">{{ errorText }}</p>

      <div class="flex items-center gap-3">
        <NButton
          type="primary"
          :loading="submitting"
          :disabled="!form.currentPassword || !form.newPassword || mismatch"
          data-testid="password-submit"
          @click="submit"
        >
          更新密码
        </NButton>
        <span v-if="changed" class="flex items-center gap-1 text-[13px] text-primary-press">
          <CheckDraw :size="22" label="密码已更新" />
          密码已更新
        </span>
      </div>
    </section>

    <section class="flex flex-col gap-3" aria-label="登录设备">
      <div class="flex items-center gap-3">
        <h3 class="text-[16px] font-semibold text-1">登录设备</h3>
        <NPopconfirm @positive-click="kickOthers">
          <template #trigger>
            <NButton size="small" secondary :disabled="otherSessions.length === 0" data-testid="revoke-others">
              退出其他设备
            </NButton>
          </template>
          其他设备上的登录会立即失效，确定吗？
        </NPopconfirm>
      </div>

      <p v-if="sessionsLoading" class="hub-muted">正在读取…</p>
      <p v-else-if="sessionsError" class="text-[13px] text-2">{{ sessionsError }}</p>
      <p v-else-if="sessions.length === 0" class="hub-muted">没有其它登录记录。</p>

      <ul v-else class="flex flex-col gap-2">
        <li v-for="item in sessions" :key="item.id" class="session-row">
          <span class="i-ph-device-mobile session-row__icon" aria-hidden="true" />
          <div class="session-row__body">
            <p class="text-[14px] text-1">
              {{ item.device }}
              <span v-if="item.current" class="session-row__badge">本机</span>
            </p>
            <p class="text-[12px] text-3">
              {{ item.ip ?? '未知 IP' }} · 最近活跃 {{ fromNow(item.lastSeenAt) }}
            </p>
          </div>
          <NButton
            v-if="!item.current"
            size="tiny"
            quaternary
            :loading="revoking === item.id"
            @click="kick(item.id)"
          >
            下线
          </NButton>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.session-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
  background: var(--c-surface);
}

.session-row__icon {
  color: var(--c-text-3);
  font-size: 20px;
}

.session-row__body {
  min-width: 0;
  flex: 1;
}

.session-row__badge {
  margin-left: var(--space-1);
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
  font-size: var(--fs-12);
}
</style>
