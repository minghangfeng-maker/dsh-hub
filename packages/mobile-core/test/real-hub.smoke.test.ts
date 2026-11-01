/**
 * 真实 HTTP 冒烟（WP40a 的 Hub，FakeDriver 配置）。
 *
 * 只有显式给出环境变量时才跑，默认跳过 —— 仓库里不放账号/密码：
 *   HUB_SMOKE_ORIGIN=http://127.0.0.1:5246 \
 *   HUB_SMOKE_USER=smoke HUB_SMOKE_PASS=*** \
 *   NODE_ENV=development npx vitest run test/real-hub.smoke.test.ts
 *
 * 覆盖：login → bootstrap → wake(404) → ticket → refresh（旧 refresh 宽限期）→ logout，
 * 以及「DEVICE_REVOKED 不清刷新、直接回登录页」的 401 分支。
 */

import { describe, expect, it } from 'vitest'
import { HubClient } from '../src/http/hub-client.js'
import { MemoryTokenStore } from '../src/auth/token-store.js'
import { HubApiError } from '../src/errors.js'
import type { AuthTokens } from '../src/contracts/auth-bootstrap.js'

const ORIGIN = process.env.HUB_SMOKE_ORIGIN
const USER = process.env.HUB_SMOKE_USER
const PASS = process.env.HUB_SMOKE_PASS
const enabled = Boolean(ORIGIN && USER && PASS)

describe.runIf(enabled)('真实 Hub 冒烟（WP40a）', () => {
  it('login → bootstrap → wake → ticket → refresh → logout', async () => {
    const store = new MemoryTokenStore()
    const client = new HubClient({
      origin: ORIGIN!,
      tokenStore: store,
      clientName: 'dsh-hub-app-smoke',
      clientVersion: '0.1.0-dev',
    })

    const tokens = await client.login({
      username: USER!,
      password: PASS!,
      deviceName: 'A1 smoke',
      platform: 'android',
    })
    expect(tokens.accessToken).toMatch(/^dshm_at_/)
    expect(tokens.refreshToken).toMatch(/^dshm_rt_/)
    expect(tokens.deviceId).toMatch(/^dv_[0-9a-f]{32}$/)

    const boot = await client.bootstrap()
    expect(boot.user.username).toBe(USER)
    expect(typeof boot.points.balance).toBe('number')
    expect(Array.isArray(boot.backends)).toBe(true)
    const cloud = boot.backends.find((b) => b.id === 'cloud:self')
    expect(cloud).toBeTruthy()
    // 手机自己的设备不在 backends 里（WP40a 修复项）
    expect(boot.backends.some((b) => b.id === tokens.deviceId)).toBe(false)

    // FakeDriver 下实例 absent → wake 404 INSTANCE_ABSENT（中文提示由客户端映射）
    if (boot.instance.status === 'absent') {
      const error = await client.wake().catch((e) => e)
      expect(error).toBeInstanceOf(HubApiError)
      expect(error.code).toBe('INSTANCE_ABSENT')
    }

    // ticket 不要求 connectable=true：绑定用户 + 节点即可（通道真正握手时才探测）
    const ticket = await client.requestTicket('cloud:self')
    expect(ticket.ticket.length).toBeGreaterThanOrEqual(16)

    // refresh：轮换一对新令牌
    const before = await store.load()
    const refreshed = await client.refreshTokens()
    expect(refreshed).not.toBeNull()
    expect(refreshed!.accessToken).not.toBe(before!.accessToken)
    expect(refreshed!.refreshToken).not.toBe(before!.refreshToken)

    // 旧 refresh 在 10 秒宽限期内 → 401 DEVICE_TOKEN_INVALID（不是 DEVICE_REVOKED）
    const grace = await fetch(`${ORIGIN}/api/mobile/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://localhost' },
      body: JSON.stringify({ refreshToken: before!.refreshToken }),
    })
    expect(grace.status).toBe(401)
    const body = (await grace.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('DEVICE_TOKEN_INVALID')

    const oldAccess = before!.accessToken
    await client.logout()
    expect(await store.load()).toBeNull()

    // logout 吊销本设备：旧 access 立刻 DEVICE_REVOKED
    const revoked = await fetch(`${ORIGIN}/api/mobile/bootstrap`, {
      headers: { authorization: `Bearer ${oldAccess}`, origin: 'https://localhost' },
    })
    expect(revoked.status).toBe(401)
    const revokedBody = (await revoked.json()) as { error?: { code?: string } }
    expect(revokedBody.error?.code).toBe('DEVICE_REVOKED')
  })

  it('401 DEVICE_REVOKED 不走 refresh，直接清令牌', async () => {
    // 拿一对令牌，然后 logout 吊销，再用同一个 client 发请求
    const store = new MemoryTokenStore()
    const client = new HubClient({
      origin: ORIGIN!,
      tokenStore: store,
      clientName: 'dsh-hub-app-smoke',
      clientVersion: '0.1.0-dev',
    })
    await client.login({
      username: USER!,
      password: PASS!,
      deviceName: 'A1 smoke',
      platform: 'android',
    })
    const tokens = (await store.load()) as AuthTokens
    await client.logout()
    // 重新塞回旧令牌，模拟「服务端已吊销、客户端还拿着」
    await store.save(tokens)
    const error = await client.bootstrap().catch((e) => e)
    expect(error.code).toBe('DEVICE_REVOKED')
    expect(await store.load()).toBeNull()
  })
})
