import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket, WebSocketServer } from 'ws'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createNodeRemote, type NodeRemote } from '@dsh-hub/dsh-node-remote'
import type { MobileClientFrame } from '@dsh-hub/shared'
import { createTestApp, createUser, loginAs, type TestApp } from './helpers.js'

/** 全链：真 Hub 通道/中继 + 真 adapter(default transport) + 真手机 WS；Host 用最小真实 HTTP/WS 替身。 */

let test: TestApp
let hubPort = 0
let hostServer: Server
let hostOrigin = ''
let wss: WebSocketServer
const sockets: WebSocket[] = []

function fakeHost(): void {
  hostServer = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const endpoint = (req.url ?? '').replace('/api/', '')
      const send = (value: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: 'r', result: { ok: true, value } }))
      }
      if (body.includes('__dsh_hub_probe')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: 'r', result: { ok: false, error: { code: 'gateway/arguments-invalid', message: 'probe' } } }))
        return
      }
      if (endpoint === 'session/list') return send({ items: [] })
      if (endpoint === 'session/create') return send({ sessionId: 's_full' })
      if (endpoint === 'workspace/initializeDefault') return send({ workspace: { workspaceId: 'w1' } })
      if (endpoint === 'session/prompt') return send({ accepted: true })
      if (endpoint === 'session/page') {
        return send({
          hasMore: false,
          records: [{
            type: 'event',
            event: { type: 'user/message', seq: 9, time: 1, data: { content: [{ type: 'text', text: '真实用户正文' }], source: { kind: 'user', rpcId: 'm_full_1' } } },
          }],
        })
      }
      if (endpoint === '$events/result') return send(undefined)
      if (endpoint === 'userQuestions/answer') return send(true)
      res.writeHead(404)
      res.end()
    })
  })
  wss = new WebSocketServer({ server: hostServer, path: '/api/remote.mux' })
  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      if (frame['type'] !== 'open') return
      const id = frame['streamId']
      const payload = JSON.stringify(frame['payload'] ?? {})
      if (payload.includes('__dsh_hub_probe')) {
        socket.send(JSON.stringify({ type: 'error', streamId: id, error: { code: 'gateway/arguments-invalid', message: 'p' } }))
        return
      }
      if (frame['endpoint'] === '$events') {
        socket.send(JSON.stringify({ type: 'item', streamId: id, value: { type: 'ready', clientId: 'c1', host: { home: '/h' } } }))
        return
      }
      if (frame['endpoint'] === 'session/follow') {
        socket.send(JSON.stringify({ type: 'item', streamId: id, value: { type: 'snapshot', cursor: 9, records: [], hasMore: false, projections: { values: {} }, header: {} } }))
        return
      }
      if (frame['endpoint'] === 'session/control') {
        socket.send(JSON.stringify({ type: 'item', streamId: id, value: { type: 'baseline', value: { projections: {} } } }))
      }
    })
  })
}

