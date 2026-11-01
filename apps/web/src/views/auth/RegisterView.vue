<script setup lang="ts">
import { RegisterRequestSchema, USERNAME_MAX_LENGTH } from '@dsh-hub/shared'
import { useDebounceFn } from '@vueuse/core'
import { NAlert, NButton, NInput } from 'naive-ui'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { checkUsername, register } from '@/api/auth'
import { describeError } from '@/api/errors'
import CheckDraw from '@/components/base/CheckDraw.vue'
import PasswordStrength from '@/components/base/PasswordStrength.vue'
import CloudNap from '@/components/illustrations/CloudNap.vue'
import { scorePassword } from '@/composables/usePasswordStrength'
import { requestWelcomeGuide } from '@/composables/useWelcomeGuide'
import { safeNextPath } from '@/router'
import { useAuthStore } from '@/stores/auth'
import { useSiteStore } from '@/stores/site'

/**
 * 注册页（07 §5.2）：邀请码（`mode=invite` 必填、`?code=` 预填）、用户名实时校验（失焦 + 400ms 防抖）、
 * 昵称、密码（强度条）、确认密码；成功后 `pending` 展示审批页，否则勾号动画后跳 `/home` 并弹一次性引导。
 */
type UsernameStatus = 'idle' | 'checking' | 'available' | 'unavailable'

const auth = useAuthStore()
const site = useSiteStore()
const route = useRoute()
const router = useRouter()

const inviteCode = ref(String(route.query['code'] ?? ''))
const username = ref('')
const displayName = ref('')
const password = ref('')
const confirmPassword = ref('')
const submitting = ref(false)
const errorMessage = ref<string | null>('')
const usernameStatus = ref<UsernameStatus>('idle')
const usernameHint = ref('')

const success = ref(false)
const pending = ref(false)

const mode = computed(() => site.site.registrationMode)
const needInvite = computed(() => mode.value === 'invite')
const closed = computed(() => mode.value === 'closed')
const canCheckUsername = computed(() => username.value.length >= 3)

onMounted(() => {
  void site.load()
})

const USERNAME_REASON: Record<string, string> = {
  taken: '这个用户名已经被占用了',
  reserved: '这个用户名是系统保留字',
  invalid: '只能用小写字母、数字、- 和 _，且以字母开头',
}

async function runCheck(): Promise<void> {
  const value = username.value.trim()
  if (!canCheckUsername.value) {
    usernameStatus.value = 'idle'
    usernameHint.value = ''
    return
  }

  usernameStatus.value = 'checking'
  try {
    const result = await checkUsername(value)
    usernameStatus.value = result.available ? 'available' : 'unavailable'
    usernameHint.value = result.available ? '这个用户名可以用' : (USERNAME_REASON[result.reason ?? ''] ?? '用户名不可用')
  } catch (error) {
    // 限流/网络失败不阻塞填写，提交时服务端还会再校验一次
    usernameStatus.value = 'idle'
    usernameHint.value = describeError(error).message
  }
}

// 失焦立即校验 + 输入时 400ms 防抖（07 §5.2）
const debouncedCheck = useDebounceFn(runCheck, 400)

watch(username, () => {
  usernameHint.value = ''
  if (!canCheckUsername.value) {
    usernameStatus.value = 'idle'
    return
  }
  usernameStatus.value = 'checking'
  void debouncedCheck()
})

