<script setup lang="ts">
import type { DesktopDevice } from '@dsh-hub/shared'
import { DeviceNameSchema } from '@dsh-hub/shared'
import { NButton, NInput, NPopconfirm, useMessage } from 'naive-ui'
import { computed, ref } from 'vue'

import { listMyDesktopDevices, renameMyDesktopDevice, revokeMyDesktopDevice } from '@/api/desktop'
import { describeError } from '@/api/errors'
import { isHubApiError } from '@/api/http'
import MiniTag from '@/components/admin/MiniTag.vue'
import {
  deviceKindOf,
  deviceMetaText,
  mobilePlatformIcon,
  presenceText,
  presenceTone,
} from '@/components/desktop/text'
import SoftCard from '@/components/base/SoftCard.vue'
import { useAsyncData } from '@/composables/useAsyncData'
import { formatDateTime, fromNow } from '@/composables/useFormat'

/**
 * 工作台「我的实例」区块里的桌面设备列表（D6 §6.2，WP25c 交付物 2）。
 *
 * - 只列**当前有效**的设备：`GET /api/me/desktop-devices` 会把 30 天内已吊销的也带回来，
 *   那些在台账里看得到就够，工作台不铺开；
 * - 「本机」标记**不做**：服务端不知道哪台是当前浏览器所在的机器，标错比不标更糟；
 * - 吊销 = 设备令牌与设备密钥一起失效（客户端下一个请求就退登录），所以要二次确认；
 * - 没有设备时给「下载桌面端」入口（WP36 起指向公开主页 `/`，安装包在左卡）。
 * - 不放隐私说明长文：卡片右上角一个「隐私说明」链接，指向 `/desktop/privacy`。
 * - **改名**（WP25f 交付物 3）：行内编辑，提交前用服务端同一份 `DeviceNameSchema` 校验
 *   （≤64 字、禁控制字符与路径分隔符）——校验文案与后端一致，用户不用提交一次才知道格式不对；
 *   服务端对别人的设备返回 404，这里就地提示「设备不存在或已退出」而不是「没有权限」。
 */
const message = useMessage()

const { data, loading, error, reload } = useAsyncData(() => listMyDesktopDevices())

const devices = computed<DesktopDevice[]>(
  () => data.value?.items.filter((item) => item.revokedAt === null) ?? [],
)
const limit = computed(() => data.value?.limit ?? null)
const revoking = ref<string | null>(null)

/** 正在改名的设备（null = 没有行在编辑）；同一时刻只允许一行 */
const editingId = ref<string | null>(null)
const draftName = ref('')
const renameError = ref('')
const renaming = ref(false)

function startRename(device: DesktopDevice): void {
  editingId.value = device.deviceId
  draftName.value = device.name
  renameError.value = ''
}

function cancelRename(): void {
  editingId.value = null
  renameError.value = ''
}

/** 提交前跑一遍契约里的设备名校验（与后端同一份 schema，文案也一样） */
async function submitRename(device: DesktopDevice): Promise<void> {
  const parsed = DeviceNameSchema.safeParse(draftName.value)
  if (!parsed.success) {
    renameError.value = parsed.error.issues[0]?.message ?? '设备名不合法'
    return
  }
  const name = parsed.data
  if (name === device.name) {
    cancelRename()
    return
  }

  renaming.value = true
  renameError.value = ''
  try {
    await renameMyDesktopDevice(device.deviceId, name)
    message.success('设备名已更新')
    editingId.value = null
    await reload()
  } catch (cause) {
    if (isHubApiError(cause) && cause.code === 'NOT_FOUND') {
      // 别人的设备与「已经退出的设备」后端都给 404：措辞按后者说（绝大多数情况就是这个）
      renameError.value = '设备不存在或已退出'
      return
    }
    renameError.value = describeError(cause).message
  } finally {
    renaming.value = false
  }
}

async function revoke(device: DesktopDevice): Promise<void> {
  revoking.value = device.deviceId
  try {
    await revokeMyDesktopDevice(device.deviceId)
    message.success(`${device.name} 已退出登录`)
    await reload()
  } catch (cause) {
    message.error(describeError(cause).message)
  } finally {
    revoking.value = null
  }
}
</script>

