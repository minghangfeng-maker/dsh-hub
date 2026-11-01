import { describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import { createAppRouter, routes } from '@/router'

/** 07 §3 路由表里的全部名称（顺序与文档一致）。 */
const ROUTE_NAMES = [
  'Landing',
  'Login',
  'Register',
  'Home',
  'Me',
  'Usage',
  'ForcePassword',
  // WP54c：手机 App / 手机网页版的登录页同源打开「忘记密码」（`webPage('/forgot-password')`）
  'ForgotPassword',
  'AdminOverview',
  // WP57：AI 助手独立页
  'AdminAssistant',
  'AdminUsers',
  'AdminUserDetail',
  'AdminInstances',
  'AdminPlugins',
  'AdminPluginDetail',
  'AdminRuntimes',
  'AdminModels',
  // 18 §6：Claude Code 与 Codex 管理
  'AdminClaudeCode',
  'AdminCodex',
  'AdminSearch',
  'AdminRolloutWizard',
  'AdminJobs',
  'AdminJobDetail',
  'AdminInvites',
  'AdminSettings',
  'AdminAudit',
  // WP25c：桌面端授权页 / 隐私说明（WP36 起下载入口在公开主页）
  'DesktopAuthorize',
  'DesktopPrivacy',
  // WP44：公开使用文档
  'Docs',
  'NotFound',
] as const

/**
 * 没有名字的路由（重定向等）：`/admin/relay` → `/admin/models`（12 §10）；
 * `/admin/rollouts/new` → `/admin/rollouts`（WP28b）；
 * `/admin/desktop` → 各页的桌面侧（WP32b，docs/22 §1.4）；
 * `/desktop/download` → `/`（WP36：下载入口合并到公开主页）；
 * `/settings/security` → `/me?tab=security`（WP54c：手机 App 的「去网页修改密码」写死的老地址）；
 * `/admin` → `/admin/overview`（WP57：座舱在界面上下线）
 */
const REDIRECT_PATHS = [
  '/admin/relay',
  '/admin/rollouts/new',
  '/admin/desktop',
  '/desktop/download',
  '/settings/security',
  '/admin',
]

/** 需要路径参数的路由（用于 resolve 冒烟）。 */
const ROUTE_PARAMS: Record<string, Record<string, string>> = {
  AdminUserDetail: { id: 'u_0000001' },
  AdminPluginDetail: { id: 'demo-plugin' },
  AdminJobDetail: { id: 'job_0000001' },
}

describe('router/index.ts（07 §3 路由表）', () => {
  it('包含全部路由名，且不重名、不缺少、不多余', () => {
    const names = routes.map((route) => route.name).filter((name): name is string => typeof name === 'string')

    expect(names).toHaveLength(ROUTE_NAMES.length)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(expect.arrayContaining([...ROUTE_NAMES]))
  })

  // 这条会把每个页面的 chunk 真跑一遍（含 Naive UI 的 DataTable/DatePicker/Upload），
  // 三个包并行跑测试时 5s 默认超时不够，放宽到 30s（WP6 加的管理端页面让 chunk 变多）。
  it('每条路由都能解析并懒加载出组件', { timeout: 30_000 }, async () => {
    const router = createAppRouter(createMemoryHistory())

    for (const name of ROUTE_NAMES) {
      const resolved = router.resolve({ name, params: ROUTE_PARAMS[name] ?? {} })
      const loader = resolved.matched.at(-1)?.components?.default

      expect(loader, `路由 ${name} 缺少懒加载组件`).toBeTypeOf('function')
      const mod = (await (loader as () => Promise<unknown>)()) as { default?: unknown }
      expect(mod.default, `路由 ${name} 的组件没有 default 导出`).toBeTruthy()
    }
  })

  it('`/` 是免登录的公开主页（WP36），不再重定向到 `/home`', async () => {
    const landing = routes.find((route) => route.path === '/')
    expect(landing?.name).toBe('Landing')
    expect(landing?.redirect).toBeUndefined()
    expect(landing?.meta?.layout).toBe('blank')
    expect(landing?.meta?.title).toBe('DSH Hub')

    // 不挂守卫，单独验证路由本身
    const router = createRouter({ history: createMemoryHistory(), routes })
    await router.push('/')
    expect(router.currentRoute.value.name).toBe('Landing')
  })

  it('旧下载地址 `/desktop/download` 重定向到公开主页 `/`', async () => {
    expect(REDIRECT_PATHS).toContain('/desktop/download')

    const router = createRouter({ history: createMemoryHistory(), routes })
    await router.push('/desktop/download')
    expect(router.currentRoute.value.path).toBe('/')
    expect(router.currentRoute.value.name).toBe('Landing')
  })

  it('旧地址 `/admin/relay` 重定向到 `/admin/models`，查询参数原样带过去', () => {
    const router = createAppRouter(createMemoryHistory())

    const plain = router.resolve('/admin/relay')
    expect(plain.path).toBe('/admin/relay')
    expect(REDIRECT_PATHS).toContain(plain.path)

    const withQuery = router.resolve('/admin/relay?tab=wallets&userId=2')
    const record = router.resolve('/admin/models?tab=wallets&userId=2')
    expect(record.fullPath).toBe('/admin/models?tab=wallets&userId=2')
    expect(withQuery.query).toEqual({ tab: 'wallets', userId: '2' })
  })

  it('`/admin/models?tab=tools` 跳到 `/admin/search`，其余参数保留（15 §1）', async () => {
    // 只验证路由层的 beforeEnter（不装守卫，避免测试里碰 pinia）
    const router = createRouter({ history: createMemoryHistory(), routes })
    await router.push('/admin/models?tab=tools&userId=2')

    expect(router.currentRoute.value.path).toBe('/admin/search')
    expect(router.currentRoute.value.query).toEqual({ userId: '2' })
  })

  it('旧「桌面端」地址按 tab 重定向到各页的桌面侧（docs/22 §1.4）', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes })

    const cases: [string, string][] = [
      ['/admin/desktop', '/admin/instances?platform=desktop'],
      ['/admin/desktop?tab=overview', '/admin/instances?platform=desktop'],
      ['/admin/desktop?tab=plugins', '/admin/plugins?platform=desktop'],
      ['/admin/desktop?tab=config', '/admin/models?tab=dsh&platform=desktop'],
      ['/admin/desktop?tab=versions', '/admin/runtimes?platform=desktop'],
    ]
    for (const [from, to] of cases) {
      await router.push(from)
      expect(router.currentRoute.value.fullPath, from).toBe(to)
    }
  })

  it('未匹配的路径落到 NotFound（07 §3 兜底）', () => {
    const router = createAppRouter(createMemoryHistory())
    const resolved = router.resolve('/definitely/not/a/page')

    expect(resolved.name).toBe('NotFound')
    expect(resolved.matched.at(-1)?.meta.layout).toBe('auth')
  })
})
