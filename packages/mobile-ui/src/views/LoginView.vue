<script setup lang="ts">
/**
 * 登录页（文档 §1.4 第 5 条 / §6.2）：
 * 只有用户名和密码，**不显示服务器地址**。注册、忘记密码、必须改密码都跳 Hub 网页。
 * 错误码按契约草案映射成中文；「待审批 / 已停用 / 必须改密码 / 限流」各有对应说明。
 *
 * 手机网页版（WP54 / C10）：
 *  - 没有「记住账号密码」开关 —— 网页里没有 SecureStorage，密码交给**浏览器自带的密码管理器**；
 *    表单是真正的 `<form>`、两个输入框带 `autocomplete="username"` / `"current-password"`，
 *    登录成功（登录页被路由替换掉）时 Chrome/Safari 会提示保存密码。
 *  - 注册 / 找回密码在**同页跳转**（Hub 网页与 /m/ 同源，返回手势即回登录页，与 APK 的
 *    Custom Tab 盖一层最接近）；见 `lib/web-ui.ts` 的 hubPageTarget 注释。
 *
 * 服务器地址（开源版新增）：APK 没有内置任何 Hub 入口时（构建时没给 `VITE_HUB_ORIGINS`），
 * 登录页顶部出现「服务器地址」输入框，用户填自己的 Hub 地址并持久化到 localStorage；
 * 内置了地址的包平时收起这个输入框，只在底部留一个「服务器地址」按钮用于改错/换服务器。
 * 网页版的入口就是页面 origin，既不显示也不能改。
 */

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from '@/components/AppIcon.vue'
import NetDiagSheet from '@/components/NetDiagSheet.vue'
import BrandMark from '@/components/BrandMark.vue'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { HubApiError } from '@dsh-hub/mobile-core'
import {
  CAN_EDIT_SERVER_ADDRESS,
  HUB_ORIGIN,
  IS_MOCK,
  NEEDS_SERVER_ADDRESS,
  webPage,
} from '@/lib/app-info'
import { normalizeServerAddressInput, readServerAddress, saveServerAddress } from '@/lib/server-address'
import { loginSecureStore, rememberedLogin } from '@/lib/instance'
import { isNative, openExternal } from '@/lib/storage'
import { REMEMBER_LOGIN_SUPPORTED, hubPageTarget } from '@/lib/web-ui'

const router = useRouter()
const auth = useAuthStore()
const ui = useUiStore()

/** 密码后端：Web 与「原生壳没注册 SecureStorage」都是 null，此时只记用户名。 */
const secureStore = loginSecureStore
/**
 * 「记住账号密码」开关是否有意义（网页版没有：C10 交给浏览器密码管理器）。
 * APK 构建里恒为 true，界面与 0.4.11 完全一致。
 */
const canRemember = REMEMBER_LOGIN_SUPPORTED
/** 「记住账号密码」默认勾选，挂载后按存储里的用户选择覆盖。 */
const remember = ref(true)
/** 密码是否由安全存储自动预填：用户一动手就置 false。 */
const passwordFromStore = ref(false)
/** 自动预填密码对应的用户名（改用户名时要撤掉旧账号的密码）。 */
const restoredUsername = ref('')

const username = ref(IS_MOCK ? 'demo' : '')
const password = ref(IS_MOCK ? 'demo1234' : '')
const submitting = ref(false)
const errorCode = ref('')
const errorText = ref('')
/** 限流倒计时：Hub 在 429 的 `details.retryAfterSec` 给出秒数，按秒刷新。 */
const cooldownUntil = ref(0)
const nowTick = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null

/**
 * 记住账号密码的能力提示：只有**原生壳缺安全存储**（真的存不了密码）时才说一句，
 * Web 版不再挂「仅 App 内保存」这种说明性文字（0.4.5 去文案）。
 */
const rememberHint = computed(() => {
  if (!isNative()) return ''
  return secureStore ? '' : '当前版本无法保存密码，只记住用户名'
})

