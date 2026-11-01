/**
 * 对话 store 里的**连接计时**（0.4.1 §1/§2/§3）。
 *
 * 纯函数的规则在 `connection-banner.test.ts` 里全覆盖；这里锁的是 store 侧的三件事：
 *  1) 计时与 tick：link 离开 connected 才开始计，1 秒 tick 让横幅从「安静」→「连接中」→
 *     「暂时连不上」逐级升级；连上立刻清零，tick 也停掉（不会有一个定时器空转）；
 *  2) 切后台暂停计时：回前台从那一刻重新算，锁屏很久回来不会立刻弹警示；
 *  3) 队列消息的连接状态：没连上时「与服务器连接中…」，这条排队 ≥15 秒才升级，
 *     连上后返回 null（交给「发送中…」）；
 *     外加「连接类瞬态错误不再单独弹红条」（交给顶部横幅）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChannelLink, ChannelLinkEvent } from '@dsh-hub/mobile-core'
import { useAuthStore } from '../src/stores/auth'
import { useBackendStore } from '../src/stores/backend'
import { CONNECTION_TICK_MS, useChatStore } from '../src/stores/chat'
import { gateway, outboxStore } from '../src/lib/instance'

/** 推进假时钟（同时把微任务跑完：core 的帧处理全是 promise 链）。 */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

/** 只跑微任务（不等定时器）。 */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
}

class FakeChannel implements ChannelLink {
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
  last(type: string): any | undefined {
    return [...this.sent].reverse().find((frame) => frame.type === type)
  }
  private emit(event: ChannelLinkEvent): void {
    for (const handler of [...this.handlers]) handler(event)
  }
}

const V2_CAPS = {
  sessions: true,
  history: true,
  send: true,
  stop: true,
  stream: true,
  questions: true,
  approvals: false,
  create: true,
}
const V2_CAPS_EXTRA = {
  models: true,
  rename: true,
  archive: true,
  filesRead: true,
  filesList: true,
  filesUpload: true,
  deliverables: true,
}
const FEATURES = [
  'models',
  'tools',
  'reasoning',
  'files',
  'deliverables',
  'attachments',
  'rename',
  'archive',
  'usage',
  'session-state',
]

interface Booted {
  chat: ReturnType<typeof useChatStore>
  channel: FakeChannel
  /** 让下一次（重连的）openChannel 兑现一条新通道。 */
  resolveNext(): FakeChannel
  /** 关掉当前通道，模拟网络掉线。 */
  drop(): Promise<void>
  /** 在给定通道上完成 hello 握手（= 真正连上）。 */
  hello(channel: FakeChannel): Promise<void>
}

function sessionRow(sessionId: string): unknown {
  return {
    sessionId,
    title: sessionId,
    updatedAt: 1_730_000_000_000,
    running: false,
    blank: false,
    agentAvailable: true,
  }
}

/**
 * 起一个「已登录 + 第一次已连上 + s1 已打开」的 chat store。
 *
 * `openChannel` 第一次兑现 `channel`，之后每次返回一个**挂起**的 promise ——
 * 断线重连会停在这个「连不上」的状态，直到用例 `resolveNext()` 放行，
 * 正好对应真机上「重连请求发出去、服务端一直不给握手」的样子。
 */
async function boot(): Promise<Booted> {
  setActivePinia(createPinia())
  const auth = useAuthStore()
  const backend = useBackendStore()
  const chat = useChatStore()
  auth.phase = 'authenticated'
  auth.user = { id: 1, username: 'alice', displayName: 'Alice' } as never
  auth.backends = [
    {
      id: 'cloud:self',
      kind: 'cloud',
      name: '云实例',
      status: 'running',
      connectable: true,
      capabilities: V2_CAPS,
    },
  ] as never
  // 实例已 running：backend 的自动唤醒 guard 直接返回（不会去打真实 Hub，wakeState 保持干净）。
  auth.instance = { status: 'running', capacityFull: false } as never
  backend.selectedBackendId = 'cloud:self'
  backend.wakeState = 'ready'

  const channel = new FakeChannel()
  const waiting: Array<(link: ChannelLink) => void> = []
  let opened = 0
  vi.spyOn(gateway, 'openChannel').mockImplementation(() => {
    opened += 1
    if (opened === 1) return Promise.resolve(channel)
    return new Promise<ChannelLink>((resolve) => waiting.push(resolve))
  })

  await chat.switchBackend('cloud:self')
  await flush()
  await helloOn(channel)
  const sessions = channel.last('sessions')
  if (sessions) {
    channel.server({ v: 1, type: 'sessions', requestId: sessions.requestId, items: [sessionRow('s1')] })
    await flush()
  }
  await chat.openSession('s1')
  await flush()

  return {
    chat,
    channel,
    resolveNext(): FakeChannel {
      const next = new FakeChannel()
      const resolve = waiting.shift()
      resolve?.(next)
      return next
    },
    async drop(): Promise<void> {
      channel.close(1006, 'network')
      await flush()
    },
    hello: helloOn,
  }
}

