/**
 * 发送队列（Outbox）单测（WP46 第一阶段 A）。
 *
 * 锁住的六条：
 *  1. 唤醒/未连接时排队、连上自动发（两条按入队顺序发出，幂等键 = 队列 id）；
 *  2. 还没会话时先建会话再发首条；**建会话失败只按那一次 create 的 requestId** 判定，
 *     别的错误帧不许把消息退回队列（旧 UI 是「任何 error 都当建会话失败」）；
 *  3. 附件就绪后才发（并把上传踢起来）；上传失败/跨重启丢失的附件摘掉并提示一次，
 *     不许把队列永久卡死；
 *  4. 持久化：条目落盘 → 新实例（模拟杀 App 重开）恢复成待发气泡 → 连上后按序发出；
 *     按 accountKey + backendId 隔离，账号清理器一起清；
 *  5. 已经发出但结果未知的**绝不自动重发**（发出前先从盘上删除）；
 *  6. 条目属于哪个会话就发进哪个会话（不悄悄切会话），归档时一起作废。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  bootWithSessions,
  createHarness,
  helloFrame,
  historyFrame,
  openSession,
  sessionRow,
  sessionsFrame,
  sleep,
  type FakeChannel,
  type Harness,
} from './helpers/fake-channel.js'
import {
  IndexedDbOutboxStore,
  MemoryOutboxStore,
  createOutboxStore,
} from '../src/cache/outbox-store.js'
import type { WorkspaceState } from '../src/channel/workspace.js'
import type { CreateFrameOptions } from '../src/channel/wire.js'
import { purgeAccountCaches, registerAccountCachePurger } from '../src/cache/db.js'
import { FakeIndexedDB } from './helpers/fake-indexeddb.js'

const ACCOUNT = 'https://hub.test|alice'
const BACKEND = 'cloud:self'

interface OutboxHarness extends Harness {
  store: MemoryOutboxStore
  state(): WorkspaceState
  retried: string[]
  createFailures: Array<{ code: string; message: string; retryable: boolean }>
  uploadsStarted: string[]
  /** 附件本地状态（测试可随时改）。 */
  attachmentStates: Map<string, 'local' | 'uploading' | 'ready' | 'failed' | 'cancelled' | 'missing'>
  outgoing: Map<string, { kind: 'image' | 'file'; uploadId: string; name: string; mimeType: string; bytes: number }>
}

interface HarnessOptions {
  store?: MemoryOutboxStore
  accountKey?: string | null
  backendId?: string
  createOptions?: () => CreateFrameOptions
}

function outboxHarness(options: HarnessOptions = {}): OutboxHarness {
  const store = options.store ?? new MemoryOutboxStore()
  const retried: string[] = []
  const createFailures: OutboxHarness['createFailures'] = []
  const uploadsStarted: string[] = []
  const attachmentStates: OutboxHarness['attachmentStates'] = new Map()
  const outgoing: OutboxHarness['outgoing'] = new Map()
  const accountKey = options.accountKey === undefined ? ACCOUNT : options.accountKey
  const base = createHarness({
    nodeId: options.backendId ?? BACKEND,
    ...(accountKey === null ? {} : { accountKey }),
    outbox: {
      store,
      ...(options.createOptions ? { createOptions: options.createOptions } : {}),
      attachmentState: (localId) => attachmentStates.get(localId) ?? 'missing',
      outgoingAttachment: (localId) => outgoing.get(localId) ?? null,
      startUploads: (sessionId) => uploadsStarted.push(sessionId),
      retryAttachment: (localId) => retried.push(localId),
      onCreateFailed: (input) => createFailures.push(input),
    },
  })
  return {
    ...base,
    store,
    retried,
    createFailures,
    uploadsStarted,
    attachmentStates,
    outgoing,
    state: () => base.controller.getState(),
  }
}

/** 连上并等到 hello 之后的服务端帧稳定（不建会话）。 */
async function connect(h: OutboxHarness): Promise<FakeChannel> {
  h.controller.start()
  await sleep(0)
  const channel = h.channels[h.channels.length - 1]!
  channel.emitOpen()
  channel.server(helloFrame({ requestId: channel.last('hello').requestId }))
  await sleep(0)
  const sessions = channel.last('sessions')
  if (sessions) channel.server(sessionsFrame(sessions.requestId, []))
  await sleep(0)
  return channel
}