/** 登录页挂载时预填：用户名（所有环境）+ 密码（仅原生安全存储）。 */
async function restoreRemembered(): Promise<void> {
  try {
    const saved = await rememberedLogin.load()
    // 极快点击登录（mock 版预填了 demo）时不要用异步读到的值覆盖正在提交的表单
    if (submitting.value) return
    remember.value = saved.remember
    if (saved.username) username.value = saved.username
    if (saved.password) {
      password.value = saved.password
      passwordFromStore.value = true
      restoredUsername.value = saved.username
    }
  } catch {
    /* 记住账号密码只是便利功能：读失败就当没存过，不影响正常登录 */
  }
}

onMounted(() => {
  // 启动竞态兜底：如果登录态其实已经恢复（自动登录成功但路由还停在这一页），
  // 直接回首页，别让用户再点一次「登录」。正常冷启动会在启动画面里完成恢复，
  // 只有真的恢复不了才会看到这个页面。
  if (auth.isAuthenticated) {
    void router.replace('/')
    return
  }
  void restoreRemembered()
})

// 用户改了用户名：预填的密码属于旧账号，撤掉（安全存储里的条目保留，切回去还能用）。
watch(username, (next) => {
  if (!passwordFromStore.value || next.trim() === restoredUsername.value) return
  password.value = ''
  passwordFromStore.value = false
})

function onPasswordInput(): void {
  passwordFromStore.value = false
}

async function onRememberChange(event: Event): Promise<void> {
  // 直接读 DOM：v-model 与 @change 在同一元素上时，处理顺序不保证，显式同步一次最稳。
  const checked = (event.target as HTMLInputElement | null)?.checked ?? remember.value
  remember.value = checked
  try {
    await rememberedLogin.setRemember(checked)
  } catch {
    /* 偏好写失败不影响登录 */
  }
}

/** 登录成功后的持久化：用户名必记；密码只在勾选 + 安全存储可用时写。 */
async function rememberAfterLogin(): Promise<void> {
  try {
    await rememberedLogin.onLoginSuccess(username.value, password.value, remember.value)
  } catch {
    /* 记住账号密码失败不影响登录 */
  }
}

const cooldownLeft = computed(() =>
  cooldownUntil.value > 0 ? Math.max(0, Math.ceil((cooldownUntil.value - nowTick.value) / 1000)) : 0,
)

const displayError = computed(() => {
  if (!errorText.value) return ''
  if (cooldownLeft.value > 0) return `${errorText.value}（${cooldownLeft.value} 秒后可重试）`
  return errorText.value
})

const canSubmit = computed(
  () =>
    username.value.trim().length > 0 &&
    password.value.length > 0 &&
    !submitting.value &&
    cooldownLeft.value === 0,
)

/**
 * 服务器地址（见文件头注释）：只在 APK 没有内置入口时显示；内置了地址也能点开改。
 */
const canEditServer = CAN_EDIT_SERVER_ADDRESS
const needsServer = NEEDS_SERVER_ADDRESS
const serverAddress = ref(readServerAddress() ?? HUB_ORIGIN)
const showServerField = ref(needsServer)
const serverError = ref('')

function openServerField(): void {
  showServerField.value = true
}

/**
 * 校验/保存「服务器地址」。返回 true = 可以继续登录；
 * 返回 false = 地址有问题（已显示错误），或者刚刚保存了新地址、页面正在重载。
 *
 * 为什么要重载：网关（`lib/instance.ts`）在模块加载时就用入口列表建好了客户端，
 * 换地址等于换客户端；重载一次最省事，也保证所有存了 origin 的地方一致。
 */
function applyServerAddress(): boolean {
  if (!showServerField.value) return true
  const result = normalizeServerAddressInput(serverAddress.value)
  if (!result.ok) {
    serverError.value = result.message
    return false
  }
  serverError.value = ''
  if (result.origin === HUB_ORIGIN) {
    showServerField.value = false
    return true
  }
  if (!saveServerAddress(result.origin)) {
    serverError.value = '保存失败：浏览器存储不可用'
    return false
  }
  location.reload()
  return false
}

