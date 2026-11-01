import { beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp, createUser, json, type TestApp } from './helpers.js'
import { adminSession } from './wp1-helpers.js'
import { MOBILE_COCKPIT_NODE_ID } from '@dsh-hub/shared'

/**
 * WP56e2：**显式设备令牌优先于 cookie**（座舱嵌入页的同源坑）。
 *
 * 背景（J11 端到端抓到的真问题）：`/m/?embed=cockpit` 与 `/admin` 是**同源** iframe（docs/24 §6），
 * 浏览器会把管理员的 `hub_sid` 一起带上。原来的会话钩子是「有 cookie 就只看 cookie」，
 * 于是 App 会用**管理员身份**拿到普通 bootstrap（`backends=[cloud:self]`，实例 absent），
 * 座舱通道永远连不上 —— 界面上表现为「输入框能打字、发出去永远在排队」。
 *
 * 现在：请求里明确带了 `Authorization: Bearer dshm_at_…` 就按设备令牌解析（scope 生效），
 * 没带才回落到 cookie 会话。
 */

let ctx: TestApp
let app: FastifyInstance
let admin: Awaited<ReturnType<typeof adminSession>>
const codes = new Map<string, number>()

beforeEach(async () => {
  ctx = await createTestApp()
  app = ctx.app
  admin = await adminSession(app, 'wp56e2-admin')
  codes.clear()
  // 交接码的签发/存表归 WP56a；这里接一个同形的假实现（与 wp56b 的测试同一手法）
  ;(app.deps.services as unknown as Record<string, unknown>)['cockpit'] = {
    consumeHandoff(code: string): number | null {
      const adminId = codes.get(code)
      if (adminId === undefined) return null
      codes.delete(code)
      return adminId
    },
  }
})

async function cockpitToken(): Promise<string> {
  const code = 'wp56e2-handoff-code'
  codes.set(code, admin.user.id)
  const res = await app.inject({
    method: 'POST',
    url: '/api/mobile/auth/cockpit-exchange',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ code }),
  })
  expect(res.statusCode).toBe(200)
  return json<{ accessToken: string }>(res).accessToken
}

describe('同源 iframe 里 cookie 与座舱令牌同时在', () => {
  it('bootstrap 以座舱令牌为准（backends 只有 cloud:ops），不被管理员 cookie 盖掉', async () => {
    const token = await cockpitToken()
    const res = await app.inject({
      method: 'GET',
      url: '/api/mobile/bootstrap',
      headers: { ...admin.headers, authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = json<{ backends: { id: string }[]; instance: { status: string } }>(res)
    expect(body.backends.map((item) => item.id)).toEqual([MOBILE_COCKPIT_NODE_ID])
  })

  it('/api/mobile/nodes 同样只看座舱令牌', async () => {
    const token = await cockpitToken()
    const res = await app.inject({
      method: 'GET',
      url: '/api/mobile/nodes',
      headers: { ...admin.headers, authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = json<{ items: { id: string }[] }>(res)
    expect(body.items.map((item) => item.id)).toEqual([MOBILE_COCKPIT_NODE_ID])
  })

  it('不带 Bearer 时仍然按 cookie 走（管理员的普通 bootstrap 不受影响）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/mobile/bootstrap', headers: admin.headers })
    expect(res.statusCode).toBe(200)
    const body = json<{ backends: { id: string }[] }>(res)
    expect(body.backends.map((item) => item.id)).toContain('cloud:self')
  })

  it('带的是失效的设备令牌时明确 401，不会静默退回 cookie 身份', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/mobile/bootstrap',
      headers: { ...admin.headers, authorization: 'Bearer dshm_at_not_a_real_token' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('手机令牌仍然只能打 /api/mobile/*（带 cookie 也一样）', async () => {
    const token = await cockpitToken()
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/overview',
      headers: { ...admin.headers, authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })
})

void createUser