/** 应答一次 create（成功）并等队列跑完。 */
async function answerCreate(
  h: OutboxHarness,
  channel: FakeChannel,
  sessionId = 's_new',
  extra: Record<string, unknown> = {},
): Promise<void> {
  const request = channel.last('create')
  expect(request, '应该发出了 create 帧').toBeTruthy()
  channel.server({
    v: 1,
    type: 'created',
    requestId: request.requestId,
    sessionId,
    ...extra,
  })
  await sleep(0)
  // created 之后会开会话（history/subscribe 各一帧），把这些应答掉再等队列推进。
  const history = channel.last('history')
  if (history) {
    channel.server(historyFrame(history.requestId, sessionId, [], { cursor: 0 }))
    await sleep(0)
  }
  await sleep(0)
}

function sentFrames(channel: FakeChannel): Array<Record<string, any>> {
  return channel.sent.filter((frame) => frame.type === 'send')
}

describe('Outbox：唤醒/断线排队，连上自动发', () => {
  it('未连接时两条消息只进队列、不写通道；连上后先建会话再按序发出', async () => {
    const h = outboxHarness({
      createOptions: () => ({ provider: 'deepseek', model: 'flash', effort: 'low', preset: 'chat' }),
    })
    h.controller.start()
    await sleep(0)
    const channel = h.channels[0]!

    const first = h.controller.enqueueSend('第一条')
    const second = h.controller.enqueueSend('第二条')
    await sleep(5)

    // 排队中：状态里有两条待发气泡，通道上什么都没发
    expect(h.state().outbox.map((entry) => entry.text)).toEqual(['第一条', '第二条'])
    expect(h.state().outbox[0]!.sessionId).toBeNull()
    expect(channel.count('send')).toBe(0)
    expect(channel.count('create')).toBe(0)

    // 连上（hello + 空会话列表）：队列自己发起建会话，带 UI 给的模型/预设
    channel.emitOpen()
    channel.server(helloFrame({ requestId: channel.last('hello').requestId }))
    await sleep(0)
    const sessions = channel.last('sessions')
    if (sessions) channel.server(sessionsFrame(sessions.requestId, []))
    await sleep(5)
    expect(channel.count('create')).toBe(1)
    expect(channel.last('create')).toMatchObject({
      provider: 'deepseek',
      model: 'flash',
      effort: 'low',
      preset: 'chat',
    })

    await answerCreate(h, channel, 's_new')
    // 两条都发出去了，顺序与入队一致，clientMessageId 就是队列 id
    const sends = sentFrames(channel)
    expect(sends).toHaveLength(2)
    expect(sends[0]!.text).toBe('第一条')
    expect(sends[1]!.text).toBe('第二条')
    expect(sends[0]!.clientMessageId).toBe(first)
    expect(sends[1]!.clientMessageId).toBe(second)
    expect(sends[0]!.sessionId).toBe('s_new')
    expect(h.state().outbox).toHaveLength(0)
    // 本地气泡沿用同一个身份（换身份会让气泡闪一下重建）
    const localIds = h.state().messages.filter((entry) => entry.role === 'user').map((entry) => entry.localId)
    expect(localIds).toContain(first)
    expect(localIds).toContain(second)
  })

  it('断开期间继续入队：恢复连接后自动补发', async () => {
    const h = outboxHarness()
    const channel = await connect(h)
    h.controller.openSession('s1')
    await sleep(0)
    openSession(channel, 's1')
    await sleep(0)

    channel.drop(1006)
    await sleep(0)
    h.controller.enqueueSend('断线时打的字')
    await sleep(5)
    expect(h.state().outbox).toHaveLength(1)

    // 重连（harness 的退避是 1ms）：新通道 hello 之后队列自动发
    await sleep(20)
    const next = h.channels[h.channels.length - 1]!
    next.emitOpen()
    next.server(helloFrame({ requestId: next.last('hello').requestId }))
    await sleep(0)
    const sessions = next.last('sessions')
    if (sessions) next.server(sessionsFrame(sessions.requestId, [sessionRow('s1')]))
    await sleep(10)
    const sends = sentFrames(next)
    expect(sends.map((frame) => frame.text)).toContain('断线时打的字')
    expect(h.state().outbox).toHaveLength(0)
  })
})