describe('全链：Hub 通道/中继 ↔ adapter ↔ 手机 WS', () => {
  beforeAll(async () => {
    fakeHost()
    await new Promise<void>((resolve) => hostServer.listen(0, '127.0.0.1', resolve))
    const address = hostServer.address()
    hostOrigin = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
    test = await createTestApp()
    await new Promise<void>((resolve) => test.app.server.listen(0, '127.0.0.1', resolve))
    const bound = test.app.server.address()
    hubPort = typeof bound === 'object' && bound !== null ? bound.port : 0
  })
  afterAll(async () => {
    for (const socket of sockets) socket.terminate()
    await test.close()
    wss.close()
    hostServer.close()
  })

  it('手机 hello/list/create/send 经真中继与真 adapter 全链往返', async () => {
    const user = await createUser(test.app)
    const deviceId = `dv_${randomBytes(16).toString('hex')}`
    const now = test.clock.nowIso()
    test.app.deps.db.run(
      `INSERT INTO desktop_devices (device_id, user_id, install_key, name, platform, os_major, arch,
         app_version, app_channel, runtime_version, capabilities_json, status,
         registered_at, first_seen_at, last_auth_at, last_report_at, created_at, updated_at)
       VALUES (?, ?, NULL, 'Windows', 'win32', '11', 'x64', '0.9.3', 'latest', '0.2.1', NULL, 'active', ?, ?, ?, ?, ?, ?)`,
      deviceId, user.id, now, now, now, now, now, now,
    )
    const token = `dsh_dev_${'a'.repeat(40)}`
    test.app.deps.db.run(
      `INSERT INTO desktop_device_tokens (id, device_id, user_id, created_at, last_used_at, expires_at, ip, user_agent, app_version)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'vitest', '0.9.3')`,
      createHash('sha256').update(token).digest('hex'), deviceId, user.id, now, now, new Date(Date.now() + 86_400_000).toISOString(),
    )

    // 桌面侧：真中继客户端 + 真 adapter(default HTTP/mux)
    const adapters = new Map<string, NodeRemote>()
    const relay = new WebSocket(`ws://127.0.0.1:${String(hubPort)}/api/desktop/relay`, { headers: { authorization: `Bearer ${token}` } })
    sockets.push(relay)
    await once(relay, 'open')
    relay.send(JSON.stringify({ v: 1, type: 'hello', deviceId, hostStatus: 'running', capabilities: { sessions: true, history: true, send: true, stop: true, stream: true, questions: true, approvals: true, create: true }, clientVersion: '0.9.3' }))
    relay.on('message', (data) => {
      const envelope = JSON.parse(data.toString()) as Record<string, unknown>
      if (envelope['type'] !== 'frame') return
      const channelId = String(envelope['channelId'])
      const payload = envelope['payload'] as MobileClientFrame
      void (async () => {
        let adapter = adapters.get(channelId)
        if (adapter === undefined) {
          adapter = await createNodeRemote({ origin: hostOrigin, node: { id: deviceId, kind: 'desktop', name: 'Windows', status: 'host-running' } })
          adapters.set(channelId, adapter)
        }
        await adapter.dispatch(payload, (out) => {
          relay.send(JSON.stringify({ v: 1, type: 'frame', channelId, payload: out }))
        })
      })()
    })
    // 等 Hub 登记好中继（CI 的 2 核机器上 80ms 不够）
    await delay(300)

    // 手机侧：真 WS 通道
    const session = loginAs(test.app, user)
    const mobile = new WebSocket(`ws://127.0.0.1:${String(hubPort)}/api/mobile/nodes/${deviceId}/channel`, { headers: { cookie: session.cookie } })
    sockets.push(mobile)
    await once(mobile, 'open')
    const frames: Array<Record<string, unknown>> = []
    mobile.on('message', (data) => frames.push(JSON.parse(data.toString()) as Record<string, unknown>))
    const send = (frame: unknown): void => mobile.send(JSON.stringify(frame))
    send({ v: 1, type: 'hello', requestId: 'h', client: { name: 'm1', version: '0' } })
    await vi.waitFor(() => expect(frames.some((f) => f['type'] === 'hello')).toBe(true), { timeout: 3000, interval: 20 })

    send({ v: 1, type: 'sessions', requestId: 'l' })
    await vi.waitFor(() => expect(frames.some((f) => f['type'] === 'sessions')).toBe(true), { timeout: 3000, interval: 20 })

    send({ v: 1, type: 'create', requestId: 'c' })
    await vi.waitFor(() => expect(frames.find((f) => f['type'] === 'created')?.['sessionId']).toBe('s_full'), { timeout: 3000, interval: 20 })

    send({ v: 1, type: 'send', requestId: 'p', sessionId: 's_full', text: 'hi', clientMessageId: 'm_full_1' })
    await vi.waitFor(
      () => expect(frames.some((f) => f['type'] === 'ack' && f['clientMessageId'] === 'm_full_1')).toBe(true),
      { timeout: 3000, interval: 20 },
    )

    // 断线回收：手机断开后 Hub 通道被清理，adapter 关闭
    mobile.close()
    await delay(120)
    for (const adapter of adapters.values()) await adapter.close()
  })
})

