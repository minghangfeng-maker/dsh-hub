import { USER_A, USER_B } from '../src/config.js'
import type { Journey } from '../src/context.js'
import { waitFor } from '../src/harness.js'
import { gotoPath, hasText, textOf, waitForText } from '../src/ui.js'

/**
 * J8 管理端（10 §C1 的管理侧、04 §4.1–§4.4）
 *
 * 用户列表看到 A、B；实例页 A 运行中且有资源数据；用户详情日志查看器有内容；审计里能看到注册/登录/实例启停。
 * 数据面（接口）与界面面（WP6 的真实页面）**都验**：接口断言给出精确数值，界面断言证明这些数据真的渲染出来。
 */
export default {
  id: 'J8',
  title: '管理端（用户/实例/日志/审计，界面 + 接口）',
  dependsOn: 'J1–J7',
  timeoutMs: 3 * 60 * 1000,
  async run(ctx) {
    const admin = await ctx.page('admin')
    const api = await ctx.api('admin')
    const collector = ctx.world.collectorFor('admin')
    collector.clear()

    // ── 0. 前置：A 的实例必须在跑（J8 单跑时上一次清理可能已经删掉容器） ──
    const aApi = await ctx.api('A')
    const before = await aApi.get<{ instance: { status: string } }>('/api/me/instance')
    if (before.body.instance.status !== 'running') {
      ctx.note(`A 的实例当前是 ${before.body.instance.status}，先启动它（J8 要验「运行中 + 资源数据 + 日志」）`)
      await aApi.post('/api/me/instance/start', {})
      const ready = await waitFor(async () => {
        const state = await aApi.get<{ instance: { status: string } }>('/api/me/instance')
        return state.body.instance.status === 'running'
      }, 90_000, 1000)
      ctx.require('前置：A 的实例已启动并就绪', ready)
    }

    // ── 0.1 概览的宿主/实例数据（04 §4.1；WP8a 发现原先恒为 0/false，已修） ──
    const overview = await api.get<{
      instances: { running: number; max: number; starting: number; error: number }
      host: { cpuCount: number; memTotal: number; diskTotal: number; dockerOk: boolean; dockerVersion: string | null }
      runtime: { defaultVersion: string | null; versions: number }
    }>('/api/admin/overview')
    ctx.requireOk('GET /api/admin/overview', overview)
    const host = overview.body.host
    ctx.expect(
      '概览的宿主数据是真实值（cpuCount/memTotal/diskTotal > 0）',
      host.cpuCount > 0 && host.memTotal > 0 && host.diskTotal > 0,
      JSON.stringify(host),
    )
    ctx.expect('概览的 dockerOk=true（Docker 可达）', host.dockerOk === true, JSON.stringify(host))
    ctx.expect(
      '概览的实例计数是真实值（running ≥ 1、max > 0）',
      overview.body.instances.running >= 1 && overview.body.instances.max > 0,
      JSON.stringify(overview.body.instances),
    )
    ctx.note(
      `概览宿主：CPU ${String(host.cpuCount)} 核、内存 ${(host.memTotal / 1024 ** 3).toFixed(1)}GB、磁盘 ${(host.diskTotal / 1024 ** 3).toFixed(0)}GB、docker ${host.dockerVersion ?? '?'}`,
    )

    // ── 1. 用户列表（接口） ─────────────────────────────────────────────
    const users = await api.get<{ items: { username: string; slug: string }[]; total: number }>(
      '/api/admin/users?pageSize=50',
    )
    ctx.requireOk('GET /api/admin/users', users)
    const usernames = users.body.items.map((item) => item.username)
    ctx.expect('用户列表里有 A', usernames.includes(USER_A.username), usernames.join('、'))
    ctx.expect('用户列表里有 B', usernames.includes(USER_B.username), usernames.join('、'))
    const rowA = ctx.requireDefined(
      '用户列表里有 A 的行',
      users.body.items.find((item) => item.username === USER_A.username),
    )
    ctx.world.patchUser('A', { slug: rowA.slug })

    // ── 2. 实例页：A 运行中且有资源数据（接口） ─────────────────────────
    const instances = await api.get<
      {
        user: { username: string }
        instance: { status: string }
        stats: { cpuPercent: number; memoryBytes: number; memoryLimitBytes: number; pids: number } | null
      }[]
    >('/api/admin/instances')
    ctx.requireOk('GET /api/admin/instances', instances)
    const instanceA = ctx.requireDefined(
      '实例列表里有 A',
      instances.body.find((item) => item.user.username === USER_A.username),
    )
    ctx.expect('A 的实例是 running', instanceA.instance.status === 'running', instanceA.instance.status)
    ctx.expect(
      'A 的实例有资源数据（CPU/内存/pids）',
      instanceA.stats !== null && instanceA.stats.memoryLimitBytes > 0 && instanceA.stats.pids > 0,
      JSON.stringify(instanceA.stats),
    )
    if (instanceA.stats) {
      ctx.note(
        `A 实例 stats：CPU ${instanceA.stats.cpuPercent.toFixed(2)}%、内存 ${String(instanceA.stats.memoryBytes)}/${String(instanceA.stats.memoryLimitBytes)} B、pids ${String(instanceA.stats.pids)}`,
      )
    }
    const instanceB = instances.body.find((item) => item.user.username === USER_B.username)
    ctx.expect(
      'B 的实例未运行且没有资源数据',
      instanceB === undefined || instanceB.instance.status !== 'running',
      JSON.stringify(instanceB?.instance.status),
    )

    // ── 3. 用户详情 + 日志（接口） ──────────────────────────────────────
    const userIdA = ctx.requireDefined('A 的 userId', ctx.world.state.users.A?.userId)
    const detail = await api.get<{ user: { username: string } }>(`/api/admin/users/${String(userIdA)}`)
    ctx.requireOk('GET /api/admin/users/:id', detail)
    ctx.expect('用户详情是 A', detail.body.user.username === USER_A.username, detail.body.user.username)

    const logs = await api.get<{ text: string }>(`/api/admin/instances/${String(userIdA)}/logs?tail=300`)
    ctx.requireOk('GET /api/admin/instances/:userId/logs', logs)
    ctx.expect(
      '日志接口有内容（容器日志非空）',
      logs.body.text.trim().length > 0,
      `日志长度 ${String(logs.body.text.length)}；前 80 字：${logs.body.text.slice(0, 80).replace(/\n/g, ' / ')}`,
    )
    ctx.expect(
      '日志已脱敏（不出现 dsh-auth- 明文 cookie 值）',
      !/dsh-auth-[A-Za-z0-9_-]{10,}\.v1\./.test(logs.body.text),
    )

    // ── 4. 审计：注册 / 登录 / 实例启停（接口） ─────────────────────────
    const audit = await api.get<{ items: { action: string; actorUsername: string | null }[]; total: number }>(
      '/api/admin/audit?pageSize=100',
    )
    ctx.requireOk('GET /api/admin/audit', audit)
    const actions = audit.body.items.map((item) => item.action)
    for (const action of ['auth.register', 'auth.login.success', 'instance.start', 'instance.stop']) {
      ctx.expect(
        `审计里有 ${action}`,
        actions.includes(action),
        `共 ${String(actions.length)} 条：${[...new Set(actions)].join('、')}`,
      )
    }
    const registerAudits = audit.body.items.filter((item) => item.action === 'auth.register')
    ctx.expect(
      '注册审计记在用户 A 名下（而不是管理员）',
      registerAudits.some((item) => item.actorUsername === USER_A.username),
      `注册审计 ${String(registerAudits.length)} 条：${registerAudits.map((item) => item.actorUsername ?? '—').join('、')}`,
    )

    // ── 5. 界面：概览 ──────────────────────────────────────────────────
    await gotoPath(admin, '/admin')
    await waitForText(admin, '用户总数', 15_000)
    const overviewText = await textOf(admin, 'body')
    ctx.expect(
      '概览页渲染统计卡（用户总数 / 运行中实例）',
      overviewText.includes('用户总数') && overviewText.includes('运行中实例'),
    )
    ctx.expect(
      '概览页显示宿主资源与 Docker 状态',
      /宿主|Docker|磁盘/.test(overviewText),
      overviewText.replace(/\n+/g, ' / ').slice(0, 160),
    )
    await ctx.shot(admin, 'J8-01-admin-overview')

    // ── 6. 界面：用户列表看到 A、B ─────────────────────────────────────
    await gotoPath(admin, '/admin/users')
    await waitForText(admin, USER_A.username, 15_000)
    const usersText = await textOf(admin, 'body')
    ctx.expect('用户表格里有 A', usersText.includes(USER_A.username))
    ctx.expect('用户表格里有 B', usersText.includes(USER_B.username))
    ctx.expect('用户表格显示实例状态（A 运行中）', /运行中/.test(usersText), usersText.replace(/\n+/g, ' / ').slice(0, 200))
    await ctx.shot(admin, 'J8-02-admin-users')

    const search = admin.locator('input[placeholder="搜索用户名 / 昵称"]')
    if ((await search.count()) > 0) {
      await search.first().fill(USER_B.username)
      await admin.waitForTimeout(1500)
      // 注意：不能直接 `includes('e2euser')` 判 A 是否还在——B 的用户名 `e2euserb` 本身包含它，
      // 所以按「表格行数 + 行内容」判（WP8a 实测踩到过）。
      const rows = await admin.locator('tbody tr').count()
      const rowText = await textOf(admin, 'tbody')
      ctx.expect(
        '用户列表搜索只剩 1 行（B）',
        rows === 1 && rowText.includes(USER_B.username),
        `行数 ${String(rows)}，行内容：${rowText.replace(/\n+/g, ' / ').slice(0, 120)}`,
      )
      await ctx.shot(admin, 'J8-03-admin-users-search')
    } else {
      ctx.fail('用户列表搜索框存在', '没找到 placeholder="搜索用户名 / 昵称" 的输入框')
    }

    // ── 7. 界面：实例页有 A 与资源数据 ─────────────────────────────────
    await gotoPath(admin, '/admin/instances')
    await waitForText(admin, '运行中', 15_000)
    const instancesText = await textOf(admin, 'body')
    ctx.expect('实例页列出 A', instancesText.includes(USER_A.username), instancesText.replace(/\n+/g, ' / ').slice(0, 200))
    ctx.expect(
      '实例页有「运行中 x / y」汇总',
      /运行中\s*\d+\s*\/\s*\d+/.test(instancesText),
      instancesText.replace(/\n+/g, ' / ').slice(0, 200),
    )
    ctx.expect('实例页有资源条（CPU / 内存）', /CPU|内存/.test(instancesText))
    ctx.expect(
      '实例页的宿主资源条不是 0 B（概览的 host 已接线）',
      !/宿主内存\s*0 B/.test(instancesText.replace(/\n+/g, ' ')),
      instancesText.replace(/\n+/g, ' / ').slice(0, 200),
    )
    await ctx.shot(admin, 'J8-04-admin-instances')

    // ── 8. 界面：用户详情日志查看器有内容 ──────────────────────────────
    await gotoPath(admin, `/admin/users/${String(userIdA)}?tab=environment`)
    await waitForText(admin, '容器日志', 15_000)
    const logLines = await admin.locator('.log-viewer__line').count()
    ctx.expect('用户详情「环境」Tab 的日志查看器有日志行', logLines > 0, `日志行数 ${String(logLines)}`)
    const logText = await textOf(admin, '[aria-label="日志内容"]')
    ctx.expect('日志内容非空', logText.trim().length > 0, logText.slice(0, 120).replace(/\n/g, ' / '))
    const logSearch = admin.locator('input[aria-label="搜索日志"]')
    if ((await logSearch.count()) > 0) {
      await logSearch.first().fill('tini')
      await admin.waitForTimeout(800)
      const hits = await textOf(admin, '.log-viewer__hits')
      ctx.expect('日志搜索「tini」有命中提示', hits.trim().length > 0, `命中提示「${hits}」`)
    }
    await ctx.shot(admin, 'J8-05-admin-user-detail-env')

    // ── 9. 界面：审计时间线有注册/登录/实例启停 ────────────────────────
    await gotoPath(admin, '/admin/audit')
    await waitForText(admin, '注册账号', 15_000)
    const auditText = await textOf(admin, 'body')
    for (const label of ['注册账号', '登录成功', '启动实例', '停止实例']) {
      ctx.expect(`审计页出现「${label}」`, auditText.includes(label), auditText.replace(/\n+/g, ' / ').slice(0, 200))
    }
    await ctx.shot(admin, 'J8-06-admin-audit')

    // ── 10. 界面：邀请码页能看到 J2 生成的邀请码 ───────────────────────
    const codeA = ctx.world.state.invites.A
    if (codeA !== undefined) {
      await gotoPath(admin, '/admin/invites')
      const shown = await hasText(admin, codeA, 12_000)
      ctx.expect('邀请码页能看到 J2 生成的邀请码', shown, `邀请码 ${codeA}`)
      await ctx.shot(admin, 'J8-07-admin-invites')
    }

    await ctx.checkConsoleClean('admin', '管理端页面')
  },
} satisfies Journey