describe('Outbox：建会话失败只认那一次 create 的回包', () => {
  it('create 的错误回包让条目留在队列、错误上屏，不影响同队列后续重试', async () => {
    const h = outboxHarness()
    const channel = await connect(h)
    const id = h.controller.enqueueSend('会被退回来的')
    await sleep(5)
    const create = channel.last('create')
    expect(create).toBeTruthy()

    channel.server({
      v: 1,
      type: 'error',
      requestId: create.requestId,
      code: 'feature-unsupported',
      message: '当前后端不支持这个功能',
      retryable: false,
    })
    await sleep(5)

    // 条目还在队列里（没有丢消息），错误条给出真实原因，钩子被调用一次
    expect(h.state().outbox.map((entry) => entry.id)).toEqual([id])
    expect(h.state().error?.code).toBe('feature-unsupported')
    expect(h.createFailures).toHaveLength(1)
    expect(h.createFailures[0]!.code).toBe('feature-unsupported')
    // 退避期内不会立刻再发 create（旧 UI 会每帧重试一次）
    expect(channel.count('create')).toBe(1)
  })

  it('无关的错误帧（没有 requestId / 别的 requestId）不会把首条消息退回队列', async () => {
    const h = outboxHarness()
    const channel = await connect(h)
    const id = h.controller.enqueueSend('别动我')
    await sleep(5)
    const create = channel.last('create')

    // 通道级错误（真机切后台回来的 adapter-unavailable）
    channel.server({ v: 1, type: 'error', code: 'adapter-unavailable', message: '后端暂时不可用', retryable: true })
    // 别的请求的错误
    channel.server({ v: 1, type: 'error', requestId: 'a999', code: 'internal', message: 'x', retryable: false })
    await sleep(5)

    expect(h.state().outbox.map((entry) => entry.id)).toEqual([id])
    expect(h.createFailures).toHaveLength(0)

    await answerCreate(h, channel, 's_new')
    expect(sentFrames(channel).map((frame) => frame.clientMessageId)).toEqual([id])
  })

  it('preset-not-found：钩子丢掉 preset，退避后自动用默认设置重试成功', async () => {
    let preset: string | null = 'missing-preset'
    const h = outboxHarness({
      createOptions: () => (preset === null ? {} : { preset }),
    })
    const channel = await connect(h)
    h.controller.enqueueSend('用默认设置重试')
    await sleep(5)
    channel.server({
      v: 1,
      type: 'error',
      requestId: channel.last('create').requestId,
      code: 'preset-not-found',
      message: '预设不存在',
      retryable: false,
    })
    await sleep(5)
    // UI 的钩子会把无效 preset 丢掉
    preset = null
    expect(h.createFailures[0]!.code).toBe('preset-not-found')

    // 退避（1s）到点自动重试，这次不带 preset
    await sleep(1_100)
    expect(channel.count('create')).toBe(2)
    expect(channel.last('create').preset).toBeUndefined()
    await answerCreate(h, channel, 's_new')
    expect(sentFrames(channel)).toHaveLength(1)
  })
})

