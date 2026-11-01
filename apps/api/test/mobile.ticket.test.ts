import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MOBILE_TICKET_TTL_MS, type MobileTicketResponse } from '@dsh-hub/shared'
import { createTestApp, createUser, json, loginAs, type TestApp, type TestUser } from './helpers.js'
import { bearerHeaders, mobileSession, MOBILE_APP_ORIGIN } from './helpers-mobile.js'

/**
 * 一次性通道 ticket 与「设备吊销后关通道」（WP40a / v2 §3、M4 §16）。
 *
 * 这里用**真 socket**：ticket 的唯一用途就是 WebSocket 升级，`fastify.inject` 覆盖不到。
 */

let test: TestApp
let port = 0
const sockets: WebSocket[] = []

const CAPS = {
  sessions: true,
  history: true,
  send: true,
  stop: true,
  stream: true,
  questions: true,
  approvals: false,
  create: true,
}

function deviceRow(userId: number, deviceId: string, name = '我的 Windows'): void {
  const now = test.clock.nowIso()
  test.app.deps.db.run(
    `INSERT INTO desktop_devices (device_id, user_id, install_key, name, platform, os_major, arch,
       app_version, app_channel, runtime_version, capabilities_json, status,
       registered_at, first_seen_at, last_auth_at, last_report_at, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'win32', '11', 'x64', '0.9.3', 'latest', '0.2.1', NULL, 'active', ?, ?, ?, ?, ?, ?)`,
    deviceId,
    userId,
    name,
    now,
    now,
    now,
    now,
    now,
    now,
  )
}

function tokenRow(userId: number, deviceId: string, plain: string): void {
  const id = createHash('sha256').update(plain).digest('hex')
  const now = test.clock.nowIso()
  test.app.deps.db.run(
    `INSERT INTO desktop_device_tokens (id, device_id, user_id, created_at, last_used_at, expires_at,
       ip, user_agent, app_version) VALUES (?, ?, ?, ?, ?, ?, NULL, 'vitest', '0.9.3')`,
    id,
    deviceId,
    userId,
    now,
    now,
    new Date(Date.now() + 86_400_000).toISOString(),
  )
}

/** 连一条桌面中继并 hello（让该节点 connectable） */
async function connectRelay(token: string, deviceId: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/api/desktop/relay`, {
    headers: { authorization: `Bearer ${token}` },
  })
  sockets.push(socket)
  await once(socket, 'open')
  socket.send(
    JSON.stringify({ v: 1, type: 'hello', deviceId, hostStatus: 'running', capabilities: CAPS, clientVersion: '0.9.3' }),
  )
  await delay(50)
  return socket
}

/** 桌面中继的 hello 回帧（让手机通道真的走完 hello/hello 往返） */
function relayEcho(relay: WebSocket, deviceId: string): void {
  relay.on('message', (data: Buffer) => {
    const envelope = JSON.parse(data.toString()) as Record<string, unknown>
    if (envelope['type'] !== 'frame') return
    const payload = envelope['payload'] as { type?: string; requestId?: string }
    if (payload.type !== 'hello') return
    relay.send(
      JSON.stringify({
        v: 1,
        type: 'frame',
        channelId: envelope['channelId'],
        payload: {
          v: 1,
          type: 'hello',
          requestId: payload.requestId,
          node: { id: deviceId, kind: 'desktop', name: '我的 Windows', status: 'host-running' },
          capabilities: CAPS,
          subscribed: [],
          serverTime: Date.now(),
        },
      }),
    )
  })
}

interface OpenedChannel {
  socket: WebSocket | null
  status: number
  /** 从建连那一刻就开始收集的服务端帧（避免错过 open 后立刻到达的 error/bye） */
  frames: Array<Record<string, unknown>>
}

/** 用 ticket（或 cookie）打开手机通道；被拒时 `socket=null` 且给出 HTTP 状态码 */
async function openChannel(
  nodeId: string,
  query: string,
  headers: Record<string, string> = {},
): Promise<OpenedChannel> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/api/mobile/nodes/${nodeId}/channel?${query}`, { headers })
  sockets.push(socket)
  const frames: Array<Record<string, unknown>> = []
  socket.on('message', (data: Buffer) => {
    try {
      frames.push(JSON.parse(data.toString()) as Record<string, unknown>)
    } catch {
      // 只收 JSON 帧
    }
  })
  const outcome = await Promise.race([
    once(socket, 'open').then(() => 'open' as const),
    once(socket, 'unexpected-response').then(([, response]) => (response as { statusCode: number }).statusCode),
  ])
  return outcome === 'open' ? { socket, status: 101, frames } : { socket: null, status: outcome, frames }
}

