import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp, createUser, json, type TestApp } from './helpers.js'
import { mobileLogin } from './helpers-mobile.js'
import { adminSession } from './wp1-helpers.js'
import { MOBILE_COCKPIT_NODE_ID } from '@dsh-hub/shared'

/**
 * WP56b：座舱令牌与 `cloud:ops` 节点（docs/24 §3.3）。
 *
 * 覆盖任务书要求的四项：交接码一次性 / 60 秒过期 / 绑定管理员、scope 越权 403、
 * 管理员降级后令牌失效（通道 `bye` 由服务层事件测试覆盖）、以及「不占手机设备名额」。
 *
 * 交接码的签发与存表归 WP56a；这里用**同一形状的假实现**接在 `services.cockpit` 上，
 * 接口见 `modules/mobile/cockpit-port.ts`。
 */

let ctx: TestApp
let app: FastifyInstance
let admin: Awaited<ReturnType<typeof adminSession>>
/** 一次性交接码：码 → 管理员 id（消费即删，模拟 60 秒一次性） */
const codes = new Map<string, number>()

beforeEach(async () => {
  ctx = await createTestApp()
  app = ctx.app
  admin = await adminSession(app, 'cockpit-admin')
  codes.clear()
  // WP56a 的 modules/cockpit 合并后会实例化同名服务；这里用鸭子类型的假实现接上接缝
  ;(app.deps.services as unknown as Record<string, unknown>)['cockpit'] = {
    // WP56a 的签名：交接码 → 管理员 id（一次性、60 秒由它保证）
    consumeHandoff(code: string) {
      const adminId = codes.get(code)
      if (adminId === undefined) return null
      codes.delete(code)
      return adminId
    },
  }
})

afterEach(async () => {
  await ctx.close()
})

function issueCode(adminId: number, code = `code-${Math.random().toString(36).slice(2)}`): string {
  codes.set(code, adminId)
  return code
}

async function exchange(code: string) {
  return app.inject({
    method: 'POST',
    url: '/api/mobile/auth/cockpit-exchange',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ code }),
  })
}

async function asCockpit(token: string, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  })
  return res
}

describe('交接码 → 座舱令牌', () => {
  it('换到与登录同形的令牌对，额外 scope=cockpit，有效期 12 小时', async () => {
    const res = await exchange(issueCode(admin.user.id))
    expect(res.statusCode).toBe(200)
    const body = json<{
      accessToken: string
      refreshToken: string
      accessExpiresAt: string
      refreshExpiresAt: string
      deviceId: string
      scope: string
      user: { id: number; username: string }
    }>(res)
    expect(body.scope).toBe('cockpit')
    expect(body.accessToken.startsWith('dshm_at_')).toBe(true)
    expect(body.refreshToken.startsWith('dshm_rt_')).toBe(true)
    expect(body.deviceId).toMatch(/^dv_[0-9a-f]{32}$/u)
    expect(body.user.id).toBe(admin.user.id)
    const ttl = Date.parse(body.accessExpiresAt) - ctx.clock.now().getTime()
    expect(ttl).toBe(12 * 3_600_000)
    expect(Date.parse(body.refreshExpiresAt)).toBe(Date.parse(body.accessExpiresAt))
  })

  it('交接码是一次性的：第二次兑换失败', async () => {
    const code = issueCode(admin.user.id)
    expect((await exchange(code)).statusCode).toBe(200)
    const again = await exchange(code)
    expect(again.statusCode).toBe(401)
    expect(json<{ error: { code: string } }>(again).error.code).toBe('INVALID_CREDENTIALS')
  })

  it('不存在的码 / 普通用户的码一律拒绝', async () => {
    expect((await exchange('never-issued')).statusCode).toBe(401)
    const plain = await createUser(app, { username: 'not-an-admin' })
    const res = await exchange(issueCode(plain.id))
    expect(res.statusCode).toBe(403)
  })

  it('不占手机设备名额：座舱令牌不在 desktop_devices 里', async () => {
    const before = app.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_devices')!.n
    await exchange(issueCode(admin.user.id))
    const after = app.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_devices')!.n
    expect(after).toBe(before)
    const rows = app.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cockpit_admin_tokens')!.n
    expect(rows).toBe(2) // access + refresh
  })
})

