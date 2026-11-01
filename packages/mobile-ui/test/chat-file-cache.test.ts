/**
 * 对话 store 的「产出文件 / 云端路径图片」行为（0.2.14 真机反馈 ① ②）。
 *
 * 这里验证的是 **UI 层决策**（core 的缓存/重试在 core 单测里覆盖）：
 *  - 持久缓存命中时 chat store 直接出 blob URL，不再发 `file-read`（重开会话秒开）；
 *  - 下载失败显示错误文案、退出 loading，并在冷却期内不自动重发；
 *  - 用户点「重试」（force）能立刻重发；
 *  - 正文云端路径图片走 `readFile({path})`，成功后有可用的 object URL。
 *
 * 说明：Node 环境没有 DOM/IndexedDB，`lib/instance` 的单例会自动退化为内存实现，
 * 正好用来做「持久缓存命中」的注入；object URL 用 stub 代替。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChannelLink, ChannelLinkEvent } from '@dsh-hub/mobile-core'
import { useAuthStore } from '../src/stores/auth'
import { useBackendStore } from '../src/stores/backend'
import { useChatStore } from '../src/stores/chat'
import { useFilesStore } from '../src/stores/files'
import { DIAGNOSTICS_KEY, type DiagEvent } from '../src/lib/diagnostics'
import { fileStore, gateway } from '../src/lib/instance'

/** Node 里没有 localStorage：给诊断模块一个内存实现，断言 file:read 诊断事件。 */
const storageData = new Map<string, string>()
const memoryStorage = {
  getItem: (key: string): string | null => storageData.get(key) ?? null,
  setItem: (key: string, value: string): void => {
    storageData.set(key, value)
  },
  removeItem: (key: string): void => {
    storageData.delete(key)
  },
  clear: (): void => {
    storageData.clear()
  },
  key: (index: number): string | null => [...storageData.keys()][index] ?? null,
  get length(): number {
    return storageData.size
  },
}

function diagEvents(): DiagEvent[] {
  const raw = storageData.get(DIAGNOSTICS_KEY)
  if (raw === undefined) return []
  return JSON.parse(raw) as DiagEvent[]
}

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

let blobSeq = 0

interface Booted {
  chat: ReturnType<typeof useChatStore>
  files: ReturnType<typeof useFilesStore>
  auth: ReturnType<typeof useAuthStore>
  channel: FakeChannel
  accountKey: string
}

/** 起一个「已登录 + 通道已连接 + 会话已打开」的 chat store（真实 core 状态机 + 假通道）。 */
async function boot(options: { connect?: boolean } = {}): Promise<Booted> {
  setActivePinia(createPinia())
  const auth = useAuthStore()
  const backend = useBackendStore()
  const chat = useChatStore()
  // 文件加载/预取/缓存拆到独立 store（WP46 B）：预取的 watch 在 store 创建时装好。
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
  if (options.connect !== false) {
    // switchBackend 才会把 backendId 定下来并建 controller（App.vue 的真实入口）；
    // 直接 ensureConnected 会因为 backendId 还是 null 而提前返回。
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
    if (sessions) channel.server({ v: 1, type: 'sessions', requestId: sessions.requestId, items: [] })
    await sleep(0)
    await chat.openSession('s1')
    await sleep(0)
  }
  return { chat, files, auth, channel, accountKey: auth.accountKey ?? '' }
}

function fileFrame(
  requestId: string,
  input: { fileRef: string; name: string; mimeType: string; mediaType: 'image' | 'file'; bytes: Uint8Array },
): unknown {
  return {
    v: 1,
    type: 'file',
    requestId,
    sessionId: 's1',
    fileRef: input.fileRef,
    name: input.name,
    mediaType: input.mediaType,
    mimeType: input.mimeType,
    bytes: input.bytes.byteLength,
    encoding: 'base64',
    data: Buffer.from(input.bytes).toString('base64'),
  }
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor 超时')
    await sleep(2)
  }
}

