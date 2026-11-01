<script setup lang="ts">
import type { DesktopAuthorizeView, DesktopDevice } from '@dsh-hub/shared'
import { NAlert, NButton, NPopconfirm, useMessage } from 'naive-ui'
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import {
  decideDesktopAuthorize,
  fetchDesktopAuthorizeRequest,
  listMyDesktopDevices,
  revokeMyDesktopDevice,
} from '@/api/desktop'
import { describeError } from '@/api/errors'
import { isHubApiError } from '@/api/http'
import {
  archText,
  channelText,
  loginCodeText,
  permissionText,
  presenceText,
  presenceTone,
  systemText,
} from '@/components/desktop/text'
import MiniTag from '@/components/admin/MiniTag.vue'
import { formatDateTime } from '@/composables/useFormat'
import { isLoopbackRedirectUrl } from '@/utils/desktop-redirect'
import { replaceLocation } from '@/utils/navigation'

/**
 * 桌面端授权页 `/desktop/authorize?req=<id>`（D2 §3.2，WP25c 交付物 1）。
 *
 * 桌面端在系统浏览器里打开这个地址；用户在这里看清「哪台设备、以谁的身份、要什么权限」再决定。
 * 三条纪律：
 * 1. **未登录先登录**：路由要求登录，守卫会把 `next`（含 `?req=`）带到登录页，登录后原样回来；
 * 2. **只跳回环**：`approve/deny` 返回的地址先过 `isLoopbackRedirectUrl`，否则拒绝跳转并报错
 *    （即使后端被改坏也不把刚点过「允许」的用户带去别处）；
 * 3. **设备数满了就地解决**：接口给的 `deviceCount/deviceLimit` 超限时列出已登录设备、可当场吊销一台。
 *    但**不**禁用「允许」——同一台设备重新登录会复用原来的设备行、不会新建，禁用会把合法重登录也挡掉；
 *    真正的上限判定仍在客户端的 `auth/token` 那一步（409 DEVICE_LIMIT_REACHED）。
 */
const route = useRoute()
const message = useMessage()

const requestId = computed(() => {
  const raw = route.query['req']
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.length > 0 ? value : ''
})

const view = ref<DesktopAuthorizeView | null>(null)
const loading = ref(true)
const deciding = ref(false)
/**
 * 错误态。`action` 只给「下一步在网页端」的情况用（必须改密）：那种错不是死路，
 * 给一个真的能点的链接，比让用户自己找 `/me` 强（07 §2.7：交互本身要做到不用教）。
 */
const problem = ref<{
  title: string
  detail: string
  action?: { to: string; text: string }
} | null>(null)

/** 设备数超限时展开的「已登录设备」，可就地吊销 */
const limitDevices = ref<DesktopDevice[]>([])
const revoking = ref<string | null>(null)

const overLimit = computed(() => {
  const current = view.value
  return current !== null && current.deviceCount >= current.deviceLimit
})

/** 登录阶段细分原因（`details.loginCode`）优先，其次才是全局错误码文案 */
function explain(error: unknown): { title: string; detail: string; action?: { to: string; text: string } } {
  if (isHubApiError(error)) {
    const loginCode = error.details['loginCode']
    // 「必须改密」有两条来路（WP25e 交付物 11 + WP25f 交付物 7）：
    // 1. 桌面端 `auth/token` 回 `details.loginCode=password_change_required`（403）；
    // 2. 网页会话本身被全局网关拦住时是 `MUST_CHANGE_PASSWORD`（授权页连取数都做不了）。
    // 两种都给同一条明确提示 + 改密页链接 —— 不再走通用的「账号不可用」。
    if (loginCode === 'password_change_required' || error.code === 'MUST_CHANGE_PASSWORD') {
      return {
        title: '请先在网页端修改初始密码',
        detail: '请先在网页端修改初始密码，再登录桌面端。',
        action: { to: '/me/password', text: '去改密码' },
      }
    }
    const loginCodeText_ = loginCodeText(loginCode)
    if (error.code === 'GONE') {
      return { title: '这次登录已过期', detail: '请回到桌面端重新点「登录」，会打开一个新的授权页。' }
    }
    if (error.code === 'NOT_FOUND') {
      return { title: '登录请求不存在', detail: '这条请求可能已经用过或已失效，请在桌面端重新点「登录」。' }
    }
    if (error.code === 'CONFLICT') {
      return { title: '这次登录已经处理过了', detail: '请在桌面端查看结果；需要再登录一次时重新发起。' }
    }
    if (error.code === 'UNAUTHENTICATED') {
      return { title: '登录状态已过期', detail: '请重新登录后再授权。' }
    }
    return { title: '无法完成这次授权', detail: loginCodeText_ ?? describeError(error).message }
  }
  return { title: '无法完成这次授权', detail: describeError(error).message }
}

