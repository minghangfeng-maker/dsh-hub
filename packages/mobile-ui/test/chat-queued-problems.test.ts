/**
 * 待发气泡的「附件问题」与「待回答角标」（WP46 第二阶段）。
 *
 * 1. 附件上传失败 / 跨重启丢失时，消息**停在队列里**并显示成问题气泡（不再是「发送中…」），
 *    由用户选「重试 / 去掉附件发送 / 删除」——绝不自动丢附件把文字发出去；
 * 2. 会话行的 `pendingInteractions`（Hub 暂存的未决提问/审批）驱动「待回答」角标：
 *    当前会话不算（卡片就在页面上），其它会话才算，并给出第一个可点开的会话。
 *
 * 用真实的 core 状态机 + 假通道：附件走真的 upload-begin/chunk/uploaded 帧。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChannelLink, ChannelLinkEvent } from '@dsh-hub/mobile-core'
import { useAuthStore } from '../src/stores/auth'
import { useBackendStore } from '../src/stores/backend'
import { useChatStore } from '../src/stores/chat'
import { gateway, outboxStore } from '../src/lib/instance'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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
  count(type: string): number {
    return this.sent.filter((frame) => frame.type === type).length
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
}

function sessionRow(sessionId: string, pendingInteractions?: number, running = false): unknown {
  return {
    sessionId,
    title: sessionId,
    updatedAt: 1_730_000_000_000,
    running,
    blank: false,
    agentAvailable: true,
    ...(pendingInteractions === undefined ? {} : { pendingInteractions }),
  }
}

/** 起一个「已登录 + 通道已连接 + s1 已打开」的 chat store。 */
async function boot(items: unknown[] = [sessionRow('s1')]): Promise<Booted> {
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
  backend.selectedBackendId = 'cloud:self'
  const channel = new FakeChannel()
  vi.spyOn(gateway, 'openChannel').mockResolvedValue(channel)
  await chat.switchBackend('cloud:self')
  await sleep(10)
  channel.emitOpen()
  await sleep(0)
  channel.server({
    v: 1,
    type: 'hello',
    requestId: channel.last('hello').requestId,
    node: { id: 'cloud:self', kind: 'cloud', name: '云实例', status: 'running' },
    capabilities: V2_CAPS,
    capabilitiesV2: V2_CAPS_EXTRA,
    features: FEATURES,
    subscribed: [],
    serverTime: 1_730_000_000_000,
  })
  await sleep(0)
  const sessions = channel.last('sessions')
  if (sessions) channel.server({ v: 1, type: 'sessions', requestId: sessions.requestId, items })
  await sleep(0)
  await chat.openSession('s1')
  await sleep(0)
  return { chat, channel }
}

/** 应答一次完整的附件上传（upload-begin → upload-started → chunk → uploaded）。 */
function completeUpload(channel: FakeChannel): void {
  const begin = channel.last('upload-begin')
  const uploadId = `up_${channel.count('upload-begin')}`
  channel.server({
    v: 1,
    type: 'upload-started',
    requestId: begin.requestId,
    uploadId,
    maxChunkBytes: 144 * 1024,
  })
  const chunk = channel.last('upload-chunk')
  channel.server({
    v: 1,
    type: 'upload-received',
    requestId: chunk.requestId,
    uploadId,
    seq: chunk.seq,
    received: 8,
  })
  channel.server({
    v: 1,
    type: 'uploaded',
    requestId: chunk.requestId,
    uploadId,
    kind: 'image',
    name: 'a.png',
    mimeType: 'image/png',
    bytes: 8,
    expiresAt: Date.now() + 600_000,
  })
}

/** 让 upload-begin 失败（上传任务直接进 failed）。 */
function failUpload(channel: FakeChannel): void {
  const begin = channel.last('upload-begin')
  channel.server({
    v: 1,
    type: 'error',
    requestId: begin.requestId,
    code: 'file-too-large',
    message: '单个附件不能超过 5MB',
    retryable: false,
  })
}

const PICKED = {
  kind: 'image' as const,
  name: 'a.png',
  mimeType: 'image/png',
  bytes: 8,
  base64: 'AAAAAAAAAAA=',
  previewUrl: 'blob:test-preview',
}