async function issueTicket(
  user: Pick<TestUser, 'username' | 'password'>,
  nodeId: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: MobileTicketResponse & { error?: { code: string } } }> {
  const session = headers === undefined ? (await mobileSession(test.app, user)).headers : headers
  const res = await test.app.inject({
    method: 'POST',
    url: `/api/mobile/nodes/${encodeURIComponent(nodeId)}/ticket`,
    headers: session,
  })
  return { status: res.statusCode, body: json(res) }
}

beforeAll(async () => {
  // 会话复查调到很远：本文件要证明「吊销 → 立刻关」靠的是事件而不是 20 秒轮询
  process.env['HUB_MOBILE_SESSION_RECHECK_MS'] = '600000'
  test = await createTestApp()
  await new Promise<void>((resolve) => test.app.server.listen(0, '127.0.0.1', resolve))
  const address = test.app.server.address()
  port = typeof address === 'object' && address !== null ? address.port : 0
})

afterAll(async () => {
  for (const socket of sockets) socket.terminate()
  await test.close()
  delete process.env['HUB_MOBILE_SESSION_RECHECK_MS']
})

describe('POST /api/mobile/nodes/:id/ticket', () => {
  it('Bearer 申请 cloud:self 的票：30 秒有效，一次性', async () => {
    const user = await createUser(test.app, { username: 'ticket-one', password: 'Pass-pass-1' })
    const { headers } = await mobileSession(test.app, user)
    const issued = await issueTicket(user, 'cloud:self', headers)
    expect(issued.status, JSON.stringify(issued.body)).toBe(200)
    expect(issued.body.ticket.length).toBeGreaterThan(20)
    const ttl = Date.parse(issued.body.expiresAt) - test.clock.now().getTime()
    expect(ttl).toBe(MOBILE_TICKET_TTL_MS)

    // 实例没跑：WS 能升级（票有效），但马上收到 node-not-connectable + bye
    const opened = await openChannel('cloud:self', `ticket=${issued.body.ticket}`, { origin: MOBILE_APP_ORIGIN })
    expect(opened.socket).not.toBeNull()
    await delay(150)
    expect(
      opened.frames.some((frame) => frame['type'] === 'error' && frame['code'] === 'node-not-connectable'),
    ).toBe(true)
    expect(opened.frames.some((frame) => frame['type'] === 'bye')).toBe(true)

    // 同一张票第二次用 → 401（已消费）
    const reused = await openChannel('cloud:self', `ticket=${issued.body.ticket}`, { origin: MOBILE_APP_ORIGIN })
    expect(reused.socket).toBeNull()
    expect(reused.status).toBe(401)
  })

  it('过期的票 → 401', async () => {
    const user = await createUser(test.app, { username: 'ticket-exp', password: 'Pass-pass-1' })
    const { headers } = await mobileSession(test.app, user)
    const issued = await issueTicket(user, 'cloud:self', headers)
    test.clock.advance(MOBILE_TICKET_TTL_MS + 1_000)
    const opened = await openChannel('cloud:self', `ticket=${issued.body.ticket}`, { origin: MOBILE_APP_ORIGIN })
    expect(opened.socket).toBeNull()
    expect(opened.status).toBe(401)
  })

  it('票绑定的节点与 URL 不一致 → 403，且票已作废', async () => {
    const user = await createUser(test.app, { username: 'ticket-node', password: 'Pass-pass-1' })
    const { headers } = await mobileSession(test.app, user)
    const issued = await issueTicket(user, 'cloud:self', headers)
    const wrong = await openChannel('dv_00000000000000000000000000000001', `ticket=${issued.body.ticket}`, {
      origin: MOBILE_APP_ORIGIN,
    })
    expect(wrong.socket).toBeNull()
    expect(wrong.status).toBe(403)
    // 票已被消费：拿回正确的节点也用不了
    const after = await openChannel('cloud:self', `ticket=${issued.body.ticket}`, { origin: MOBILE_APP_ORIGIN })
    expect(after.socket).toBeNull()
    expect(after.status).toBe(401)
  })

  it('签发时就绑定了设备：设备随后被吊销 → 403 DEVICE_REVOKED', async () => {
    const user = await createUser(test.app, { username: 'ticket-dev', password: 'Pass-pass-1' })
    const { headers, tokens } = await mobileSession(test.app, user)
    const issued = await issueTicket(user, 'cloud:self', headers)
    // 网页端吊销这台手机
    const web = loginAs(test.app, user)
    const revoke = await test.app.inject({
      method: 'DELETE',
      url: `/api/me/desktop-devices/${tokens.deviceId}`,
      headers: web.headers,
    })
    expect(revoke.statusCode).toBe(204)
    const opened = await openChannel('cloud:self', `ticket=${issued.body.ticket}`, { origin: MOBILE_APP_ORIGIN })
    expect(opened.socket).toBeNull()
    expect(opened.status).toBe(403)
  })

  it('手机自己的设备 id 不是节点 → 404（手机不是后端）', async () => {
    const user = await createUser(test.app, { username: 'ticket-self', password: 'Pass-pass-1' })
    const { headers, tokens } = await mobileSession(test.app, user)
    const res = await issueTicket(user, tokens.deviceId, headers)
    expect(res.status).toBe(404)
    expect(res.body.error?.code).toBe('NOT_FOUND')
  })

  it('别人的节点 → 404（不做归属探测）', async () => {
    const owner = await createUser(test.app, { username: 'ticket-owner', password: 'Pass-pass-1' })
    const other = await createUser(test.app, { username: 'ticket-other', password: 'Pass-pass-1' })
    const deviceId = `dv_${randomBytes(16).toString('hex')}`
    deviceRow(owner.id, deviceId)
    const { headers } = await mobileSession(test.app, other)
    const res = await issueTicket(other, deviceId, headers)
    expect(res.status).toBe(404)
    expect(res.body.error?.code).toBe('NOT_FOUND')
  })

  it('没有令牌 → 401', async () => {
    const res = await test.app.inject({ method: 'POST', url: '/api/mobile/nodes/cloud:self/ticket' })
    expect(res.statusCode).toBe(401)
  })
})