async function load(): Promise<void> {
  if (!requestId.value) {
    loading.value = false
    problem.value = { title: '缺少登录请求编号', detail: '请回到桌面端点「登录」重新打开授权页。' }
    return
  }

  loading.value = true
  try {
    view.value = await fetchDesktopAuthorizeRequest(requestId.value)
    problem.value = null
    if (overLimit.value) await loadLimitDevices()
  } catch (error) {
    view.value = null
    problem.value = explain(error)
  } finally {
    loading.value = false
  }
}

async function loadLimitDevices(): Promise<void> {
  try {
    const response = await listMyDesktopDevices()
    limitDevices.value = response.items.filter((item) => item.revokedAt === null)
  } catch {
    // 列不出来也不影响主流程：允许 / 拒绝照常可用
    limitDevices.value = []
  }
}

async function revoke(device: DesktopDevice): Promise<void> {
  revoking.value = device.deviceId
  try {
    await revokeMyDesktopDevice(device.deviceId)
    message.success(`${device.name} 已退出登录`)
    await load()
  } catch (error) {
    message.error(describeError(error).message)
  } finally {
    revoking.value = null
  }
}

/**
 * 允许 / 拒绝：后端返回要整页跳转的地址（回到桌面端的本机回环）。
 * 不是回环就**不跳**，把问题留在授权页上说清楚（防开放重定向）。
 */
async function decide(allow: boolean): Promise<void> {
  if (deciding.value) return
  deciding.value = true
  try {
    const { redirectUrl } = await decideDesktopAuthorize(requestId.value, allow)
    if (!isLoopbackRedirectUrl(redirectUrl)) {
      problem.value = {
        title: '桌面端返回的跳转地址不安全',
        detail: '它不是本机回环地址，已经阻止跳转。请回到桌面端重新登录。',
      }
      return
    }
    replaceLocation(redirectUrl)
  } catch (error) {
    // 409（另一个标签页先点过）也留在这条提示上；用户回桌面端即可看到结果
    problem.value = explain(error)
  } finally {
    deciding.value = false
  }
}

onMounted(() => void load())
</script>

