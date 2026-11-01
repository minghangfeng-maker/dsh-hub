<script setup lang="ts">
import type { DesktopDeviceAdminItem } from '@dsh-hub/shared'
import { NButton, NPopconfirm, useMessage } from 'naive-ui'
import { computed, ref } from 'vue'

import { listAdminDesktopDevices, revokeAdminDesktopDevice } from '@/api/desktop'
import { describeError } from '@/api/errors'
import MiniTag from '@/components/admin/MiniTag.vue'
import { presenceText, presenceTone, systemText } from '@/components/desktop/text'
import SoftCard from '@/components/base/SoftCard.vue'
import { useAsyncData } from '@/composables/useAsyncData'
import { fromNow } from '@/composables/useFormat'
import { isReauthCanceled, withReauth } from '@/composables/useReauth'

/**
 * 用户详情 · 安全 →「桌面设备」（WP25c 交付物 3 的最后一条：用户详情页显示该用户的桌面设备）。
 *
 * 与「登录会话」分开：会话是浏览器 cookie（踢下线），设备是桌面端令牌 + 每设备密钥，
 * 吊销语义不同（D6 §6.3）。这里只列**还没吊销**的设备，历史留在 `/admin/instances?tab=desktop`。
 */
const props = defineProps<{
  userId: number
  username: string
}>()

const message = useMessage()
const revoking = ref<string | null>(null)

const { data, loading, error, reload } = useAsyncData(() =>
  listAdminDesktopDevices({ userId: props.userId, revoked: 'active', pageSize: 100 }),
)

const rows = computed<DesktopDeviceAdminItem[]>(() => data.value?.items ?? [])

async function revoke(row: DesktopDeviceAdminItem): Promise<void> {
  revoking.value = row.device.deviceId
  try {
    await withReauth(() => revokeAdminDesktopDevice(row.device.deviceId), {
      title: '吊销设备',
      description: `吊销 ${row.device.name} 后，${props.username} 的这台桌面端会立即退出登录，本地文件与会话不受影响。`,
      confirmText: '吊销',
      type: 'warning',
    })
    message.success(`${row.device.name} 已吊销`)
    await reload()
  } catch (cause) {
    if (!isReauthCanceled(cause)) message.error(describeError(cause).message)
  } finally {
    revoking.value = null
  }
}
</script>

<template>
  <SoftCard title="桌面设备" data-testid="admin-user-desktop-devices">
    <template #title-extra>
      <span v-if="rows.length > 0" class="admin-user-desktop__count">共 {{ rows.length }} 台</span>
    </template>

    <p v-if="loading && !data" class="text-[12px] text-3">正在读取…</p>

    <div v-else-if="error" class="admin-user-desktop__error">
      <span class="text-[13px] text-danger" role="alert">{{ error.message }}</span>
      <NButton size="tiny" quaternary @click="reload">重试</NButton>
    </div>

    <p v-else-if="rows.length === 0" class="text-[13px] text-2" data-testid="admin-user-desktop-empty">
      这个用户还没有登录过桌面端
    </p>

    <ul v-else class="admin-user-desktop__list">
      <li
        v-for="row in rows"
        :key="row.device.deviceId"
        class="admin-user-desktop__row"
        data-testid="admin-user-desktop-row"
      >
        <span class="i-ph-desktop admin-user-desktop__icon" aria-hidden="true" />
        <div class="admin-user-desktop__body">
          <p class="admin-user-desktop__name-line">
            <span class="admin-user-desktop__name" :title="row.device.name">{{ row.device.name }}</span>
            <MiniTag
              :text="presenceText(row.device.presence)"
              :tone="presenceTone(row.device.presence)"
              size="sm"
            />
          </p>
          <p class="admin-user-desktop__meta">
            <span>{{ systemText(row.device.platform, row.device.osMajor) }}</span>
            <span class="admin-user-desktop__sep" aria-hidden="true">·</span>
            <span class="admin-user-desktop__mono">客户端 {{ row.device.appVersion ?? '—' }}</span>
            <span class="admin-user-desktop__sep" aria-hidden="true">·</span>
            <span>最后在线 {{ fromNow(row.device.lastReportAt) }}</span>
          </p>
        </div>
        <NPopconfirm positive-text="确认吊销" @positive-click="revoke(row)">
          <template #trigger>
            <NButton
              size="tiny"
              quaternary
              :loading="revoking === row.device.deviceId"
              data-testid="admin-user-desktop-revoke"
            >
              吊销
            </NButton>
          </template>
          该设备将退出登录，本地文件与会话不受影响。确定吗？
        </NPopconfirm>
      </li>
    </ul>
  </SoftCard>
</template>

<style scoped>
.admin-user-desktop__count {
  color: var(--c-text-3);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.admin-user-desktop__error {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.admin-user-desktop__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.admin-user-desktop__row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
}

.admin-user-desktop__icon {
  color: var(--c-text-3);
  font-size: 18px;
}

.admin-user-desktop__body {
  min-width: 0;
  flex: 1;
}

.admin-user-desktop__name-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.admin-user-desktop__name {
  overflow: hidden;
  max-width: 100%;
  color: var(--c-text);
  font-size: var(--fs-13);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-user-desktop__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
  color: var(--c-text-3);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.admin-user-desktop__sep {
  color: var(--c-text-3);
}

.admin-user-desktop__mono {
  font-family: var(--font-mono);
}
</style>
