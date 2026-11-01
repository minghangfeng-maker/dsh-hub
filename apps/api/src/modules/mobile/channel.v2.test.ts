import { describe, expect, it } from 'vitest'
import type {
  MobileClientFrame,
  MobileServerFrame,
  NodeCapabilities,
  NodeRemote,
} from '@dsh-hub/dsh-node-remote'
import type { WsConnection } from '../../lib/ws-upgrade.js'
import { IdempotencyStore, MobileChannel } from './channel.js'
import type { ChannelNode, RelayConnection } from './types.js'

/**
 * 通道层对 v2 的**早拒**：
 *
 * v2 帧必须先由客户端声明、再被节点 hello 回显（§17 D1）。老桌面 adapter 不认识 v2 帧，
 * 收到会静默忽略 —— 通道层必须在 Hub 侧就回 `feature-unsupported`，否则 App 干等。
 */

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

/** 假 remote：hello 按 `enable` 回显特性（模拟「支持 / 不支持 v2 的节点」）。 */
function remoteWith(enable: string[] | null): NodeRemote & { calls: MobileClientFrame[] } {
  const calls: MobileClientFrame[] = []
  return {
    calls,
    capabilities: CAPS,
    compatible: true,
    missing: [],
    node: { id: 'cloud:self', kind: 'cloud', name: '云实例', status: 'running' },
    async dispatch(frame, sink) {
      calls.push(frame)
      if (frame.type === 'hello') {
        await sink({
          v: 1,
          type: 'hello',
          requestId: frame.requestId,
          node: this.node,
          capabilities: CAPS,
          subscribed: [],
          serverTime: 1,
          ...(enable === null ? {} : { features: enable as never }),
        })
        return
      }
      if (frame.type === 'models') {
        await sink({
          v: 1,
          type: 'models',
          requestId: frame.requestId,
          default: { provider: 'p', model: 'm' },
          items: [],
          failures: [],
        })
      }
    },
    async close() {},
  }
}

function channelWith(ws: FakeWs, node: ChannelNode) {
  return new MobileChannel(
    ws,
    { userId: 1, nodeId: 'cloud:self', node, validateSession: () => ({ id: 1 }), audit: () => undefined },
    new IdempotencyStore(),
    () => undefined,
    () => undefined,
  )
}

