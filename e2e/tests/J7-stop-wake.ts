import { PUBLIC_ORIGIN } from '../src/config.js'
import type { Journey } from '../src/context.js'
import { dismissWelcomeIfAny, gotoPath, waitForStatusLine } from '../src/ui.js'

/**
 * J7 停止与唤醒（10 §C6 的后半段）
 *
 * `/home` 点「停止」→ 访问 `/dsh/<username>/` 出现唤醒页（`x-hub-instance: waking`）→ 自动启动 → 自动进入 DSH。
 * 前半段（空闲自动停止，审计 reason=idle）要等 `idleStopMinutes`，不在这条旅程里跑。
 */
export default {
  id: 'J7',
  title: '停止与唤醒（停止 → 唤醒页 → 自动启动 → 自动进入 DSH）',
  dependsOn: 'J3',
  timeoutMs: 5 * 60 * 1000,
  async run(ctx) {
    const username = ctx.requireDefined('世界状态里有 A 的用户名', ctx.world.state.users.A?.username)
    const page = await ctx.page('A')
    const api = await ctx.world.apiFor('A')
    const collector = ctx.world.collectorFor('A')
    collector.clear()

    await gotoPath(page, '/home')
    await dismissWelcomeIfAny(page)
    // J3 打开的 DSH 标签要关掉：实例停止后它的 WS 会自动重连，代理对未运行实例的 upgrade 一律 404，
    // 控制台会刷一片「WebSocket handshake 404」——那是被测行为本身，不是缺陷。
    const closed = await ctx.world.closeExtraPages('A')
    if (closed > 0) ctx.note(`关闭 ${String(closed)} 个额外标签页（DSH 页在实例停止后会刷 WS 重连 404）`)
    // 先等首页把真实状态拉回来（默认渲染是 absent，别把它当成运行中）
    const runningText = await waitForStatusLine(page, /已运行|正在运行/, 30_000)
    ctx.require('停止前实例是运行中', /已运行|正在运行/.test(runningText), `状态行「${runningText}」`)

    // ── 1. 点「停止」 ───────────────────────────────────────────────────
    await page.locator('[data-testid="instance-stop"]').click()
    // stopped 状态行有两种文案：没使用过是「已停止」，使用过是「上次使用 X 前」
    const stoppedText = await waitForStatusLine(page, /已停止|上次使用/, 60_000)
    ctx.require('界面状态变为「已停止」', /已停止|上次使用/.test(stoppedText), `状态行「${stoppedText}」`)

    const afterStop = await api.get<{ instance: { status: string } }>('/api/me/instance')
    ctx.expect('接口确认实例 status=stopped', afterStop.body.instance.status === 'stopped', afterStop.body.instance.status)
    await ctx.shot(page, 'J7-01-stopped')

    // ── 2. 访问 /dsh/<username>/ → 唤醒页 ───────────────────────────────
    const target = `${PUBLIC_ORIGIN}/dsh/${username}/`
    const wakeResponse = await page.context().request.get(target, { headers: { accept: 'text/html' } })
    const wakeHtml = (await wakeResponse.body()).toString('utf8')
    ctx.expect(
      '未运行时访问 /dsh/<username>/ 返回唤醒页（x-hub-instance: waking）',
      wakeResponse.status() === 200 && wakeResponse.headers()['x-hub-instance'] === 'waking',
      `HTTP ${String(wakeResponse.status())} x-hub-instance=${wakeResponse.headers()['x-hub-instance'] ?? '（无）'}`,
    )
    ctx.expect('唤醒页是 hub-web 的产品页（不是兜底页）', wakeHtml.includes('wake-card'), wakeHtml.slice(0, 120))

    const navigation = await page.goto(target, { waitUntil: 'domcontentloaded' })
    ctx.expect(
      '浏览器打开 /dsh/<username>/ 看到唤醒页',
      (navigation?.status() ?? 0) === 200 && (await page.title()).includes('正在唤醒你的 DSH'),
      `HTTP ${String(navigation?.status())} title=${await page.title()}`,
    )
    await ctx.shot(page, 'J7-02-wake-page')

    // ── 3. 自动启动 → 自动进入 DSH ──────────────────────────────────────
    const wokeUp = await page
      .waitForFunction(() => typeof (globalThis as { __DSH_BOOT__?: unknown }).__DSH_BOOT__ !== 'undefined', {
        timeout: 120_000,
      })
      .then(() => true)
      .catch(() => false)
    ctx.require('唤醒页自动完成启动并进入 DSH 界面', wokeUp, `当前 ${page.url()}：${(await page.title()) || '（无标题）'}`)
    ctx.expect('进入后 URL 仍在 /dsh/<username>/', page.url() === target, page.url())

    const afterWake = await api.get<{ instance: { status: string } }>('/api/me/instance')
    ctx.expect('接口确认实例已回到 running', afterWake.body.instance.status === 'running', afterWake.body.instance.status)

    const transport = await page.evaluate(() => {
      const value = (globalThis as { __DSH_TRANSPORT__?: { ownsHost?: boolean } }).__DSH_TRANSPORT__
      return value === undefined ? null : value.ownsHost === true
    })
    ctx.expect('唤醒后 ownsHost 仍注入成功', transport === true)
    await ctx.shot(page, 'J7-03-auto-woken')

    await ctx.checkConsoleClean('A', '停止与唤醒')
  },
} satisfies Journey