async function helloOn(channel: FakeChannel): Promise<void> {
  channel.emitOpen()
  await flush()
  const helloFrame = channel.last('hello')
  channel.server({
    v: 1,
    type: 'hello',
    requestId: helloFrame?.requestId,
    node: { id: 'cloud:self', kind: 'cloud', name: '云实例', status: 'running' },
    capabilities: V2_CAPS,
    capabilitiesV2: V2_CAPS_EXTRA,
    features: FEATURES,
    subscribed: [],
    serverTime: 1_730_000_000_000,
  })
  await flush()
}

beforeEach(async () => {
  await outboxStore.clearAll()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('连接计时：宽限期 → 中性 → 警示 → 连上清零', () => {
  it('断开后在宽限期内安静，4 秒后中性，15 秒后警示，连上后清零且 tick 停掉', async () => {
    const { chat, channel, resolveNext, hello } = await boot()
    expect(chat.link).toBe('connected')
    expect(chat.statusText).toBe('')
    expect(chat.notConnectedSince).toBeNull()

    // tick 只在未连接时运行：从断开那一刻开始，1 秒一次。
    const setSpy = vi.spyOn(globalThis, 'setInterval')
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')

    await (async () => {
      channel.close(1006, 'network')
      await flush()
    })()
    expect(chat.link).toBe('reconnecting')
    expect(chat.notConnectedSince).not.toBeNull()

    const tickCall = setSpy.mock.calls.findIndex((call) => call[1] === CONNECTION_TICK_MS)
    expect(tickCall).toBeGreaterThanOrEqual(0)
    const tickId = setSpy.mock.results[tickCall]!.value as ReturnType<typeof setInterval>

    // 宽限期内：一个字都不显示（这就是「锁屏回来闪一下」被消掉的地方）
    expect(chat.statusText).toBe('')
    await advance(3_000)
    expect(chat.statusText).toBe('')
    expect(chat.connectionBanner.show).toBe(false)

    // 4 秒后：中性提示，没有「第 N 次」
    await advance(1_100)
    expect(chat.statusText).toBe('正在连接服务器…')
    expect(chat.statusTone).toBe('info')
    expect(chat.statusAction).toBe('')
    expect(chat.statusText).not.toMatch(/第|次/)

    // 15 秒后：警示 + 重试
    await advance(11_000)
    expect(chat.statusText).toBe('暂时连不上服务器')
    expect(chat.statusTone).toBe('warn')
    expect(chat.statusAction).toBe('重试')

    // 重连成功：立刻隐藏、计时清零、tick 停掉
    await advance(200)
    const next = resolveNext()
    await flush()
    await hello(next)
    expect(chat.link).toBe('connected')
    expect(chat.statusText).toBe('')
    expect(chat.connectionBanner.show).toBe(false)
    expect(chat.notConnectedSince).toBeNull()
    expect(clearSpy.mock.calls.some((call) => call[0] === tickId)).toBe(true)

    // 连上之后再等 20 秒：不会又冒出提示（计时已经停了）
    await advance(20_000)
    expect(chat.statusText).toBe('')
  })
})

describe('连接计时：切后台暂停', () => {
  it('切后台期间不计时，回前台从那一刻重新算 4 秒', async () => {
    const { chat, drop } = await boot()
    await drop()
    await advance(10_000)
    expect(chat.statusText).toBe('正在连接服务器…')

    chat.recordAppState(false) // 切后台（锁屏）
    expect(chat.statusText).toBe('')
    expect(chat.notConnectedSince).toBeNull()

    // 后台待 10 分钟：回来不该立刻弹「暂时连不上」
    await advance(600_000)
    expect(chat.statusText).toBe('')
    expect(chat.connectionBanner.show).toBe(false)

    chat.recordAppState(true) // 回前台：从这一刻重新计
    expect(chat.statusText).toBe('')
    await advance(3_000)
    expect(chat.statusText).toBe('')
    await advance(1_100)
    expect(chat.statusText).toBe('正在连接服务器…')
  })

  it('statusState / statusTone 仍由横幅驱动（旧读法兼容）', async () => {
    const { chat, drop } = await boot()
    expect(chat.statusState).toBe('ready')
    await drop()
    await advance(5_000)
    expect(chat.statusState).toBe('waking') // info
    expect(chat.statusTone).toBe('info')
    await advance(11_000)
    expect(chat.statusState).toBe('busy') // warn
    expect(chat.statusTone).toBe('warn')
  })
})

describe('队列消息气泡下的连接状态', () => {
  it('没连上：与服务器连接中… → 排队 15 秒后「暂时连不上…」→ 连上后交回「发送中…」', async () => {
    const { chat, drop, resolveNext, hello } = await boot()
    await drop()

    chat.send('排队的一条')
    await flush()
    const entryId = chat.outbox[0]!.id
    expect(chat.queuedLinkStateOf(entryId)).toBe('connecting')
    expect(chat.statusText).toBe('') // 顶部还没到 4 秒，不重复提示

    await advance(5_000)
    // 顶部中性提示；消息下方仍是「连接中」（这条自己才排了 5 秒）
    expect(chat.statusText).toBe('正在连接服务器…')
    expect(chat.queuedLinkStateOf(entryId)).toBe('connecting')

    await advance(10_500) // 这条排队 15.5 秒
    expect(chat.queuedLinkStateOf(entryId)).toBe('timeout')

    const next = resolveNext()
    await flush()
    await hello(next)
    expect(chat.link).toBe('connected')
    expect(chat.queuedLinkStateOf(entryId)).toBeNull()

    // 连上之后 core 自己把它发出去（队列条目离开 outbox）
    await advance(100)
    expect(chat.outbox.find((item) => item.id === entryId)).toBeUndefined()
  })

  it('连着的消息不进连接状态（队列空 → null）', async () => {
    const { chat } = await boot()
    chat.send('直发的一条')
    await flush()
    const entry = chat.outbox[0]
    if (entry) expect(chat.queuedLinkStateOf(entry.id)).toBeNull()
    expect(chat.queuedLinkStateOf(null)).toBeNull()
    expect(chat.queuedLinkStateOf('not-a-real-id')).toBeNull()
  })
})

describe('错误条：连接类瞬态错误交给顶部横幅', () => {
  it('建链失败（upstream-unavailable）不单独弹红条，横幅立刻警示', async () => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    const backend = useBackendStore()
    const chat = useChatStore()
    auth.phase = 'authenticated'
    auth.user = { id: 1, username: 'alice', displayName: 'Alice' } as never
    auth.backends = [
      {
        id: 'cloud:self',
        kind: 'cloud',
        name: '云实例',
        status: 'running',
        connectable: true,
        capabilities: V2_CAPS,
      },
    ] as never
    auth.instance = { status: 'running', capacityFull: false } as never
    backend.selectedBackendId = 'cloud:self'
    backend.wakeState = 'ready'
    vi.spyOn(gateway, 'openChannel').mockRejectedValue(new Error('boom'))

    await chat.switchBackend('cloud:self')
    await flush()
    expect(chat.link).toBe('failed')
    expect(chat.workspaceError?.code).toBe('upstream-unavailable')
    expect(chat.visibleWorkspaceError).toBeNull()
    expect(chat.statusText).toBe('暂时连不上服务器')
    expect(chat.statusAction).toBe('重连')
  })

  it('非连接类错误照常显示（错误条还在）', async () => {
    const { chat, channel } = await boot()
    channel.server({ v: 1, type: 'error', code: 'agent-busy', message: '助手正忙，请稍后再发', retryable: false })
    await flush()
    expect(chat.workspaceError?.code).toBe('agent-busy')
    expect(chat.visibleWorkspaceError?.code).toBe('agent-busy')
    expect(chat.statusText).toBe('') // 连着呢，顶部不该出现连接提示
  })
})
