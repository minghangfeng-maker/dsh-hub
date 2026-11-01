<script setup lang="ts">
import type { UserAdminView } from '@dsh-hub/shared'
import { NButton, NModal, useMessage } from 'naive-ui'
import { ref } from 'vue'

import { resetUserPassword, revokeUserSessions } from '@/api/admin-users'
import { describeError } from '@/api/errors'
import AdminUserDesktopDevices from '@/components/admin/desktop/AdminUserDesktopDevices.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import SoftCard from '@/components/base/SoftCard.vue'
import { formatDateTime } from '@/composables/useFormat'
import { isReauthCanceled, sensitive } from '@/composables/useReauth'

/**
 * 用户详情 · 安全（07 §7.3）：会话数与强制下线、重置密码（一次性临时密码）。
 * 两个操作都属于敏感操作，走 `ConfirmPasswordDialog` 二次确认。
 */
const props = defineProps<{
  user: UserAdminView
  sessions: number
}>()

const emit = defineEmits<{ changed: [] }>()

const message = useMessage()
const busy = ref(false)
const showTemp = ref(false)
const tempPassword = ref('')

async function revoke(): Promise<void> {
  busy.value = true
  try {
    const result = await sensitive(() => revokeUserSessions(props.user.id), {
      title: '强制下线',
      description: `将让 ${props.user.username} 的所有登录会话立即失效，下次访问要重新登录；正在进行中的 DSH 任务不受影响。`,
      confirmText: '全部下线',
      type: 'warning',
    })
    message.success(`已下线 ${result.revoked} 个会话`)
    emit('changed')
  } catch (error) {
    if (!isReauthCanceled(error)) message.error(describeError(error).message)
  } finally {
    busy.value = false
  }
}

async function reset(): Promise<void> {
  busy.value = true
  try {
    const result = await sensitive(() => resetUserPassword(props.user.id), {
      title: '重置密码',
      description: `为 ${props.user.username} 生成一个新的临时密码（只显示一次），并吊销该用户的其它会话。`,
      confirmText: '重置',
    })
    tempPassword.value = result.tempPassword
    showTemp.value = true
    emit('changed')
  } catch (error) {
    if (!isReauthCanceled(error)) message.error(describeError(error).message)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="user-security">
    <SoftCard title="登录会话">
      <dl class="user-security__meta">
        <div>
          <dt>在线会话</dt>
          <dd>{{ sessions }} 个</dd>
        </div>
        <div>
          <dt>最近登录</dt>
          <dd>{{ formatDateTime(user.lastLoginAt) }}</dd>
        </div>
        <div>
          <dt>最近登录 IP</dt>
          <dd>{{ user.lastLoginIp ?? '—' }}</dd>
        </div>
      </dl>

      <div class="user-security__actions">
        <NButton size="small" :loading="busy" :disabled="sessions === 0" @click="revoke"
          >强制下线全部会话</NButton
        >
      </div>
    </SoftCard>

    <!-- 桌面端设备（WP25c）：与浏览器会话分开列，吊销语义不同（D6 §6.3） -->
    <AdminUserDesktopDevices :user-id="user.id" :username="user.username" />

    <SoftCard title="密码">
      <div class="user-security__row">
        <MiniTag
          :text="user.mustChangePassword ? '用户下次登录必须改密' : '密码状态正常'"
          :tone="user.mustChangePassword ? 'butter' : 'success'"
          size="sm"
        />
        <NButton size="small" type="warning" ghost :loading="busy" @click="reset">重置密码</NButton>
      </div>
    </SoftCard>

    <NModal v-model:show="showTemp" preset="card" title="新的临时密码" :style="{ maxWidth: '420px' }">
      <p class="user-security__temp">{{ tempPassword }}</p>
      <p class="user-security__hint">关闭后无法再次查看，请通过安全渠道交给用户。</p>
      <template #footer>
        <div class="user-security__footer">
          <NButton size="small" type="primary" @click="showTemp = false">我已记下</NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.user-security {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.user-security__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-6);
  font-size: var(--fs-13);
}

.user-security__meta dt {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.user-security__actions {
  margin-top: var(--space-3);
}

.user-security__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.user-security__hint {
  margin-top: var(--space-2);
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.user-security__temp {
  margin-bottom: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-control);
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
  font-family: var(--font-mono);
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
  letter-spacing: 1px;
  text-align: center;
  word-break: break-all;
}

.user-security__footer {
  display: flex;
  justify-content: flex-end;
}
</style>
