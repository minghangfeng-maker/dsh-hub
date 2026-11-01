import type { MobileServerFrame, WebSocketLike } from '../src/index.js'

/**
 * 假 DSH Host（HTTP unary + `/api/remote.mux` 的 WS 替身）。
 *
 * 从 `adapter.test.ts` 抽出来，供 adapter / park（WP46）两组测试共用：
 * 两个文件各拷一份替身，迟早会漂移成「一个能复现、另一个不能」。
 */


export interface Call {
  endpoint: string
  payload: unknown
}

export interface FakeHostOptions {
  /** endpoint → 响应；返回 undefined 表示方法不存在。 */
  respond?: (endpoint: string, payload: unknown) => { ok: true; value: unknown } | { ok: false; code: string; message: string } | undefined
  /** 自定义 WS：默认自动回一条 snapshot（cursor=42）。 */
  ws?: FakeSocket
  /** 关掉「探测载荷自动回答」，用于测鉴权失败等场景。 */
  probeShortcut?: boolean
}

export class FakeSocket implements WebSocketLike {
  readonly sent: Array<Record<string, unknown>> = []
  /** 测试用：attachWait 对 agentId 参数名回参数校验错误，验证回退 agent。 */
  attachWaitRejectsAgentId = false
  /** 测试用：attachWait 立即回 item，进入 accepted 态。 */
  attachWaitEmitsItem = false
  private textListeners: Array<(text: string) => void> = []
  private closeListeners: Array<(code: number, reason: string) => void> = []
  private errorListeners: Array<(error: Error) => void> = []
  closed = false

  send(text: string): void {
    const frame = JSON.parse(text) as Record<string, unknown>
    this.sent.push(frame)
    // 能力探测会真的开一条 session/follow：这里按「校验先于调用」自动回 arguments-invalid
    const payload = frame['payload'] as { args?: Record<string, unknown> } | undefined
    if (this.attachWaitEmitsItem && frame['type'] === 'open' && frame['endpoint'] === 'userQuestions/attachWait') {
      queueMicrotask(() => {
        this.push({ type: 'item', streamId: frame['streamId'], value: { remainingMs: 5_000 } })
      })
      return
    }
    if (this.attachWaitRejectsAgentId && frame['type'] === 'open' && frame['endpoint'] === 'userQuestions/attachWait') {
      const args = (frame['payload'] as { args?: Record<string, unknown> }).args ?? {}
      queueMicrotask(() => {
        this.push(
          'agentId' in args
            ? { type: 'error', streamId: frame['streamId'], error: { code: 'gateway/arguments-invalid', message: 'wrong name' } }
            : { type: 'item', streamId: frame['streamId'], value: { remainingMs: 5_000 } },
        )
      })
      return
    }
    if (frame['type'] === 'open' && frame['endpoint'] === '$events') {
      queueMicrotask(() => {
        this.push({
          type: 'item',
          streamId: frame['streamId'],
          value: { type: 'ready', clientId: 'c1', host: { home: '/home/test' } },
        })
      })
      return
    }
    if (frame['type'] === 'open' && JSON.stringify(payload ?? {}).includes('__dsh_hub_probe')) {
      queueMicrotask(() => {
        this.push({
          type: 'error',
          streamId: frame['streamId'],
          error: { code: 'gateway/arguments-invalid', message: 'probe rejected before invocation' },
        })
      })
    }
  }
  close(code = 1000, reason = ''): void {
    // 测试替身：探测阶段会 close 一条 mux，之后 adapter 会重新取 socket，所以不永久停用
    for (const listener of this.closeListeners) listener(code, reason)
  }
  onText(listener: (text: string) => void): void {
    this.textListeners.push(listener)
  }
  onClose(listener: (code: number, reason: string) => void): void {
    this.closeListeners.push(listener)
  }
  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener)
  }
  /** 模拟 Host 推一帧。 */
  push(frame: unknown): void {
    const text = JSON.stringify(frame)
    for (const listener of this.textListeners) listener(text)
  }
  fail(error: Error): void {
    for (const listener of this.errorListeners) listener(error)
  }
  opensFor(endpoint: string): number {
    return this.sent.filter((item) => item['type'] === 'open' && item['endpoint'] === endpoint && !isProbeOpen(item)).length
  }
  get openedStreamIds(): string[] {
    return this.sent
      .filter((item) => item['type'] === 'open' && !isProbeOpen(item))
      .map((item) => String(item['streamId']))
  }
  streamFor(endpoint: string): string {
    const opens = this.sent.filter((item) => item['type'] === 'open' && item['endpoint'] === endpoint && !isProbeOpen(item))
    const open = opens.at(-1)
    if (open === undefined) throw new Error(`没有 open ${endpoint}`)
    return String(open['streamId'])
  }
}

