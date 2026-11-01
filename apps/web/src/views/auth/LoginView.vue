<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { NAlert, NButton, NCheckbox, NInput } from 'naive-ui'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { describeError } from '@/api/errors'
import CaInstallDialog from '@/components/base/CaInstallDialog.vue'
import { formatCountdown } from '@/composables/useFormat'
import { safeNextPath } from '@/router'
import { useAuthStore } from '@/stores/auth'
import { useSiteStore } from '@/stores/site'

/**
 * 登录页（07 §5.1）：用户名、密码（可显隐）、记住我、loading；错误就地显示在表单上方的柔和提示条，
 * ACCOUNT_LOCKED 显示倒计时；首次访问提示可关闭，链到 /ca.crt 与四平台安装说明弹窗。
 */
const auth = useAuthStore()
const site = useSiteStore()
const route = useRoute()
const router = useRouter()

const CA_HINT_KEY = 'hub.ca-hint.dismissed'

const username = ref('')
const password = ref('')
const remember = ref(true)
const submitting = ref(false)
const errorMessage = ref('')
const lockedSeconds = ref(0)
const showCaDialog = ref(false)
const caHintDismissed = ref(readCaHint())

onMounted(() => {
  void site.load()
})

// 锁定倒计时（ACCOUNT_LOCKED 的 details.retryAfterSec）
const { pause, resume } = useIntervalFn(
  () => {
    lockedSeconds.value = Math.max(0, lockedSeconds.value - 1)
  },
  1000,
  { immediate: false },
)

watch(lockedSeconds, (value) => {
  if (value > 0) resume()
  else pause()
})

/** 07 §5.1：只有服务端给了非空 caCertUrl（即真的有自签证书）时才提示安装 */
const caCertAvailable = computed(() => site.site.caCertUrl.trim().length > 0)
const locked = computed(() => lockedSeconds.value > 0)
const alertText = computed(() =>
  locked.value ? `${errorMessage.value}（${formatCountdown(lockedSeconds.value)} 后可再试）` : errorMessage.value,
)

function readCaHint(): boolean {
  try {
    return window.localStorage.getItem(CA_HINT_KEY) === '1'
  } catch {
    return true
  }
}

function dismissCaHint(): void {
  caHintDismissed.value = true
  try {
    window.localStorage.setItem(CA_HINT_KEY, '1')
  } catch {
    // 隐私模式：忽略
  }
}

async function submit(): Promise<void> {
  errorMessage.value = ''

  if (!username.value.trim() || !password.value) {
    errorMessage.value = '请填写用户名和密码'
    return
  }

  submitting.value = true
  try {
    await auth.login(username.value.trim(), password.value, remember.value)
    await router.replace(safeNextPath(route.query['next']) ?? '/home')
  } catch (error) {
    const description = describeError(error)
    errorMessage.value = description.message
    if (description.retryAfterSec !== null) lockedSeconds.value = description.retryAfterSec
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <section class="auth-form">
    <header class="auth-form__head">
      <h1 class="auth-form__title">欢迎回来</h1>
      <p class="auth-form__subtitle">{{ site.site.tagline }}</p>
    </header>

    <NAlert v-if="alertText" type="error" :bordered="false" class="mb-4" aria-live="polite">
      {{ alertText }}
    </NAlert>

    <form class="auth-form__body" @submit.prevent="submit">
      <label class="auth-field">
        <span class="auth-field__label">用户名</span>
        <NInput
          v-model:value="username"
          placeholder="你的用户名"
          :input-props="{ autocomplete: 'username', 'aria-label': '用户名' }"
        />
      </label>

      <label class="auth-field">
        <span class="auth-field__label">密码</span>
        <NInput
          v-model:value="password"
          type="password"
          show-password-on="click"
          placeholder="你的密码"
          :input-props="{ autocomplete: 'current-password', 'aria-label': '密码' }"
        />
      </label>

      <div class="auth-form__row">
        <NCheckbox v-model:checked="remember">记住我</NCheckbox>
        <span class="auth-form__muted">忘记密码？请联系管理员重置</span>
      </div>

      <NButton
        type="primary"
        block
        attr-type="submit"
        :loading="submitting"
        :disabled="locked"
        class="auth-form__submit"
      >
        登录
      </NButton>
    </form>

    <p v-if="site.registrationOpen" class="auth-form__foot">
      还没有账号？
      <RouterLink to="/register" class="hub-link">去注册</RouterLink>
    </p>

    <div v-if="!caHintDismissed && caCertAvailable" class="auth-form__hint">
      <span class="i-ph-shield-warning" aria-hidden="true" />
      <span>浏览器提示不安全？</span>
      <button type="button" class="auth-form__hint-link" @click="showCaDialog = true">安装根证书</button>
      <a :href="site.site.caCertUrl" class="hub-link" download>直接下载</a>
      <button type="button" class="auth-form__hint-close" aria-label="不再提示" @click="dismissCaHint">✕</button>
    </div>

    <CaInstallDialog v-if="caCertAvailable" v-model:show="showCaDialog" :ca-cert-url="site.site.caCertUrl" />
  </section>
</template>

<style scoped>
.auth-form__head {
  margin-bottom: var(--space-6);
  text-align: center;
}

.auth-form__title {
  font-size: var(--fs-24);
  font-weight: var(--fw-semibold);
  color: var(--c-text);
}

.auth-form__subtitle {
  margin-top: var(--space-1);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

/* ≥960px 时左侧品牌区已经显示同一句标语（AuthLayout），卡片里不再重复 */
@media (min-width: 960px) {
  .auth-form__subtitle {
    display: none;
  }
}

.auth-form__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.auth-field {
  display: block;
}

.auth-field__label {
  display: block;
  margin-bottom: var(--space-1);
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.auth-form__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.auth-form__muted {
  color: var(--c-text-3);
  font-size: var(--fs-12);
}

.auth-form__submit {
  margin-top: var(--space-1);
}

.auth-form__foot {
  margin-top: var(--space-4);
  text-align: center;
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.auth-form__hint {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
  margin-top: var(--space-4);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-control);
  background: var(--c-sky-soft);
  color: var(--c-text-2);
  font-size: var(--fs-12);
}

.auth-form__hint-link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--c-primary-press);
  cursor: pointer;
  font-size: var(--fs-12);
  text-decoration: underline;
}

.auth-form__hint-close {
  margin-left: auto;
  padding: 0 2px;
  border: 0;
  background: none;
  color: var(--c-text-3);
  cursor: pointer;
  font-size: var(--fs-12);
}

/*
 * 手机宽度（WP54c）：根证书提示那一行是 12px 小字，行内链接与 ✕ 的点击区只有 19px。
 * `padding-block` 只扩可点范围、不改行盒高度；✕ 绝对定位到右上角做成 44×44，
 * 免得挤成单独一行把提示框撑高。（只在自签证书部署时才出现，生产用正式证书时不显示）
 */
@media (max-width: 640px) {
  .auth-form__hint {
    position: relative;
    padding-right: var(--space-8);
  }

  .auth-form__hint-link,
  .auth-form__hint a {
    padding-block: 13px;
  }

  .auth-form__hint-close {
    position: absolute;
    top: 0;
    right: 0;
    min-width: 44px;
    min-height: 44px;
    margin-left: 0;
    padding: 0;
  }
}
</style>