<template>
  <section class="desktop-authorize" data-testid="desktop-authorize">
    <header class="desktop-authorize__head">
      <h1 class="desktop-authorize__title">登录授权</h1>
    </header>

    <p v-if="loading" class="text-[13px] text-2">正在读取这次登录请求…</p>

    <div
      v-else-if="problem"
      class="desktop-authorize__problem"
      role="alert"
      data-testid="desktop-authorize-problem"
    >
      <span class="i-ph-warning-circle desktop-authorize__problem-icon" aria-hidden="true" />
      <div>
        <p class="desktop-authorize__problem-title">{{ problem.title }}</p>
        <p class="desktop-authorize__problem-detail">{{ problem.detail }}</p>
        <RouterLink
          v-if="problem.action"
          :to="problem.action.to"
          class="desktop-authorize__problem-action"
          data-testid="desktop-authorize-password-link"
        >
          <NButton size="tiny" type="primary" secondary>{{ problem.action.text }}</NButton>
        </RouterLink>
      </div>
    </div>

    <template v-else-if="view">
      <!-- 已经点过（刷新/回退回来看到的） -->
      <div
        v-if="view.status !== 'waiting'"
        class="desktop-authorize__done"
        data-testid="desktop-authorize-done"
      >
        <span
          class="desktop-authorize__done-icon"
          :class="view.status === 'allowed' ? 'i-ph-check-circle' : 'i-ph-x-circle'"
          aria-hidden="true"
        />
        <p class="desktop-authorize__done-title">
          {{ view.status === 'allowed' ? '已经允许这台设备登录' : '已经拒绝了这次登录' }}
        </p>
        <p class="text-[14px] text-2">可以回到桌面端了。</p>
      </div>

      <template v-else>
        <div class="desktop-authorize__device">
          <span class="i-ph-desktop desktop-authorize__device-icon" aria-hidden="true" />
          <div class="desktop-authorize__device-body">
            <p class="desktop-authorize__device-name" data-testid="desktop-authorize-device-name">
              {{ view.deviceName }}
            </p>
            <p class="desktop-authorize__device-meta">
              <span>{{ systemText(view.platform, view.osMajor) }}</span>
              <span class="desktop-authorize__sep" aria-hidden="true">·</span>
              <span>{{ archText(view.arch) }}</span>
              <span class="desktop-authorize__sep" aria-hidden="true">·</span>
              <span class="desktop-authorize__mono">客户端 {{ view.appVersion }}</span>
              <span class="desktop-authorize__sep" aria-hidden="true">·</span>
              <span>{{ channelText(view.appChannel) }}</span>
            </p>
          </div>
        </div>

        <dl class="desktop-authorize__facts">
          <div class="desktop-authorize__fact">
            <dt>登录账号</dt>
            <dd class="desktop-authorize__account-line" data-testid="desktop-authorize-user">
              <span class="desktop-authorize__account"
                >{{ view.user.displayName }}（@{{ view.user.username }}）</span
              >
              <span class="desktop-authorize__role">· {{ view.user.roleLabel }}</span>
            </dd>
          </div>
          <div class="desktop-authorize__fact">
            <dt>请求的权限</dt>
            <dd>
              <ul class="desktop-authorize__permissions" data-testid="desktop-authorize-permissions">
                <li v-for="permission in view.permissions" :key="permission">
                  <span class="i-ph-check desktop-authorize__check" aria-hidden="true" />
                  <span>{{ permissionText(permission) }}</span>
                </li>
              </ul>
            </dd>
          </div>
          <div class="desktop-authorize__fact">
            <dt>有效期至</dt>
            <dd class="desktop-authorize__mono">{{ formatDateTime(view.expiresAt) }}</dd>
          </div>
        </dl>

        <!-- 设备数超限：按状态出现的正式提示（07 §2.7 第 3 条），不是常驻说明 -->
        <NAlert
          v-if="overLimit"
          type="warning"
          :bordered="false"
          class="desktop-authorize__limit"
          data-testid="desktop-authorize-limit"
        >
          已登录 {{ view.deviceCount }} 台设备，达到上限（{{ view.deviceLimit }} 台）。
        </NAlert>

        <ul v-if="overLimit && limitDevices.length > 0" class="desktop-authorize__limit-list">
          <li
            v-for="device in limitDevices"
            :key="device.deviceId"
            class="desktop-authorize__limit-row"
            data-testid="desktop-authorize-limit-row"
          >
            <span class="i-ph-desktop desktop-authorize__limit-icon" aria-hidden="true" />
            <div class="desktop-authorize__limit-body">
              <p class="desktop-authorize__limit-name">{{ device.name }}</p>
              <p class="desktop-authorize__device-meta">
                <span>{{ systemText(device.platform, device.osMajor) }}</span>
                <span class="desktop-authorize__sep" aria-hidden="true">·</span>
                <MiniTag
                  :text="presenceText(device.presence)"
                  :tone="presenceTone(device.presence)"
                  size="sm"
                />
              </p>
            </div>
            <NPopconfirm positive-text="确认吊销" @positive-click="revoke(device)">
              <template #trigger>
                <NButton
                  size="tiny"
                  quaternary
                  :loading="revoking === device.deviceId"
                  data-testid="desktop-authorize-limit-revoke"
                >
                  吊销
                </NButton>
              </template>
              这台设备会立即退出登录，本地文件与会话不受影响。确定吗？
            </NPopconfirm>
          </li>
        </ul>

        <div class="desktop-authorize__actions">
          <NButton
            type="primary"
            block
            :loading="deciding"
            data-testid="desktop-authorize-allow"
            @click="decide(true)"
          >
            允许
          </NButton>
          <NButton
            block
            secondary
            :disabled="deciding"
            data-testid="desktop-authorize-deny"
            @click="decide(false)"
          >
            拒绝
          </NButton>
        </div>

        <button
          type="button"
          class="desktop-authorize__not-me"
          data-testid="desktop-authorize-not-me"
          :disabled="deciding"
          @click="decide(false)"
        >
          这不是我的设备
        </button>
      </template>
    </template>

    <footer class="desktop-authorize__footer">
      <RouterLink to="/desktop/privacy" class="desktop-authorize__privacy">隐私说明</RouterLink>
    </footer>
  </section>