export function isProbeOpen(item: Record<string, unknown>): boolean {
  const payload = item['payload'] as { args?: Record<string, unknown> } | undefined
  return JSON.stringify(item['payload'] ?? {}).includes('__dsh_hub_probe')
}

export function fakeHost(options: FakeHostOptions = {}): { calls: Call[]; fetch: typeof fetch; socket: FakeSocket } {
  const calls: Call[] = []
  const socket = options.ws ?? new FakeSocket()
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input))
    const endpoint = url.pathname.replace('/api/', '')
    const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; payload: unknown }
    calls.push({ endpoint, payload: body.payload })
    // 探测载荷先于业务：真实 Host 在业务调用前拒绝；替身也照这个顺序回答。
    // 该端点没有被配置时仍回 method-unavailable（模拟旧 Host 缺端点）。
    if (options.probeShortcut !== false && JSON.stringify(body.payload).includes('__dsh_hub_probe')) {
      const known = options.respond?.(endpoint, body.payload) !== undefined
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            type: 'server-response',
            result: {
              ok: false,
              error: {
                code: known ? 'gateway/arguments-invalid' : 'gateway/method-unavailable',
                message: 'probe',
              },
            },
          }),
      }
    }
    const answer = options.respond?.(endpoint, body.payload)
    if (answer === undefined) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            type: 'server-response',
            result: { ok: false, error: { code: 'gateway/method-unavailable', message: 'no such endpoint' } },
          }),
      }
    }
    if (answer.ok) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ type: 'server-response', result: { ok: true, value: answer.value } }),
      }
    }
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          type: 'server-response',
          result: { ok: false, error: { code: answer.code, message: answer.message } },
        }),
    }
  }) as unknown as typeof fetch
  return { calls, fetch: fetchImpl, socket }
}

export const NODE = { id: 'cloud:self', kind: 'cloud' as const, name: '云实例', status: 'running' }

export function defaultRespond(): NonNullable<FakeHostOptions['respond']> {
  return (endpoint, payload) => {
    if (endpoint === 'session/list') {
      return {
        ok: true,
        value: {
          items: [
            {
              sessionId: 's_a',
              updatedAt: 10,
              running: true,
              blank: false,
              agentAvailable: true,
              cwd: '/home/alice/secret',
              projections: { values: { title: '会话 A' } },
            },
            { sessionId: 's_child', updatedAt: 20, running: false, blank: true, agentAvailable: false, parentSessionId: 's_a' },
          ],
        },
      }
    }
    if (endpoint === 'session/page') {
      return {
        ok: true,
        value: {
          hasMore: true,
          records: [
            { type: 'event', event: { type: 'user/message', seq: 12, time: 100, data: { source: { kind: 'user', rpcId: 'm_hist' }, message: { content: [{ type: 'text', text: '帮我看下' }] } } } },
            {
              type: 'event',
              event: {
                type: 'assistant/message',
                seq: 13,
                time: 200,
                data: { source: { kind: 'agent' }, message: { content: [{ type: 'text', text: '先跑测试' }, { type: 'tool-call', name: 'bash' }] } },
              },
            },
          ],
        },
      }
    }
    if (endpoint === 'session/prompt') return { ok: true, value: { accepted: true } }
    if (endpoint === 'session/cancel') return { ok: true, value: { accepted: true } }
    if (endpoint === 'session/create') return { ok: true, value: { sessionId: 's_new' } }
    if (endpoint === 'userQuestions/answer') return { ok: true, value: true }
    if (endpoint === '$events/result') return { ok: true, value: undefined }
    // 参数错的端点也证明它存在：返回 arguments-invalid 而不是 method-unavailable
    if (endpoint === 'session/history') return { ok: false, code: 'gateway/arguments-invalid', message: 'args' }
    return { ok: false, code: 'gateway/arguments-invalid', message: `probe ${endpoint}` }
  }
}

export function lastCall(calls: Call[], endpoint: string): Call | undefined {
  return calls.filter((call) => call.endpoint === endpoint).at(-1)
}

export async function collect(frames: MobileServerFrame[]): Promise<(frame: MobileServerFrame) => void> {
  return (frame) => {
    frames.push(frame)
  }
}