describe('Outbox：附件就绪后再发', () => {
  it('附件还在上传时等，上传中就绪后带上 uploadId 发出去', async () => {
    const h = outboxHarness()
    const channel = await connect(h)
    h.controller.openSession('s1')
    await sleep(0)
    openSession(channel, 's1')
    await sleep(0)

    h.attachmentStates.set('local-1', 'uploading')
    h.controller.enqueueSend('带附件的', { attachmentIds: ['local-1'] })
    await sleep(5)
    expect(channel.count('send')).toBe(0)
    // 附件没就绪：把上传踢起来（UI 侧幂等）
    expect(h.uploadsStarted).toContain('s1')

    // 上传完成 → 下一次状态提交（上传进度帧）时自动发
    h.attachmentStates.set('local-1', 'ready')
    h.outgoing.set('local-1', {
      kind: 'image',
      uploadId: 'up_1',
      name: 'a.png',
      mimeType: 'image/png',
      bytes: 12,
    })
    // 任何一次状态提交都会推进队列（真机上是 upload-received 的进度帧）。
    h.controller.clearError()
    await sleep(5)
    const sends = sentFrames(channel)
    expect(sends).toHaveLength(1)
    expect(sends[0]!.attachments).toEqual([
      { kind: 'image', uploadId: 'up_1', name: 'a.png', mimeType: 'image/png', bytes: 12 },
    ])
  })

  it('附件上传失败：消息**停在队列里**并标记失败，不自动丢附件发出', async () => {
    const h = outboxHarness()
    const channel = await connect(h)
    h.controller.openSession('s1')
    await sleep(0)
    openSession(channel, 's1')
    await sleep(0)

    h.attachmentStates.set('local-bad', 'failed')
    const id = h.controller.enqueueSend('图片没传上去', { attachmentIds: ['local-bad'] })
    await sleep(20)

    // 一条都不能发出去：用户以为发了图、其实没发是最坏的结果。
    expect(sentFrames(channel)).toHaveLength(0)
    const entry = h.state().outbox.find((item) => item.id === id)
    expect(entry?.problem).toEqual({ kind: 'upload-failed', attachmentIds: ['local-bad'] })
    // 后一条也不能越位（同一会话保持入队顺序）
    h.controller.enqueueSend('后面这条', {})
    await sleep(10)
    expect(sentFrames(channel)).toHaveLength(0)
  })

  it('跨重启丢失的附件：同样停在队列，标记为附件丢失（可「去掉附件发送」）', async () => {
    const store = new MemoryOutboxStore()
    const first = outboxHarness({ store })
    first.controller.start()
    await sleep(0)
    // 模拟「入队时附件还在上传，随后 App 被杀」：只存了 localId，字节没落盘。
    first.attachmentStates.set('local-lost', 'uploading')
    // 显式排进 s1：本次只验证「恢复后附件丢失 → 停在队列并标记」这条语义。
    const id = first.controller.enqueueSend('带图的消息', { attachmentIds: ['local-lost'], sessionId: 's1' })
    await sleep(10)
    first.controller.dispose()

    const second = outboxHarness({ store })
    const channel = await connect(second)
    second.controller.openSession('s1')
    await sleep(0)
    openSession(channel, 's1')
    await sleep(20)
    expect(sentFrames(channel)).toHaveLength(0)
    const entry = second.state().outbox.find((item) => item.id === id)
    expect(entry?.problem).toEqual({ kind: 'attachment-missing', attachmentIds: ['local-lost'] })
  })

  it('三个动作：重试（重新推上传）/ 去掉附件发送 / 删除', async () => {
    const h = outboxHarness()
    const channel = await connect(h)
    h.controller.openSession('s1')
    await sleep(0)
    openSession(channel, 's1')
    await sleep(0)

    // 1) 重试：把出问题的附件交给 UI 重传；状态恢复 ready 后自动发出
    h.attachmentStates.set('local-bad', 'failed')
    const retryId = h.controller.enqueueSend('重试后发出', { attachmentIds: ['local-bad'] })
    await sleep(10)
    expect(h.state().outbox[0]?.problem?.kind).toBe('upload-failed')
    expect(h.controller.retryQueuedAttachments(retryId)).toBe(true)
    expect(h.retried).toEqual(['local-bad'])
    h.attachmentStates.set('local-bad', 'ready')
    h.outgoing.set('local-bad', {
      kind: 'image',
      uploadId: 'up_retry',
      name: 'a.png',
      mimeType: 'image/png',
      bytes: 3,
    })
    // 上传进度帧会改 state.uploads → 触发队列
    h.controller.clearError()
    await sleep(10)
    const retriedSends = sentFrames(channel)
    expect(retriedSends).toHaveLength(1)
    expect(retriedSends[0]!.attachments?.[0]?.uploadId).toBe('up_retry')

    // 2) 去掉附件发送：按纯文本发出（用户明确点的）
    h.attachmentStates.set('local-bad-2', 'failed')
    const detachId = h.controller.enqueueSend('只发文字', { attachmentIds: ['local-bad-2'] })
    await sleep(10)
    expect(h.state().outbox).toHaveLength(1)
    expect(h.controller.sendQueuedWithoutAttachments(detachId)).toBe(true)
    await sleep(10)
    const detachSends = sentFrames(channel)
    expect(detachSends).toHaveLength(2)
    expect(detachSends[1]!.text).toBe('只发文字')
    expect(detachSends[1]!.attachments).toBeUndefined()

    // 3) 删除：整条作废，不发出
    h.attachmentStates.set('local-bad-3', 'failed')
    const discardId = h.controller.enqueueSend('作废这条', { attachmentIds: ['local-bad-3'] })
    await sleep(10)
    expect(h.controller.discardQueuedMessage(discardId)).toBe(true)
    await sleep(10)
    expect(h.state().outbox).toHaveLength(0)
    expect(sentFrames(channel)).toHaveLength(2)
  })
})