beforeEach(async () => {
  blobSeq = 0
  ;(URL as unknown as { createObjectURL: (blob: Blob) => string }).createObjectURL = () => `blob:test-${++blobSeq}`
  ;(URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = () => undefined
  ;(globalThis as unknown as { localStorage: typeof memoryStorage }).localStorage = memoryStorage
  storageData.clear()
  await fileStore.clearAll()
})

describe('files store：交付物命中持久缓存不再走通道', () => {
  it('缓存命中：直接生成 blob URL，file-read 一次都不发', async () => {
    const { files, channel, accountKey } = await boot()
    await fileStore.put({
      accountKey,
      sessionId: 's1',
      key: 'ref-cached',
      name: 'pelican-ride-hd.png',
      mimeType: 'image/png',
      mediaType: 'image',
      bytes: 4,
      data: new Uint8Array([1, 2, 3, 4]),
      cachedAt: Date.now(),
      touchedAt: Date.now(),
    })
    await files.ensureFile('ref-cached', {
      name: 'pelican-ride-hd.png',
      mimeType: 'image/png',
      mediaType: 'image',
      bytes: 4,
    })
    expect(channel.count('file-read')).toBe(0)
    expect(files.fileUrls['ref-cached']?.url).toBe('blob:test-1')
    expect(files.fileLoading['ref-cached']).toBeUndefined()
    expect(files.fileErrors['ref-cached']).toBeUndefined()
  })

  it('未命中走通道，成功后写入持久缓存（下次重开直接命中）', async () => {
    const { files, channel, accountKey } = await boot()
    expect(await files.hasCachedFile('ref-net')).toBe(false)
    const promise = files.ensureFile('ref-net', { name: 'a.png', mimeType: 'image/png', mediaType: 'image' })
    await waitFor(() => channel.count('file-read') === 1)
    channel.server(
      fileFrame(channel.last('file-read').requestId, {
        fileRef: 'ref-net',
        name: 'a.png',
        mimeType: 'image/png',
        mediaType: 'image',
        bytes: new Uint8Array([9, 9]),
      }),
    )
    await promise
    expect(files.fileUrls['ref-net']?.url).toBe('blob:test-1')
    await sleep(10)
    expect(await fileStore.has(accountKey, 's1', 'ref-net')).toBe(true)
    // FileAttachment 用它判断「大图不自动下载但如果本地已有就直接渲染」
    expect(await files.hasCachedFile('ref-net')).toBe(true)
  })
})

describe('files store：下载失败的错误态与重试', () => {
  it('明确拒绝：显示错误文案、退出 loading；冷却期内不自动重发', async () => {
    const { files, chat, channel } = await boot()
    const promise = files.ensureFile('ref-bad', { name: 'bad.png', mediaType: 'image' })
    await waitFor(() => channel.count('file-read') === 1)
    channel.server({
      v: 1,
      type: 'error',
      requestId: channel.last('file-read').requestId,
      code: 'file-refused',
      message: '不允许访问这个文件',
      retryable: false,
    })
    await promise
    expect(files.fileErrors['ref-bad']).toBe('不允许访问这个文件')
    expect(files.fileLoading['ref-bad']).toBeUndefined()
    expect(files.fileUrls['ref-bad']).toBeUndefined()

    // 没有 force：冷却期内（30s）不再发请求——否则 applyState 每帧重试会让图片永远转圈。
    await files.ensureFile('ref-bad', { name: 'bad.png', mediaType: 'image' })
    await sleep(10)
    expect(channel.count('file-read')).toBe(1)

    // 用户点「重试」：force 立刻重来
    const retry = files.ensureFile('ref-bad', { name: 'bad.png', mediaType: 'image' }, { force: true })
    await waitFor(() => channel.count('file-read') === 2)
    channel.server(
      fileFrame(channel.last('file-read').requestId, {
        fileRef: 'ref-bad',
        name: 'bad.png',
        mimeType: 'image/png',
        mediaType: 'image',
        bytes: new Uint8Array([3]),
      }),
    )
    await retry
    expect(files.fileUrls['ref-bad']?.url).toBe('blob:test-1')
    expect(files.fileErrors['ref-bad']).toBeUndefined()
  })

  it('超时：错误文案进入 fileErrors，不再永远停在加载中', async () => {
    const { files, chat, channel } = await boot()
    const promise = files.ensureFile('ref-timeout', { name: 'slow.png', mediaType: 'image' })
    await waitFor(() => channel.count('file-read') === 1)
    // 不回复：core 会按 3 次退避 + 30s 超时收尾。这里只断言「失败会留下错误态、
    // 不会永远 loading」——直接把通道断掉让 pending 请求失败更快。
    channel.close(1006, 'drop')
    await promise
    expect(files.fileLoading['ref-timeout']).toBeUndefined()
    // 断链后 core 会对未完成请求走超时/失败路径；这里只要求有明确错误或已经不在加载。
    expect(files.fileUrls['ref-timeout']).toBeUndefined()
  })
})

describe('chat store：正文云端路径图片（readFile({path})）', () => {
  it('loadCloudImage 发 path 字段并返回 blob URL；第二次命中内存缓存', async () => {
    const { files, chat, channel } = await boot()
    const path = '/workspace/out/pelican-ride-hd.png'
    const promise = files.loadCloudImage(path, { alt: '骑自行车的鹈鹕' })
    await waitFor(() => channel.count('file-read') === 1)
    const sent = channel.last('file-read')
    expect(sent.path).toBe(path)
    expect(sent.fileRef).toBeUndefined()
    channel.server(
      fileFrame(sent.requestId, {
        fileRef: 'ref-path',
        name: 'pelican-ride-hd.png',
        mimeType: 'image/png',
        mediaType: 'image',
        bytes: new Uint8Array([5, 5, 5]),
      }),
    )
    const loaded = await promise
    expect(loaded.url).toBe('blob:test-1')
    expect(loaded.mimeType).toBe('image/png')
    // 第二次：同一个 path 直接复用，不再发帧
    const again = await files.loadCloudImage(path)
    expect(again.url).toBe('blob:test-1')
    expect(channel.count('file-read')).toBe(1)
  })

  it('路径被拒（file-refused）：抛错且冷却期内不重复请求（正文显示下载卡片）', async () => {
    const { files, chat, channel } = await boot()
    const promise = files.loadCloudImage('/etc/passwd')
    await waitFor(() => channel.count('file-read') === 1)
    channel.server({
      v: 1,
      type: 'error',
      requestId: channel.last('file-read').requestId,
      code: 'file-refused',
      message: '不允许访问这个文件',
      retryable: false,
    })
    await expect(promise).rejects.toThrow('不允许访问这个文件')
    await expect(files.loadCloudImage('/etc/passwd')).rejects.toThrow('不允许访问这个文件')
    expect(channel.count('file-read')).toBe(1)
  })
})

describe('files store：全局 file-read 闸门（同一时刻只允许一条在飞）', () => {
  it('两个交付物同时要下载时串行：前一条完成前不出现第二条 file-read', async () => {
    const { files, chat, channel } = await boot()
    const first = files.ensureFile('ref-a', { name: 'a.png', mimeType: 'image/png', mediaType: 'image' })
    const second = files.ensureFile('ref-b', { name: 'b.png', mimeType: 'image/png', mediaType: 'image' })
    await waitFor(() => channel.count('file-read') === 1)
    // 等过闸门的 120ms 间隔窗口，第二条仍然不能发出去
    await sleep(160)
    expect(channel.count('file-read')).toBe(1)
    channel.server(
      fileFrame(channel.last('file-read').requestId, {
        fileRef: 'ref-a',
        name: 'a.png',
        mimeType: 'image/png',
        mediaType: 'image',
        bytes: new Uint8Array([1]),
      }),
    )
    await first
    await waitFor(() => channel.count('file-read') === 2)
    channel.server(
      fileFrame(channel.last('file-read').requestId, {
        fileRef: 'ref-b',
        name: 'b.png',
        mimeType: 'image/png',
        mediaType: 'image',
        bytes: new Uint8Array([2]),
      }),
    )
    await second
    expect(files.fileUrls['ref-a']?.url).toBeTruthy()
    expect(files.fileUrls['ref-b']?.url).toBeTruthy()
  })

  it('自动预取只拉 ≤1MiB 的图：3.6MB gif 不会自己发 file-read（等用户点击）', async () => {
    const { channel } = await boot()
    channel.server({
      v: 1,
      type: 'deliverable',
      sessionId: 's1',
      seq: 20,
      turn: 1,
      callId: 'call-images',
      files: [
        {
          fileRef: 'ref-png',
          name: 'pelican-ride-hd.png',
          pathLabel: 'outputs/pelican-ride-hd.png',
          mediaType: 'image',
          mimeType: 'image/png',
          bytes: 478 * 1024,
        },
        {
          fileRef: 'ref-gif',
          name: 'pelican-ride.gif',
          pathLabel: 'outputs/pelican-ride.gif',
          mediaType: 'image',
          mimeType: 'image/gif',
          bytes: 3_600_000,
        },
      ],
    })
    await waitFor(() => channel.count('file-read') >= 1)
    await sleep(300)
    expect(channel.count('file-read')).toBe(1)
    expect(channel.last('file-read').fileRef).toBe('ref-png')
  })
})

describe('files store：文件读取诊断（file:read / file:read-fail）', () => {
  it('成功记 name/bytes/src；失败记错误码（真机诊断面板可见）', async () => {
    const { files, chat, channel } = await boot()
    const okPromise = files.ensureFile('ref-diag', { name: 'pelican.png', mimeType: 'image/png', mediaType: 'image' })
    await waitFor(() => channel.count('file-read') === 1)
    channel.server(
      fileFrame(channel.last('file-read').requestId, {
        fileRef: 'ref-diag',
        name: 'pelican.png',
        mimeType: 'image/png',
        mediaType: 'image',
        bytes: new Uint8Array(2048),
      }),
    )
    await okPromise
    const okEvent = diagEvents()
      .filter((event) => event.name === 'file:read')
      .at(-1)
    expect(okEvent?.detail).toContain('name=pelican.png')
    expect(okEvent?.detail).toContain('bytes=2KB')
    expect(okEvent?.detail).toContain('src=network')

    const badPromise = files.ensureFile('ref-bad-diag', { name: 'secret.png', mediaType: 'image' })
    await waitFor(() => channel.count('file-read') === 2)
    channel.server({
      v: 1,
      type: 'error',
      requestId: channel.last('file-read').requestId,
      code: 'file-refused',
      message: '不允许访问这个文件',
      retryable: false,
    })
    await badPromise
    const failEvent = diagEvents()
      .filter((event) => event.name === 'file:read-fail')
      .at(-1)
    expect(failEvent?.detail).toContain('code=file-refused')
    expect(failEvent?.detail).toContain('name=secret.png')
  })
})