function startCooldown(seconds: number): void {
  cooldownUntil.value = Date.now() + Math.max(1, seconds) * 1000
  nowTick.value = Date.now()
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = setInterval(() => {
    nowTick.value = Date.now()
    if (cooldownLeft.value === 0 && tickTimer) {
      clearInterval(tickTimer)
      tickTimer = null
    }
  }, 250)
}

onBeforeUnmount(() => {
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
})

const mustChangePassword = computed(() => errorCode.value === 'MUST_CHANGE_PASSWORD')

/**
 * 登录报「网络连接失败」时给一个「网络检测」入口（0.4.9）：
 * 只有在真的拿到非 HubApiError 的网络异常时才出现（其它错误码与网络无关）。
 */
const networkError = computed(() => errorCode.value === 'network')
const diagOpen = ref(false)

function openDiag(): void {
  diagOpen.value = true
}

function closeDiag(): void {
  diagOpen.value = false
}

/** 弹层里点「重新登录」：关掉弹层、用表单里还留着的账号密码再试一次。 */
function retryLogin(): void {
  diagOpen.value = false
  if (!canSubmit.value) return
  void submit()
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return
  if (!applyServerAddress()) return
  submitting.value = true
  errorCode.value = ''
  errorText.value = ''
  try {
    await auth.login(username.value, password.value)
    await rememberAfterLogin()
    await router.replace('/')
  } catch (error) {
    if (error instanceof HubApiError) {
      errorCode.value = error.code
      errorText.value = error.message
      if (error.retryAfterSec && error.retryAfterSec > 0) startCooldown(error.retryAfterSec)
      // 口令错：清掉已存密码（保留用户名），下次不再预填一个错的口令。
      if (error.code === 'INVALID_CREDENTIALS') await rememberedLogin.onInvalidCredentials()
    } else {
      errorCode.value = 'network'
      errorText.value = '网络连接失败，请检查网络后重试'
    }
  } finally {
    submitting.value = false
  }
}

async function openPage(path: string): Promise<void> {
  const url = webPage(path)
  if (!url) {
    ui.toast('开发版（mock）没有网页入口')
    return
  }
  try {
    // 网页版里 Hub 网页与本 App 同源：同页跳转（返回即回登录页，最接近 APK 的 Custom Tab）；
    // 开发/e2e 是跨源构建，仍然交给新标签页（见 lib/web-ui 的 hubPageTarget）。
    if (hubPageTarget(url) === 'same') {
      location.assign(url)
      return
    }
    await openExternal(url)
  } catch {
    ui.toast('打不开浏览器，请稍后重试')
  }
}
</script>

<template>
  <div class="login">
    <div class="login__brand">
      <BrandMark :width="72" />
      <h1 class="login__title">DSH Hub</h1>
    </div>

    <!-- 真 <form>：浏览器（尤其手机 Chrome/Safari）靠它认出「这是一个登录表单」并提供保存密码 -->
    <form class="login__form" method="post" @submit.prevent="submit">
      <!-- 服务器地址：没有内置入口的 APK 必填；网页版整块不渲染 -->
      <label v-if="showServerField" class="login__field" data-login-server>
        <span>服务器地址{{ needsServer ? '（必填）' : '' }}</span>
        <input
          v-model="serverAddress"
          type="url"
          name="hub-origin"
          inputmode="url"
          autocomplete="url"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          placeholder="https://hub.example.com"
          enterkeyhint="next"
          :disabled="submitting"
        />
      </label>
      <p v-if="serverError" class="login__error" role="alert">{{ serverError }}</p>

      <label class="login__field">
        <span>用户名</span>
        <input
          v-model="username"
          type="text"
          name="username"
          autocomplete="username"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          enterkeyhint="next"
          :disabled="submitting"
        />
      </label>
      <label class="login__field">
        <span>密码</span>
        <input
          v-model="password"
          type="password"
          name="password"
          autocomplete="current-password"
          enterkeyhint="go"
          :disabled="submitting"
          @input="onPasswordInput"
        />
      </label>

      <p v-if="displayError" class="login__error" role="alert">
        {{ displayError }}
      </p>
      <button v-if="networkError" class="login__diag" type="button" @click="openDiag">
        <AppIcon name="pulse" :size="14" />
        网络检测
      </button>
      <button
        v-if="mustChangePassword"
        class="login__linkbtn"
        type="button"
        @click="openPage('/me?tab=security')"
      >
        去网页修改密码
        <AppIcon name="chevronRight" :size="14" />
      </button>

      <!-- 记住账号密码：网页版没有（C10，交给浏览器密码管理器），整块不渲染 -->
      <label v-if="canRemember" class="login__remember" data-login-remember>
        <input
          v-model="remember"
          type="checkbox"
          name="remember"
          :disabled="submitting"
          @change="onRememberChange"
        />
        <span class="login__remember-body">
          <span class="login__remember-text">记住账号密码</span>
          <span v-if="rememberHint" class="login__remember-hint">{{ rememberHint }}</span>
        </span>
      </label>

      <button class="btn-primary login__submit" type="submit" :disabled="!canSubmit">
        {{ submitting ? '正在登录…' : '登录' }}
      </button>
    </form>

    <button
      v-if="canEditServer && !showServerField"
      class="login__server-toggle"
      type="button"
      @click="openServerField"
    >
      服务器地址
    </button>

    <div class="login__links">
      <button type="button" @click="openPage('/register')">注册账号</button>
      <span aria-hidden="true">·</span>
      <button type="button" @click="openPage('/forgot-password')">忘记密码</button>
    </div>

    <p v-if="IS_MOCK" class="login__dev">开发版 · 本地 mock 数据，不连接真实 Hub</p>

    <NetDiagSheet :open="diagOpen" @close="closeDiag" @relogin="retryLogin" />
  </div>