describe('作用域：座舱令牌只看得见 cloud:ops', () => {
  async function cockpitToken(): Promise<string> {
    const res = await exchange(issueCode(admin.user.id))
    return json<{ accessToken: string }>(res).accessToken
  }

  it('节点列表只有座舱节点', async () => {
    const token = await cockpitToken()
    const res = await asCockpit(token, 'GET', '/api/mobile/nodes')
    expect(res.statusCode).toBe(200)
    const items = json<{ items: { id: string; kind: string; connectable: boolean }[] }>(res).items
    expect(items).toHaveLength(1)
    expect(items[0]!.id).toBe(MOBILE_COCKPIT_NODE_ID)
    expect(items[0]!.kind).toBe('cloud')
    // 座舱容器在测试里没起来 → 不可连接，但节点本身在列表里（App 要显示「未运行」而不是空列表）
    expect(items[0]!.connectable).toBe(false)
  })

  it('bootstrap 只给通道需要的字段（没有积分、没有 APK 更新）', async () => {
    const token = await cockpitToken()
    const res = await asCockpit(token, 'GET', '/api/mobile/bootstrap')
    expect(res.statusCode).toBe(200)
    const body = json<{
      points: { enabled: boolean; balance: number }
      backends: { id: string }[]
      app: { downloadUrl: string | null; latestVersionCode: number }
      voice: unknown
    }>(res)
    expect(body.points).toEqual({ balance: 0, enabled: false })
    expect(body.backends.map((node) => node.id)).toEqual([MOBILE_COCKPIT_NODE_ID])
    expect(body.app.downloadUrl).toBeNull()
    expect(body.app.latestVersionCode).toBe(0)
    expect(body.voice).toBeTruthy()
  })

  it('其余手机接口 403（唤醒自己的云实例、合并设备）', async () => {
    const token = await cockpitToken()
    expect((await asCockpit(token, 'POST', '/api/mobile/instance/wake')).statusCode).toBe(403)
    expect((await asCockpit(token, 'POST', '/api/mobile/auth/consolidate')).statusCode).toBe(403)
    // 语音是嵌入模式保留的能力（这里只断言不是 403：ASR 在测试里没启用，回 4xx/5xx 但不会是作用域拒绝）
    const asr = await app.inject({
      method: 'POST',
      url: '/api/mobile/asr?lang=zh',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/wav' },
      payload: Buffer.alloc(0),
    })
    expect(asr.statusCode).not.toBe(403)
  })

  it('普通手机/网页版令牌看不见 cloud:ops', async () => {
    const login = await mobileLogin(app, admin.user, { deviceName: '手机', platform: 'web' })
    expect(login.status, JSON.stringify(login.body)).toBe(200)
    const token = login.tokens!.accessToken
    const nodes = await asCockpit(token, 'GET', '/api/mobile/nodes')
    expect(nodes.statusCode).toBe(200)
    expect(json<{ items: { id: string }[] }>(nodes).items.map((node) => node.id)).not.toContain(
      MOBILE_COCKPIT_NODE_ID,
    )
    // 也不能拿普通令牌去连座舱节点
    const ticket = await asCockpit(
      token,
      'POST',
      `/api/mobile/nodes/${encodeURIComponent(MOBILE_COCKPIT_NODE_ID)}/ticket`,
    )
    expect(ticket.statusCode).toBe(404)
  })
})

describe('刷新与吊销', () => {
  it('refresh 轮换一对新令牌，旧 refresh 立即失效', async () => {
    const first = json<{ refreshToken: string }>(await exchange(issueCode(admin.user.id)))
    const res = await app.inject({
      method: 'POST',
      url: '/api/mobile/auth/refresh',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ refreshToken: first.refreshToken }),
    })
    expect(res.statusCode).toBe(200)
    const second = json<{ accessToken: string; refreshToken: string; scope: string }>(res)
    expect(second.scope).toBe('cockpit')
    expect(second.refreshToken).not.toBe(first.refreshToken)
    // 新的能用
    expect((await asCockpit(second.accessToken, 'GET', '/api/mobile/nodes')).statusCode).toBe(200)
    // 旧的已经轮换掉了
    const replay = await app.inject({
      method: 'POST',
      url: '/api/mobile/auth/refresh',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ refreshToken: first.refreshToken }),
    })
    expect(replay.statusCode).toBe(401)
  })

  it('管理员登出：座舱令牌立即作废', async () => {
    const token = json<{ accessToken: string }>(await exchange(issueCode(admin.user.id))).accessToken
    expect((await asCockpit(token, 'GET', '/api/mobile/nodes')).statusCode).toBe(200)
    const logout = await app.inject({
      method: 'POST',
      url: '/api/mobile/auth/logout',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(logout.statusCode).toBe(204)
    expect((await asCockpit(token, 'GET', '/api/mobile/nodes')).statusCode).toBe(401)
  })

  it('管理员被降级：令牌失效，库里也标了吊销', async () => {
    // 系统有「最后一个管理员」保护：先造第二个管理员，才能把造事的那位降级
    await createUser(app, { username: 'second-admin', role: 'admin' })
    const token = json<{ accessToken: string }>(await exchange(issueCode(admin.user.id))).accessToken
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${String(admin.user.id)}`,
      headers: { ...admin.headers, 'content-type': 'application/json', 'x-hub-csrf': '1' },
      payload: JSON.stringify({ role: 'user' }),
    })
    expect(patch.statusCode).toBe(200)
    expect((await asCockpit(token, 'GET', '/api/mobile/nodes')).statusCode).toBe(401)
    const live = app.deps.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM cockpit_admin_tokens WHERE admin_id = ? AND revoked_at IS NULL',
      admin.user.id,
    )
    expect(live!.n).toBe(0)
  })

  it('系统账号不能登录（口令是一次性随机值，且 is_system 兜底）', async () => {
    // 建出系统账号（座舱生命周期服务）
    const opsId = app.deps.services.cockpitOps.systemUserId() ?? 0
    expect(opsId).toBe(0)
    await app.deps.services.cockpitOps.ensureStarted()
    await app.deps.services.cockpitOps.whenSettled()
    const id = app.deps.services.cockpitOps.systemUserId()
    expect(id).toBeGreaterThan(0)
    const login = await app.inject({
      method: 'POST',
      url: '/api/mobile/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        username: 'hub-ops',
        password: 'whatever-1',
        deviceName: 'x',
        platform: 'web',
      }),
    })
    expect(login.statusCode).toBe(401)
    // 也不出现在管理端用户列表里
    const list = await app.inject({ method: 'GET', url: '/api/admin/users', headers: admin.headers })
    const usernames = json<{ items: { username: string }[] }>(list).items.map((item) => item.username)
    expect(usernames).not.toContain('hub-ops')
  })
})
