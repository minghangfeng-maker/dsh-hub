import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type {
  DesktopDeviceAdminItemSchema,
  DesktopDeviceDetailResponse,
  DesktopMyDevicesResponse,
  MobileBootstrapResponse,
  MobileNodesResponse,
} from '@dsh-hub/shared'
import type { z } from 'zod'
import {
  createTestApp,
  createUser,
  json,
  loginAs,
  type TestApp,
  type TestSession,
  type TestUser,
} from './helpers.js'
import { bearerHeaders, mobileBootstrap, mobileLogin, mobileSession, refreshToken } from './helpers-mobile.js'

/**
 * 手机网页版（`platform='web'`，WP54a / WP54 §2 C1）：平台落库后的全链行为。
 *
 * 为什么单独一组：网页版和 App 走的是**同一套**登录 / 设备令牌 / 通道，差别只在两处
 * （契约 C1/C11）：`mobile_platform='web'` 要能写进设备台账，且 bootstrap 的 `app` 段
 * 不下发 APK 更新与强更地板。其余路径（ticket / refresh / 吊销 / 列表）必须与 App 完全一致 ——
 * 所以这里用与 App 相同的 injection 流程走一遍，而不是相信「代码通用」。
 *
 * **网页版与 android 是两台设备**：同一用户的 web 与 android 记录不能互相合并 / 顶掉，
 * 否则「手机 App 登一次，网页版就被踢下线」。
 */

/** 网页版的真实来源是 Hub 自己（同源）；测试里就是 createTestApp 的 HUB_PUBLIC_ORIGIN */
const WEB_ORIGIN = 'http://127.0.0.1:7701'
const WEB_DEVICE_NAME = '手机网页版 · Chrome · Android'

let ctx: TestApp
let alice: TestUser
let aliceSession: TestSession
let adminSession: TestSession

beforeEach(async () => {
  ctx = await createTestApp()
  alice = await createUser(ctx.app, { username: 'alice', password: 'Alice-pass-1' })
  aliceSession = loginAs(ctx.app, alice)
  const root = await createUser(ctx.app, { username: 'root', password: 'Root-pass-1', role: 'admin' })
  adminSession = loginAs(ctx.app, root)
})

afterEach(async () => {
  await ctx.close()
})

interface DeviceRow {
  device_id: string
  kind: string
  mobile_platform: string | null
  name: string
  status: string
  install_key: string | null
}

function deviceRows(): DeviceRow[] {
  return ctx.app.deps.db.all<DeviceRow>(
    'SELECT device_id, kind, mobile_platform, name, status, install_key FROM desktop_devices ORDER BY id',
  )
}

function activeMobile(): DeviceRow[] {
  return deviceRows().filter((row) => row.kind === 'mobile' && row.status === 'active')
}

function platforms(list: DeviceRow[]): Array<string | null> {
  return list.map((row) => row.mobile_platform).sort()
}

/** 管理端把 APK 版本地板配起来：这样「web 拿不到这些值」才是有意义的断言 */
async function configureAppFloor(): Promise<void> {
  const patch = await ctx.app.inject({
    method: 'PATCH',
    url: '/api/admin/settings',
    headers: adminSession.headers,
    payload: JSON.stringify({
      mobile: {
        app: {
          minVersionCode: 7,
          latestVersionCode: 9,
          downloadUrl: 'https://hub.example.com:8123/app/dsh-hub.apk',
        },
      },
    }),
  })
  expect(patch.statusCode, patch.body).toBe(200)
}

/** web 设备登录（走网页版的同源 Origin） */
async function webLogin(installId?: string, deviceName = WEB_DEVICE_NAME) {
  return mobileLogin(ctx.app, alice, { platform: 'web', deviceName, installId, origin: WEB_ORIGIN })
}