describe('Outbox：持久化（冷启动恢复 + 账号隔离）', () => {
  it('条目先落盘；新实例（模拟杀 App 重开）恢复成待发气泡并在连上后发出', async () => {
    const store = new MemoryOutboxStore()
    const first = outboxHarness({ store })
    first.controller.start()
    await sleep(0)
    const firstId = first.controller.enqueueSend('杀掉之前打的字')
    await sleep(10)
    expect(await store.load(ACCOUNT, BACKEND)).toHaveLength(1)
    // 模拟 App 被杀：dispose（不再发帧）
    first.controller.dispose()

    const second = outboxHarness({ store })
    const channel = await connect(second)
    // 冷启动：恢复的条目先显示成待发气泡
    expect(second.state().outbox.map((entry) => entry.id)).toEqual([firstId])
    expect(second.state().outbox[0]!.text).toBe('杀掉之前打的字')
    // 连上后自动建会话 → 发出
    await sleep(5)
    await answerCreate(second, channel, 's_recovered')
    expect(sentFrames(channel).map((frame) => frame.clientMessageId)).toEqual([firstId])
    expect(second.state().outbox).toHaveLength(0)
  })

  it('按 accountKey + backendId 隔离；账号级清理器会清掉队列', async () => {
    const store = new MemoryOutboxStore()
    const h = outboxHarness({ store })
    h.controller.start()
    await sleep(0)
    h.controller.enqueueSend('账号 A 的草稿')
    await sleep(10)

    // 另一个后端 / 另一个账号：读不到
    expect(await store.load(ACCOUNT, 'desktop:home')).toEqual([])
    expect(await store.load('https://hub.test|bob', BACKEND)).toEqual([])

    // 退出登录走的是账号级清理器（`createOutboxStore` 注册的同一个动作）
    const off = registerAccountCachePurger((accountKey) =>
      accountKey === null ? store.clearAll() : store.clearAccount(accountKey),
    )
    try {
      await purgeAccountCaches(ACCOUNT)
    } finally {
      off()
    }
    expect(await store.load(ACCOUNT, BACKEND)).toEqual([])
  })

  it('发出之前先从盘上删除：已经发出但结果未知的消息不会在重启后自动重发', async () => {
    const store = new MemoryOutboxStore()
    const h = outboxHarness({ store })
    const channel = await connect(h)
    h.controller.openSession('s1')
    await sleep(0)
    openSession(channel, 's1')
    await sleep(0)

    h.controller.enqueueSend('只发一次')
    await sleep(20)
    expect(sentFrames(channel)).toHaveLength(1)
    // 盘上已经没有这条（ack / canonical 消息都没来 = 结果未知）
    expect(await store.load(ACCOUNT, BACKEND)).toEqual([])

    // 重开：队列空 → 不会重发
    h.controller.dispose()
    const second = outboxHarness({ store })
    const next = await connect(second)
    expect(second.state().outbox).toHaveLength(0)
    expect(next.count('send')).toBe(0)
  })
})

