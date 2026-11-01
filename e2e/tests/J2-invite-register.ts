import { ApiClient, describeApi, errorCodeOf } from '../src/api.js'
import { newContext } from '../src/browser.js'
import { PUBLIC_ORIGIN, USER_A } from '../src/config.js'
import type { Journey } from '../src/context.js'
import { dismissWelcomeIfAny, fillRegisterForm, gotoPath, hasText, submitRegister } from '../src/ui.js'

/**
 * J2 邀请码注册（10 §B1、§B2）
 *
 * 管理端生成邀请码 → 新用户在 `/register?code=` 注册 → 落到 `/home` 且欢迎引导出现；
 * 无码 / 错码 / 用尽码一律 `INVITE_INVALID` 且不消耗邀请码。
 *
 * 邀请码的生成界面（`/admin/invites`）归 WP6（尚未合并，当前是占位页），
 * 所以这里用管理员会话直接调 `POST /api/admin/invites`——接口契约与 04 §4.4 一致。
 */
export default {
  id: 'J2',
  needsFreshData: true,
  title: '邀请码注册（管理端生成 → /register?code= → 欢迎引导）',
  dependsOn: 'J1',
  async run(ctx) {
    const adminApi = await ctx.api('admin')

    // ── 1. 生成两个邀请码（A 用界面注册，B 留给 J4） ───────────────────────
    const created = await adminApi.post<{ items: { id: number; code: string; maxUses: number; usedCount: number }[] }>(
      '/api/admin/invites',
      { count: 2, maxUses: 1, note: 'WP8a e2e' },
    )
    ctx.requireOk('POST /api/admin/invites 生成邀请码', created)
    const invites = created.body.items
    ctx.require('返回 2 个邀请码', invites.length === 2, `实际 ${String(invites.length)}`)
    const codeA = invites[0]!.code
    const codeB = invites[1]!.code
    ctx.world.state.invites.A = codeA
    ctx.world.state.invites.B = codeB
    ctx.world.save()
    ctx.expect('邀请码是 12 位字符串', /^[A-Za-z0-9]{12}$/.test(codeA), codeA)

    // 再建一个只给「用尽码」用例的邀请码
    const wasteInvite = await adminApi.post<{ items: { code: string }[] }>('/api/admin/invites', {
      count: 1,
      maxUses: 1,
      note: 'WP8a e2e 用尽码用例',
    })
    ctx.requireOk('生成第 3 个邀请码（用尽码用例）', wasteInvite)
    const wasteCode = wasteInvite.body.items[0]!.code

    // 失败的注册都在这个「客人」上下文里发（不能污染 A 的会话）
    const guest = await newContext(ctx.browser)
    const guestApi = new ApiClient(guest.context.request, PUBLIC_ORIGIN)

    const inviteState = async (): Promise<{ used: number; uses: unknown[] }> => {
      const list = await adminApi.get<{
        items: { code: string; usedCount: number; uses: unknown[] }[]
      }>('/api/admin/invites?pageSize=50')
      const row = list.body.items.find((item) => item.code === codeA)
      return { used: row?.usedCount ?? -1, uses: row?.uses ?? [] }
    }
    const before = await inviteState()
    ctx.expect('新邀请码 usedCount=0', before.used === 0, `usedCount=${String(before.used)}`)

    // ── 2. 负例：无码 / 错码 / 用尽码（10 §B1） ───────────────────────────
    const noCode = await guestApi.post('/api/auth/register', {
      username: 'e2enocode',
      password: 'E2e-Nocode-20261',
    })
    ctx.expect(
      '无邀请码注册 → 400 INVITE_INVALID',
      noCode.status === 400 && errorCodeOf(noCode) === 'INVITE_INVALID',
      describeApi(noCode),
    )

    const wrongCode = await guestApi.post('/api/auth/register', {
      username: 'e2ewrongcode',
      password: 'E2e-Wrongcode-20261',
      inviteCode: 'ZZZZZZZZZZZZ',
    })
    ctx.expect(
      '错邀请码注册 → 400 INVITE_INVALID',
      wrongCode.status === 400 && errorCodeOf(wrongCode) === 'INVITE_INVALID',
      describeApi(wrongCode),
    )

    const wasteUser = await guestApi.post('/api/auth/register', {
      username: 'e2ewaste',
      password: 'E2e-Waste-20261',
      inviteCode: wasteCode,
    })
    ctx.expect('用尽码用例：第一次用该码注册成功（201）', wasteUser.status === 201, describeApi(wasteUser))
    const exhausted = await guestApi.post('/api/auth/register', {
      username: 'e2ewaste2',
      password: 'E2e-Waste2-20261',
      inviteCode: wasteCode,
    })
    ctx.expect(
      '用尽码注册 → 400 INVITE_INVALID',
      exhausted.status === 400 && errorCodeOf(exhausted) === 'INVITE_INVALID',
      describeApi(exhausted),
    )

    const after = await inviteState()
    ctx.expect(
      '失败的注册没有消耗邀请码（usedCount 仍为 0）',
      after.used === 0,
      `usedCount=${String(after.used)}`,
    )
    await guest.context.close()

    // ── 3. 正例：界面注册（?code= 预填 → 自动登录 → /home → 欢迎引导） ────
    const page = await ctx.world.pageFor('A')
    const collector = ctx.world.collectorFor('A')
    collector.clear()
    await gotoPath(page, `/register?code=${codeA}`)
    const prefilled = await page.locator('input[aria-label="邀请码"]').inputValue()
    ctx.require('注册页从 ?code= 预填邀请码', prefilled === codeA, `实际「${prefilled}」`)
    await ctx.shot(page, 'J2-01-register-form')

    await fillRegisterForm(page, {
      username: USER_A.username,
      password: USER_A.password,
      displayName: USER_A.displayName,
      inviteCode: codeA,
    })
    await submitRegister(page)

    const landed = await page
      .waitForURL(`${PUBLIC_ORIGIN}/home`, { timeout: 25_000 })
      .then(() => true)
      .catch(() => false)
    ctx.require(
      '界面注册成功后落到 /home',
      landed,
      `当前 URL ${page.url()}；页面提示「${((await hasText(page, '邀请码', 500)) ? '邀请码相关' : '')}」`,
    )

    const welcome = await hasText(page, '欢迎加入，先看三步', 8000)
    ctx.expect('注册后出现欢迎引导（3 步气泡）', welcome)
    await ctx.shot(page, 'J2-02-welcome-guide')
    if (welcome) {
      await dismissWelcomeIfAny(page)
      ctx.note('欢迎引导已关闭（避免遮挡后续旅程的截图与点击）')
    }

    // 会话与身份
    const me = await adminApi.get<{ items: { username: string; slug: string; id: number }[] }>(
      `/api/admin/users?q=${USER_A.username}`,
    )
    const row = ctx.requireDefined(
      '管理员能在用户列表里搜到新注册用户 A',
      me.body.items.find((item) => item.username === USER_A.username),
      JSON.stringify(me.body).slice(0, 200),
    )
    ctx.world.patchUser('A', { slug: row.slug, userId: row.id })
    ctx.expect('新用户 slug 形如 uXXXXXXX', /^u[a-z0-9]{7}$/.test(row.slug), row.slug)

    const mine = await adminApi.get(`/api/admin/users/${String(row.id)}`)
    ctx.expect('用户详情可见', mine.ok, describeApi(mine))

    // ── 4. 邀请码记账 ───────────────────────────────────────────────────
    const finalState = await inviteState()
    ctx.expect('邀请码被消耗 1 次', finalState.used === 1, `usedCount=${String(finalState.used)}`)
    ctx.expect('邀请码使用记录里有该用户', finalState.uses.length === 1, JSON.stringify(finalState.uses))

    // ── 5. console ─────────────────────────────────────────────────────
    // 注册页未登录时会探测 `/api/auth/me`，401 属设计内（J1 里有同样放行）
    await ctx.checkConsoleClean('A', '注册流程', [{ status: 401, pathIncludes: '/api/auth/me' }])
    await ctx.shot(page, 'J2-03-home-after-register', true)
    ctx.note(`A 的 slug=${row.slug}、邀请码=${codeA}`)
  },
} satisfies Journey