/** 用 shared 的注册 schema + 前端补充规则做一次校验（07 §1：表单校验复用同一套 schema）。 */
function validate(): string | null {
  if (needInvite.value && !inviteCode.value.trim()) return '请填写邀请码'

  const parsed = RegisterRequestSchema.safeParse({
    username: username.value.trim(),
    password: password.value,
    displayName: displayName.value.trim() || undefined,
    inviteCode: inviteCode.value.trim() || undefined,
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const field = String(issue?.path[0] ?? '')
    const prefix = field === 'username' ? '用户名：' : field === 'password' ? '密码：' : ''
    return `${prefix}${issue?.message ?? '请检查表单填写'}`
  }

  if (password.value !== confirmPassword.value) return '两次输入的密码不一致'

  const strength = scorePassword(password.value, username.value.trim())
  if (!strength.acceptable) return `密码强度不足：${strength.reasons.join('、')}`

  if (usernameStatus.value === 'unavailable') return usernameHint.value || '用户名不可用'

  return null
}

async function submit(): Promise<void> {
  errorMessage.value = validate()
  if (errorMessage.value) return

  submitting.value = true
  try {
    const response = await register({
      username: username.value.trim(),
      password: password.value,
      displayName: displayName.value.trim() || undefined,
      inviteCode: inviteCode.value.trim() || undefined,
    })

    if (!response.sessionStarted) {
      // requireApproval：不建会话，展示「等待审批」
      pending.value = true
      return
    }

    auth.setUser(response.user)
    await auth.fetchMe().catch(() => null)

    success.value = true
    requestWelcomeGuide()
    // 让勾号动画播完（400ms）再跳转
    setTimeout(() => {
      void router.replace(safeNextPath(route.query['next']) ?? '/home')
    }, 520)
  } catch (error) {
    errorMessage.value = describeError(error).message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <!-- ① 审批中等结果页 -->
  <section v-if="pending" class="auth-result">
    <CloudNap :size="128" animated />
    <h1 class="auth-result__title">已提交，等待管理员审批</h1>
    <p class="auth-result__text">
      管理员通过后就能登录了。你的用户名是
      <code class="auth-result__code">{{ username }}</code>
      ，记得保存好密码。
    </p>
    <RouterLink to="/login">
      <NButton type="primary" round>返回登录</NButton>
    </RouterLink>
  </section>

  <!-- ② 注册关闭 -->
  <section v-else-if="closed" class="auth-result">
    <h1 class="auth-result__title">当前没有开放注册</h1>
    <p class="auth-result__text">可以找管理员要一个邀请码，或者稍后再来看看。</p>
    <RouterLink to="/login">
      <NButton round>返回登录</NButton>
    </RouterLink>
  </section>

  <!-- ③ 成功勾号 -->
  <section v-else-if="success" class="auth-result">
    <CheckDraw :size="72" label="注册成功" />
    <h1 class="auth-result__title">注册成功，正在进入工作台…</h1>
  </section>

  <!-- ④ 注册表单 -->
  <section v-else class="auth-form">
    <header class="auth-form__head">
      <h1 class="auth-form__title">创建你的账号</h1>
      <!-- 需要审批是状态提示，要留着；不需要审批时不用再解释（07 §2.7） -->
      <p v-if="site.requireApproval" class="auth-form__subtitle">提交后需要管理员审批</p>
    </header>

    <NAlert v-if="errorMessage" type="error" :bordered="false" class="mb-4" aria-live="polite">
      {{ errorMessage }}
    </NAlert>

    <form class="auth-form__body" @submit.prevent="submit">
      <label v-if="needInvite" class="auth-field">
        <span class="auth-field__label">邀请码</span>
        <NInput
          v-model:value="inviteCode"
          placeholder="12 位邀请码"
          :input-props="{ autocomplete: 'off', 'aria-label': '邀请码' }"
        />
      </label>

      <label class="auth-field">
        <span class="auth-field__label">用户名</span>
        <NInput
          v-model:value="username"
          :maxlength="USERNAME_MAX_LENGTH"
          placeholder="小写字母开头，3–32 位"
          :input-props="{ autocomplete: 'username', 'aria-label': '用户名' }"
          @blur="runCheck"
        >
          <template #suffix>
            <span v-if="usernameStatus === 'checking'" class="i-ph-circle-notch ring-spin text-3" aria-hidden="true" />
            <span
              v-else-if="usernameStatus === 'available'"
              class="i-ph-check-circle text-primary"
              aria-label="用户名可用"
            />
            <span
              v-else-if="usernameStatus === 'unavailable'"
              class="i-ph-x-circle text-danger"
              aria-label="用户名不可用"
            />
          </template>
        </NInput>
        <span
          v-if="usernameHint"
          class="auth-field__hint"
          :class="usernameStatus === 'available' ? 'auth-field__hint--ok' : 'auth-field__hint--bad'"
          aria-live="polite"
        >
          {{ usernameHint }}
        </span>
      </label>

      <label class="auth-field">
        <span class="auth-field__label">昵称（可选）</span>
        <NInput
          v-model:value="displayName"
          :maxlength="32"
          placeholder="想让大家怎么称呼你"
          :input-props="{ autocomplete: 'nickname', 'aria-label': '昵称' }"
        />
      </label>

      <div class="auth-field">
        <label>
          <span class="auth-field__label">密码</span>
          <NInput
            v-model:value="password"
            type="password"
            show-password-on="click"
            placeholder="至少 10 位，含两类字符"
            :input-props="{ autocomplete: 'new-password', 'aria-label': '密码' }"
          />
        </label>
        <PasswordStrength :password="password" :username="username" />
      </div>

      <label class="auth-field">
        <span class="auth-field__label">确认密码</span>
        <NInput
          v-model:value="confirmPassword"
          type="password"
          show-password-on="click"
          placeholder="再输入一次"
          :input-props="{ autocomplete: 'new-password', 'aria-label': '确认密码' }"
        />
      </label>

      <NButton type="primary" block attr-type="submit" :loading="submitting" class="auth-form__submit">
        注册
      </NButton>
    </form>

    <p class="auth-form__foot">
      已经有账号了？
      <RouterLink to="/login" class="hub-link">去登录</RouterLink>
    </p>
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

.auth-field__hint {
  display: block;
  margin-top: var(--space-1);
  font-size: var(--fs-12);
}

.auth-field__hint--ok {
  color: var(--c-primary-press);
}

.auth-field__hint--bad {
  color: var(--c-danger);
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

.auth-result {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) 0;
  text-align: center;
}

.auth-result__title {
  font-size: var(--fs-20);
  font-weight: var(--fw-semibold);
  color: var(--c-text);
}

.auth-result__text {
  color: var(--c-text-2);
  font-size: var(--fs-13);
}

.auth-result__code {
  padding: 1px var(--space-2);
  border-radius: 8px;
  background: var(--c-primary-soft);
  color: var(--c-primary-press);
  font-family: var(--font-mono);
}
</style>
