import type { ChannelLink, ChannelLinkEvent } from '../../src/channel/link.js'
import {
  WorkspaceController,
  type WorkspaceControllerOptions,
} from '../../src/channel/workspace.js'

/** 可控的假通道：服务端帧同步注入，便于精确断言时序。 */
export class FakeChannel implements ChannelLink {
  state: 'connecting' | 'open' | 'closed' = 'open'
  sent: any[] = []
  private handlers = new Set<(event: ChannelLinkEvent) => void>()

  send(text: string): boolean {
    if (this.state !== 'open') return false
    this.sent.push(JSON.parse(text))
    return true
  }

  close(code = 1000, reason = ''): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    this.emit({ type: 'close', code, reason })
  }

  onEvent(handler: (event: ChannelLinkEvent) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  emitOpen(): void {
    this.emit({ type: 'open' })
  }

  server(frame: unknown): void {
    this.emit({ type: 'text', data: JSON.stringify(frame) })
  }

  /** 模拟网络掉线（不是客户端主动关）。 */
  drop(code = 1006): void {
    this.state = 'closed'
    this.emit({ type: 'close', code, reason: 'drop' })
  }

  last(type: string): any | undefined {
    return [...this.sent].reverse().find((frame) => frame.type === type)
  }

  count(type: string): number {
    return this.sent.filter((frame) => frame.type === type).length
  }

  private emit(event: ChannelLinkEvent): void {
    for (const handler of [...this.handlers]) handler(event)
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface Harness {
  controller: WorkspaceController
  channels: FakeChannel[]
}

export function createHarness(overrides: Partial<WorkspaceControllerOptions> = {}): Harness {
  const channels: FakeChannel[] = []
  const controller = new WorkspaceController({
    nodeId: 'cloud:self',
    client: { name: 'dsh-hub-app-test', version: '0.1.0-dev' },
    openChannel: async () => {
      const channel = new FakeChannel()
      channels.push(channel)
      return channel
    },
    keepAlive: false,
    reconnect: { baseMs: 1, maxMs: 2, maxAttempts: 3 },
    ...overrides,
  })
  return { controller, channels }
}

export const CAPABILITIES = {
  sessions: true,
  history: true,
  send: true,
  stop: true,
  stream: true,
  questions: true,
  approvals: false,
  create: true,
}

export function helloFrame(overrides: Record<string, unknown> = {}): unknown {
  return {
    v: 1,
    type: 'hello',
    requestId: 'hello-1',
    node: { id: 'cloud:self', kind: 'cloud', name: '云服务器', status: 'running' },
    capabilities: CAPABILITIES,
    subscribed: [],
    serverTime: 1_730_000_000_000,
    ...overrides,
  }
}

export function sessionRow(
  sessionId: string,
  title: string | null = '会话',
  running = false,
): unknown {
  return {
    sessionId,
    title,
    updatedAt: 1_730_000_000_000,
    running,
    blank: false,
    agentAvailable: true,
  }
}

export function sessionsFrame(requestId: string, items: unknown[]): unknown {
  return { v: 1, type: 'sessions', requestId, items }
}

export function historyFrame(
  requestId: string,
  sessionId: string,
  items: unknown[],
  options: { cursor?: number | null; nextBeforeSeq?: number | null; hasMore?: boolean } = {},
): unknown {
  return {
    v: 1,
    type: 'history',
    requestId,
    sessionId,
    items,
    nextBeforeSeq: options.nextBeforeSeq ?? null,
    cursor: options.cursor ?? 10,
    hasMore: options.hasMore ?? false,
  }
}

export function deltaFrame(
  sessionId: string,
  attemptId: string,
  index: number,
  text: string,
  part: 'text' | 'reasoning' = 'text',
  revision = 1,
): unknown {
  return {
    v: 1,
    type: 'delta',
    sessionId,
    attemptId,
    revision,
    index,
    turn: 1,
    step: 1,
    part: { kind: part, text },
  }
}

export async function boot(h: Harness, features?: string[]): Promise<FakeChannel> {
  h.controller.start()
  await sleep(0)
  const channel = h.channels[h.channels.length - 1]!
  channel.emitOpen()
  const helloRequest = channel.last('hello')
  channel.server(helloFrame({ requestId: helloRequest.requestId, ...(features ? { features } : {}) }))
  return channel
}

/** hello 之后会收到 sessions 请求；这里把它应答掉，返回通道。 */
export async function bootWithSessions(
  h: Harness,
  items: unknown[] = [sessionRow('s1')],
  features?: string[],
): Promise<FakeChannel> {
  const channel = await boot(h, features)
  const request = channel.last('sessions')
  channel.server(sessionsFrame(request.requestId, items))
  return channel
}

/** 打开会话并把首屏 history 应答掉。 */
export function openSession(
  channel: FakeChannel,
  sessionId: string,
  items: unknown[] = [],
  cursor = 10,
): void {
  const historyRequest = channel.last('history')
  channel.server(historyFrame(historyRequest.requestId, sessionId, items, { cursor }))
}
