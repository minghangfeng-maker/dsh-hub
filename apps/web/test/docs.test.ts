import type { PublicSiteResponse, UserPublic } from '@dsh-hub/shared'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import { createAppRouter, routes } from '@/router'
import { useAuthStore } from '@/stores/auth'
import DocsView from '@/views/DocsView.vue'

/**
 * 公开使用文档 `/docs`（WP44）。
 *
 * 免登录；目录与正文九节一一对应；注册开关决定第 2 节第一步的说法；
 * 顶栏未登录是「登录」、已登录是「进入工作台」；引用的截图、隐私说明、主页 Tab 直达链接都在。
 */

enableAutoUnmount(afterEach)

const USER: UserPublic = {
  id: 1,
  slug: 'u7k2m9xa',
  username: 'mint-tea',
  displayName: '薄荷茶',
  bio: '',
  avatarUrl: null,
  role: 'user',
  status: 'active',
  mustChangePassword: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  lastLoginAt: '2026-10-12T08:00:00.000Z',
  usernameChangedAt: null,
}

const SITE: PublicSiteResponse = {
  name: 'DSH Hub',
  tagline: '探索未至之境',
  announcement: '',
  announcementLevel: 'info',
  registrationMode: 'open',
  requireApproval: false,
  caCertUrl: null,
}

const SECTION_IDS = ['what', 'quickstart', 'working', 'workbench', 'desktop', 'android', 'account', 'faq']

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function stubFetch(site: Partial<PublicSiteResponse> = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/public/site')) return json({ ...SITE, ...site })
      if (url.includes('/api/auth/me')) {
        return json({ error: { code: 'UNAUTHENTICATED', message: '请先登录' } }, 401)
      }
      return json({ error: { code: 'NOT_FOUND', message: '资源不存在' } }, 404)
    }),
  )
}

async function mountDocs(options: { site?: Partial<PublicSiteResponse>; user?: UserPublic } = {}) {
  stubFetch(options.site)
  const pinia = createPinia()
  if (options.user) useAuthStore(pinia).setUser(options.user)
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/docs')
  await router.isReady()
  const wrapper = mount(DocsView, { global: { plugins: [pinia, router] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('公开使用文档 /docs（WP44）', () => {
  it('路由免登录：未登录访问 /docs 不会被送去登录页', async () => {
    stubFetch()
    const router = createAppRouter(createMemoryHistory(), { pinia: createPinia() })
    await router.push('/docs').catch(() => undefined)

    expect(router.currentRoute.value.name).toBe('Docs')
    expect(router.currentRoute.value.meta.layout).toBe('blank')
    expect(router.currentRoute.value.meta.requiresAuth).toBeFalsy()
  })

  it('目录九项与正文九节一一对应，目录链接是页内锚点', async () => {
    const wrapper = await mountDocs()

    expect(wrapper.get('h1').text()).toBe('DSH Hub 使用文档')
    const tocLinks = wrapper.get('[data-testid="docs-toc"]').findAll('a')
    expect(tocLinks.map((link) => link.attributes('href'))).toEqual(SECTION_IDS.map((id) => `/docs#${id}`))
    for (const id of SECTION_IDS) {
      expect(wrapper.find(`section#${id}`).exists(), `缺少第 ${id} 节`).toBe(true)
    }
    expect(wrapper.findAll('section h2')).toHaveLength(SECTION_IDS.length)
  })

  it('未登录：顶栏是「回到主页」「登录」', async () => {
    const wrapper = await mountDocs()

    expect(wrapper.get('[data-testid="docs-home"]').attributes('href')).toBe('/')
    expect(wrapper.get('[data-testid="docs-login"]').attributes('href')).toBe('/login')
    expect(wrapper.find('[data-testid="docs-workbench"]').exists()).toBe(false)
  })

  it('已登录：顶栏换成「进入工作台」', async () => {
    const wrapper = await mountDocs({ user: USER })

    expect(wrapper.get('[data-testid="docs-workbench"]').attributes('href')).toBe('/home')
    expect(wrapper.find('[data-testid="docs-login"]').exists()).toBe(false)
  })

  it('注册开放时第一步链到注册页；关闭时改说找管理员', async () => {
    const open = await mountDocs()
    const quickstart = open.get('[data-testid="docs-section-quickstart"]')
    expect(quickstart.find('a[href="/register"]').exists()).toBe(true)

    const closed = await mountDocs({ site: { registrationMode: 'closed' } })
    const closedStart = closed.get('[data-testid="docs-section-quickstart"]')
    expect(closedStart.find('a[href="/register"]').exists()).toBe(false)
    expect(closedStart.text()).toContain('找管理员')
  })

  it('不写积分与计费（WP53）：没有积分章节，正文不出现积分/计费/余额', async () => {
    const wrapper = await mountDocs()

    expect(wrapper.find('[data-testid="docs-section-points"]').exists()).toBe(false)
    const text = wrapper.get('main').text()
    for (const word of ['积分', '计费', '余额', '收费', '充值']) expect(text).not.toContain(word)
    expect(text).toContain('DSH Hub 连通万物')
  })

  it('中文正文里没有模板换行留下的多余空格', async () => {
    const wrapper = await mountDocs()
    // 逐个文字块检查（块与块之间的换行不算）：Vue 会把中文行间的换行压成一个空格
    const blocks = wrapper.findAll('main :is(p, li, dt, dd, td, th, figcaption, h1, h2, h3)')
    const stray = blocks
      .map((block) => block.element.textContent ?? '')
      .flatMap((text) => text.match(/[\u4e00-\u9fff，。、；：！？）」] +[\u4e00-\u9fff（「<]/g) ?? [])
    expect(stray).toEqual([])
  })

  it('引用：隐私说明、主页桌面端/安卓端 Tab 直达、真实截图带 alt', async () => {
    const wrapper = await mountDocs()

    expect(wrapper.find('a[href="/desktop/privacy"]').exists()).toBe(true)
    expect(wrapper.find('a[href="/?platform=desktop"]').exists()).toBe(true)
    expect(wrapper.find('a[href="/?platform=android"]').exists()).toBe(true)
    const img = wrapper.get('[data-testid="docs-section-quickstart"] img')
    expect(img.attributes('alt')).toContain('销售表')
  })
})
