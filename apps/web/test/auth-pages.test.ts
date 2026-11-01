import type { PublicSiteResponse } from '@dsh-hub/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'

import { routes } from '@/router'
import ForcePasswordView from '@/views/auth/ForcePasswordView.vue'
import LoginView from '@/views/auth/LoginView.vue'
import RegisterView from '@/views/auth/RegisterView.vue'

const SITE: PublicSiteResponse = {
  name: 'DSH Hub',
  tagline: '你的云上 AI 工作台',
  announcement: '',
  announcementLevel: 'info',
  registrationMode: 'invite',
  requireApproval: false,
  caCertUrl: '/ca.crt',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/** 路由到指定路径（不装守卫：这里只验证页面自身行为）。 */
async function routerAt(path: string): Promise<Router> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  await router.isReady()
  return router
}

async function mountAt(path: string, component: unknown, siteOverride: Partial<PublicSiteResponse> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/public/site')) return json({ ...SITE, ...siteOverride })
      return json({ error: { code: 'NOT_FOUND', message: '资源不存在' } }, 404)
    }),
  )

  const router = await routerAt(path)
  const wrapper = mount(component as never, {
    global: { plugins: [createPinia(), router] },
  })
  await flushPromises()

  return { wrapper, router }
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('登录页（07 §5.1）', () => {
  it('渲染用户名/密码/记住我/登录按钮与注册入口', async () => {
    const { wrapper } = await mountAt('/login', LoginView)

    expect(wrapper.text()).toContain('欢迎回来')
    expect(wrapper.text()).toContain('你的云上 AI 工作台')
    expect(wrapper.findAll('input')).toHaveLength(2)
    expect(wrapper.text()).toContain('记住我')
    expect(wrapper.text()).toContain('去注册')
    // 首次访问的证书提示条（服务端给了非空 caCertUrl 时才出现，可关闭）
    expect(wrapper.text()).toContain('安装根证书')
    expect(wrapper.find('a[href="/ca.crt"]').exists()).toBe(true)
  })

  it('caCertUrl 为空时不显示证书提示条（07 §5.1：阶段一本地 http）', async () => {
    const { wrapper } = await mountAt('/login', LoginView, { caCertUrl: '' })

    expect(wrapper.text()).not.toContain('安装根证书')
    expect(wrapper.find('a[href="/ca.crt"]').exists()).toBe(false)
    expect(wrapper.find('.auth-form__hint').exists()).toBe(false)
  })

  it('服务端返回 caCertUrl=null 时：站点信息仍然生效（不被判成契约错误），且不显示证书提示', async () => {
    const { wrapper } = await mountAt('/login', LoginView, {
      tagline: '薄荷味的工作台',
      caCertUrl: null as unknown as string,
    })

    // 标语来自响应 → 说明容错解析通过，没有整份退回兜底值
    expect(wrapper.text()).toContain('薄荷味的工作台')
    expect(wrapper.text()).not.toContain('安装根证书')
  })

  it('注册关闭时不显示「去注册」', async () => {
    const { wrapper } = await mountAt('/login', LoginView, { registrationMode: 'closed' })
    expect(wrapper.text()).not.toContain('去注册')
  })

  it('空表单提交：就地提示，不发请求', async () => {
    const { wrapper } = await mountAt('/login', LoginView)

    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(wrapper.find('.n-alert').text()).toContain('请填写用户名和密码')
  })

  it('登录失败：显示服务端中文文案，并且不跳转', async () => {
    const { wrapper, router } = await mountAt('/login', LoginView)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ error: { code: 'INVALID_CREDENTIALS', message: '用户名或密码不对，再试一次？' } }, 401),
      ),
    )

    const inputs = wrapper.findAll('input')
    await inputs[0]?.setValue('mint-tea')
    await inputs[1]?.setValue('wrong-password')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(wrapper.find('.n-alert').text()).toContain('用户名或密码不对')
    expect(router.currentRoute.value.path).toBe('/login')
  })

  it('ACCOUNT_LOCKED：显示锁定文案 + mm:ss 倒计时', async () => {
    const { wrapper } = await mountAt('/login', LoginView)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(
          {
            error: {
              code: 'ACCOUNT_LOCKED',
              message: '账号被临时锁定，请稍后再试',
              details: { retryAfterSec: 900 },
            },
          },
          423,
        ),
      ),
    )

    const inputs = wrapper.findAll('input')
    await inputs[0]?.setValue('mint-tea')
    await inputs[1]?.setValue('wrong-password')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(wrapper.find('.n-alert').text()).toContain('15:00')
  })

  it('登录成功后跳转到 next（站内路径）', async () => {
    const { wrapper, router } = await mountAt('/login?next=/me', LoginView)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/api/auth/login')) {
          return json({
            user: {
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
              lastLoginAt: null,
              usernameChangedAt: null,
            },
          })
        }
        if (url.includes('/api/auth/me')) {
          return json({ error: { code: 'UNAUTHENTICATED', message: '请先登录' } }, 401)
        }
        return json({ error: { code: 'NOT_FOUND', message: '资源不存在' } }, 404)
      }),
    )

    const inputs = wrapper.findAll('input')
    await inputs[0]?.setValue('mint-tea')
    await inputs[1]?.setValue('mint-tea-2026')
    await wrapper.find('form').trigger('submit')
    await vi.waitFor(
      () => {
        expect(router.currentRoute.value.path).toBe('/me')
      },
      { timeout: 10_000 },
    )
  })
})