function cloudNode(remote: NodeRemote): ChannelNode {
  return { kind: 'cloud', remote }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

describe('通道 v2 特性协商与早拒', () => {
  it('客户端声明 + 节点回显：v2 帧被转发', async () => {
    const ws = new FakeWs()
    const remote = remoteWith(['models'])
    const channel = channelWith(ws, cloudNode(remote))
    await channel.start()
    ws.receive({
      v: 1,
      type: 'hello',
      requestId: 'h1',
      client: { name: 'app', version: '1' },
      features: ['models'],
    })
    await flush()
    ws.receive({ v: 1, type: 'models', requestId: 'm1' })
    await flush()
    expect(remote.calls.map((frame) => frame.type)).toEqual(['hello', 'models'])
    expect(ws.frames().some((frame) => frame.type === 'models')).toBe(true)
    await channel.dispose('test')
  })

  it('节点没回显（老桌面 adapter）：v2 帧立刻 feature-unsupported，不转发', async () => {
    const ws = new FakeWs()
    const remote = remoteWith(null)
    const channel = channelWith(ws, cloudNode(remote))
    await channel.start()
    ws.receive({
      v: 1,
      type: 'hello',
      requestId: 'h1',
      client: { name: 'app', version: '1' },
      features: ['files'],
    })
    await flush()
    ws.receive({ v: 1, type: 'file-read', requestId: 'f1', sessionId: 's_1', path: 'a.txt' })
    await flush()
    expect(remote.calls.map((frame) => frame.type)).toEqual(['hello'])
    expect(ws.frames().at(-1)).toMatchObject({
      type: 'error',
      code: 'feature-unsupported',
      requestId: 'f1',
    })
    await channel.dispose('test')
  })

  it('字段不合法的帧：错误信息要指出是哪个字段（例如 App 误传 create.cwd）', async () => {
    const ws = new FakeWs()
    const remote = remoteWith(['models'])
    const channel = channelWith(ws, cloudNode(remote))
    await channel.start()
    ws.receive({ v: 1, type: 'hello', requestId: 'h1', client: { name: 'app', version: '1' }, features: ['models'] })
    await flush()
    // cwd 不在 `create` 的 strictObject 里（§17：客户端不能传工作目录）
    ws.receive({ v: 1, type: 'create', requestId: 'c-bad', cwd: '/etc' })
    await flush()
    const error = ws.frames().at(-1)
    expect(error).toMatchObject({ type: 'error', requestId: 'c-bad', code: 'internal' })
    expect(String((error as { message: string }).message)).toContain('cwd')
    // 帧没被转发给节点（不会有会话被建出来）
    expect(remote.calls.map((frame) => frame.type)).toEqual(['hello'])
    await channel.dispose('test')
  })

  it('老客户端（无 features）发 v2 独有帧 → feature-unsupported', async () => {
    const ws = new FakeWs()
    const remote = remoteWith(null)
    const channel = channelWith(ws, cloudNode(remote))
    await channel.start()
    ws.receive({ v: 1, type: 'hello', requestId: 'h1', client: { name: 'app', version: '1' } })
    await flush()
    ws.receive({ v: 1, type: 'models', requestId: 'm1' })
    await flush()
    expect(ws.frames().at(-1)).toMatchObject({ code: 'feature-unsupported' })
    expect(remote.calls.map((frame) => frame.type)).toEqual(['hello'])
    await channel.dispose('test')
  })

  it('v1 帧的 v2 扩展字段也要协商：create.model / send.attachments / sessions.includeArchived', async () => {
    const ws = new FakeWs()
    const remote = remoteWith([])
    const channel = channelWith(ws, cloudNode(remote))
    await channel.start()
    ws.receive({ v: 1, type: 'hello', requestId: 'h1', client: { name: 'app', version: '1' }, features: [] })
    await flush()
    ws.receive({
      v: 1,
      type: 'create',
      requestId: 'c1',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      effort: 'high',
    })
    await flush()
    ws.receive({
      v: 1,
      type: 'send',
      requestId: 's1',
      sessionId: 's_1',
      text: '看附件',
      clientMessageId: 'm1',
      attachments: [{ kind: 'file', uploadId: 'up', name: 'a.pdf', mimeType: 'application/pdf', bytes: 1 }],
    })
    await flush()
    ws.receive({ v: 1, type: 'sessions', requestId: 'l1', includeArchived: true })
    await flush()
    const errors = ws.frames().filter((frame) => frame.type === 'error')
    expect(errors).toHaveLength(3)
    for (const error of errors) expect(error).toMatchObject({ code: 'feature-unsupported' })
    expect(remote.calls.map((frame) => frame.type)).toEqual(['hello'])
    await channel.dispose('test')
  })

  it('协商过的特性里，v1 形态的 create/send/sessions 仍然照旧转发', async () => {
    const ws = new FakeWs()
    const remote = remoteWith(['models', 'attachments', 'archive'])
    const channel = channelWith(ws, cloudNode(remote))
    await channel.start()
    ws.receive({
      v: 1,
      type: 'hello',
      requestId: 'h1',
      client: { name: 'app', version: '1' },
      features: ['models', 'attachments', 'archive'],
    })
    await flush()
    ws.receive({ v: 1, type: 'create', requestId: 'c1', preset: 'chat' })
    await flush()
    ws.receive({ v: 1, type: 'sessions', requestId: 'l1', includeArchived: true })
    await flush()
    expect(remote.calls.map((frame) => frame.type)).toEqual(['hello', 'create', 'sessions'])
    expect(ws.frames().some((frame) => frame.type === 'error')).toBe(false)
    await channel.dispose('test')
  })

  it('桌面中继：Hub 转发 v2 帧到 relay（payload 原样；中继已声明 relayFeatures）', async () => {
    const ws = new FakeWs()
    const sent: unknown[] = []
    const relay: RelayConnection = {
      deviceId: 'dv_1',
      generation: 'g1',
      closed: false,
      userId: 1,
      clientVersion: '0.9.3',
      hostStatus: 'running',
      capabilities: CAPS,
      // WP48：connector 声明了它放行的 v2 特性（= 评估 R1 方案 A 之后的样子）
      relayFeatures: ['models'],
      channels: new Set<string>(),
      send: (envelope) => {
        sent.push(envelope)
      },
      close: () => undefined,
    }
    const channel = channelWith(ws, { kind: 'desktop', relay })
    await channel.start()
    // 真实顺序：客户端先 hello → Hub 转发 → 桌面 adapter 回显（经中继回到 deliver）
    ws.receive({
      v: 1,
      type: 'hello',
      requestId: 'h1',
      client: { name: 'app', version: '1' },
      features: ['models'],
    })
    await flush()
    channel.deliver({
      v: 1,
      type: 'hello',
      requestId: 'h1',
      node: { id: 'dv_1', kind: 'desktop', name: 'PC', status: 'host-running' },
      capabilities: CAPS,
      subscribed: [],
      serverTime: 1,
      features: ['models'],
    } as MobileServerFrame)
    ws.receive({ v: 1, type: 'models', requestId: 'm1' })
    await flush()
    expect(sent.some((item) => (item as { type: string }).type === 'frame')).toBe(true)
    expect(ws.frames().some((frame) => frame.type === 'error')).toBe(false)
    await channel.dispose('test')
  })
})