describe('通道 ?ticket= 升级与吊销关闭', () => {
  it('ticket 通道打通：手机 hello 经真中继往返', async () => {
    const user = await createUser(test.app, { username: 'chan-ticket', password: 'Pass-pass-1' })
    const { headers } = await mobileSession(test.app, user)
    const deviceId = `dv_${randomBytes(16).toString('hex')}`
    deviceRow(user.id, deviceId)
    const desktopToken = `dsh_dev_${'d'.repeat(40)}`
    tokenRow(user.id, deviceId, desktopToken)
    const relay = await connectRelay(desktopToken, deviceId)
    relayEcho(relay, deviceId)

    const issued = await issueTicket(user, deviceId, headers)
    expect(issued.status).toBe(200)
    const opened = await openChannel(deviceId, `ticket=${issued.body.ticket}`, { origin: MOBILE_APP_ORIGIN })
    expect(opened.socket).not.toBeNull()
    opened.socket!.send(
      JSON.stringify({ v: 1, type: 'hello', requestId: 'h1', client: { name: 'app', version: '2.0.0' } }),
    )
    await delay(150)
    expect(opened.frames.some((frame) => frame['type'] === 'hello' && frame['requestId'] === 'h1')).toBe(true)
  })

  it('设备被网页端吊销 → 已建立的通道立刻 bye(session-expired) 并断开（不等 20 秒复查）', async () => {
    const user = await createUser(test.app, { username: 'chan-revoke', password: 'Pass-pass-1' })
    const { headers, tokens } = await mobileSession(test.app, user)
    const nodeId = `dv_${randomBytes(16).toString('hex')}`
    deviceRow(user.id, nodeId)
    const desktopToken = `dsh_dev_${'e'.repeat(40)}`
    tokenRow(user.id, nodeId, desktopToken)
    relayEcho(await connectRelay(desktopToken, nodeId), nodeId)

    const issued = await issueTicket(user, nodeId, headers)
    const opened = await openChannel(nodeId, `ticket=${issued.body.ticket}`, { origin: MOBILE_APP_ORIGIN })
    expect(opened.socket).not.toBeNull()
    const phone = opened.socket!
    const closed = once(phone, 'close')
    phone.send(JSON.stringify({ v: 1, type: 'hello', requestId: 'h1', client: { name: 'app', version: '2.0.0' } }))
    await delay(80)

    // 网页端吊销这台手机（设备 A）——不是通道所在的节点
    const web = loginAs(test.app, user)
    const revoke = await test.app.inject({
      method: 'DELETE',
      url: `/api/me/desktop-devices/${tokens.deviceId}`,
      headers: web.headers,
    })
    expect(revoke.statusCode).toBe(204)

    // 会话复查是 10 分钟，所以这里只能靠吊销事件：1 秒内必须断
    await Promise.race([
      closed,
      delay(1_000).then(() => {
        throw new Error(`通道没被关闭：${JSON.stringify({ readyState: phone.readyState, frames: opened.frames })}`)
      }),
    ])
    expect(JSON.stringify(opened.frames)).toContain('session-expired')
  })

  it('旧 cookie 方式开通道仍然可用（0.2.0 回归）', async () => {
    const user = await createUser(test.app, { username: 'chan-cookie', password: 'Pass-pass-1' })
    const nodeId = `dv_${randomBytes(16).toString('hex')}`
    deviceRow(user.id, nodeId)
    const desktopToken = `dsh_dev_${'f'.repeat(40)}`
    tokenRow(user.id, nodeId, desktopToken)
    relayEcho(await connectRelay(desktopToken, nodeId), nodeId)
    const session = loginAs(test.app, user)
    const opened = await openChannel(nodeId, '', { cookie: session.cookie })
    expect(opened.socket).not.toBeNull()
    opened.socket!.send(JSON.stringify({ v: 1, type: 'hello', requestId: 'c1', client: { name: 'm1', version: '0' } }))
    await delay(150)
    expect(opened.frames.some((frame) => frame['type'] === 'hello')).toBe(true)
  })

  it('ticket 通道的 Origin 放行 App 来源，拒绝站外来源', async () => {
    const user = await createUser(test.app, { username: 'chan-origin', password: 'Pass-pass-1' })
    const { headers } = await mobileSession(test.app, user)
    const first = await issueTicket(user, 'cloud:self', headers)
    const blocked = await openChannel('cloud:self', `ticket=${first.body.ticket}`, { origin: 'https://evil.example' })
    expect(blocked.socket).toBeNull()
    expect(blocked.status).toBe(403)

    const second = await issueTicket(user, 'cloud:self', headers)
    const allowed = await openChannel('cloud:self', `ticket=${second.body.ticket}`, { origin: MOBILE_APP_ORIGIN })
    expect(allowed.socket).not.toBeNull()
    // Bearer 头不是 ticket 通道的凭据（浏览器 WS 也带不了）：没有 ticket 时即使带 Bearer 也 401
    const viaHeader = await openChannel('cloud:self', '', bearerHeaders(headers['authorization']!.slice(7)))
    expect(viaHeader.socket).toBeNull()
    expect(viaHeader.status).toBe(401)
  })
})