describe('注册页（07 §5.2）', () => {
  it('邀请码从 ?code= 预填，且 mode=invite 时显示该字段', async () => {
    const { wrapper } = await mountAt('/register?code=ABCD2345EFGH', RegisterView)

    expect(wrapper.text()).toContain('邀请码')
    const inviteInput = wrapper.findAll('input')[0]
    expect((inviteInput?.element as HTMLInputElement).value).toBe('ABCD2345EFGH')
  })

  it('注册关闭时显示友好说明，不显示表单', async () => {
    const { wrapper } = await mountAt('/register', RegisterView, { registrationMode: 'closed' })

    expect(wrapper.text()).toContain('当前没有开放注册')
    expect(wrapper.find('form').exists()).toBe(false)
  })

  it('mode=open 时不要求邀请码', async () => {
    const { wrapper } = await mountAt('/register', RegisterView, { registrationMode: 'open' })
    expect(wrapper.text()).not.toContain('邀请码')
  })

  it('用户名失焦触发 check-username，可用时显示 ✓ 提示', async () => {
    const { wrapper } = await mountAt('/register', RegisterView)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/api/auth/check-username')) return json({ available: true })
        return json({ error: { code: 'NOT_FOUND', message: '资源不存在' } }, 404)
      }),
    )

    const usernameInput = wrapper.findAll('input')[1]
    await usernameInput?.setValue('mint-tea')
    await usernameInput?.trigger('blur')
    await flushPromises()

    expect(wrapper.text()).toContain('这个用户名可以用')
    expect(wrapper.find('.i-ph-check-circle').exists()).toBe(true)
  })

  it('用户名被占用时显示 ✗ 与原因', async () => {
    const { wrapper } = await mountAt('/register', RegisterView)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/api/auth/check-username')) return json({ available: false, reason: 'taken' })
        return json({ error: { code: 'NOT_FOUND', message: '资源不存在' } }, 404)
      }),
    )

    const usernameInput = wrapper.findAll('input')[1]
    await usernameInput?.setValue('mint-tea')
    await usernameInput?.trigger('blur')
    await flushPromises()

    expect(wrapper.text()).toContain('已经被占用')
    expect(wrapper.find('.i-ph-x-circle').exists()).toBe(true)
  })

  it('两次密码不一致：就地提示，不发注册请求', async () => {
    const { wrapper } = await mountAt('/register', RegisterView)

    const inputs = wrapper.findAll('input')
    await inputs[0]?.setValue('ABCD2345EFGH')
    await inputs[1]?.setValue('mint-tea')
    await inputs[2]?.setValue('薄荷茶')
    await inputs[3]?.setValue('mint-tea-2026')
    await inputs[4]?.setValue('mint-tea-2027')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(wrapper.find('.n-alert').text()).toContain('两次输入的密码不一致')
  })

  it('弱密码给出中文原因（与后端规则一致）', async () => {
    const { wrapper } = await mountAt('/register', RegisterView)

    const inputs = wrapper.findAll('input')
    await inputs[0]?.setValue('ABCD2345EFGH')
    await inputs[1]?.setValue('mint-tea')
    // 长度够（过 shared schema），但只有一类字符 → 强度校验拦下
    await inputs[3]?.setValue('abcdefghijkl')
    await inputs[4]?.setValue('abcdefghijkl')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(wrapper.find('.n-alert').text()).toContain('密码强度不足')
    expect(wrapper.find('.n-alert').text()).toContain('至少包含字母、数字、符号中的两类')
  })

  it('密码太短时用 shared schema 的中文文案（复用同一套契约）', async () => {
    const { wrapper } = await mountAt('/register', RegisterView)

    const inputs = wrapper.findAll('input')
    await inputs[0]?.setValue('ABCD2345EFGH')
    await inputs[1]?.setValue('mint-tea')
    await inputs[3]?.setValue('abc123')
    await inputs[4]?.setValue('abc123')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(wrapper.find('.n-alert').text()).toContain('密码至少 10 位')
  })

  it('requireApproval：提交成功后展示「等待审批」结果页，不建会话', async () => {
    const { wrapper } = await mountAt('/register', RegisterView, { requireApproval: true })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/api/auth/register')) {
          return json(
            {
              user: {
                id: 9,
                slug: 'u9zz00ca',
                username: 'mint-tea',
                displayName: '薄荷茶',
                bio: '',
                avatarUrl: null,
                role: 'user',
                status: 'pending',
                mustChangePassword: false,
                createdAt: '2026-10-12T00:00:00.000Z',
                lastLoginAt: null,
                usernameChangedAt: null,
              },
              sessionStarted: false,
            },
            201,
          )
        }
        return json({ error: { code: 'NOT_FOUND', message: '资源不存在' } }, 404)
      }),
    )

    const inputs = wrapper.findAll('input')
    await inputs[0]?.setValue('ABCD2345EFGH')
    await inputs[1]?.setValue('mint-tea')
    await inputs[3]?.setValue('mint-tea-2026')
    await inputs[4]?.setValue('mint-tea-2026')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(wrapper.text()).toContain('已提交，等待管理员审批')
    expect(wrapper.find('form').exists()).toBe(false)
  })
})

describe('强制改密页（07 §3 /me/password）', () => {
  it('两次新密码不一致时提示（后端还会再校验一次）', async () => {
    const { wrapper } = await mountAt('/me/password', ForcePasswordView)

    const inputs = wrapper.findAll('input')
    await inputs[0]?.setValue('temp-password-1')
    await inputs[1]?.setValue('mint-tea-2026')
    await inputs[2]?.setValue('mint-tea-2027')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(wrapper.find('.n-alert').text()).toContain('两次输入的新密码不一致')
  })

  it('新密码与当前密码相同也拦下来', async () => {
    const { wrapper } = await mountAt('/me/password', ForcePasswordView)

    const inputs = wrapper.findAll('input')
    await inputs[0]?.setValue('mint-tea-2026')
    await inputs[1]?.setValue('mint-tea-2026')
    await inputs[2]?.setValue('mint-tea-2026')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(wrapper.find('.n-alert').text()).toContain('不能和当前密码相同')
  })
})
