/**
 * 对话 store 的「每帧去重」（0.2.17 性能修复）。
 *
 * 真机现象：流式回答越长机器越烫、往上翻历史时输入卡顿。根因是 `applyState` 对**每一帧**
 * 做昂贵工作——而流式时**每个 delta 都是一帧**：
 *  - 每帧 `sessionCache.putSessions(...)`：一次 readwrite 事务把整份会话列表落进 IndexedDB；
 *  - 每帧 `prefetchFiles()`：`collectFiles` 全量遍历工具卡 + 交付物；
 *  - 每 500ms 重写一次完全相同的对话快照（`putConversation`）。
 *
 * Controller 的 patch 是 `{ ...state, ...partial }`，没变的字段保持同一个引用，所以现在只在
 * 「输入引用变了」时做这些事（外加「切会话」这个显式信号）。这个文件锁住三件事：
 *  1) 连续 N 个 delta 帧：会话缓存 **0** 次写入；会话列表变化：恰好 **1** 次；
 *  2) 同一份消息快照不会被反复写（对话缓存）；
 *  3) 预取只在工具卡/交付物换引用或切会话时跑——即使失败冷却期已过，delta 帧也不会把它
 *     重新拖起来（否则真机上就是「每帧重试一次超时」的死循环）。
 *
 * 说明：Node 环境没有 IndexedDB，`lib/instance` 的单例自动退化为内存实现，
 * 正好可以在真实调用路径上用 spy 数写入次数；object URL 用 stub 代替。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChannelLink, ChannelLinkEvent } from '@dsh-hub/mobile-core'
import { useAuthStore } from '../src/stores/auth'
import { useBackendStore } from '../src/stores/backend'
import { useChatStore } from '../src/stores/chat'
import { useFilesStore } from '../src/stores/files'
import { gateway, sessionCache } from '../src/lib/instance'

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
const FEATURES = ['models', 'tools', 'reasoning', 'files', 'deliverables', 'attachments', 'rename', 'archive']

function sessionRow(sessionId: string, title: string | null = '会话'): unknown {
  return {
    sessionId,
    title,
    updatedAt: 1_730_000_000_000,
    running: false,
    blank: false,
    agentAvailable: true,
  }
}

function sessionsFrame(requestId: string, items: unknown[]): unknown {
  return { v: 1, type: 'sessions', requestId, items }
}

function deltaFrame(sessionId: string, attemptId: string, index: number, text: string): unknown {
  return {
    v: 1,
    type: 'delta',
    sessionId,
    attemptId,
    revision: 1,
    index,
    turn: 1,
    step: 1,
    part: { kind: 'text', text },
  }
}

function historyFrame(requestId: string, sessionId: string, items: unknown[]): unknown {
  return { v: 1, type: 'history', requestId, sessionId, items, nextBeforeSeq: null, cursor: 10, hasMore: false }
}

function deliverableFrame(files: unknown[]): unknown {
  return {
    v: 1,
    type: 'deliverable',
    sessionId: 's1',
    seq: 20,
    turn: 1,
    callId: 'call-images',
    files,
  }
}

interface Booted {
  chat: ReturnType<typeof useChatStore>
  files: ReturnType<typeof useFilesStore>
  auth: ReturnType<typeof useAuthStore>
  channel: FakeChannel
}

/** 起一个「已登录 + 通道已连接 + 会话列表 1 条 + 会话 s1 已打开」的 chat store。 */
async function boot(): Promise<Booted> {
  setActivePinia(createPinia())
  const auth = useAuthStore()
  const backend = useBackendStore()
  const chat = useChatStore()
  // 文件加载/预取拆到独立 store（WP46 B）：预取的 watch 在 store 创建时装好。
  const files = useFilesStore()
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
  // 后端选择搬到 stores/backend.ts（WP46 C）：测试仍按「已登录 + 已选云后端」起步。
  backend.selectedBackendId = 'cloud:self'
  const channel = new FakeChannel()
  vi.spyOn(gateway, 'openChannel').mockResolvedValue(channel)
  await chat.switchBackend('cloud:self')
  await sleep(10)
  channel.emitOpen()
  await sleep(0)
  const hello = channel.last('hello')
  channel.server({
    v: 1,
    type: 'hello',
    requestId: hello.requestId,
    node: { id: 'cloud:self', kind: 'cloud', name: '云实例', status: 'running' },
    capabilities: V2_CAPS,
    capabilitiesV2: V2_CAPS_EXTRA,
    features: FEATURES,
    subscribed: [],
    serverTime: 1_730_000_000_000,
  })
  await sleep(0)
  const sessions = channel.last('sessions')
  channel.server(sessionsFrame(sessions.requestId, [sessionRow('s1')]))
  await sleep(0)
  await chat.openSession('s1')
  await sleep(0)
  return { chat, files, auth, channel }
}

