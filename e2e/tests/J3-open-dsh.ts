import type { Page } from 'playwright-core'
import { ConsoleCollector, wsRecords } from '../src/browser.js'
import { OPEN_DSH_BUDGET_MS, PUBLIC_ORIGIN } from '../src/config.js'
import type { Journey } from '../src/context.js'
import { dismissWelcomeIfAny, gotoPath, waitForStatusLine } from '../src/ui.js'

/**
 * J3 打开我的 DSH（10 §C1）
 *
 * `/home` 点「打开 DSH」→ 阶段条推进 → 新标签打开 `/dsh/<username>/` → DSH 工作区界面出现、
 * WS 已连接、`__DSH_TRANSPORT__.ownsHost === true`、「回到 Hub」按钮存在、0 个 console error。
 */
export default {
  id: 'J3',
  title: '打开我的 DSH（阶段条 → 新标签 /dsh/<username>/ → 工作区）',
  dependsOn: 'J2',
  timeoutMs: 5 * 60 * 1000,
  async run(ctx) {
    const slug = ctx.requireDefined('世界状态里有 A 的 slug（J2 已跑过）', ctx.world.state.users.A?.slug)
    const username = ctx.requireDefined('世界状态里有 A 的用户名', ctx.world.state.users.A?.username)
    const page = await ctx.page('A')
    const collector = ctx.world.collectorFor('A')
    collector.clear()

    await gotoPath(page, '/home')
    const primary = page.locator('[data-testid="instance-primary"]')
    await primary.waitFor({ state: 'visible', timeout: 20_000 })
    // 全新浏览器上下文首次进 /home 会弹欢迎引导，遮罩会挡住主按钮（J2 已验证过它的出现）
    if (await dismissWelcomeIfAny(page)) ctx.note('关掉了一次性欢迎引导（遮罩会挡住「打开 DSH」）')
    await ctx.shot(page, 'J3-01-home-before-open')

    // 点之前先看实例是不是已经在跑（跑着就直接开新标签，不会有阶段条）
    const aApi = await ctx.api('A')
    const preStatus = await aApi
      .get<{ instance: { status: string } }>('/api/me/instance')
      .then((response) => response.body.instance.status)
      .catch(() => 'unknown')
    ctx.note(`点击「打开 DSH」前实例状态：${preStatus}`)

    // ── 点「打开 DSH」：会先开一个 about:blank 新标签，就绪后把 location 换过去 ──
    const startedAt = Date.now()
    const context = page.context()
    const [dshPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 30_000 }),
      primary.click(),
    ])
    const dshCollector = new ConsoleCollector()
    dshCollector.attach(dshPage)
    ctx.log(`新标签已打开（${String(Date.now() - startedAt)}ms 时），等阶段条与就绪跳转`)

    // 阶段条（准备容器 → 启动服务 → 准备插件 → 就绪）
    const phaseVisible = await page
      .locator('[data-testid="instance-phases"]')
      .waitFor({ state: 'visible', timeout: 25_000 })
      .then(() => true)
      .catch(() => false)
    if (preStatus === 'running') {
      ctx.skip('启动过程中出现阶段条（instance-phases）', '实例本来就运行中，点「打开 DSH」是直接开新标签，不会有启动阶段')
    } else {
      ctx.expect('启动过程中出现阶段条（instance-phases）', phaseVisible)
    }
    if (phaseVisible) {
      const phaseText = (await page.locator('[data-testid="instance-phases"]').innerText()).replace(/\n+/g, ' / ')
      ctx.note(`阶段条文案：${phaseText}`)
      await ctx.shot(page, 'J3-02-home-starting-phases')
    }

    // 就绪后新标签跳到 /dsh/<username>/
    const target = `${PUBLIC_ORIGIN}/dsh/${username}/`
    const navigated = await dshPage
      .waitForURL(target, { timeout: 120_000 })
      .then(() => true)
      .catch(() => false)
    ctx.require(
      `新标签最终打开 ${target}`,
      navigated,
      `当前 ${dshPage.url()}（等待 ${String(Date.now() - startedAt)}ms）`,
    )
    const elapsed = Date.now() - startedAt
    ctx.expect(
      `首次「打开 DSH」在 ${String(OPEN_DSH_BUDGET_MS / 1000)}s 预算内（10 §C1）`,
      elapsed <= OPEN_DSH_BUDGET_MS,
      `实际 ${(elapsed / 1000).toFixed(1)}s`,
    )

    // ── DSH 界面本体 ───────────────────────────────────────────────────
    await dshPage.waitForLoadState('domcontentloaded').catch(() => undefined)
    const bootLoaded = await dshPage
      .waitForFunction(() => typeof (globalThis as { __DSH_BOOT__?: unknown }).__DSH_BOOT__ !== 'undefined', {
        timeout: 30_000,
      })
      .then(() => true)
      .catch(() => false)
    ctx.expect('DSH 页面里 __DSH_BOOT__ 已就位', bootLoaded)

    const transport = await dshPage.evaluate(() => {
      const value = (globalThis as { __DSH_TRANSPORT__?: { ownsHost?: boolean } }).__DSH_TRANSPORT__
      return value === undefined ? null : { ownsHost: value.ownsHost === true }
    })
    ctx.require('__DSH_TRANSPORT__ 存在', transport !== null, JSON.stringify(transport))
    ctx.expect('__DSH_TRANSPORT__.ownsHost === true（代理注入，10 §C1）', transport?.ownsHost === true)

    const backButton = await dshPage.locator('#dshhub-back').count()
    ctx.expect('「回到 Hub」悬浮按钮存在（#dshhub-back）', backButton > 0, `匹配 ${String(backButton)} 个`)

    // 工作区界面：DSH 的侧栏/工作区标题（文案随版本变化，这里断言多个候选之一）
    const uiText = (await dshPage.locator('body').innerText().catch(() => '')).replace(/\n+/g, ' / ')
    const uiMarkers = ['工作区', 'Workspace', '新建会话', 'New session', 'DeepSeek']
    const marker = uiMarkers.find((item) => uiText.includes(item))
    ctx.expect(
      'DSH 工作区界面已渲染（出现工作区/会话等界面文案）',
      marker !== undefined,
      `命中「${marker ?? '无'}」；页面文本前 200 字：${uiText.slice(0, 200)}`,
    )
    ctx.note(`DSH 页面标题「${await dshPage.title()}」；界面文案命中 ${marker ?? '（无）'}`)

    // 默认工作区（05 §1 F16/S7、06 §4.3）：由 managed.patch.yml 的 workspace-controller 条目下发。
    // DSH 需要一点时间做 documentsLookup（条目里给了 10s 超时），所以这里轮询等它就绪，
    // 不能读一次 innerText 就下结论（WP3 合并前 managed.patch.yml 只有 `[]` 兜底，界面会一直停在「选择工作区」）。
    const workspaceReady = await dshPage
      .waitForFunction(() => !/选择工作区|Choose workspace/.test(document.body.innerText), { timeout: 25_000 })
      .then(() => true)
      .catch(() => false)
    ctx.expect(
      'DSH 默认工作区已就绪（workspace-controller.documentsDirectory 生效）',
      workspaceReady,
      workspaceReady
        ? undefined
        : `25s 后界面仍是「选择工作区」；页面文本：${(await dshPage.locator('body').innerText()).replace(/\n+/g, ' / ').slice(0, 160)}`,
    )
    if (workspaceReady) {
      const managed = `${ctx.hub.dataDir}/users/${slug}/managed/managed.patch.yml`
      ctx.note(`默认工作区已就绪；managed.patch.yml = ${managed}`)
    }

    // ── WS 连接（探针在页面里包了 WebSocket） ───────────────────────────
    const wsConnected = await dshPage
      .waitForFunction(
        () => ((window as unknown as { __E2E_WS?: { opened: boolean }[] }).__E2E_WS ?? []).some((item) => item.opened),
        { timeout: 20_000 },
      )
      .then(() => true)
      .catch(() => false)
    const records = await wsRecords(dshPage).catch(() => [])
    ctx.expect(
      'DSH 的 WebSocket 已连接（至少一条 open）',
      wsConnected,
      records.map((item) => `${item.url} opened=${String(item.opened)} frames=${String(item.frames)}`).join(' | ') || '（没有 WS 记录）',
    )
    ctx.expect(
      'WS 上有真实帧往来（frames > 0）',
      records.some((item) => item.frames > 0),
      records.map((item) => `${item.url}→${String(item.frames)} 帧`).join(' | '),
    )

    await ctx.shot(dshPage, 'J3-03-dsh-workspace')

    // ── 资源条与状态（主卡片应显示运行中） ─────────────────────────────
    await gotoPath(page, '/home')
    const runningText = await waitForStatusLine(page, /已运行|正在运行/, 20_000)
    ctx.expect('工作台主卡片显示运行中', /已运行|正在运行/.test(runningText), `状态行「${runningText}」`)

    // ── console ────────────────────────────────────────────────────────
    await ctx.checkConsoleClean('A', 'Hub 工作台 + 打开流程')
    const dshErrors = dshCollector.errors()
    ctx.expect(
      'DSH 页面 0 个 JS console error（10 §C1）',
      dshErrors.length === 0,
      dshErrors.map((issue) => `[${issue.kind}] ${issue.text}`).join(' | ').slice(0, 600),
    )
    const dshUnexpected = dshCollector.unexpectedHttpErrors([])
    ctx.expect(
      'DSH 页面没有 4xx/5xx 响应',
      dshUnexpected.length === 0,
      dshUnexpected.map((issue) => `${String(issue.status)} ${issue.url ?? ''}`).join(' | ').slice(0, 400),
    )
    if (dshCollector.httpErrors().length > 0) {
      ctx.note(
        `DSH 页面 4xx/5xx：${dshCollector
          .httpErrors()
          .map((issue) => `${String(issue.status)} ${(issue.url ?? '').replace(PUBLIC_ORIGIN, '')}`)
          .join('、')}`,
      )
    }

    const container = ctx.requireDefined(
      'e2e 网络里能找到 A 的容器（label dshhub.slug）',
      await ctx.hub.containerForSlug(slug),
    )
    ctx.world.patchUser('A', { containerName: container })
    ctx.note(`A 的容器：${container}`)

    // 备份一份工作区快照，J5 会往里写文件
    const inspected = await ctx.hub.docker(['inspect', container, '--format', '{{.State.Status}} {{.Image}}'])
    ctx.expect('容器处于 running', inspected.stdout.startsWith('running'), inspected.stdout.trim())
  },
} satisfies Journey

/** 让 TS 记住 Page 的用法（截图/评估都在上面用到了） */
export type { Page }
