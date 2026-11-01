import { describe, expect, it } from 'vitest'
import type { MobileClientFrame, NodeCapabilities, NodeRemote } from '@dsh-hub/dsh-node-remote'
import type { MobileServerFrameAll } from '@dsh-hub/shared'
import type { WsConnection } from '../../lib/ws-upgrade.js'
import { IdempotencyStore, MobileChannel } from './channel.js'
import type { ChannelNode, RelayConnection } from './types.js'

/**
 * WP48：hello 审计（P0）、桌面节点不再「假 v2」（评估 R1 方案 B）、v1 硬切开关（P2）。
 *
 * 三件事都发生在**通道层**，因为只有它同时知道三件事实：客户端声明了什么、这条通道
 * 实际回显了什么（WP46 之后由 NodeSession 按通道改写）、以及这条通道背后的节点是不是
 * 桌面中继（relay 只放行 v1 的 11 种帧）。
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
  frames(): MobileServerFrameAll[] {
    return this.sent.map((text) => JSON.parse(text) as MobileServerFrameAll)
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

/** 假云节点：hello 按 `enable` 回显特性（null = 老 adapter，不回显）。 */
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
      }
    },
    async close() {},
  }
}

interface AuditEntry {
  action: string
  detail: Record<string, unknown>
}

function channelWith(
  ws: FakeWs,
  node: ChannelNode,
  audits: AuditEntry[],
  options: { nodeId?: string } = {},
): MobileChannel {
  return new MobileChannel(
    ws,
    {
      userId: 1,
      nodeId: options.nodeId ?? 'cloud:self',
      node,
      validateSession: () => ({ id: 1 }),
      audit: (action, detail) => {
        audits.push({ action, detail: detail ?? {} })
      },
    },
    new IdempotencyStore(),
    () => undefined,
    () => undefined,
  )
}

function cloudNode(remote: NodeRemote): ChannelNode {
  return { kind: 'cloud', remote }
}