</template>

<style scoped>
.desktop-authorize__head {
  margin-bottom: var(--space-6);
  text-align: center;
}

.desktop-authorize__title {
  color: var(--c-text);
  font-size: var(--fs-24);
  font-weight: var(--fw-semibold);
}

.desktop-authorize__device {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-control);
  background: var(--c-primary-soft);
}

.desktop-authorize__device-icon {
  color: var(--c-primary-press);
  font-size: 26px;
}

.desktop-authorize__device-body {
  min-width: 0;
}

.desktop-authorize__device-name {
  overflow: hidden;
  color: var(--c-text);
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desktop-authorize__device-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
  color: var(--c-text-2);
  font-size: var(--fs-12);
  white-space: nowrap;
}

.desktop-authorize__sep {
  color: var(--c-text-3);
}

.desktop-authorize__mono {
  font-family: var(--font-mono);
}

.desktop-authorize__facts {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-4);
  font-size: var(--fs-14);
}

.desktop-authorize__fact dt {
  margin-bottom: 2px;
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.desktop-authorize__fact dd {
  color: var(--c-text);
}

/* 账号行：昵称可能很长，整段省略而不是把（@用户名）拆到两行（07 §2.8） */
.desktop-authorize__account-line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1);
}

.desktop-authorize__account {
  overflow: hidden;
  max-width: 100%;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desktop-authorize__role {
  white-space: nowrap;
}

.desktop-authorize__permissions {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.desktop-authorize__permissions li {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

.desktop-authorize__check {
  margin-top: 3px;
  color: var(--c-success);
}

.desktop-authorize__limit {
  margin-top: var(--space-4);
}

.desktop-authorize__limit-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.desktop-authorize__limit-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: var(--border-width) solid var(--c-border);
  border-radius: var(--radius-control);
}

.desktop-authorize__limit-icon {
  color: var(--c-text-3);
  font-size: 18px;
}

.desktop-authorize__limit-body {
  min-width: 0;
  flex: 1;
}

.desktop-authorize__limit-name {
  overflow: hidden;
  color: var(--c-text);
  font-size: var(--fs-13);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desktop-authorize__actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-6);
}

.desktop-authorize__not-me {
  display: block;
  margin: var(--space-3) auto 0;
  padding: 0;
  border: 0;
  background: none;
  color: var(--c-text-3);
  cursor: pointer;
  font-size: var(--fs-12);
  text-decoration: underline;
}

.desktop-authorize__not-me:hover {
  color: var(--c-danger-ink);
}

.desktop-authorize__problem {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-control);
  background: var(--c-danger-soft);
}

.desktop-authorize__problem-icon {
  color: var(--c-danger-ink);
  font-size: 20px;
}

.desktop-authorize__problem-title {
  color: var(--c-danger-ink);
  font-size: var(--fs-14);
  font-weight: var(--fw-semibold);
}

.desktop-authorize__problem-detail {
  margin-top: var(--space-1);
  color: var(--c-text-2);
  font-size: var(--fs-14);
}

.desktop-authorize__problem-action {
  display: inline-block;
  margin-top: var(--space-2);
}

.desktop-authorize__done {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-4) 0;
  text-align: center;
}

.desktop-authorize__done-icon {
  color: var(--c-success);
  font-size: 32px;
}

.desktop-authorize__done-title {
  color: var(--c-text);
  font-size: var(--fs-16);
  font-weight: var(--fw-semibold);
}

.desktop-authorize__footer {
  margin-top: var(--space-6);
  text-align: center;
}

.desktop-authorize__privacy {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.desktop-authorize__privacy:hover {
  color: var(--c-primary-press);
}
</style>
