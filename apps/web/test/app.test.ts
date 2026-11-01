import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import App from '@/App.vue'
import { routes } from '@/router'

/** 建一个真实的 #app 挂载点，验证 main.ts 的挂载目标在 DOM 里能正常工作。 */
function createAppHost(): HTMLDivElement {
  const host = document.createElement('div')
  host.id = 'app'
  document.body.append(host)
  return host
}

async function mountApp(path: string) {
  const host = createAppHost()
  const router = createRouter({ history: createMemoryHistory(), routes })

  await router.push(path)
  await router.isReady()

  const wrapper = mount(App, {
    attachTo: host,
    global: { plugins: [createPinia(), router] },
  })

  await flushPromises()

  return { host, router, wrapper }
}

describe('App.vue 冒烟（WP5a 起的真实页面）', () => {
  it('挂载 /login：渲染登录卡片 + AuthLayout 玻璃外壳', async () => {
    const { host, wrapper } = await mountApp('/login')

    // 三包并行跑测试时 jsdom 里懒加载 + Naive 渲染可能超过默认的 1s
    await vi.waitFor(
      () => {
        expect(host.textContent ?? '').toContain('欢迎回来')
      },
      { timeout: 10_000 },
    )

    expect(host.innerHTML.length).toBeGreaterThan(0)
    // 真实登录表单：用户名 / 密码 / 登录按钮
    expect(host.textContent ?? '').toContain('用户名')
    expect(host.textContent ?? '').toContain('登录')
    expect(host.querySelectorAll('input').length).toBeGreaterThanOrEqual(2)
    // meta.layout = auth → App.vue 选中 AuthLayout（玻璃卡片）
    expect(host.querySelector('.auth-layout__card')).not.toBeNull()
    // 主题覆盖已注入：Naive UI 的 ConfigProvider 会挂上 n-config-provider
    expect(host.querySelector('.n-config-provider')).not.toBeNull()

    wrapper.unmount()
    host.remove()
  })

  it('管理端路由渲染 AdminLayout（232px 侧边栏 + 面包屑）', async () => {
    const { host, wrapper } = await mountApp('/admin/users')

    await vi.waitFor(
      () => {
        expect(host.querySelector('aside')).not.toBeNull()
      },
      { timeout: 10_000 },
    )

    const nav = host.querySelector('aside')?.textContent ?? ''
    expect(nav).toContain('DSH 版本')
    expect(nav).toContain('任务中心')
    // WP11b：中转站并进「模型」页，侧栏「能力下发」只剩一个入口
    expect(nav).toContain('模型')
    expect(nav).not.toContain('中转站')
    // 顶栏面包屑与「返回我的工作台」
    expect(host.textContent ?? '').toContain('返回我的工作台')
    expect(host.textContent ?? '').toContain('管理后台')

    wrapper.unmount()
    host.remove()
  })
})
