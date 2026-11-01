import { ADMIN_PASSWORD, ADMIN_USERNAME, PUBLIC_ORIGIN } from '../src/config.js'
import type { Journey } from '../src/context.js'
import { gotoPath, hasText, loginViaUi, textOf, waitForText } from '../src/ui.js'

/**
 * J1 管理员初始化（10 §B2 的前置）
 *
 * CLI `create-admin` → 浏览器登录 → `/admin` 概览加载，无 console error。
 * WP6 合并后 `/admin` 是真实的概览页（统计卡 + 宿主资源 + 最近注册/审计），这里顺带断言它渲染出统计卡。
 */
export default {
  id: 'J1',
  needsFreshData: true,
  title: '管理员初始化（CLI create-admin → 界面登录 → /admin）',
  async run(ctx) {
    // ── 1. CLI 创建管理员 ────────────────────────────────────────────────
    const created = await ctx.hub.cli(
      ['create-admin', '--username', ADMIN_USERNAME, '--display-name', 'E2E 管理员', '--password-stdin'],
      { stdin: `${ADMIN_PASSWORD}\n`, timeoutMs: 60_000 },
    )
    ctx.require(
      'CLI `create-admin --password-stdin` 退出码 0',
      created.code === 0,
      `code=${String(created.code)} stdout=${created.stdout.trim()} stderr=${created.stderr.trim()}`,
    )
    ctx.expect('CLI 输出「已创建管理员」', /已创建管理员/.test(created.stdout), created.stdout.trim())

    // 重复创建必须被拒绝（用户名占用），否则说明唯一性约束没生效
    const duplicated = await ctx.hub.cli(
      ['create-admin', '--username', ADMIN_USERNAME, '--display-name', '重复', '--password-stdin'],
      { stdin: `${ADMIN_PASSWORD}\n`, timeoutMs: 60_000 },
    )
    ctx.expect(
      '重复 create-admin 被拒绝（退出码非 0 且提示已被占用）',
      duplicated.code !== 0 && /已被占用/.test(duplicated.stderr + duplicated.stdout),
      `code=${String(duplicated.code)} out=${(duplicated.stderr + duplicated.stdout).trim()}`,
    )

    // CLI 落库的管理员能在 user:list 里看到
    const list = await ctx.hub.cli(['user:list'], { timeoutMs: 60_000 })
    ctx.expect(
      'CLI `user:list` 能看到 hubadmin（角色 admin）',
      list.code === 0 && list.stdout.includes(ADMIN_USERNAME) && /admin/.test(list.stdout),
      list.stdout.split('\n').slice(0, 4).join(' | '),
    )

    // ── 2. 浏览器登录（这一步必须走界面） ───────────────────────────────
    const page = await ctx.world.pageFor('admin')
    const collector = ctx.world.collectorFor('admin')
    collector.clear()
    await ctx.shot(page, 'J1-01-login')

    await gotoPath(page, '/login')
    await loginViaUi(page, ADMIN_USERNAME, ADMIN_PASSWORD)
    await page.waitForURL(`${PUBLIC_ORIGIN}/home`, { timeout: 20_000 })
    ctx.require('界面登录后落到 /home', page.url() === `${PUBLIC_ORIGIN}/home`, page.url())
    const greeting = await hasText(page, 'E2E 管理员', 10_000)
    ctx.expect('工作台显示管理员昵称', greeting, await textOf(page, 'body').then((text) => text.slice(0, 120)))

    // ── 3. /admin = 舰桥（WP56c），经典概览挪到 /admin/overview ──────────
    await gotoPath(page, '/admin')
    await page.waitForLoadState('networkidle').catch(() => undefined)
    const adminShell = await page.locator('body').innerText()
    // 中控台那一栏的标题只在 aria-label 上（对话区是 iframe / 占位），所以按 DOM 取三栏
    const bridge = await page.evaluate(() => {
      const panes = [...document.querySelectorAll('.cockpit__pane')].map((el) => el.getAttribute('aria-label'))
      return { panes, hasCenter: document.querySelector('.cockpit__center') !== null }
    })
    ctx.require(
      '/admin 能进入舰桥（左舷 · 态势 / 中控台 · 对话 / 右舷 · 行动，无侧边栏）',
      bridge.hasCenter && bridge.panes.includes('左舷 · 态势') && bridge.panes.includes('右舷 · 行动'),
      `${JSON.stringify(bridge)}；${adminShell.slice(0, 160).replace(/\n+/g, ' / ')}`,
    )
    ctx.expect('管理端页面不是 404/登录跳转', !page.url().includes('/login') && page.url().includes('/admin'), page.url())
    ctx.expect('舰桥页隐藏了经典侧边栏', !(adminShell.includes('概览') && adminShell.includes('租约')), adminShell.slice(0, 120).replace(/\n+/g, ' / '))

    // 经典概览：/admin/overview（docs/24 §1 的路由表）
    await gotoPath(page, '/admin/overview')
    await waitForText(page, '用户总数', 15_000)
    const overviewText = await textOf(page, 'body')
    ctx.expect('经典概览（/admin/overview）渲染出统计卡「用户总数」', overviewText.includes('用户总数'))
    ctx.expect(
      '经典概览显示宿主资源/Docker 状态',
      /宿主|Docker|磁盘/.test(overviewText),
      overviewText.replace(/\n+/g, ' / ').slice(0, 160),
    )

    // 会话确实以「管理员」身份工作（页面上下文带 cookie 调接口）
    const overview = await ctx.world.apiFor('admin').then((api) => api.get('/api/admin/overview'))
    ctx.require('管理接口 /api/admin/overview 200', overview.ok, `HTTP ${String(overview.status)}`)
    const body = overview.body as { users?: { total?: number }; runtime?: { defaultVersion?: string | null } }
    ctx.expect(
      '概览返回的用户总数 ≥ 1（CLI 建的管理员）',
      (body.users?.total ?? 0) >= 1,
      `total=${String(body.users?.total)}`,
    )
    ctx.note(
      `概览 runtime.defaultVersion=${String(body.runtime?.defaultVersion)}（WP3 未合并时为 null，实例走 HUB_DEFAULT_DSH_VERSION 兜底）`,
    )
    await ctx.shot(page, 'J1-02-admin-overview')

    // ── 4. console error ────────────────────────────────────────────────
    // 说明：登录前 SPA 会探测 `/api/auth/me`，401 是设计内的（04 §2），Chromium 会把它记成
    // 一条「Failed to load resource」的 console error；这里只放行这一条，其余 4xx/5xx 都算问题
    // （WP3 未合并导致的 404 由 checkConsoleClean 记成 skip，不算缺陷）。
    await ctx.checkConsoleClean('admin', '登录 + /admin', [
      { status: 401, pathIncludes: '/api/auth/me' },
      // 舰桥的 iframe `/m/` 在没有 App 网页版产物时是 404（J11 才装产物），不算缺陷
      { status: 404, pathIncludes: '/m/' },
    ])
  },
} satisfies Journey
