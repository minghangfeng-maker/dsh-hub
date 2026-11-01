import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { createPinia } from 'pinia'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'

import { routes } from '@/router'
import { useAuthStore } from '@/stores/auth'
import MeView from '@/views/user/MeView.vue'

vi.mock('@/api/me', () => ({
  updateMe: vi.fn(),
  uploadAvatar: vi.fn(),
  deleteAvatar: vi.fn(),
  changePassword: vi.fn(),
  listSessions: vi.fn(async () => ({
    items: [
      {
        id: 'sess-current',
        current: true,
        createdAt: '2026-10-12T09:00:00.000Z',
        lastSeenAt: '2026-10-12T12:00:00.000Z',
        ip: '192.168.1.24',
        userAgent: 'Chrome',
        device: '桌面 Chrome',
      },
    ],
  })),
  revokeSession: vi.fn(),
  revokeOtherSessions: vi.fn(),
}))

/**
 * 个人中心 `/me`（15 §2.4）：
 * - 只剩「资料」「安全」两个标签，点击写入 `?tab=`；
 * - 旧地址 `?tab=plugins|exports` 用 `router.replace` 跳到 `/home#plugins|#data`（不能停在被裁掉的 Tab）。
 */
beforeAll(async () => {
  await Promise.all([
    import('@/components/user/me/ProfileTab.vue'),
    import('@/components/user/me/SecurityTab.vue'),
  ])
})

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await flushPromises()
}

async function mountMe(path: string): Promise<{ wrapper: ReturnType<typeof mount>; router: Router }> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  await router.isReady()

  const pinia = createPinia()
  useAuthStore(pinia).setUser({
    id: 12,
    slug: 'u7k2m9xr',
    username: 'littletao',
    displayName: '小桃',
    bio: '喜欢把东西收拾得整整齐齐。',
    avatarUrl: null,
    role: 'user',
    status: 'active',
    mustChangePassword: false,
    createdAt: '2026-09-01T02:10:00.000Z',
    lastLoginAt: '2026-10-12T05:30:00.000Z',
    usernameChangedAt: null,
  })

  const Host = defineComponent({
    components: { MeView, NMessageProvider },
    template: '<NMessageProvider><MeView /></NMessageProvider>',
  })

  const wrapper = mount(Host, { global: { plugins: [pinia, router] } })
  await settle()
  return { wrapper, router }
}

async function clickTab(wrapper: ReturnType<typeof mount>, label: string): Promise<void> {
  const tab = wrapper.findAll('.n-tabs-tab').find((item) => item.text().includes(label))
  if (!tab) throw new Error(`没有找到 Tab：${label}`)
  await tab.trigger('click')
  await settle()
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('个人中心 /me 的两个 Tab（15 §2.4）', () => {
  it('默认进「资料」，只有资料与安全两个 Tab', async () => {
    const { wrapper } = await mountMe('/me')

    const labels = wrapper.findAll('.n-tabs-tab').map((item) => item.text())
    expect(labels.some((text) => text.includes('资料'))).toBe(true)
    expect(labels.some((text) => text.includes('安全'))).toBe(true)
    expect(labels.some((text) => text.includes('我的插件'))).toBe(false)
    expect(labels.some((text) => text.includes('数据导出'))).toBe(false)

    expect(wrapper.find('[aria-label="用户名 30 天内可修改一次"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('?tab=security 直接落到安全：改密表单 + 设备列表（本机标记）', async () => {
    const { wrapper } = await mountMe('/me?tab=security')

    expect(wrapper.text()).toContain('修改密码')
    expect(wrapper.text()).toContain('当前密码')
    expect(wrapper.text()).toContain('登录设备')
    expect(wrapper.text()).toContain('桌面 Chrome')
    expect(wrapper.text()).toContain('本机')
    // 懒挂载：资料 Tab 没被渲染
    expect(wrapper.find('[aria-label="用户名 30 天内可修改一次"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('?tab=plugins → /home#plugins，?tab=exports → /home#data（router.replace）', async () => {
    const plugins = await mountMe('/me?tab=plugins')
    // 懒加载的 /home chunk 要等一会儿才解析完路由
    await vi.waitFor(() => expect(plugins.router.currentRoute.value.path).toBe('/home'), { timeout: 5000 })
    expect(plugins.router.currentRoute.value.hash).toBe('#plugins')
    // 被裁掉的 Tab 不再渲染
    expect(plugins.wrapper.text()).not.toContain('我的插件')
    plugins.wrapper.unmount()

    const exports = await mountMe('/me?tab=exports')
    await vi.waitFor(() => expect(exports.router.currentRoute.value.path).toBe('/home'), { timeout: 5000 })
    expect(exports.router.currentRoute.value.hash).toBe('#data')
    expect(exports.wrapper.text()).not.toContain('数据导出')
    exports.wrapper.unmount()
  })

  it('点击 Tab 会把 ?tab= 写进 URL；未知 tab 兜底回资料', async () => {
    const { wrapper, router } = await mountMe('/me')

    await clickTab(wrapper, '安全')
    expect(router.currentRoute.value.query.tab).toBe('security')
    expect(wrapper.text()).toContain('修改密码')

    await clickTab(wrapper, '资料')
    expect(router.currentRoute.value.query.tab).toBe('profile')

    wrapper.unmount()

    const fallback = await mountMe('/me?tab=nonsense')
    expect(fallback.wrapper.find('[aria-label="用户名 30 天内可修改一次"]').exists()).toBe(true)
    fallback.wrapper.unmount()
  })
})
