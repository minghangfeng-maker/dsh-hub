import { describe, expect, it, vi } from 'vitest'
import type { MobileClientFrame, MobileServerFrame, NodeCapabilities, NodeRemote } from '@dsh-hub/dsh-node-remote'
import type { WsConnection } from '../../lib/ws-upgrade.js'
import { IdempotencyStore, MobileChannel } from './channel.js'
import type { ChannelNode, RelayConnection } from './types.js'

class FakeWs implements WsConnection {
  readonly sent: string[] = []
  closed = false
  lastActivityAt = Date.now()
  remoteAddress = '127.0.0.1'
  private textListeners: Array<(text: string) => void> = []
  private closeListeners: Array<(code: number, reason: string) => void> = []

  send(text: string): void {
    this.sent.push(text)
  }
  ping(): void {}
  close(code = 1000, reason = ''): void {
    if (this.closed) return
    this.closed = true
    for (const listener of this.closeListeners) listener(code, reason)
  }
  onText(listener: (text: string) => void): void {
    this.textListeners.push(listener)
  }
  onClose(listener: (code: number, reason: string) => void): void {
    this.closeListeners.push(listener)
  }
  receive(frame: unknown): void {
    const text = typeof frame === 'string' ? frame : JSON.stringify(frame)
    for (const listener of this.textListeners) listener(text)
  }
  frames(): MobileServerFrame[] {
    return this.sent.map((text) => JSON.parse(text) as MobileServerFrame)
  }
}

const CAPS: NodeCapabilities = {
  sessions: true,
  history: true,
  send: true,
  stop: true,
  stream: true,
  questions: true,
  approvals: false,
  create: true,
}

function fakeRemote(onDispatch?: (frame: MobileClientFrame) => void): NodeRemote & { calls: MobileClientFrame[] } {
  const calls: MobileClientFrame[] = []
  return {
    calls,
    capabilities: CAPS,
    compatible: true,
    missing: [],
    node: { id: 'cloud:self', kind: 'cloud', name: '云实例', status: 'running' },
    async dispatch(frame, sink) {
      calls.push(frame)
      onDispatch?.(frame)
      if (frame.type === 'hello') {
        // 回显客户端声明的 v2 特性（真实 adapter 也会回显实际启用的集合）
        await sink({
          v: 1,
          type: 'hello',
          requestId: frame.requestId,
          node: this.node,
          capabilities: CAPS,
          subscribed: [],
          serverTime: 1,
          features: frame.features ?? [],
        })
      } else if (frame.type === 'send') {
        await sink({ v: 1, type: 'ack', requestId: frame.requestId, clientMessageId: frame.clientMessageId })
      } else if (frame.type === 'ping') {
        await sink({ v: 1, type: 'pong', t: frame.t })
      }
    },
    async close() {},
  }
}

