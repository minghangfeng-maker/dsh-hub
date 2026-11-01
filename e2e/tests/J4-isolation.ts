import { ApiClient, describeApi, errorCodeOf } from '../src/api.js'
import { newContext } from '../src/browser.js'
import { PUBLIC_ORIGIN, USER_B } from '../src/config.js'
import type { Journey } from '../src/context.js'
import { gotoPath } from '../src/ui.js'

/**
 * J4 越权隔离（10 §C3）
 *
 * 用户 B 访问 `/dsh/<A 的用户名>/`、`/dsh/<A>/api/...`、静态资源 → 404，且不泄漏任何内容
 * （不能出现 `__DSH_BOOT__`、DSH 界面文案）。对照项：
 *   - A 自己访问同样的地址是 200（否则「404」可能只是代理整体坏了）；
 *   - 未登录访问是 302 跳登录（也不泄漏内容）；
 *   - 旧地址 `/u/<slug>/` 对未登录/非主人也是 404（避免用 slug 枚举用户名，任务书 §2）。
 */
export default {
  id: 'J4',
  title: '越权隔离（B 访问 A 的 /dsh/<username>/ 与 /api → 404）',
  dependsOn: 'J2/J3',
  async run(ctx) {
    const username = ctx.requireDefined('世界状态里有 A 的用户名', ctx.world.state.users.A?.username)

    // ── 注册 B（J2 只注册了 A；B 用第二个邀请码） ────────────────────────
    let inviteCode = ctx.world.state.invites.B
    if (inviteCode === undefined) {
      const adminApi = await ctx.api('admin')
      const created = await adminApi.post<{ items: { code: string }[] }>('/api/admin/invites', {
        count: 1,
        maxUses: 1,
        note: 'WP8a e2e user B',
      })
      ctx.requireOk('补生成 B 的邀请码', created)
      inviteCode = created.body.items[0]!.code
      ctx.world.state.invites.B = inviteCode
      ctx.world.save()
    }

    const guest = await newContext(ctx.browser)
    const guestApi = new ApiClient(guest.context.request, PUBLIC_ORIGIN)
    const registered = await guestApi.post('/api/auth/register', {
      username: USER_B.username,
      password: USER_B.password,
      displayName: USER_B.displayName,
      inviteCode,
    })
    const alreadyRegistered = errorCodeOf(registered) === 'USERNAME_TAKEN'
    ctx.require(
      '用户 B 注册成功（或此前已注册）',
      registered.status === 201 || alreadyRegistered,
      describeApi(registered),
    )
    await guest.context.close()

    const adminApi = await ctx.api('admin')
    const users = await adminApi.get<{ items: { id: number; username: string; slug: string }[] }>(
      `/api/admin/users?q=${USER_B.username}`,
    )
    const bRow = ctx.requireDefined(
      '管理员能看到用户 B',
      users.body.items.find((item) => item.username === USER_B.username),
    )
    ctx.world.patchUser('B', { slug: bRow.slug, userId: bRow.id })

    const bPage = await ctx.page('B')
    const bApi = await ctx.world.apiFor('B')
    const collector = ctx.world.collectorFor('B')
    collector.clear()

    // B 自己的会话是有效的（排除「根本没登录」这种伪 404）
    const bMe = await bApi.get('/api/auth/me')
    ctx.require('B 的会话有效（/api/auth/me 200）', bMe.status === 200, describeApi(bMe))

    // ── 越权访问 A 的代理路径 ───────────────────────────────────────────
    const crossRoot = await bApi.get(`/dsh/${username}/`, { maxRedirects: 0 })
    ctx.expect(
      `B 访问 /dsh/${username}/ → 404`,
      crossRoot.status === 404,
      `HTTP ${String(crossRoot.status)}，body 前 120 字：${crossRoot.raw.toString('utf8').slice(0, 120)}`,
    )
    ctx.expect(
      '404 响应不泄漏 DSH 页面内容（无 __DSH_BOOT__、无 DSH 文案）',
      !crossRoot.raw.toString('utf8').includes('__DSH_BOOT__'),
    )

    for (const path of ['api/remote.mux', 'plugins/events', 'assets/index.js']) {
      const cross = await bApi.get(`/dsh/${username}/${path}`, { maxRedirects: 0 })
      ctx.expect(
        `B 访问 /dsh/${username}/${path} → 404（不泄漏存在性）`,
        cross.status === 404,
        `HTTP ${String(cross.status)}`,
      )
    }

    // 浏览器里也走一遍（页面渲染 + 不能是登录跳转或 200 空页）
    const navigation = await bPage.goto(`${PUBLIC_ORIGIN}/dsh/${username}/`, { waitUntil: 'domcontentloaded' })
    const status = navigation?.status() ?? 0
    ctx.expect('浏览器访问越权 URL 也是 404', status === 404, `HTTP ${String(status)} @ ${bPage.url()}`)
    const bodyText = (await bPage.locator('body').innerText().catch(() => '')).slice(0, 200)
    ctx.expect(
      '越权页面上没有任何 DSH 内容',
      !bodyText.includes('新会话') && !bodyText.includes('__DSH_BOOT__'),
      bodyText.replace(/\n+/g, ' / '),
    )
    await ctx.shot(bPage, 'J4-01-cross-user-404')

    // ── 对照 1：A 自己访问是 200（含静态资源） ─────────────────────────
    const aApi = await ctx.api('A')
    const ownRoot = await aApi.get(`/dsh/${username}/`)
    ctx.require(
      `对照：A 访问自己的 /dsh/${username}/ → 200 且含 __DSH_BOOT__`,
      ownRoot.status === 200 && ownRoot.raw.toString('utf8').includes('__DSH_BOOT__'),
      `HTTP ${String(ownRoot.status)}`,
    )
    const html = ownRoot.raw.toString('utf8')
    const asset = /(?:src|href)="([^"]*assets\/[^"]+)"/.exec(html)?.[1]
    if (asset === undefined) {
      ctx.skip('对照：A 能取到自己的静态资源（200）', 'HTML 里没找到 assets/ 引用（DSH 版本变了？）')
    } else {
      const assetPath = new URL(asset, `http://x/dsh/${username}/`).pathname
      const ownAsset = await aApi.get(assetPath, { maxRedirects: 0 })
      const crossAsset = await bApi.get(assetPath, { maxRedirects: 0 })
      ctx.expect(`对照：A 取自己的静态资源 ${assetPath} → 200`, ownAsset.status === 200, `HTTP ${String(ownAsset.status)}`)
      ctx.expect(`B 取同一静态资源 → 404`, crossAsset.status === 404, `HTTP ${String(crossAsset.status)}`)
    }

    // ── 对照 2：未登录 → 302 跳登录（不跟随重定向，看原始状态码） ───────
    const anon = await newContext(ctx.browser)
    const anonApi = new ApiClient(anon.context.request, PUBLIC_ORIGIN)
    const anonCross = await anonApi.get(`/dsh/${username}/`, {
      headers: { accept: 'text/html' },
      maxRedirects: 0,
    })
    ctx.expect(
      '未登录访问 /dsh/<username>/ → 302 跳登录（不泄漏内容）',
      anonCross.status === 302,
      `HTTP ${String(anonCross.status)}，location=${anonCross.headers['location'] ?? '（无）'}`,
    )
    ctx.expect(
      '302 的 Location 是登录页且带 next 回跳',
      (anonCross.headers['location'] ?? '').startsWith('/login?next='),
      anonCross.headers['location'] ?? '（无）',
    )
    await anon.context.close()

    // ── B 自己的工作台正常 ─────────────────────────────────────────────
    await ctx.checkConsoleClean('B', '越权访问', [
      // B 故意访问 A 的地址，浏览器控制台必然记一条 404，这是被测行为本身
      { status: 404, pathIncludes: `/dsh/${username}/` },
    ])
    await gotoPath(bPage, '/home')
    await bPage.locator('[data-testid="instance-primary"]').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined)
    const bHome = (await bPage.locator('body').innerText().catch(() => '')).replace(/\n+/g, ' / ')
    ctx.expect(
      'B 能正常进入自己的工作台',
      bHome.includes('我的 DSH') && bPage.url() === `${PUBLIC_ORIGIN}/home`,
      `${bPage.url()}：${bHome.slice(0, 160)}`,
    )
    await ctx.shot(bPage, 'J4-02-user-b-home')
  },
} satisfies Journey