beforeEach(async () => {
  ;(URL as unknown as { createObjectURL: (blob: Blob) => string }).createObjectURL = () => 'blob:test'
  ;(URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = () => undefined
  // 发送队列是进程内单例（真机是 IndexedDB）：用例之间必须清干净，否则上一个用例的
  // 草稿会被下一个 controller 在构造时恢复出来（这就是「恢复」本身在起作用）。
  await outboxStore.clearAll()
})

describe('待发气泡：附件上传失败时停在队列里等用户决定', () => {
  it('上传失败 → 气泡显示「附件上传失败」+ 不是「发送中…」，一条都没发出去', async () => {
    const { chat, channel } = await boot()
    chat.addAttachment(PICKED)
    await sleep(0)
    failUpload(channel)
    await sleep(0)
    chat.send('这张图你看看')
    await sleep(20)

    expect(channel.count('send')).toBe(0)
    const entryId = chat.outbox[0]!.id
    expect(chat.queuedProblemOf(entryId)?.kind).toBe('upload-failed')
    // 气泡不再是 pending（否则 UI 会显示「发送中…」）
    const bubble = chat.displayMessages.find((item) => item.localId === entryId)
    expect(bubble?.pending).toBe(false)
    expect(chat.canSend).toBe(true)
  })

  it('「去掉附件发送」：按纯文本发出，附件缩略图映射一起清掉', async () => {
    const { chat, channel } = await boot()
    chat.addAttachment(PICKED)
    await sleep(0)
    failUpload(channel)
    await sleep(0)
    chat.send('这张图你看看')
    await sleep(20)
    const entryId = chat.outbox[0]!.id

    chat.sendQueuedWithoutAttachments(entryId)
    await sleep(20)
    const sends = channel.sent.filter((frame) => frame.type === 'send')
    expect(sends).toHaveLength(1)
    expect(sends[0].text).toBe('这张图你看看')
    expect(sends[0].attachments).toBeUndefined()
    // 气泡上的附件缩略图随「用户明确去掉」一起消失
    expect(chat.localAttachmentFor({ localId: entryId } as never)).toEqual([])
  })

  it('「删除」：整条作废，不发出去', async () => {
    const { chat, channel } = await boot()
    chat.addAttachment(PICKED)
    await sleep(0)
    failUpload(channel)
    await sleep(0)
    chat.send('作废这条')
    await sleep(20)
    const entryId = chat.outbox[0]!.id

    chat.discardQueuedMessage(entryId)
    await sleep(20)
    expect(chat.outbox).toHaveLength(0)
    expect(channel.count('send')).toBe(0)
  })

  it('「重试」：上传重来一次，成功后带着附件按原样发出', async () => {
    const { chat, channel } = await boot()
    chat.addAttachment(PICKED)
    await sleep(0)
    failUpload(channel)
    await sleep(0)
    chat.send('重试后发出')
    await sleep(20)
    const entryId = chat.outbox[0]!.id
    expect(chat.queuedProblemOf(entryId)?.kind).toBe('upload-failed')

    chat.retryQueuedAttachments(entryId)
    await sleep(0)
    completeUpload(channel)
    await sleep(30)

    const sends = channel.sent.filter((frame) => frame.type === 'send')
    expect(sends).toHaveLength(1)
    expect(sends[0].text).toBe('重试后发出')
    expect(sends[0].attachments?.[0]?.uploadId).toBe('up_2')
    expect(chat.outbox).toHaveLength(0)
  })
})

describe('待回答角标：pendingInteractions', () => {
  it('当前会话不算，其它会话才算；给出第一个可点开的会话', async () => {
    const { chat, channel } = await boot([
      sessionRow('s1', 2), // 当前会话：提问卡就在页面上，不算
      sessionRow('s2', 1),
      sessionRow('s3', 3),
      sessionRow('s4'),
    ])
    chat.refreshSessions()
    await sleep(0)
    channel.server({
      v: 1,
      type: 'sessions',
      requestId: channel.last('sessions').requestId,
      items: [sessionRow('s1', 2), sessionRow('s2', 1), sessionRow('s3', 3), sessionRow('s4')],
    })
    await sleep(0)

    expect(chat.pendingAnswerCount).toBe(2)
    expect(chat.pendingAnswerSessions.map((row) => row.sessionId)).toEqual(['s2', 's3'])
    expect(chat.firstPendingAnswerSession?.sessionId).toBe('s2')
  })

  it('全都没在等回答时计数为 0（不显示提示条）', async () => {
    const { chat } = await boot([sessionRow('s1')])
    expect(chat.pendingAnswerCount).toBe(0)
    expect(chat.firstPendingAnswerSession).toBeNull()
  })
})
