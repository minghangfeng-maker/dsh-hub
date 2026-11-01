/**
 * `WorkspaceController.readFile` 的持久缓存 / 路径读取 / 失败重试（0.2.14 真机反馈 ① ②）。
 *
 * 这些用例对应真机上的两条抱怨：
 *  - 「交付物图片一直正在加载图片…」→ 读取失败要能重试，不能无限转圈；
 *  - 「重新打开会话交付物大概率超时」→ 下载一次后落盘，重开不再发 `file-read`。
 */

import { describe, expect, it } from 'vitest'
import { MemoryFileStore, fileCacheKeyOf } from '../src/cache/file-store.js'
import { FileDownloadError, bytesToBase64 } from '../src/channel/files.js'
import { createHarness, helloFrame, sessionRow, sessionsFrame, sleep, type FakeChannel } from './helpers/fake-channel.js'

const ACCOUNT = 'https://hub.test|alice'

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

type Harness = ReturnType<typeof createHarness>

async function boot(overrides: Parameters<typeof createHarness>[0] = {}): Promise<{
  h: Harness
  channel: FakeChannel
}> {
  const h = createHarness(overrides)
  h.controller.start()
  await sleep(0)
  const channel = h.channels[h.channels.length - 1]!
  channel.emitOpen()
  channel.server(
    helloFrame({
      requestId: channel.last('hello').requestId,
      capabilities: V2_CAPS,
      capabilitiesV2: V2_CAPS_EXTRA,
      features: FEATURES,
    }),
  )
  const sessionsRequest = channel.last('sessions')
  channel.server(sessionsFrame(sessionsRequest.requestId, [sessionRow('s1')]))
  await sleep(0)
  h.controller.openSession('s1')
  await sleep(0)
  const historyRequest = channel.last('history')
  channel.server({
    v: 1,
    type: 'history',
    requestId: historyRequest.requestId,
    sessionId: 's1',
    items: [],
    nextBeforeSeq: null,
    cursor: 10,
    hasMore: false,
  })
  await sleep(0)
  return { h, channel }
}

/** 一次性 `file` 帧（小文件走这条；大文件走 file-chunk，语义一致）。 */
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
    data: bytesToBase64(input.bytes),
  }
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor 超时')
    await sleep(2)
  }
}