<template>
  <SoftCard title="桌面设备" data-testid="desktop-devices-card">
    <template #title-extra>
      <span v-if="devices.length > 0" class="desktop-devices__count" data-testid="desktop-device-count">
        共 {{ devices.length }} 台
      </span>
    </template>
    <template #extra>
      <RouterLink to="/desktop/privacy" class="desktop-devices__link" data-testid="desktop-privacy-link">
        隐私说明
      </RouterLink>
    </template>

    <p v-if="loading && !data" class="text-[12px] text-3">正在读取…</p>

    <div v-else-if="error" class="desktop-devices__error">
      <span class="text-[13px] text-danger" role="alert">{{ error.message }}</span>
      <NButton size="tiny" quaternary @click="reload">重试</NButton>
    </div>

    <div v-else-if="devices.length === 0" class="desktop-devices__empty" data-testid="desktop-devices-empty">
      <span class="i-ph-desktop desktop-devices__empty-icon" aria-hidden="true" />
      <p class="text-[14px] text-2">还没有设备登录过桌面端</p>
      <RouterLink to="/" data-testid="desktop-download-link">
        <NButton size="small" secondary>下载桌面端</NButton>
      </RouterLink>
    </div>

    <ul v-else class="desktop-devices__list">
      <li
        v-for="device in devices"
        :key="device.deviceId"
        class="desktop-devices__row"
        data-testid="desktop-device-row"
      >
        <span
          :class="
            deviceKindOf(device) === 'mobile' ? mobilePlatformIcon(device.mobilePlatform) : 'i-ph-desktop'
          "
          class="desktop-devices__icon"
          aria-hidden="true"
        />

        <div class="desktop-devices__body">
          <p v-if="editingId !== device.deviceId" class="desktop-devices__name-line">
            <span class="desktop-devices__name" :title="device.name">{{ device.name }}</span>
            <MiniTag :text="presenceText(device.presence)" :tone="presenceTone(device.presence)" size="sm" />
          </p>
          <div v-else class="desktop-devices__rename">
            <NInput
              v-model:value="draftName"
              size="tiny"
              :maxlength="64"
              show-count
              :status="renameError ? 'error' : undefined"
              data-testid="desktop-device-rename-input"
              @keyup.enter="submitRename(device)"
              @keyup.esc="cancelRename"
            />
            <NButton
              size="tiny"
              type="primary"
              :loading="renaming"
              data-testid="desktop-device-rename-save"
              @click="submitRename(device)"
            >
              保存
            </NButton>
            <NButton size="tiny" quaternary :disabled="renaming" @click="cancelRename">取消</NButton>
          </div>
          <p
            v-if="renameError && editingId === device.deviceId"
            class="desktop-devices__rename-error"
            role="alert"
            data-testid="desktop-device-rename-error"
          >
            {{ renameError }}
          </p>
          <p class="desktop-devices__meta">
            <span>{{ deviceMetaText(device) }}</span>
            <!-- 手机网页版没有 APK 版本号可报（刷到最新即可），未知时干脆不写「客户端 —」（WP54c） -->
            <span v-if="device.appVersion">· 客户端 {{ device.appVersion }}</span>
          </p>
          <p class="desktop-devices__meta">
            <span>最后在线 {{ fromNow(device.lastReportAt) }}</span>
            <span>· 登录于 {{ formatDateTime(device.lastAuthAt) }}</span>
          </p>
        </div>

        <div class="desktop-devices__actions">
          <NButton
            v-if="editingId !== device.deviceId"
            size="tiny"
            quaternary
            :disabled="renaming"
            data-testid="desktop-device-rename"
            @click="startRename(device)"
          >
            改名
          </NButton>
          <NPopconfirm positive-text="确认退出" @positive-click="revoke(device)">
            <template #trigger>
              <NButton
                size="tiny"
                quaternary
                :loading="revoking === device.deviceId"
                :disabled="revoking !== null && revoking !== device.deviceId"
                data-testid="desktop-device-revoke"
              >
                退出登录
              </NButton>
            </template>
            这台设备会立即退出登录，本地文件与会话不受影响。确定吗？
          </NPopconfirm>
        </div>
      </li>
    </ul>

    <p v-if="limit && devices.length > 0" class="desktop-devices__quota" data-testid="desktop-device-quota">
      已用 {{ limit.used }} / {{ limit.max }}
    </p>
  </SoftCard>
</template>

<style scoped>
.desktop-devices__count {
  color: var(--c-text-3);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.desktop-devices__link {
  color: var(--c-primary-press);
  font-size: var(--fs-13);
  white-space: nowrap;
}

.desktop-devices__empty {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.desktop-devices__empty-icon {
  color: var(--c-text-3);
  font-size: 22px;
}

.desktop-devices__error {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.desktop-devices__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.desktop-devices__row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
  background: var(--c-surface);
}

.desktop-devices__icon {
  color: var(--c-text-3);
  font-size: 20px;
}

.desktop-devices__body {
  min-width: 0;
  flex: 1;
}

.desktop-devices__name-line {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: var(--space-2);
}

/* 状态胶囊不参与压缩，名字自己省略（07 §2.8：胶囊和名字都不从中间断开） */
.desktop-devices__name-line :deep(.mini-tag) {
  flex: none;
}

.desktop-devices__name {
  overflow: hidden;
  min-width: 0;
  flex: 0 1 auto;
  color: var(--c-text);
  font-size: var(--fs-14);
  font-weight: var(--fw-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desktop-devices__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  color: var(--c-text-3);
  font-size: var(--fs-12);
  white-space: nowrap;
}

/* 改名行：输入框可以一直缩，按钮与计数不换行（07 §2.8：按钮文字不从中间断、也不拆到两行） */
.desktop-devices__rename {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: var(--space-2);
}

.desktop-devices__rename :deep(.n-input) {
  min-width: 0;
  flex: 1 1 auto;
}

.desktop-devices__rename > :deep(.n-button) {
  flex: none;
  white-space: nowrap;
}

.desktop-devices__rename-error {
  margin-top: var(--space-1);
  color: var(--c-danger-ink);
  font-size: var(--fs-12);
}

.desktop-devices__actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
}

.desktop-devices__quota {
  margin-top: var(--space-3);
  color: var(--c-text-3);
  font-size: var(--fs-12);
  white-space: nowrap;
}

/* 窄屏（≤520）按钮单独一行：设备名宁可能省，也不挤成一条缝；不出现横向滚动（07 §9） */
@media (max-width: 520px) {
  .desktop-devices__row {
    flex-wrap: wrap;
  }

  .desktop-devices__body {
    flex: 1 1 calc(100% - 32px);
  }

  .desktop-devices__actions {
    margin-left: auto;
  }
}
</style>