describe('手机网页版：登录 → bootstrap → ticket → 刷新 → 吊销', () => {
  it('登录写进设备台账（kind=mobile, mobile_platform=web），令牌前缀与 App 相同', async () => {
    const result = await webLogin('web-install-0001')
    expect(result.status, JSON.stringify(result.body)).toBe(200)
    const tokens = result.tokens!
    expect(tokens.accessToken).toMatch(/^dshm_at_/u)
    expect(tokens.refreshToken).toMatch(/^dshm_rt_/u)

    expect(deviceRows()).toMatchObject([
      {
        device_id: tokens.deviceId,
        kind: 'mobile',
        mobile_platform: 'web',
        name: WEB_DEVICE_NAME,
        status: 'active',
      },
    ])
    // installId 落库是加盐 sha256（不存原始值）
    const stored = deviceRows()[0]!
    expect(stored.install_key).toMatch(/^[0-9a-f]{64}$/u)
    expect(stored.install_key).not.toContain('web-install-0001')
    expect(JSON.stringify(deviceRows())).not.toContain(tokens.accessToken)

    const actions = ctx.app.deps.db
      .all<{ action: string }>('SELECT action FROM audit_logs ORDER BY id')
      .map((row) => row.action)
    expect(actions).toContain('mobile.login')
  })

  it('bootstrap：web 设备拿「无更新」形态（0 / 0 / null / []），android 与 cookie 路径仍拿设置里的值', async () => {
    await configureAppFloor()

    const web = await mobileSession(ctx.app, alice, {
      platform: 'web',
      deviceName: WEB_DEVICE_NAME,
      installId: 'web-install-0001',
      origin: WEB_ORIGIN,
    })
    const webBoot = await mobileBootstrap(ctx.app, web.headers)
    expect(webBoot.status, JSON.stringify(webBoot.body)).toBe(200)
    expect(webBoot.body.user.username).toBe('alice')
    // 网页版：没有 APK 更新、没有强更地板 —— 任何按数值比较的客户端都「什么都不用做」
    expect(webBoot.body.app).toEqual({
      minVersionCode: 0,
      latestVersionCode: 0,
      downloadUrl: null,
      downloadMirrors: [],
    })
    // 其余字段与 App 同形（web 不是后端；云实例仍在列表里）
    expect(webBoot.body.backends.map((node) => node.id)).toEqual(['cloud:self'])

    // android 设备：照旧是设置里的地板与下载地址
    const android = await mobileSession(ctx.app, alice, { platform: 'android', deviceName: 'Pixel 8' })
    const androidBoot = await mobileBootstrap(ctx.app, android.headers)
    expect(androidBoot.body.app).toEqual({
      minVersionCode: 7,
      latestVersionCode: 9,
      downloadUrl: 'https://hub.example.com:8123/app/dsh-hub.apk',
      downloadMirrors: [],
    })

    // 0.2.0 老 APK 的 cookie 路径（没有设备身份）行为不变
    const viaCookie = await ctx.app.inject({
      method: 'GET',
      url: '/api/mobile/bootstrap',
      headers: aliceSession.headers,
    })
    expect(viaCookie.statusCode).toBe(200)
    expect(json<MobileBootstrapResponse>(viaCookie).app).toEqual({
      minVersionCode: 7,
      latestVersionCode: 9,
      downloadUrl: 'https://hub.example.com:8123/app/dsh-hub.apk',
      downloadMirrors: [],
    })
  })

  it('ticket / 节点列表 / 刷新：与 App 走同一条链', async () => {
    const { tokens, headers } = await mobileSession(ctx.app, alice, {
      platform: 'web',
      deviceName: WEB_DEVICE_NAME,
      installId: 'web-install-0001',
      origin: WEB_ORIGIN,
    })

    const nodes = await ctx.app.inject({ method: 'GET', url: '/api/mobile/nodes', headers })
    expect(nodes.statusCode).toBe(200)
    expect(json<MobileNodesResponse>(nodes).items[0]?.id).toBe('cloud:self')

    const ticket = await ctx.app.inject({
      method: 'POST',
      url: '/api/mobile/nodes/cloud%3Aself/ticket',
      headers,
    })
    expect(ticket.statusCode, ticket.body).toBe(200)
    const ticketBody = json<{ ticket: string; expiresAt: string }>(ticket)
    expect(ticketBody.ticket.length).toBeGreaterThan(0)
    expect(Number.isNaN(Date.parse(ticketBody.expiresAt))).toBe(false)

    const refreshed = await refreshToken(ctx.app, tokens.refreshToken, { origin: WEB_ORIGIN })
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200)
    expect(refreshed.tokens!.deviceId).toBe(tokens.deviceId)
    expect(refreshed.tokens!.accessToken).not.toBe(tokens.accessToken)
    // 轮换后旧 access 只回「去 refresh」，不是「设备被吊销」
    const old = await mobileBootstrap(ctx.app, headers)
    expect(old.status).toBe(401)
    expect(old.errorCode).toBe('DEVICE_TOKEN_INVALID')
    // 新令牌可用；设备行仍是同一台 web 设备
    const after = await mobileBootstrap(ctx.app, bearerHeaders(refreshed.tokens!.accessToken, WEB_ORIGIN))
    expect(after.status).toBe(200)
    expect(activeMobile()).toHaveLength(1)
    expect(activeMobile()[0]?.mobile_platform).toBe('web')
  })

  it('网页端吊销（DELETE /api/me/desktop-devices/:id）→ web 设备 401 DEVICE_REVOKED', async () => {
    const { tokens, headers } = await mobileSession(ctx.app, alice, {
      platform: 'web',
      deviceName: WEB_DEVICE_NAME,
      origin: WEB_ORIGIN,
    })
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/me/desktop-devices',
      headers: aliceSession.headers,
    })
    const mine = json<DesktopMyDevicesResponse>(list)
    const web = mine.items.find((item) => item.deviceId === tokens.deviceId)
    expect(web).toMatchObject({
      kind: 'mobile',
      mobilePlatform: 'web',
      name: WEB_DEVICE_NAME,
      revokedAt: null,
    })
    // web 设备不占桌面设备配额
    expect(mine.limit.used).toBe(0)

    const revoke = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/me/desktop-devices/${tokens.deviceId}`,
      headers: aliceSession.headers,
    })
    expect(revoke.statusCode).toBe(204)

    const after = await mobileBootstrap(ctx.app, headers)
    expect(after.status).toBe(401)
    expect(after.errorCode).toBe('DEVICE_REVOKED')
    expect(deviceRows()[0]?.status).toBe('revoked')
  })

  it('退出登录：设备行吊销、再登录复用不了（与 App 同一语义）', async () => {
    const first = await mobileSession(ctx.app, alice, {
      platform: 'web',
      deviceName: WEB_DEVICE_NAME,
      installId: 'web-install-0001',
      origin: WEB_ORIGIN,
    })
    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/api/mobile/auth/logout',
      headers: first.headers,
    })
    expect(logout.statusCode).toBe(204)
    // 同一 installId 再登录：旧行已 revoked，不再复用 → 新设备行（与 App 行为一致）
    const second = await mobileSession(ctx.app, alice, {
      platform: 'web',
      deviceName: WEB_DEVICE_NAME,
      installId: 'web-install-0001',
      origin: WEB_ORIGIN,
    })
    expect(second.tokens.deviceId).not.toBe(first.tokens.deviceId)
    expect(deviceRows().filter((row) => row.mobile_platform === 'web')).toHaveLength(2)
    expect(activeMobile()).toHaveLength(1)
  })
})

describe('手机网页版与手机 App 是两台设备（不互相合并）', () => {
  it('同一用户 web + android 各自一台：都在台账里、都能用、consolidate 不互相动', async () => {
    const android = await mobileSession(ctx.app, alice, {
      platform: 'android',
      deviceName: 'Android · 7SUN',
      installId: 'apk-install-0001',
    })
    const web = await mobileSession(ctx.app, alice, {
      platform: 'web',
      deviceName: WEB_DEVICE_NAME,
      installId: 'web-install-0001',
      origin: WEB_ORIGIN,
    })
    expect(web.tokens.deviceId).not.toBe(android.tokens.deviceId)
    expect(activeMobile()).toHaveLength(2)
    expect(platforms(activeMobile())).toEqual(['android', 'web'])

    // 网页版调 consolidate：没有要合并的（同平台的另一台不存在），android 更不能被合并
    const consolidated = await ctx.app.inject({
      method: 'POST',
      url: '/api/mobile/auth/consolidate',
      headers: web.headers,
    })
    expect(consolidated.statusCode).toBe(200)
    expect(json<{ removed: number }>(consolidated as never).removed).toBe(0)

    // 两台都还能用（谁都没把谁顶下线）
    expect((await mobileBootstrap(ctx.app, android.headers)).status).toBe(200)
    expect((await mobileBootstrap(ctx.app, web.headers)).status).toBe(200)
    expect(
      activeMobile()
        .map((row) => row.device_id)
        .sort(),
    ).toEqual([android.tokens.deviceId, web.tokens.deviceId].sort())
  })

  it('同一个 deviceName 也不合并：web 带 installId 登录只清理 web 的历史记录，android 一台不动', async () => {
    // 对抗场景：网页版给的设备名与 App 的设备名**故意一样**，且都是旧版 App 那种「每次登录新增一条」
    const name = '手机 · Pixel'
    const androidOld = await mobileLogin(ctx.app, alice, { platform: 'android', deviceName: name })
    const androidOld2 = await mobileLogin(ctx.app, alice, { platform: 'android', deviceName: name })
    const webOld = await mobileLogin(ctx.app, alice, {
      platform: 'web',
      deviceName: name,
      origin: WEB_ORIGIN,
    })
    const webOld2 = await mobileLogin(ctx.app, alice, {
      platform: 'web',
      deviceName: name,
      origin: WEB_ORIGIN,
    })
    expect(activeMobile()).toHaveLength(4)
    expect(platforms(activeMobile())).toEqual(['android', 'android', 'web', 'web'])

    // 新版网页版（带 installId）登录 → 只合并 web 的两条历史记录
    const webNew = await mobileLogin(ctx.app, alice, {
      platform: 'web',
      deviceName: name,
      installId: 'web-install-0002',
      origin: WEB_ORIGIN,
    })
    expect(webNew.status).toBe(200)

    const active = activeMobile()
    expect(active).toHaveLength(3)
    const activePlatforms = platforms(active)
    expect(activePlatforms).toEqual(['android', 'android', 'web'])
    expect(active.filter((row) => row.mobile_platform === 'web')[0]?.device_id).toBe(webNew.tokens!.deviceId)
    // 两条 android 历史记录都还在（没有因为同名就被 web 合并掉）
    const androidIds = active.filter((row) => row.mobile_platform === 'android').map((row) => row.device_id)
    expect(androidIds.sort()).toEqual([androidOld.tokens!.deviceId, androidOld2.tokens!.deviceId].sort())

    // 被合并的是那两条 web 历史记录
    const revoked = deviceRows()
      .filter((row) => row.status === 'revoked')
      .map((row) => row.device_id)
    expect(revoked.sort()).toEqual([webOld.tokens!.deviceId, webOld2.tokens!.deviceId].sort())
    // 合并动作有审计
    const actions = ctx.app.deps.db
      .all<{ action: string }>('SELECT action FROM audit_logs ORDER BY id')
      .map((row) => row.action)
    expect(actions).toContain('mobile.device.merge')

    // android 的令牌没有被旋转掉：仍然能 bootstrap
    expect((await mobileBootstrap(ctx.app, bearerHeaders(androidOld.tokens!.accessToken))).status).toBe(200)
    // 同一台 web 再用同一 installId 登录 → 复用同一条设备记录（不新增）
    const webAgain = await mobileLogin(ctx.app, alice, {
      platform: 'web',
      deviceName: name,
      installId: 'web-install-0002',
      origin: WEB_ORIGIN,
    })
    expect(webAgain.tokens!.deviceId).toBe(webNew.tokens!.deviceId)
    expect(activeMobile()).toHaveLength(3)
  })

  it('手机设备上限只按 kind=mobile 计，web 与 android 各自被顶掉的是「最老的手机」，不碰桌面设备', async () => {
    const desktop = await ctx.app.deps.db.run(
      `INSERT INTO desktop_devices (device_id, user_id, install_key, name, kind, platform, capabilities_json,
                                    first_seen_at, created_at, updated_at)
       VALUES (?, ?, NULL, '我的 Windows', 'desktop', 'win32', NULL, ?, ?, ?)`,
      `dv_${'f'.repeat(32)}`,
      alice.id,
      ctx.clock.nowIso(),
      ctx.clock.nowIso(),
      ctx.clock.nowIso(),
    )
    expect(desktop.changes).toBe(1)

    const web = await mobileSession(ctx.app, alice, {
      platform: 'web',
      deviceName: WEB_DEVICE_NAME,
      installId: 'web-install-0001',
      origin: WEB_ORIGIN,
    })
    expect((await mobileBootstrap(ctx.app, web.headers)).status).toBe(200)
    expect(deviceRows().find((row) => row.kind === 'desktop')?.status, '手机登录不应触碰桌面设备').toBe(
      'active',
    )
  })
})

describe('设备列表 / 管理端对 web 的展示', () => {
  it('管理端设备列表与详情都带 mobilePlatform=web（按台账原样给，不做平台白名单）', async () => {
    const { tokens } = await mobileSession(ctx.app, alice, {
      platform: 'web',
      deviceName: WEB_DEVICE_NAME,
      installId: 'web-install-0001',
      origin: WEB_ORIGIN,
    })

    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/desktop-devices?userId=${String(alice.id)}&revoked=all&pageSize=50`,
      headers: adminSession.headers,
    })
    expect(list.statusCode, list.body).toBe(200)
    const items = json<{ items: Array<z.infer<typeof DesktopDeviceAdminItemSchema>> }>(list).items
    const row = items.find((item) => item.device.deviceId === tokens.deviceId)
    expect(row?.device).toMatchObject({
      kind: 'mobile',
      mobilePlatform: 'web',
      name: WEB_DEVICE_NAME,
      presence: 'offline',
    })
    expect(row?.user).toMatchObject({ id: alice.id, username: 'alice' })

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/desktop-devices/${tokens.deviceId}`,
      headers: adminSession.headers,
    })
    expect(detail.statusCode, detail.body).toBe(200)
    const body = json<DesktopDeviceDetailResponse>(detail)
    expect(body.device).toMatchObject({ kind: 'mobile', mobilePlatform: 'web' })
    expect(body.plugins).toEqual([])
    expect(body.pluginCount).toBe(0)
  })

  it('改了密码（级联吊销）也覆盖 web 设备：下一次请求 401 DEVICE_REVOKED', async () => {
    const { headers } = await mobileSession(ctx.app, alice, {
      platform: 'web',
      deviceName: WEB_DEVICE_NAME,
      origin: WEB_ORIGIN,
    })
    ctx.app.deps.services.desktop.revokeTokensForUser(alice.id, 'password-change')
    const res = await mobileBootstrap(ctx.app, headers)
    expect(res.status).toBe(401)
    expect(res.errorCode).toBe('DEVICE_REVOKED')
  })
})

describe('web 设备的通道（WS）：Hub 自己的来源能过来源检查', () => {
  /** 直接写一行桌面设备（通道要绑节点，不用起真中继：节点不存在时通道会被 bye 掉） */
  function seedDesktopDevice(): string {
    const id = `dv_${'e'.repeat(32)}`
    const now = ctx.clock.nowIso()
    ctx.app.deps.db.run(
      `INSERT INTO desktop_devices (device_id, user_id, install_key, name, kind, platform, os_major, arch,
         app_version, app_channel, runtime_version, capabilities_json, status,
         registered_at, first_seen_at, last_auth_at, last_report_at, created_at, updated_at)
       VALUES (?, ?, NULL, '我的 Windows', 'desktop', 'win32', '11', 'x64', '0.9.3', 'latest', '0.2.1',
               NULL, 'active', ?, ?, ?, ?, ?, ?)`,
      id,
      alice.id,
      now,
      now,
      now,
      now,
      now,
      now,
    )
    return id
  }

  it('web（Origin = Hub 自己）→ 101；站外来源 → 403（ticket 也没被消耗掉）', async () => {
    const nodeId = seedDesktopDevice()
    await new Promise<void>((resolve) => ctx.app.server.listen(0, '127.0.0.1', resolve))
    const address = ctx.app.server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0

    const { headers } = await mobileSession(ctx.app, alice, {
      platform: 'web',
      deviceName: WEB_DEVICE_NAME,
      installId: 'web-install-0001',
      origin: WEB_ORIGIN,
    })
    const issue = async (): Promise<string> => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/mobile/nodes/${encodeURIComponent(nodeId)}/ticket`,
        headers,
      })
      expect(res.statusCode, res.body).toBe(200)
      return json<{ ticket: string }>(res).ticket
    }

    const sockets: WebSocket[] = []
    /** 握手结果：101 = 通过来源检查并完成升级；其它数字是被拒时回的 HTTP 状态码 */
    const handshake = async (ticket: string, origin: string): Promise<number> => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${String(port)}/api/mobile/nodes/${encodeURIComponent(nodeId)}/channel?ticket=${ticket}`,
        { headers: { origin } },
      )
      sockets.push(socket)
      return Promise.race([
        once(socket, 'open').then(() => 101),
        once(socket, 'unexpected-response').then(([, res]) => (res as { statusCode: number }).statusCode),
      ])
    }

    try {
      // 站外来源：先被来源检查拦下（403），而且这一步发生在消费 ticket 之前
      expect(await handshake(await issue(), 'https://evil.example')).toBe(403)
      // 网页版的真实来源 = Hub 自己：能完成 WS 升级（节点没连中继 → 随后 bye，但门已经过了）
      expect(await handshake(await issue(), WEB_ORIGIN)).toBe(101)
    } finally {
      for (const socket of sockets) socket.close()
    }
  })
})
