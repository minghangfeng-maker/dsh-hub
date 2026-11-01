import type { InstanceSummary, PublicSiteResponse, UserPublic } from '@dsh-hub/shared'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, type Router } from 'vue-router'

import { apiRequest } from '@/api/http'
import { createAppRouter, devRoutes, isSafeInternalPath, isServerPath, safeNextPath } from '@/router'

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

const ADMIN: UserPublic = { ...USER, id: 2, username: 'root-mint', role: 'admin' }

const INSTANCE: InstanceSummary = {
  status: 'running',
  runtimeVersion: '0.15.0',
  startedAt: '2026-10-12T08:00:00.000Z',
  lastActiveAt: null,
  needsRecreate: false,
  error: null,
  openUrl: '/dsh/mint-tea/',
}

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

/** 桩掉 fetch：`/api/auth/me` 按传入用户返回，站点信息固定成功。 */
function stubFetch(user: UserPublic | null): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/public/site')) return json(SITE)
      if (url.includes('/api/auth/me')) {
        if (!user) return json({ error: { code: 'UNAUTHENTICATED', message: '请先登录' } }, 401)
        return json({ user, instance: INSTANCE })
      }
      return json({ error: { code: 'NOT_FOUND', message: '资源不存在' } }, 404)
    }),
  )
}

async function navigate(path: string, user: UserPublic | null = null): Promise<Router> {
  stubFetch(user)
  const router = createAppRouter(createMemoryHistory(), { pinia: createPinia() })
  await router.push(path).catch(() => undefined)
  return router
}

beforeEach(() => {
  window.history.pushState({}, '', '/')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('路由守卫（07 §3）', () => {
  it('未登录访问需要登录的页面 → /login?next=…', async () => {
    const home = await navigate('/home')
    expect(home.currentRoute.value.path).toBe('/login')
    expect(home.currentRoute.value.query['next']).toBe('/home')

    const admin = await navigate('/admin/users')
    expect(admin.currentRoute.value.path).toBe('/login')
    expect(admin.currentRoute.value.query['next']).toBe('/admin/users')
  })

  it('已登录访问 /login、/register → 回 /home（或 next）', async () => {
    const login = await navigate('/login', USER)
    expect(login.currentRoute.value.path).toBe('/home')

    const withNext = await navigate('/login?next=/me', USER)
    expect(withNext.currentRoute.value.path).toBe('/me')

    const register = await navigate('/register', USER)
    expect(register.currentRoute.value.path).toBe('/home')
  })

  it('普通用户访问 /admin* → /home；管理员放行', async () => {
    const forbidden = await navigate('/admin/users', USER)
    expect(forbidden.currentRoute.value.path).toBe('/home')

    const allowed = await navigate('/admin/users', ADMIN)
    expect(allowed.currentRoute.value.path).toBe('/admin/users')
    expect(allowed.currentRoute.value.name).toBe('AdminUsers')
  })

  it('游客页对未登录用户放行（/login、/register、404）', async () => {
    const login = await navigate('/login')
    expect(login.currentRoute.value.path).toBe('/login')

    const register = await navigate('/register?code=ABCD2345EFGH')
    expect(register.currentRoute.value.path).toBe('/register')
    expect(register.currentRoute.value.query['code']).toBe('ABCD2345EFGH')

    const notFound = await navigate('/nope/not-here')
    expect(notFound.currentRoute.value.name).toBe('NotFound')
  })

  it('mustChangePassword：除 /me/password 外一律被拦，并带 next', async () => {
    const forced: UserPublic = { ...USER, mustChangePassword: true }

    const blocked = await navigate('/home', forced)
    expect(blocked.currentRoute.value.path).toBe('/me/password')
    expect(blocked.currentRoute.value.query['next']).toBe('/home')

    const allowed = await navigate('/me/password', forced)
    expect(allowed.currentRoute.value.path).toBe('/me/password')

    // 改密页本身不再被重定向（否则会死循环）
    const fromLogin = await navigate('/login', forced)
    expect(fromLogin.currentRoute.value.path).toBe('/me/password')
  })

  it('未登录访问 /me/password → 登录页', async () => {
    const router = await navigate('/me/password')
    expect(router.currentRoute.value.path).toBe('/login')
  })

  it('接口层 401 会经路由器跳到登录页并带 next（http ↔ router 的接线）', async () => {
    const router = await navigate('/admin/users', ADMIN)
    expect(router.currentRoute.value.path).toBe('/admin/users')

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: { code: 'UNAUTHENTICATED', message: '登录状态已过期' } }, 401)),
    )

    await apiRequest('/api/admin/users').catch(() => undefined)
    await vi.waitFor(
      () => {
        expect(router.currentRoute.value.path).toBe('/login')
      },
      { timeout: 10_000 },
    )
  })
})

describe('服务端路径整页跳转（WP16：登录后 next 回到 DSH）', () => {
  it('登录后 next=/dsh/<用户名>/ → 整页跳转，不落到 SPA 的 404', async () => {
    stubFetch(USER)
    const assigned: string[] = []
    const router = createAppRouter(createMemoryHistory(), {
      pinia: createPinia(),
      assignLocation: (url) => assigned.push(url),
    })
    await router.push('/login?next=/dsh/mint-tea/').catch(() => undefined)
    expect(assigned).toEqual(['/dsh/mint-tea/'])
    expect(router.currentRoute.value.name).not.toBe('NotFound')
  })

  it('isServerPath 只认代理前缀', () => {
    expect(isServerPath('/dsh/mint-tea/')).toBe(true)
    expect(isServerPath('/dsh')).toBe(true)
    expect(isServerPath('/u/u7k2m9xa/?a=1')).toBe(true)
    expect(isServerPath('/dshx')).toBe(false)
    expect(isServerPath('/home')).toBe(false)
  })
})

describe('回跳路径白名单（防开放重定向）', () => {
  it('只接受站内路径', () => {
    expect(isSafeInternalPath('/home')).toBe(true)
    expect(isSafeInternalPath('/admin/users?page=2#top')).toBe(true)
  })

  it('拒绝协议相对、绝对地址、登录/注册页与非法值', () => {
    expect(isSafeInternalPath('//evil.example.com')).toBe(false)
    expect(isSafeInternalPath('/\\evil.example.com')).toBe(false)
    expect(isSafeInternalPath('https://evil.example.com')).toBe(false)
    expect(isSafeInternalPath('/login')).toBe(false)
    expect(isSafeInternalPath('/register?code=X')).toBe(false)
    expect(isSafeInternalPath('')).toBe(false)
    expect(isSafeInternalPath(undefined)).toBe(false)
    expect(isSafeInternalPath(123)).toBe(false)
  })

  it('safeNextPath 兼容数组形式的 query 并做白名单', () => {
    expect(safeNextPath('/me?tab=security')).toBe('/me?tab=security')
    expect(safeNextPath(['/me', '/admin'])).toBe('/me')
    expect(safeNextPath('//evil.example.com')).toBeNull()
    expect(safeNextPath(undefined)).toBeNull()
  })
})

describe('开发环境专属路由 /__style（交付物 9）', () => {
  it('只在 DEV 下注册（生产构建里不存在）', () => {
    if (import.meta.env.DEV) {
      expect(devRoutes.map((route) => route.name)).toEqual(['StyleGuide'])
      expect(devRoutes[0]?.path).toBe('/__style')
    } else {
      expect(devRoutes).toEqual([])
    }
  })
})