describe('readFile：持久缓存优先（重开会话不再走通道）', () => {
  it('命中持久缓存：不发 file-read，直接返回字节（fromCache=true）', async () => {
    const store = new MemoryFileStore()
    const payload = new TextEncoder().encode('cached png bytes')
    await store.put({
      accountKey: ACCOUNT,
      sessionId: 's1',
      key: 'ref-cached',
      name: 'cached.png',
      mimeType: 'image/png',
      mediaType: 'image',
      bytes: payload.byteLength,
      data: payload,
      cachedAt: Date.now(),
      touchedAt: Date.now(),
    })
    const { h, channel } = await boot({ fileStore: store, accountKey: ACCOUNT })
    const file = await h.controller.readFile('s1', { fileRef: 'ref-cached' })
    expect([...file.bytes]).toEqual([...payload])
    expect(file.fromCache).toBe(true)
    expect(file.name).toBe('cached.png')
    expect(channel.count('file-read')).toBe(0)
  })

  it('路径键也能命中（正文里的云端路径图片）', async () => {
    const store = new MemoryFileStore()
    const path = '/workspace/out/pelican-ride-hd.png'
    const payload = new TextEncoder().encode('pelican')
    const key = fileCacheKeyOf({ path })!
    await store.put({
      accountKey: ACCOUNT,
      sessionId: 's1',
      key,
      name: 'pelican-ride-hd.png',
      mimeType: 'image/png',
      mediaType: 'image',
      bytes: payload.byteLength,
      data: payload,
      cachedAt: Date.now(),
      touchedAt: Date.now(),
    })
    const { h, channel } = await boot({ fileStore: store, accountKey: ACCOUNT })
    const file = await h.controller.readFile('s1', { path })
    expect([...file.bytes]).toEqual([...payload])
    expect(file.fromCache).toBe(true)
    expect(channel.count('file-read')).toBe(0)
  })

  it('网络下载成功后会落盘：新开一个 controller（模拟重开 App）直接命中', async () => {
    const store = new MemoryFileStore()
    const payload = new Uint8Array([1, 2, 3, 4, 5])

    const first = await boot({ fileStore: store, accountKey: ACCOUNT })
    const promise = first.h.controller.readFile('s1', {
      fileRef: 'ref-new',
      name: 'new.png',
      mimeType: 'image/png',
      mediaType: 'image',
    })
    await waitFor(() => first.channel.count('file-read') === 1)
    first.channel.server(
      fileFrame(first.channel.last('file-read').requestId, {
        fileRef: 'ref-new',
        name: 'new.png',
        mimeType: 'image/png',
        mediaType: 'image',
        bytes: payload,
      }),
    )
    const file = await promise
    expect([...file.bytes]).toEqual([...payload])
    // persistFile 是异步落盘：等它写完
    await sleep(10)
    expect(await store.has(ACCOUNT, 's1', 'ref-new')).toBe(true)

    // 第二个 controller：内存缓存是空的，必须靠持久缓存命中
    const second = await boot({ fileStore: store, accountKey: ACCOUNT })
    const again = await second.h.controller.readFile('s1', { fileRef: 'ref-new' })
    expect([...again.bytes]).toEqual([...payload])
    expect(again.fromCache).toBe(true)
    expect(second.channel.count('file-read')).toBe(0)
  })

  it('账号隔离：别的账号的同名 fileRef 不会命中', async () => {
    const store = new MemoryFileStore()
    await store.put({
      accountKey: 'https://hub.test|bob',
      sessionId: 's1',
      key: 'ref-shared',
      name: 'bob.png',
      mimeType: 'image/png',
      mediaType: 'image',
      bytes: 1,
      data: new Uint8Array([9]),
      cachedAt: Date.now(),
      touchedAt: Date.now(),
    })
    const { h, channel } = await boot({ fileStore: store, accountKey: ACCOUNT })
    const promise = h.controller.readFile('s1', { fileRef: 'ref-shared' })
    await waitFor(() => channel.count('file-read') === 1)
    // 没有命中别人的缓存：确实发了网络请求
    expect(channel.last('file-read').fileRef).toBe('ref-shared')
    channel.server(
      fileFrame(channel.last('file-read').requestId, {
        fileRef: 'ref-shared',
        name: 'alice.png',
        mimeType: 'image/png',
        mediaType: 'image',
        bytes: new Uint8Array([1]),
      }),
    )
    const file = await promise
    expect([...file.bytes]).toEqual([1])
  })
})

describe('readFile：路径读取（正文图片走 readFile({path})）', () => {
  it('只带 path 时发 file-read 的 path 字段（不是 fileRef），成功后按 path: 键落盘', async () => {
    const store = new MemoryFileStore()
    const path = '/workspace/out/pelican-ride.gif'
    const payload = new Uint8Array([7, 7, 7])

    const { h, channel } = await boot({ fileStore: store, accountKey: ACCOUNT })
    const promise = h.controller.readFile('s1', { path, name: 'pelican-ride.gif' })
    await waitFor(() => channel.count('file-read') === 1)
    const sent = channel.last('file-read')
    expect(sent.path).toBe(path)
    expect(sent.fileRef).toBeUndefined()
    channel.server(
      fileFrame(sent.requestId, {
        fileRef: 'ref-from-path',
        name: 'pelican-ride.gif',
        mimeType: 'image/gif',
        mediaType: 'image',
        bytes: payload,
      }),
    )
    const file = await promise
    expect(file.mimeType).toBe('image/gif')
    expect(file.cacheKey).toBe(`path:${path}`)
    await sleep(5)
    expect(await store.has(ACCOUNT, 's1', `path:${path}`)).toBe(true)
    // 第二次读同一路径：命中内存缓存，不再发帧
    await h.controller.readFile('s1', { path })
    expect(channel.count('file-read')).toBe(1)
  })

  it('既没有 fileRef 也没有 path：直接报 file-refused，不发帧', async () => {
    const { h, channel } = await boot()
    await expect(h.controller.readFile('s1', {})).rejects.toMatchObject({
      code: 'file-refused',
      retryable: false,
    })
    expect(channel.count('file-read')).toBe(0)
  })
})

