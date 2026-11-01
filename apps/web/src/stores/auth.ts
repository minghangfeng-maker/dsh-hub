import type { InstanceSummary, UserPublic } from '@dsh-hub/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import * as authApi from '@/api/auth'
import { isHubApiError } from '@/api/http'

/**
 * 登录态（07 §1）。
 *
 * 只保存「当前用户」这一件事；实例状态在 WP5b 的页面里按需拉（避免全局 store 变成大杂烩）。
 * `initialized` 用于路由守卫：App 启动后最多问一次 `/api/auth/me`。
 */
export const useAuthStore = defineStore('auth', () => {
  const user = ref<UserPublic | null>(null)
  const instance = ref<InstanceSummary | null>(null)
  const initialized = ref(false)
  const loading = ref(false)

  const isLoggedIn = computed(() => user.value !== null)
  const isAdmin = computed(() => user.value?.role === 'admin')
  const mustChangePassword = computed(() => user.value?.mustChangePassword === true)
  const displayName = computed(() => user.value?.displayName?.trim() || user.value?.username || '')
  const avatarUrl = computed(() => user.value?.avatarUrl ?? null)

  function setUser(next: UserPublic | null): void {
    user.value = next
    if (!next) instance.value = null
  }

  function setInstance(next: InstanceSummary | null): void {
    instance.value = next
  }

  function patchUser(partial: Partial<UserPublic>): void {
    if (user.value) user.value = { ...user.value, ...partial }
  }

  /** 问一次 `/api/auth/me`；未登录（401）与网络失败都视为「没有登录」，不抛错。 */
  async function fetchMe(): Promise<UserPublic | null> {
    loading.value = true
    try {
      const response = await authApi.fetchMe()
      setUser(response.user)
      instance.value = response.instance
      return response.user
    } catch (error) {
      if (isHubApiError(error)) {
        setUser(null)
        return null
      }
      throw error
    } finally {
      initialized.value = true
      loading.value = false
    }
  }

  /** 守卫与 App.vue 调用：保证登录态已经确认过一次。 */
  async function ensureLoaded(force = false): Promise<void> {
    if (initialized.value && !force) return
    await fetchMe()
  }

  async function login(username: string, password: string, remember = false): Promise<UserPublic> {
    const { user: loggedIn } = await authApi.login({ username, password, remember })
    setUser(loggedIn)
    initialized.value = true
    // 登录响应不带 instance（04 §2），补一次 me；失败不影响登录本身
    await fetchMe().catch(() => null)
    return loggedIn
  }

  async function logout(): Promise<void> {
    try {
      await authApi.logout()
    } catch (error) {
      // 网络/接口失败也要清本地状态（HttpOnly cookie 只能由服务端清），但别把问题吞掉：
      // 联调时就是这里静默失败，导致「界面登出了、服务端会话还在」
      if (import.meta.env.DEV) console.warn('[auth] 登出接口失败，服务端会话可能仍然有效', error)
    }
    setUser(null)
    initialized.value = true
  }

  /** 重置为「未确认」状态（测试与登出后使用）。 */
  function reset(): void {
    setUser(null)
    initialized.value = false
  }

  return {
    user,
    instance,
    initialized,
    loading,
    isLoggedIn,
    isAdmin,
    mustChangePassword,
    displayName,
    avatarUrl,
    setUser,
    setInstance,
    patchUser,
    fetchMe,
    ensureLoaded,
    login,
    logout,
    reset,
  }
})
