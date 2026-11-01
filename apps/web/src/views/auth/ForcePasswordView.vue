<script setup lang="ts">
import { NAlert, NButton, NInput } from 'naive-ui'
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { describeError } from '@/api/errors'
import { changePassword } from '@/api/me'
import CheckDraw from '@/components/base/CheckDraw.vue'
import InfoTip from '@/components/base/InfoTip.vue'
import PasswordStrength from '@/components/base/PasswordStrength.vue'
import { scorePassword } from '@/composables/usePasswordStrength'
import { safeNextPath } from '@/router'
import { useAuthStore } from '@/stores/auth'
import { useSiteStore } from '@/stores/site'

/**
 * 强制改密页（07 §3 `/me/password`，04 §0.2 `MUST_CHANGE_PASSWORD`）：
 * 管理员重置密码后，用户只能访问这里；改完刷新登录态并回跳 `next` 或工作台。
 */
const auth = useAuthStore()
const site = useSiteStore()
const route = useRoute()
const router = useRouter()

const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const submitting = ref(false)
const errorMessage = ref<string | null>('')
const done = ref(false)

const forced = computed(() => auth.mustChangePassword)

onMounted(() => {
  void site.load()
})

function validate(): string | null {
  if (!currentPassword.value) return '请输入当前密码'
  if (newPassword.value === currentPassword.value) return '新密码不能和当前密码相同'
  if (newPassword.value !== confirmPassword.value) return '两次输入的新密码不一致'

  const strength = scorePassword(newPassword.value, auth.user?.username)
  if (!strength.acceptable) return `密码强度不足：${strength.reasons.join('、')}`

  return null
}

async function submit(): Promise<void> {
  errorMessage.value = validate()
  if (errorMessage.value) return

  submitting.value = true
  try {
    await changePassword({
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
    })
    done.value = true
    await auth.fetchMe().catch(() => null)
    setTimeout(() => {
      void router.replace(safeNextPath(route.query['next']) ?? '/home')
    }, 640)
  } catch (error) {
    errorMessage.value = describeError(error).message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <section v-if="done" class="auth-result">
    <CheckDraw :size="72" label="密码已更新" />
    <h1 class="auth-result__title">好的，已保存</h1>
    <p class="auth-result__text">正在进入你的工作台…</p>
  </section>

  <section v-else class="auth-form">
    <header class="auth-form__head">
      <h1 class="auth-form__title">
        {{ forced ? '设置你的新密码' : '修改密码' }}
        <InfoTip v-if="!forced" label="修改密码说明" text="改完之后，其它设备上的登录会立即失效。" />
      </h1>
      <!-- 管理员重置过 = 状态提示（07 §2.7 第 3 条） -->
      <p v-if="forced" class="auth-form__subtitle">管理员重置了你的密码</p>
    </header>

    <NAlert v-if="errorMessage" type="error" :bordered="false" class="mb-4" aria-live="polite">
      {{ errorMessage }}
    </NAlert>

    <form class="auth-form__body" @submit.prevent="submit">
      <label class="auth-field">
        <span class="auth-field__label">当前密码</span>
        <NInput
          v-model:value="currentPassword"
          type="password"
          show-password-on="click"
          placeholder="当前（或管理员给你的临时）密码"
          :input-props="{ autocomplete: 'current-password', 'aria-label': '当前密码' }"
        />
      </label>

      <div class="auth-field">
        <label>
          <span class="auth-field__label">新密码</span>
          <NInput
            v-model:value="newPassword"
            type="password"
            show-password-on="click"
            placeholder="至少 10 位，含两类字符"
            :input-props="{ autocomplete: 'new-password', 'aria-label': '新密码' }"
          />
        </label>
        <PasswordStrength :password="newPassword" :username="auth.user?.username" />
      </div>

      <label class="auth-field">
        <span class="auth-field__label">确认新密码</span>
        <NInput
          v-model:value="confirmPassword"
          type="password"
          show-password-on="click"
          placeholder="再输入一次"
          :input-props="{ autocomplete: 'new-password', 'aria-label': '确认新密码' }"
        />
      </label>

      <NButton type="primary" block attr-type="submit" :loading="submitting" class="auth-form__submit">
        保存新密码
      </NButton>
    </form>

    <p class="auth-form__foot">
      <RouterLink :to="forced ? '/login' : '/home'" class="hub-link">
        {{ forced ? '换个账号登录' : '返回工作台' }}
      </RouterLink>
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

.auth-form__submit {
  margin-top: var(--space-1);
}

.auth-form__foot {
  margin-top: var(--space-4);
  text-align: center;
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
</style>