describe('readFile：失败重试与错误态', () => {
  it('可重试错误（upstream-unavailable）自动退避重试，第二次成功', async () => {
    const { h, channel } = await boot({ fileRetry: { attempts: 3, baseDelayMs: 1, timeoutMs: 200 } })
    const payload = new Uint8Array([2, 4, 6])
    const promise = h.controller.readFile('s1', { fileRef: 'ref-retry', mediaType: 'image' })
    await waitFor(() => channel.count('file-read') === 1)
    const first = channel.last('file-read')
    channel.server({
      v: 1,
      type: 'error',
      requestId: first.requestId,
      code: 'upstream-unavailable',
      message: '服务暂时不可用，请稍后重试',
      retryable: true,
    })
    await waitFor(() => channel.count('file-read') === 2)
    const second = channel.last('file-read')
    expect(second.requestId).not.toBe(first.requestId)
    channel.server(
      fileFrame(second.requestId, {
        fileRef: 'ref-retry',
        name: 'retry.png',
        mimeType: 'image/png',
        mediaType: 'image',
        bytes: payload,
      }),
    )
    const file = await promise
    expect([...file.bytes]).toEqual([...payload])
    expect(channel.count('file-read')).toBe(2)
  })

  it('明确拒绝（file-refused）不重试，抛出可识别的错误', async () => {
    const { h, channel } = await boot({ fileRetry: { attempts: 3, baseDelayMs: 1, timeoutMs: 200 } })
    const promise = h.controller.readFile('s1', { path: '/etc/passwd' })
    await waitFor(() => channel.count('file-read') === 1)
    channel.server({
      v: 1,
      type: 'error',
      requestId: channel.last('file-read').requestId,
      code: 'file-refused',
      message: '不允许访问这个文件',
      retryable: false,
    })
    await expect(promise).rejects.toBeInstanceOf(FileDownloadError)
    await expect(promise).rejects.toMatchObject({ code: 'file-refused', retryable: false })
    await sleep(10)
    expect(channel.count('file-read')).toBe(1)
  })

  it('第一次超时（云容器刚唤醒）会重试，第二次成功', async () => {
    const { h, channel } = await boot({
      fileRetry: { attempts: 2, baseDelayMs: 1, timeoutMs: 15 },
    })
    const payload = new Uint8Array([5])
    const promise = h.controller.readFile('s1', { fileRef: 'ref-slow' })
    await waitFor(() => channel.count('file-read') === 1)
    // 第一次故意不回帧 → 15ms 后超时 → 自动重试
    await waitFor(() => channel.count('file-read') === 2)
    channel.server(
      fileFrame(channel.last('file-read').requestId, {
        fileRef: 'ref-slow',
        name: 'slow.png',
        mimeType: 'image/png',
        mediaType: 'image',
        bytes: payload,
      }),
    )
    const file = await promise
    expect([...file.bytes]).toEqual([...payload])
    expect(channel.count('file-read')).toBe(2)
  })

  it('重试用尽后抛超时错误（UI 据此显示重试按钮，而不是永远转圈）', async () => {
    const { h, channel } = await boot({
      fileRetry: { attempts: 2, baseDelayMs: 1, timeoutMs: 10 },
    })
    const promise = h.controller.readFile('s1', { fileRef: 'ref-dead' })
    await waitFor(() => channel.count('file-read') === 2)
    await expect(promise).rejects.toMatchObject({ code: 'timeout', retryable: true })
    expect(channel.count('file-read')).toBe(2)
  })
})