/** 有上限的等待（假 Date 下不能用时间做超时）。 */
async function waitFor(check: () => boolean, attempts = 500): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (check()) return
    await sleep(2)
  }
  throw new Error('waitFor 超时')
}

beforeEach(() => {
  ;(URL as unknown as { createObjectURL: (blob: Blob) => string }).createObjectURL = () => 'blob:test'
  ;(URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = () => undefined
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('chat store：流式每帧不写会话缓存（0.2.17）', () => {
  it('连续 30 个 delta 帧只写 0 次会话缓存；会话列表变化时写 1 次', async () => {
    const { chat, channel } = await boot()
    // boot 时那份 sessions 已经落过一次盘：从这里开始数 delta 帧。
    const put = vi.spyOn(sessionCache, 'putSessions')
    put.mockClear()

    for (let i = 0; i < 30; i++) channel.server(deltaFrame('s1', 'att1', i, `第${i}段`))
    await sleep(0)

    // 帧确实被应用了（不是「什么都没发生」才没写）
    expect(chat.streamingText).toContain('第29段')
    expect(put).toHaveBeenCalledTimes(0)

    // 会话列表换了新数组（标题变了）：恰好写 1 次
    chat.refreshSessions()
    channel.server(
      sessionsFrame(channel.last('sessions').requestId, [sessionRow('s1', '改过的标题'), sessionRow('s2')]),
    )
    await sleep(0)
    expect(chat.sessions).toHaveLength(2)
    expect(put).toHaveBeenCalledTimes(1)
    expect(put.mock.calls[0]?.[2]).toHaveLength(2)

    // 之后再来的 delta 帧仍然不写
    channel.server(deltaFrame('s1', 'att1', 30, '继续'))
    await sleep(0)
    expect(put).toHaveBeenCalledTimes(1)
  })

  it('同一份消息快照不会每 500ms 重写一次（对话缓存）', async () => {
    const { channel } = await boot()
    const put = vi.spyOn(sessionCache, 'putConversation')
    put.mockClear()

    channel.server(
      historyFrame(channel.last('history').requestId, 's1', [
        { seq: 1, role: 'user', at: 1_730_000_000_000, text: '你好' },
        { seq: 2, role: 'assistant', at: 1_730_000_001_000, text: '收到' },
      ]),
    )
    await sleep(700)
    expect(put).toHaveBeenCalledTimes(1)

    // 流式 delta 不改消息数组：再等两轮 500ms 也不该再写
    for (let i = 0; i < 10; i++) channel.server(deltaFrame('s1', 'att1', i, '嗯'))
    await sleep(1_200)
    expect(put).toHaveBeenCalledTimes(1)
  })
})

describe('files store：预取只跟随输入引用（0.2.17）', () => {
  it('冷却期过了也不会被 delta 帧重新拖起来；交付物换引用才重新预取', async () => {
    const { files, channel } = await boot()
    const png = {
      fileRef: 'ref-a',
      name: 'a.png',
      pathLabel: 'outputs/a.png',
      mediaType: 'image',
      mimeType: 'image/png',
      bytes: 10,
    }
    channel.server(deliverableFrame([png]))
    await waitFor(() => channel.count('file-read') === 1)
    // 明确拒绝：进 30s 冷却（不自动重试）
    channel.server({
      v: 1,
      type: 'error',
      requestId: channel.last('file-read').requestId,
      code: 'file-refused',
      message: '不允许访问这个文件',
      retryable: false,
    })
    await waitFor(() => files.fileErrors['ref-a'] !== undefined)

    // 把时钟推过冷却期：以前每帧都会重跑 prefetch → 立刻再发一轮 file-read
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 60_000)
      for (let i = 0; i < 5; i++) channel.server(deltaFrame('s1', 'att1', i, '流式'))
      await sleep(20)
      expect(channel.count('file-read')).toBe(1)

      // 交付物换了引用（新一帧）：这才允许重新预取
      channel.server(deliverableFrame([{ ...png, name: 'a-2.png' }]))
      await waitFor(() => channel.count('file-read') === 2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('工具卡引用的图片也会预取；delta 帧不重复触发', async () => {
    const { channel } = await boot()
    channel.server({
      v: 1,
      type: 'tool',
      sessionId: 's1',
      callId: 'call-1',
      kind: 'bash',
      name: 'bash',
      phase: 'end',
      status: 'ok',
      seq: 21,
      turn: 1,
      step: 1,
      title: '运行命令',
      files: [
        {
          fileRef: 'ref-tool',
          name: 'screenshot.png',
          pathLabel: 'outputs/screenshot.png',
          mediaType: 'image',
          mimeType: 'image/png',
          bytes: 10,
        },
      ],
    })
    await waitFor(() => channel.count('file-read') === 1)
    for (let i = 0; i < 10; i++) channel.server(deltaFrame('s1', 'att1', i, '流式'))
    await sleep(20)
    expect(channel.count('file-read')).toBe(1)
  })
});