function channelWith(ws: FakeWs, node: ChannelNode, validate: () => { id: number } | null = () => ({ id: 1 })) {
  return new MobileChannel(
    ws,
    { userId: 1, nodeId: 'cloud:self', node, validateSession: validate, audit: () => undefined },
    new IdempotencyStore(),
    () => undefined,
    () => undefined,
  )
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('MobileChannel 帧纪律', () => {
  it('第一帧必须是 hello', async () => {
    const ws = new FakeWs()
    const remote = fakeRemote()
    const channel = channelWith(ws, { kind: 'cloud', remote })
    await channel.start()
    ws.receive({ v: 1, type: 'sessions', requestId: 'r1' })
    await tick()
    expect(ws.frames()[0]).toMatchObject({ type: 'error', code: 'unauthenticated' })
    expect(remote.calls).toHaveLength(0)
  })

  it('版本不符给 protocol-version-unsupported', async () => {
    const ws = new FakeWs()
    const channel = channelWith(ws, { kind: 'cloud', remote: fakeRemote() })
    await channel.start()
    ws.receive({ v: 2, type: 'hello', requestId: 'r1', client: { name: 'x', version: '1' } })
    await tick()
    expect(ws.frames()[0]).toMatchObject({ type: 'error', code: 'protocol-version-unsupported' })
  })

  it('未知字段被 strictObject 拒绝', async () => {
    const ws = new FakeWs()
    const channel = channelWith(ws, { kind: 'cloud', remote: fakeRemote() })
    await channel.start()
    ws.receive({ v: 1, type: 'hello', requestId: 'r1', client: { name: 'x', version: '1' }, extra: true })
    await tick()
    expect(ws.frames()[0]).toMatchObject({ type: 'error' })
  })

  it('send 幂等：同一 clientMessageId 只下发一次', async () => {
    const ws = new FakeWs()
    const remote = fakeRemote()
    const channel = channelWith(ws, { kind: 'cloud', remote })
    await channel.start()
    ws.receive({ v: 1, type: 'hello', requestId: 'r1', client: { name: 'x', version: '1' } })
    await tick()
    const send = { v: 1, type: 'send', requestId: 'r2', sessionId: 's_1', text: '你好', clientMessageId: 'm1' }
    ws.receive(send)
    await tick()
    ws.receive({ ...send, requestId: 'r3' })
    await tick()
    expect(remote.calls.filter((frame) => frame.type === 'send')).toHaveLength(1)
    const acks = ws.frames().filter((frame) => frame.type === 'ack')
    expect(acks).toHaveLength(2)
    expect(acks[1]).toMatchObject({ clientMessageId: 'm1' })
  })

  it('会话过期由独立定时器发现（不依赖消息），并断开连接', async () => {
    vi.useFakeTimers()
    try {
      const ws = new FakeWs()
      let valid = true
      const channel = channelWith(ws, { kind: 'cloud', remote: fakeRemote() }, () => (valid ? { id: 1 } : null))
      await channel.start()
      ws.receive({ v: 1, type: 'hello', requestId: 'r1', client: { name: 'x', version: '1' } })
      await vi.advanceTimersByTimeAsync(1)
      valid = false
      // 期间不发任何帧：仍应在 20s 复查点断开
      await vi.advanceTimersByTimeAsync(21_000)
      expect(ws.frames().some((frame) => frame.type === 'bye' && frame.code === 'session-expired')).toBe(true)
      expect(ws.closed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('关闭顺序（M4 §16 回归）', () => {
  /**
   * 上游 `remote.close()` 卡住（容器已停 / Host 不响应 `$events/result`）时，
   * 手机这一侧**仍然**要在复查点收到 bye 并断开 —— 关闭不能依赖上游。
   */
  it('会话失效 + 上游 close 永不 resolve：bye 与 close 仍然到达', async () => {
    vi.useFakeTimers()
    try {
      const ws = new FakeWs()
      let valid = true
      const hangingRemote: NodeRemote = {
        ...fakeRemote(),
        // 永不 resolve
        close: () => new Promise<void>(() => undefined),
      }
      const channel = channelWith(ws, { kind: 'cloud', remote: hangingRemote }, () => (valid ? { id: 1 } : null))
      await channel.start()
      ws.receive({ v: 1, type: 'hello', requestId: 'r1', client: { name: 'x', version: '1' } })
      await vi.advanceTimersByTimeAsync(1)
      valid = false
      await vi.advanceTimersByTimeAsync(21_000)
      expect(ws.frames().some((frame) => frame.type === 'bye' && frame.code === 'session-expired')).toBe(true)
      expect(ws.closed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('主动 dispose 也一样：先关手机 socket，再等上游（有上限）', async () => {
    // 把上游等待上限压到 200ms，测试不用等 3 秒
    process.env['HUB_MOBILE_UPSTREAM_CLOSE_MS'] = '200'
    const ws = new FakeWs()
    const hangingRemote: NodeRemote = {
      ...fakeRemote(),
      close: () => new Promise<void>(() => undefined),
    }
    const channel = channelWith(ws, { kind: 'cloud', remote: hangingRemote })
    await channel.start()
    const started = Date.now()
    await channel.dispose('test')
    // 最多等 upstreamCloseMs()（这里注入 200ms；生产默认 3 秒）就返回，不会永远挂着
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(ws.closed).toBe(true)
    delete process.env['HUB_MOBILE_UPSTREAM_CLOSE_MS']
  })
})

describe('桌面通道', () => {
  it('帧原样转发给中继；open 推迟到第一帧（hello 通过后）', async () => {
    const ws = new FakeWs()
    const relay = makeRelay()
    const channel = channelWith(ws, { kind: 'desktop', relay })
    await channel.start()
    // WP48：桌面 connector 收到 open 才会为这条通道建 adapter，所以 Hub 不在 start
    // 就发 open —— P2 硬切拒绝老客户端时，桌面侧一个 adapter 都不会建。
    expect(relay.sent).toHaveLength(0)
    ws.receive({ v: 1, type: 'hello', requestId: 'r1', client: { name: 'x', version: '1' } })
    await tick()
    expect(relay.sent[0]).toMatchObject({ v: 1, type: 'open', nodeId: 'cloud:self' })
    expect(relay.sent[1]).toMatchObject({ v: 1, type: 'frame', payload: { type: 'hello' } })
    // 第二帧不再重复 open
    ws.receive({ v: 1, type: 'ping', t: 3 })
    await tick()
    expect(relay.sent.filter((item) => item['type'] === 'open')).toHaveLength(1)
  })

  it('中继推来的帧转给手机', async () => {
    const ws = new FakeWs()
    const channel = channelWith(ws, { kind: 'desktop', relay: makeRelay() })
    await channel.start()
    channel.deliver({ v: 1, type: 'pong', t: 5 })
    expect(ws.frames().at(-1)).toEqual({ v: 1, type: 'pong', t: 5 })
  })
})

describe('IdempotencyStore', () => {
  it('pending 阻止重发，done 重放，失败后允许重试，10 分钟过期', () => {
    const store = new IdempotencyStore()
    store.begin('s1:m1')
    expect(store.lookup('s1:m1')).toEqual({ state: 'pending' })
    store.complete('s1:m1', { v: 1, type: 'ack', requestId: 'r1', clientMessageId: 'm1' })
    expect(store.lookup('s1:m1')).toMatchObject({ state: 'done', frame: { type: 'ack' } })
    store.begin('s1:m2')
    store.fail('s1:m2')
    expect(store.lookup('s1:m2')).toBeUndefined()
    // 键含 sessionId：同名消息在不同会话里互不影响
    store.begin('s2:m1')
    expect(store.lookup('s2:m1')).toEqual({ state: 'pending' })
    const realNow = Date.now
    Date.now = () => realNow() + 601_000
    try {
      expect(store.lookup('s1:m1')).toBeUndefined()
    } finally {
      Date.now = realNow
    }
  })

  it('超过 256 条先丢最旧', () => {
    const store = new IdempotencyStore()
    for (let index = 0; index < 300; index += 1) store.begin(`s:k${String(index)}`)
    expect(store.lookup('s:k0')).toBeUndefined()
    expect(store.lookup('s:k299')).toBeDefined()
  })
})

function makeRelay(relayFeatures: RelayConnection['relayFeatures'] = null): RelayConnection & {
  sent: Array<Record<string, unknown>>
} {
  const sent: Array<Record<string, unknown>> = []
  return {
    deviceId: 'dv_0123456789abcdef0123456789abcdef',
    generation: 'gen-1',
    closed: false,
    userId: 1,
    clientVersion: '0.9.3',
    hostStatus: 'running',
    capabilities: CAPS,
    relayFeatures,
    channels: new Set<string>(),
    sent,
    send: (envelope) => {
      sent.push(envelope as unknown as Record<string, unknown>)
    },
    close: () => undefined,
  }
}

describe('R4/R5/R7 边界', () => {
  it('无关 requestId 的 error 不解锁待发消息；ack 才 done', async () => {
    const ws = new FakeWs()
    // 只回 hello、不回 ack：模拟「已下发、结果未知」
    const remote: NodeRemote = {
      capabilities: CAPS,
      compatible: true,
      missing: [],
      node: { id: 'cloud:self', kind: 'cloud', name: '云实例', status: 'running' },
      async dispatch(frame, sink) {
        if (frame.type === 'hello') {
          await sink({ v: 1, type: 'hello', requestId: frame.requestId, node: this.node, capabilities: CAPS, subscribed: [], serverTime: 1 })
        }
      },
      async close() {},
    }
    const channel = channelWith(ws, { kind: 'cloud', remote })
    await channel.start()
    ws.receive({ v: 1, type: 'hello', requestId: 'r1', client: { name: 'x', version: '1' } })
    await tick()
    ws.receive({ v: 1, type: 'send', requestId: 'req-send', sessionId: 's_1', text: 'hi', clientMessageId: 'm1' })
    await tick()
    // 另一条请求（history）的错误不得解锁 send
    channel.deliver({ v: 1, type: 'error', requestId: 'req-history', code: 'internal', message: 'x', retryable: false })
    ws.receive({ v: 1, type: 'send', requestId: 'req-send-2', sessionId: 's_1', text: 'hi', clientMessageId: 'm1' })
    await tick()
    expect(ws.frames().some((frame) => frame.type === 'error' && frame.code === 'send-in-flight')).toBe(true)
    // 正确 ack 后进入 done；再发重放 ack
    channel.deliver({ v: 1, type: 'ack', requestId: 'req-send', clientMessageId: 'm1' })
    ws.receive({ v: 1, type: 'send', requestId: 'req-send-3', sessionId: 's_1', text: 'hi', clientMessageId: 'm1' })
    await tick()
    const acks = ws.frames().filter((frame) => frame.type === 'ack')
    expect(acks.length).toBeGreaterThanOrEqual(1)
  })

  it('dispose 回收：onDispose 一次、底层 close 一次、重复 dispose 幂等', async () => {
    const ws = new FakeWs()
    let disposed = 0
    const channel = new MobileChannel(
      ws,
      { userId: 1, nodeId: 'cloud:self', node: { kind: 'cloud', remote: fakeRemote() }, validateSession: () => ({ id: 1 }), audit: () => undefined },
      new IdempotencyStore(),
      () => undefined,
      () => { disposed += 1 },
    )
    await channel.start()
    await channel.dispose('test')
    await channel.dispose('again')
    expect(disposed).toBe(1)
    expect(ws.closed).toBe(true)
  })

  it('上行超过 20 帧/秒被限速，不无限入队', async () => {
    const ws = new FakeWs()
    const channel = channelWith(ws, { kind: 'cloud', remote: fakeRemote() })
    await channel.start()
    for (let index = 0; index < 40; index += 1) {
      ws.receive({ v: 1, type: 'ping', t: index })
    }
    await tick()
    expect(ws.frames().some((frame) => frame.type === 'error' && frame.code === 'rate-limited')).toBe(true)
  })

  /**
   * 2026-11-10 真机事故回归：窗口 = 1 的分片上传在低延迟链路上会自然发到 20~30 片/秒，
   * 和这条通道的控制帧共用 20 帧/秒配额时，片 17 就被拒 → 附件永远停在「发送中…」。
   * 分片（大帧）必须走独立配额。
   */
  it('附件分片（大帧）不受控制帧 20 帧/秒限制', async () => {
    const ws = new FakeWs()
    const remote = fakeRemote()
    const channel = channelWith(ws, { kind: 'cloud', remote })
    await channel.start()
    ws.receive({ v: 1, type: 'hello', requestId: 'h1', client: { name: 'x', version: '1' }, features: ['attachments'] })
    await tick()
    // 144 KiB 原始 → base64 约 192 K 字符，与服务端 `CHUNK_BYTES` 一致
    const data = 'A'.repeat(Math.ceil((144 * 1024) / 3) * 4)
    for (let seq = 0; seq < 40; seq += 1) {
      ws.receive({ v: 1, type: 'upload-chunk', requestId: `c${String(seq)}`, uploadId: 'up_1', seq, data, final: seq === 39 })
    }
    await tick()
    expect(ws.frames().some((frame) => frame.type === 'error' && frame.code === 'rate-limited')).toBe(false)
    expect(remote.calls.filter((frame) => frame.type === 'upload-chunk')).toHaveLength(40)
  })

  it('分片超过 60 帧/秒才拒，且拒绝帧带 requestId（客户端能把这一片判失败）', async () => {
    const ws = new FakeWs()
    const channel = channelWith(ws, { kind: 'cloud', remote: fakeRemote() })
    await channel.start()
    ws.receive({ v: 1, type: 'hello', requestId: 'h1', client: { name: 'x', version: '1' }, features: ['attachments'] })
    await tick()
    const data = 'A'.repeat(Math.ceil((144 * 1024) / 3) * 4)
    for (let seq = 0; seq < 70; seq += 1) {
      ws.receive({ v: 1, type: 'upload-chunk', requestId: `c${String(seq)}`, uploadId: 'up_1', seq, data, final: false })
    }
    await tick()
    const rateLimited = ws.frames().filter((frame) => frame.type === 'error' && frame.code === 'rate-limited')
    expect(rateLimited.length).toBeGreaterThanOrEqual(10)
    // 每条拒绝都要点名到具体分片：App 的 upload-service 按 requestId 归位
    const requestIds = rateLimited.map((frame) => (frame.type === 'error' ? frame.requestId : undefined))
    expect(requestIds.every((id) => typeof id === 'string')).toBe(true)
    expect(requestIds[0]).toBe('c60')
  })
})