</template>

<style scoped>
.login {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 26px calc(28px + var(--safe-bottom));
  gap: 20px;
  max-width: 460px;
  margin: 0 auto;
  width: 100%;
}
.login__brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.login__title {
  font-size: 26px;
  font-weight: 650;
  letter-spacing: -0.01em;
}
.login__form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.login__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 12px 16px;
}
.login__field:focus-within {
  border-color: var(--border-strong);
}
.login__field span {
  font-size: 11.5px;
  color: var(--text-3);
  letter-spacing: 0.02em;
}
.login__field input {
  border: 0;
  background: transparent;
  font-size: 16px;
  color: var(--text);
  padding: 2px 0;
  width: 100%;
}
.login__field input:focus {
  outline: none;
}
.login__error {
  margin: 2px 4px 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--danger);
}
.login__diag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  align-self: flex-start;
  height: 32px;
  margin: -4px 4px 0;
  padding: 0 13px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--surface);
  color: var(--text-2);
  font-size: 12.5px;
}
.login__diag:active {
  background: var(--surface-2);
}
.login__linkbtn {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  align-self: flex-start;
  margin: -4px 4px 0;
  font-size: 13px;
  color: var(--accent-ink);
}
.login__remember {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 34px;
  margin: 0 4px;
  padding: 2px 0;
  cursor: pointer;
  /* 与输入卡、主按钮保持同一套克制配色：只有勾选标记用品牌蓝 */
  -webkit-tap-highlight-color: transparent;
}
.login__remember input[type='checkbox'] {
  flex: 0 0 auto;
  width: 17px;
  height: 17px;
  margin: 0;
  border-radius: 5px;
  accent-color: var(--accent);
  cursor: pointer;
}
.login__remember-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.login__remember-text {
  font-size: 13.5px;
  line-height: 1.4;
  color: var(--text-2);
}
.login__remember-hint {
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--text-3);
}
.login__submit {
  margin-top: 4px;
  width: 100%;
  padding: 14px 0;
  font-size: 15.5px;
}
.login__links {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--text-2);
}
.login__links button {
  color: var(--text-2);
  padding: 4px 2px;
}
.login__links button:active {
  color: var(--text);
}
.login__server-toggle {
  align-self: center;
  margin: -8px 0 0;
  padding: 4px 2px;
  font-size: 12px;
  color: var(--text-3);
}
.login__server-toggle:active {
  color: var(--text-2);
}
.login__dev {
  text-align: center;
  font-size: 11px;
  color: var(--text-3);
  opacity: 0.8;
  margin: 0;
}
</style>