function relayWith(
  relayFeatures: RelayConnection['relayFeatures'],
  sent: unknown[] = [],
): RelayConnection & { sent: unknown[] } {
  return {
    deviceId: 'dv_0123456789abcdef0123456789abcdef',
    generation: 'g1',
    closed: false,
    userId: 1,
    clientVersion: '0.9.3',
    hostStatus: 'running',
    capabilities: CAPS,
    relayFeatures,
    channels: new Set<string>(),
    sent,
    send: (envelope) => {
      sent.push(envelope)
    },
    close: () => undefined,
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

function helloAudit(audits: AuditEntry[]): Record<string, unknown> {
  const entry = audits.find((item) => item.action === 'mobile.hello')
  expect(entry).toBeDefined()
  return entry!.detail
}

/** 桌面 adapter 回的 hello（v2 形状；`features` / `capabilitiesV2` 由用例按需补）。 */
const DESKTOP_HELLO: Extract<MobileServerFrameAll, { type: 'hello' }> = {
  v: 1,
  type: 'hello',
  requestId: 'h1',
  node: { id: 'dv_0123456789abcdef0123456789abcdef', kind: 'desktop', name: 'PC', status: 'host-running' },
  capabilities: CAPS,
  subscribed: [],
  serverTime: 1,
}

describe('P0 hello 审计（mobile.hello）', () => {
  it('v2 客户端：detail 只有约定的 6 个键，declared/enabled 都是本通道实际集合', async () => {
    const ws = new FakeWs()
    const audits: AuditEntry[] = []
    const channel = channelWith(ws, cloudNode(remoteWith(['models', 'files'])), audits)
    await channel.start()
    ws.receive({
      v: 1,
      type: 'hello',
      requestId: 'h1',
      client: { name: 'dsh-hub-app', version: '0.2.17' },
      features: ['models', 'files'],
    })
    await flush()
    expect(ws.frames().find((frame) => frame.type === 'hello')).toMatchObject({
      features: ['models', 'files'],
    })
    const detail = helloAudit(audits)
    // 精确键集合：多一个键都可能意味着「顺手把帧/令牌写进审计」，这是硬要求
    expect(Object.keys(detail).sort()).toEqual(
      ['clientName', 'clientVersion', 'declared', 'enabled', 'nodeId', 'v2'].sort(),
    )
    expect(detail).toEqual({
      nodeId: 'cloud:self',
      clientName: 'dsh-hub-app',
      clientVersion: '0.2.17',
      declared: ['models', 'files'],
      enabled: ['models', 'files'],
      v2: true,
    })
    await channel.dispose('test')
  })

  it('v1 客户端（hello 不带 features）：declared/enabled 都是空数组，v2=false', async () => {
    const ws = new FakeWs()
    const audits: AuditEntry[] = []
    const channel = channelWith(ws, cloudNode(remoteWith(null)), audits)
    await channel.start()
    ws.receive({ v: 1, type: 'hello', requestId: 'h1', client: { name: 'legacy', version: '0' } })
    await flush()
    expect(ws.frames().find((frame) => frame.type === 'hello')).not.toHaveProperty('features')
    expect(helloAudit(audits)).toEqual({
      nodeId: 'cloud:self',
      clientName: 'legacy',
      clientVersion: '0',
      declared: [],
      enabled: [],
      v2: false,
    })
    await channel.dispose('test')
  })

  it('审计与通道断开互不影响：断开只记 disconnect，不重复记 hello', async () => {
    const ws = new FakeWs()
    const audits: AuditEntry[] = []
    const channel = channelWith(ws, cloudNode(remoteWith(['models'])), audits)
    await channel.start()
    ws.receive({
      v: 1,
      type: 'hello',
      requestId: 'h1',
      client: { name: 'app', version: '0.2.17' },
      features: ['models'],
    })
    await flush()
    await channel.dispose('test')
    expect(audits.filter((item) => item.action === 'mobile.hello')).toHaveLength(1)
    expect(audits.map((item) => item.action)).toEqual([
      'mobile.node.connect',
      'mobile.hello',
      'mobile.node.disconnect',
    ])
  })
})

describe('R1 桌面节点不再假装支持 v2（方案 B：Hub 侧降级）', () => {
  it('中继没声明 relayFeatures（旧 connector）：hello 的特性整块摘掉，v2 帧早拒', async () => {
    const ws = new FakeWs()
    const audits: AuditEntry[] = []
    const relay = relayWith(null)
    const channel = channelWith(ws, { kind: 'desktop', relay }, audits)
    await channel.start()
    ws.receive({
      v: 1,
      type: 'hello',
      requestId: 'h1',
      client: { name: 'dsh-hub-app', version: '0.2.17' },
      features: ['models', 'files'],
    })
    await flush()
    // 桌面 adapter 自己回显了 v2 特性（它确实实现了），但中继会把 v2 帧丢掉
    channel.deliver({ ...DESKTOP_HELLO, features: ['models', 'files'], capabilitiesV2: { models: true } })
    await flush()
    const hello = ws.frames().find((frame) => frame.type === 'hello')
    expect(hello).toBeDefined()
    expect(hello).not.toHaveProperty('features')
    expect(hello).not.toHaveProperty('capabilitiesV2')
    expect(helloAudit(audits)).toMatchObject({ declared: ['models', 'files'], enabled: [], v2: false })
    // 早拒：比中继那句 `unsupported phone frame` 更可读，App 不会干等
    ws.receive({ v: 1, type: 'models', requestId: 'm1' })
    await flush()
    expect(ws.frames().at(-1)).toMatchObject({ type: 'error', requestId: 'm1', code: 'feature-unsupported' })
    // 真的没有 v2 帧被发到中继（只剩 open 与那条 hello 客户端帧）
    const forwarded = relay.sent.filter((item) => (item as { type: string }).type === 'frame')
    expect(forwarded).toHaveLength(1)
    expect((forwarded[0] as { payload: { type: string } }).payload.type).toBe('hello')
    await channel.dispose('test')
  })

  it('中继声明了 relayFeatures：只回显交集（声明过的才给 App）', async () => {
    const ws = new FakeWs()
    const audits: AuditEntry[] = []
    const relay = relayWith(['models'])
    const channel = channelWith(ws, { kind: 'desktop', relay }, audits)
    await channel.start()
    ws.receive({
      v: 1,
      type: 'hello',
      requestId: 'h1',
      client: { name: 'dsh-hub-app', version: '0.2.17' },
      features: ['models', 'files'],
    })
    await flush()
    channel.deliver({ ...DESKTOP_HELLO, features: ['models', 'files'] })
    await flush()
    expect(ws.frames().find((frame) => frame.type === 'hello')).toMatchObject({ features: ['models'] })
    expect(helloAudit(audits)).toMatchObject({ enabled: ['models'], v2: true })
    // 声明过的照常转发；没声明的仍然早拒
    ws.receive({ v: 1, type: 'models', requestId: 'm1' })
    await flush()
    expect(ws.frames().some((frame) => frame.type === 'error')).toBe(false)
    ws.receive({ v: 1, type: 'file-list', requestId: 'f1', sessionId: 's_1', path: '.' })
    await flush()
    expect(ws.frames().at(-1)).toMatchObject({ code: 'feature-unsupported', requestId: 'f1' })
    await channel.dispose('test')
  })
})

describe('P2 硬切开关（HUB_MOBILE_REQUIRE_V2，默认关）', () => {
  it('开关关（默认）：hello 不带 features 照旧放行 —— 与现行为逐字节一致', async () => {
    const ws = new FakeWs()
    const audits: AuditEntry[] = []
    const remote = remoteWith(null)
    const channel = channelWith(ws, cloudNode(remote), audits)
    await channel.start()
    ws.receive({ v: 1, type: 'hello', requestId: 'h1', client: { name: 'legacy', version: '0' } })
    await flush()
    expect(remote.calls.map((frame) => frame.type)).toEqual(['hello'])
    expect(ws.frames().find((frame) => frame.type === 'hello')).toBeDefined()
    expect(ws.frames().some((frame) => frame.type === 'error' || frame.type === 'bye')).toBe(false)
    await channel.dispose('test')
  })

  it('开关开：hello 不带 features → protocol-version-unsupported + bye，且一个帧都不派发给节点', async () => {
    process.env['HUB_MOBILE_REQUIRE_V2'] = '1'
    try {
      const ws = new FakeWs()
      const audits: AuditEntry[] = []
      const remote = remoteWith(['models'])
      const channel = channelWith(ws, cloudNode(remote), audits)
      await channel.start()
      ws.receive({ v: 1, type: 'hello', requestId: 'h1', client: { name: 'legacy', version: '0' } })
      await flush()
      expect(remote.calls).toHaveLength(0)
      const frames = ws.frames()
      expect(frames.find((frame) => frame.type === 'error')).toMatchObject({
        requestId: 'h1',
        code: 'protocol-version-unsupported',
        message: '客户端版本过旧，请升级 App',
        retryable: false,
      })
      expect(frames.at(-1)).toMatchObject({ type: 'bye', code: 'protocol-version-unsupported' })
      expect(ws.closed).toBe(true)
      // 连审计都不写 hello：这条通道从没真正协商过
      expect(audits.some((item) => item.action === 'mobile.hello')).toBe(false)
    } finally {
      delete process.env['HUB_MOBILE_REQUIRE_V2']
    }
  })

  it('开关开：hello 带 features → 正常协商并回显', async () => {
    process.env['HUB_MOBILE_REQUIRE_V2'] = '1'
    try {
      const ws = new FakeWs()
      const audits: AuditEntry[] = []
      const remote = remoteWith(['models'])
      const channel = channelWith(ws, cloudNode(remote), audits)
      await channel.start()
      ws.receive({
        v: 1,
        type: 'hello',
        requestId: 'h1',
        client: { name: 'dsh-hub-app', version: '0.2.17' },
        features: ['models'],
      })
      await flush()
      expect(remote.calls.map((frame) => frame.type)).toEqual(['hello'])
      expect(ws.frames().find((frame) => frame.type === 'hello')).toMatchObject({ features: ['models'] })
      expect(helloAudit(audits)).toMatchObject({ declared: ['models'], enabled: ['models'], v2: true })
      await channel.dispose('test')
    } finally {
      delete process.env['HUB_MOBILE_REQUIRE_V2']
    }
  })

  it('开关开：features 是空数组也算老客户端（启用集合与 v1 等价）', async () => {
    process.env['HUB_MOBILE_REQUIRE_V2'] = '1'
    try {
      const ws = new FakeWs()
      const remote = remoteWith(null)
      const channel = channelWith(ws, cloudNode(remote), [])
      await channel.start()
      ws.receive({
        v: 1,
        type: 'hello',
        requestId: 'h1',
        client: { name: 'app', version: '0' },
        features: [],
      })
      await flush()
      expect(remote.calls).toHaveLength(0)
      expect(ws.frames().find((frame) => frame.type === 'error')).toMatchObject({
        code: 'protocol-version-unsupported',
      })
    } finally {
      delete process.env['HUB_MOBILE_REQUIRE_V2']
    }
  })

  it('开关开：桌面节点上老客户端连 open 都不发（桌面侧不会建 adapter）', async () => {
    process.env['HUB_MOBILE_REQUIRE_V2'] = '1'
    try {
      const ws = new FakeWs()
      const relay = relayWith(null)
      const channel = channelWith(ws, { kind: 'desktop', relay }, [])
      await channel.start()
      ws.receive({ v: 1, type: 'hello', requestId: 'h1', client: { name: 'legacy', version: '0' } })
      await flush()
      expect(relay.sent).toHaveLength(0)
      expect(ws.frames().find((frame) => frame.type === 'error')).toMatchObject({
        code: 'protocol-version-unsupported',
      })
      expect(ws.closed).toBe(true)
    } finally {
      delete process.env['HUB_MOBILE_REQUIRE_V2']
    }
  })

  it('开关只认 "1"：其他取值（含 "true"）按现行为处理', async () => {
    process.env['HUB_MOBILE_REQUIRE_V2'] = 'true'
    try {
      const ws = new FakeWs()
      const remote = remoteWith(null)
      const channel = channelWith(ws, cloudNode(remote), [])
      await channel.start()
      ws.receive({ v: 1, type: 'hello', requestId: 'h1', client: { name: 'legacy', version: '0' } })
      await flush()
      expect(remote.calls.map((frame) => frame.type)).toEqual(['hello'])
      await channel.dispose('test')
    } finally {
      delete process.env['HUB_MOBILE_REQUIRE_V2']
    }
  })
})