describe('Outbox：按会话排队 / 归档作废', () => {
  it('属于别的会话的条目不会发进当前会话；打开那个会话后自动发', async () => {
    const h = outboxHarness()
    const channel = await connect(h)
    h.controller.openSession('s1')
    await sleep(0)
    openSession(channel, 's1')
    await sleep(0)
    // 排进 s2 的一条（例如在 s2 里断线时打的字）
    h.controller.enqueueSend('给 s2 的', { sessionId: 's2' })
    await sleep(10)
    expect(channel.count('send')).toBe(0)
    expect(h.state().outbox).toHaveLength(1)

    // 切到 s2
    h.controller.openSession('s2')
    await sleep(0)
    openSession(channel, 's2')
    await sleep(10)
    const sends = sentFrames(channel)
    expect(sends).toHaveLength(1)
    expect(sends[0]!.sessionId).toBe('s2')
  })

  it('归档会话时把它的草稿一起作废（否则永远发不出去）', async () => {
    const h = outboxHarness()
    const channel = await connect(h)
    h.controller.openSession('s1')
    await sleep(0)
    openSession(channel, 's1')
    await sleep(0)
    h.controller.enqueueSend('要归档的草稿', { sessionId: 's_archived' })
    await sleep(5)
    expect(h.controller.discardQueuedForSession('s_archived')).toBe(1)
    expect(h.state().outbox).toHaveLength(0)
    await sleep(5)
    expect(channel.count('send')).toBe(0)
  })
})

describe('Outbox：IndexedDbOutboxStore（手机真机路径）', () => {
  const fake = new FakeIndexedDB()
  let store: IndexedDbOutboxStore

  beforeAll(() => {
    ;(globalThis as { indexedDB?: unknown }).indexedDB = fake as unknown as IDBFactory
  })
  afterAll(() => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB
  })
  beforeEach(async () => {
    store = new IndexedDbOutboxStore()
    await store.clearAll()
  })

  const record = {
    id: 'm_1',
    text: '第一条',
    at: 1_730_000_000_000,
    sessionId: null as string | null,
    attachments: [],
    attachmentIds: [] as string[],
    attempts: 0,
  }

  it('写入后可跨实例读回；空队列保存会删掉这一行', async () => {
    await store.save(ACCOUNT, BACKEND, [record])
    const reopened = new IndexedDbOutboxStore()
    expect(await reopened.load(ACCOUNT, BACKEND)).toEqual([record])

    await reopened.save(ACCOUNT, BACKEND, [])
    expect(await reopened.load(ACCOUNT, BACKEND)).toEqual([])
  })

  it('坏数据（字段缺失/类型不对）读出来直接丢弃，不把队列卡死', async () => {
    await store.save(ACCOUNT, BACKEND, [
      record,
      { id: '', text: 'x' } as never,
      { id: 'm_bad', text: 1 } as never,
    ])
    expect((await store.load(ACCOUNT, BACKEND)).map((entry) => entry.id)).toEqual(['m_1'])
  })

  it('按账号清理 / 全清（退出登录走的就是 clearAccount）', async () => {
    await store.save(ACCOUNT, BACKEND, [record])
    await store.save('acc-b', BACKEND, [{ ...record, id: 'm_2' }])
    await store.clearAccount(ACCOUNT)
    expect(await store.load(ACCOUNT, BACKEND)).toEqual([])
    expect(await store.load('acc-b', BACKEND)).toHaveLength(1)
    await store.clearAll()
    expect(await store.load('acc-b', BACKEND)).toEqual([])
  })

  it('createOutboxStore 默认挂到账号级清理：clearAccount 一起清', async () => {
    const created = createOutboxStore()
    await created.save(ACCOUNT, BACKEND, [record])
    await purgeAccountCaches(ACCOUNT)
    expect(await created.load(ACCOUNT, BACKEND)).toEqual([])
  })
})

describe('Outbox：队列计数（状态条/标题用）', () => {
  it('按会话/待建会话分别计数', async () => {
    const h = outboxHarness()
    await bootWithSessions(h, [])
    h.controller.enqueueSend('a', { sessionId: 's1' })
    h.controller.enqueueSend('b', { sessionId: 's1' })
    await sleep(5)
    expect(h.controller.queuedCount('s1')).toBe(2)
    expect(h.controller.queuedCount(null)).toBe(0)
  })
})
