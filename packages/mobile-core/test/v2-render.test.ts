/**
 * A2：v2 帧在状态机里的渲染语义（工具卡 / 思考 / 文件 / 附件上传）。
 *
 * 数据形状全部来自真实录制：`mobile-plan/v2/fixtures-v2/`（DSH Host 帧）与
 * `WP40c2-进度.md` §2（Hub 投影后的手机帧）。这里把它们按 App 实际收到的样子喂给
 * `WorkspaceController`，断言 UI 依赖的状态字段，而不是断言 UI 像素。
 */

import { describe, expect, it } from 'vitest'
import {
  bootWithSessions,
  createHarness,
  deltaFrame,
  helloFrame,
  historyFrame,
  openSession,
  sessionRow,
  sessionsFrame,
  sleep,
  type FakeChannel,
} from './helpers/fake-channel.js'
import {
  FileAssembler,
  FileCache,
  FileSequenceError,
  base64ToBytes,
  bytesToBase64,
  sha256Hex,
  verifyAssembled,
} from '../src/channel/files.js'
import {
  createUploadTask,
  nextUploadChunk,
  toOutgoingAttachment,
  uploadView,
} from '../src/channel/upload.js'
import { collectFiles, mergeThread, toolSummary } from '../src/channel/tools.js'
import type { ChatEntry } from '../src/channel/workspace.js'

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
const ALL_FEATURES = [
  'models',
  'tools',
  'reasoning',
  'files',
  'deliverables',
  'attachments',
  'rename',
  'archive',
]

function v2Hello(requestId: string): unknown {
  return helloFrame({
    requestId,
    capabilities: V2_CAPS,
    capabilitiesV2: V2_CAPS_EXTRA,
    features: ALL_FEATURES,
  })
}

/** 真实 `tool` 帧形状（WP40c2-进度 §2 d）。 */
function toolStart(overrides: Record<string, unknown> = {}): unknown {
  return {
    v: 1,
    type: 'tool',
    sessionId: 's1',
    callId: 'call_search_1',
    kind: 'search',
    name: 'web_search',
    phase: 'start',
    seq: 17,
    turn: 1,
    step: 1,
    status: 'running',
    title: '搜索网页',
    inputPreview: 'DSH Hub 手机通道 v2 冻结裁决',
    inputBytes: 60,
    ...overrides,
  }
}

function toolEnd(overrides: Record<string, unknown> = {}): unknown {
  return {
    v: 1,
    type: 'tool',
    sessionId: 's1',
    callId: 'call_search_1',
    kind: 'search',
    name: 'web_search',
    phase: 'end',
    seq: 20,
    turn: 1,
    step: 1,
    status: 'ok',
    title: '搜索网页',
    outputPreview: '1. M5 契约\n2. 开发文档\n3. WP40c2',
    outputBytes: 42,
    citations: [
      { title: 'M5 契约', url: 'https://example.invalid/m5' },
      { title: '开发文档', url: 'https://example.invalid/doc' },
      { title: 'WP40c2', url: 'https://example.invalid/wp' },
    ],
    durationMs: 860,
    ...overrides,
  }
}

async function bootV2() {
  const h = createHarness()
  h.controller.start()
  await sleep(0)
  const channel = h.channels[h.channels.length - 1]!
  channel.emitOpen()
  channel.server(v2Hello(channel.last('hello').requestId))
  const sessionsRequest = channel.last('sessions')
  channel.server(sessionsFrame(sessionsRequest.requestId, [sessionRow('s1')]))
  await sleep(0)
  return { h, channel }
}

async function openV2Session(h: ReturnType<typeof createHarness>, channel: FakeChannel, items: unknown[] = []) {
  h.controller.openSession('s1')
  await sleep(0)
  openSession(channel, 's1', items)
  await sleep(0)
}

describe('工具卡（v2 tools）', () => {
  it('start + end 合并成一张卡：摘要、来源、耗时', async () => {
    const { h, channel } = await bootV2()
    await openV2Session(h, channel)
    channel.server(toolStart())
    channel.server(toolEnd())
    await sleep(0)
    const cards = h.controller.getState().toolCards
    expect(cards).toHaveLength(1)
    const card = cards[0]!
    expect(card.callId).toBe('call_search_1')
    expect(card.phase).toBe('end')
    expect(card.status).toBe('ok')
    expect(card.citations).toHaveLength(3)
    expect(card.durationMs).toBe(860)
    expect(toolSummary(card)).toBe('搜索了 3 个网页')
  })

  it('history 重进会话时 adapter 会补发 tool 帧：同一 callId 幂等', async () => {
    const { h, channel } = await bootV2()
    await openV2Session(h, channel)
    channel.server(toolStart())
    channel.server(toolEnd())
    // 重进会话：history + 补发工具帧
    h.controller.closeSession()
    await sleep(0)
    h.controller.openSession('s1')
    await sleep(0)
    channel.server(historyFrame(channel.last('history').requestId, 's1', []))
    channel.server(toolStart({ seq: 17 }))
    channel.server(toolEnd({ seq: 20 }))
    await sleep(0)
    expect(h.controller.getState().toolCards).toHaveLength(1)
  })

  it('运行命令 / Python / 交付 / 其它工具的摘要都是人话', () => {
    const base = {
      sessionId: 's1',
      callId: 'c',
      name: 'x',
      phase: 'end' as const,
      status: 'ok' as const,
      seq: 1,
      turn: 1,
      step: 1,
      title: '',
      files: [],
      citations: [],
    }
    expect(toolSummary({ ...base, kind: 'python', title: '运行 Python' })).toBe('运行 Python')
    // 座舱 @dshhub/ops 的工具显示中文动作名（没有 title 时）
    expect(toolSummary({ ...base, kind: 'other', name: 'ops_find', title: '' })).toBe('查能力目录')
    expect(toolSummary({ ...base, kind: 'other', name: 'canvas_show', title: '' })).toBe('投放画布卡')
    expect(toolSummary({ ...base, kind: 'other', name: 'ops_find', title: 'ops_find' })).toBe('查能力目录')
    expect(toolSummary({ ...base, kind: 'bash', title: '运行命令' })).toBe('运行命令')
    expect(toolSummary({ ...base, kind: 'file-read', title: '读取文件' })).toBe('读取文件')
    expect(toolSummary({ ...base, kind: 'other', title: '未知工具' })).toBe('未知工具')
    expect(
      toolSummary({
        ...base,
        kind: 'search',
        status: 'error',
        citations: [],
      }),
    ).toBe('搜索了网页 · 失败')
  })

  it('摘要带对象：命令首行 / 文件名 / 搜索词（参考 Claude Code 的 Bash(cmd)/Write(path) 一行式）', () => {
    const base = {
      sessionId: 's1',
      callId: 'c',
      name: 'x',
      phase: 'end' as const,
      status: 'ok' as const,
      seq: 1,
      turn: 1,
      step: 1,
      title: '',
      files: [],
      citations: [],
    }
    expect(toolSummary({ ...base, kind: 'bash', inputPreview: 'sleep 90  # 等渲染\n' })).toBe('运行 sleep 90 # 等渲染')
    expect(toolSummary({ ...base, kind: 'file-write', inputPreview: '/workspace/outputs/chart.png' })).toBe('写入 chart.png')
    expect(toolSummary({ ...base, kind: 'file-read', inputPreview: 'C:\\Users\\me\\build.js' })).toBe('读取 build.js')
    expect(toolSummary({ ...base, kind: 'search', inputPreview: '赛博朋克 鹈鹕' })).toBe('搜索「赛博朋克 鹈鹕」')
    expect(toolSummary({ ...base, kind: 'fetch', inputPreview: 'https://example.com/a/b' })).toBe('打开 https://example.com/a/b')
    const long = 'x'.repeat(80)
    expect(toolSummary({ ...base, kind: 'bash', inputPreview: long })).toMatch(/^运行 x+…$/u)
  })

  it('失败的工具有 error 结构，输出预览仍在', async () => {
    const { h, channel } = await bootV2()
    await openV2Session(h, channel)
    channel.server(toolStart({ callId: 'call_search_err', seq: 30 }))
    channel.server(
      toolEnd({
        callId: 'call_search_err',
        seq: 31,
        status: 'error',
        error: { name: 'WebSearchError', code: 'upstream-401' },
        citations: undefined,
        outputPreview: '401 Unauthorized',
      }),
    )
    await sleep(0)
    const card = h.controller.getState().toolCards[0]!
    expect(card.status).toBe('error')
    expect(card.error?.code).toBe('upstream-401')
    expect(card.outputPreview).toBe('401 Unauthorized')
    expect(toolSummary(card)).toContain('失败')
  })
})

describe('思考过程（v2 reasoning）', () => {
  it('reasoning 增量与 done 分开处理（done 帧没有 text）', async () => {
    const { h, channel } = await bootV2()
    await openV2Session(h, channel)
    channel.server(deltaFrame('s1', 'att1', 0, '先想一下', 'reasoning'))
    channel.server(deltaFrame('s1', 'att1', 1, '用户在问什么。', 'reasoning'))
    await sleep(0)
    expect(h.controller.getState().streamingReasoning).toBe('先想一下用户在问什么。')
    expect(h.controller.getState().reasoningDone).toBe(false)
    // 真实 adapter：part 只有 kind，没有 text
    channel.server({
      v: 1,
      type: 'delta',
      sessionId: 's1',
      attemptId: 'att1',
      revision: 1,
      index: 2,
      turn: 1,
      step: 1,
      part: { kind: 'reasoning' },
      done: true,
    })
    await sleep(0)
    expect(h.controller.getState().reasoningDone).toBe(true)
    expect(h.controller.getState().streamingReasoning).toBe('先想一下用户在问什么。')
  })

  it('正文一开始输出，思考块就算结束（老 Hub 不发 done 也能收起）', async () => {
    const { h, channel } = await bootV2()
    await openV2Session(h, channel)
    channel.server(deltaFrame('s1', 'att1', 0, '想一想', 'reasoning'))
    channel.server(deltaFrame('s1', 'att1', 1, '答案是', 'text'))
    await sleep(0)
    expect(h.controller.getState().reasoningDone).toBe(true)
  })

  it('v1 capability 帧不会抹掉 v2 能力位（真实 Hub 会在 hello 后再发一次）', async () => {
    const { h, channel } = await bootV2()
    await sleep(0)
    expect(h.controller.getState().capabilities?.filesRead).toBe(true)
    channel.server({
      v: 1,
      type: 'capability',
      capabilities: { ...V2_CAPS, send: false },
    })
    await sleep(0)
    const caps = h.controller.getState().capabilities
    expect(caps?.send).toBe(false)
    expect(caps?.filesRead).toBe(true)
    expect(caps?.filesUpload).toBe(true)
    expect(caps?.deliverables).toBe(true)
  })

  it('history 里的 reasoning 渲染在助手消息上', async () => {
    const { h, channel } = await bootV2()
    await openV2Session(h, channel, [
      { seq: 11, role: 'user', at: 1, text: '画个图' },
      { seq: 12, role: 'assistant', at: 2, text: '好了。', reasoning: '先确认中文字体，再用 matplotlib。' },
    ])
    await sleep(0)
    const entry = h.controller.getState().messages.find((m) => m.role === 'assistant')!
    expect(entry.reasoning).toBe('先确认中文字体，再用 matplotlib。')
  })

  it('live 回合的思考会跟着 canonical 消息一起保留', async () => {
    const { h, channel } = await bootV2()
    await openV2Session(h, channel)
    channel.server(deltaFrame('s1', 'att1', 0, '先思考', 'reasoning'))
    await sleep(0)
    channel.server({
      v: 1,
      type: 'message',
      sessionId: 's1',
      seq: 40,
      role: 'assistant',
      at: 3,
      text: '这是回答。',
    })
    await sleep(0)
    const state = h.controller.getState()
    expect(state.streamingReasoning).toBeNull()
    const entry = state.messages.find((m) => m.seq === 40)!
    expect(entry.reasoning).toBe('先思考')
  })
})

describe('交付物与时间线', () => {
  it('deliverable 帧替代同 callId 的工具卡，文件可去重收集', async () => {
    const { h, channel } = await bootV2()
    await openV2Session(h, channel)
    channel.server({
      v: 1,
      type: 'tool',
      sessionId: 's1',
      callId: 'present1',
      kind: 'present',
      name: 'present',
      phase: 'end',
      seq: 45,
      turn: 1,
      step: 1,
      status: 'ok',
      title: '交付文件',
      files: [
        { fileRef: 'ref-a', name: 'chart.png', pathLabel: 'outputs/chart.png', mediaType: 'image', mimeType: 'image/png', bytes: 400000 },
      ],
    })
    channel.server({
      v: 1,
      type: 'deliverable',
      sessionId: 's1',
      seq: 46,
      turn: 1,
      callId: 'present1',
      files: [
        { fileRef: 'ref-a', name: 'chart.png', pathLabel: 'outputs/chart.png', mediaType: 'image', mimeType: 'image/png', bytes: 400000 },
        { fileRef: 'ref-b', name: 'notes.md', pathLabel: 'outputs/notes.md', mediaType: 'file', mimeType: 'text/markdown' },
      ],
    })
    await sleep(0)
    const state = h.controller.getState()
    expect(state.deliverables).toHaveLength(1)
    expect(collectFiles(state.toolCards, state.deliverables).map((f) => f.fileRef)).toEqual([
      'ref-a',
      'ref-b',
    ])
    const messages: ChatEntry[] = [
      { seq: 1, localId: null, role: 'user', text: '你好', tools: [], at: 1, pending: false, failed: false, unknown: false },
      { seq: 2, localId: null, role: 'system', text: '注入内容', tools: [], at: 2, pending: false, failed: false, unknown: false },
      { seq: 10, localId: null, role: 'assistant', text: '答', tools: [], at: 3, pending: false, failed: false, unknown: false },
    ]
    const thread = mergeThread(messages, state.toolCards, state.deliverables)
    // system 注入不出现；present 工具卡被交付物替代
    expect(thread.map((item) => item.kind)).toEqual(['message', 'message', 'deliverable'])
  })
})

describe('产出文件（v2 files）', () => {
  it('一次性 file 帧：sha256 校验通过才 resolve，坏哈希要拒', async () => {
    const bytes = new TextEncoder().encode('hello 中文')
    const good = await sha256Hex(bytes)
    const h = createHarness()
    h.controller.start()
    await sleep(0)
    const channel = h.channels[h.channels.length - 1]!
    channel.emitOpen()
    channel.server(v2Hello(channel.last('hello').requestId))
    channel.server(sessionsFrame(channel.last('sessions').requestId, [sessionRow('s1')]))
    await sleep(0)
    await openV2Session(h, channel)

    const promise = h.controller.readFile('s1', {
      fileRef: 'ref-x',
      name: 'note.txt',
      mimeType: 'text/plain',
      mediaType: 'file',
      bytes: bytes.byteLength,
    })
    const request = channel.last('file-read')
    channel.server({
      v: 1,
      type: 'file',
      requestId: request.requestId,
      sessionId: 's1',
      fileRef: 'ref-x',
      name: 'note.txt',
      mediaType: 'file',
      mimeType: 'text/plain',
      bytes: bytes.byteLength,
      encoding: 'base64',
      data: bytesToBase64(bytes),
      sha256: good,
    })
    const file = await promise
    expect([...file.bytes]).toEqual([...bytes])
    // 缓存命中：第二次不再发 file-read
    await h.controller.readFile('s1', { fileRef: 'ref-x' })
    expect(channel.count('file-read')).toBe(1)

    const badPromise = h.controller.readFile('s1', { fileRef: 'ref-y', name: 'bad', bytes: 3 })
    const badRequest = channel.last('file-read')
    channel.server({
      v: 1,
      type: 'file',
      requestId: badRequest.requestId,
      sessionId: 's1',
      fileRef: 'ref-y',
      name: 'bad',
      mediaType: 'file',
      mimeType: 'text/plain',
      bytes: 3,
      encoding: 'base64',
      data: bytesToBase64(new TextEncoder().encode('abc')),
      sha256: '0'.repeat(64),
    })
    await expect(badPromise).rejects.toThrow(/校验失败/)
  })

  it('分片 file-chunk：按 seq 装配，final 带 bytes+sha256', async () => {
    const payload = new Uint8Array(4000).map((_, i) => i % 251)
    const digest = await sha256Hex(payload)
    const h = createHarness()
    h.controller.start()
    await sleep(0)
    const channel = h.channels[h.channels.length - 1]!
    channel.emitOpen()
    channel.server(v2Hello(channel.last('hello').requestId))
    channel.server(sessionsFrame(channel.last('sessions').requestId, [sessionRow('s1')]))
    await sleep(0)
    await openV2Session(h, channel)

    const promise = h.controller.readFile('s1', {
      fileRef: 'ref-big',
      name: 'big.png',
      mimeType: 'image/png',
      mediaType: 'image',
    })
    const request = channel.last('file-read')
    const mid = 144 * 1024
    // 这里用 4000 字节切成 3 片（真实上限 144KiB；分片语义与大小无关）
    const pieces = [payload.subarray(0, mid > payload.length ? 1500 : mid), payload.subarray(1500, 3000), payload.subarray(3000)]
    pieces.forEach((piece, index) => {
      const final = index === pieces.length - 1
      channel.server({
        v: 1,
        type: 'file-chunk',
        requestId: request.requestId,
        sessionId: 's1',
        fileRef: 'ref-big',
        seq: index,
        final,
        encoding: 'base64',
        data: bytesToBase64(piece),
        ...(final ? { bytes: payload.byteLength, sha256: digest } : {}),
      })
    })
    const file = await promise
    expect(file.bytes.byteLength).toBe(payload.byteLength)
    expect(await sha256Hex(file.bytes)).toBe(digest)
    expect(file.mediaType).toBe('image')
    expect(file.mimeType).toBe('image/png')
  })

  it('分片乱序直接拒绝（不能把坏图显示出来）', () => {
    const assembler = new FileAssembler()
    expect(() => assembler.push({ seq: 1, data: 'AAAA', final: false })).toThrow(FileSequenceError)
  })

  it('缓存按会话隔离，超上限按 LRU 淘汰', () => {
    const cache = new FileCache(12)
    cache.put({ sessionId: 'a', fileRef: '1', name: '1', mimeType: 'x', mediaType: 'file', bytes: 6, data: new Uint8Array(6) })
    cache.put({ sessionId: 'b', fileRef: '1', name: '1', mimeType: 'x', mediaType: 'file', bytes: 6, data: new Uint8Array(6) })
    expect(cache.get('a', '1')).not.toBeNull()
    expect(cache.get('b', '1')).not.toBeNull()
    // 再放一个 6 字节：总量 18 > 12，淘汰最久未用的 a/1
    cache.put({ sessionId: 'c', fileRef: '1', name: '1', mimeType: 'x', mediaType: 'file', bytes: 6, data: new Uint8Array(6) })
    expect(cache.get('a', '1')).toBeNull()
    expect(cache.get('b', '1')).not.toBeNull()
  })

  it('base64 往返与校验工具（浏览器/Node 都可用）', async () => {
    const bytes = new TextEncoder().encode('a'.repeat(1000))
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes])
    expect(await verifyAssembled({ bytes }, { bytes: 1000 })).toEqual({ ok: true })
    expect((await verifyAssembled({ bytes }, { bytes: 999 })).ok).toBe(false)
  })
})

describe('附件上传（v2 attachments）', () => {
  it('upload-begin → started → chunk → received → uploaded → send.attachments', async () => {
    const { h, channel } = await bootV2()
    await openV2Session(h, channel)
    const data = bytesToBase64(new TextEncoder().encode('x'.repeat(3000)))
    const localId = h.controller.uploadAttachment('s1', {
      kind: 'image',
      name: 'p.png',
      mimeType: 'image/png',
      bytes: 3000,
      data,
    })!
    expect(localId).toBeTruthy()
    const begin = channel.last('upload-begin')
    expect(begin).toMatchObject({ sessionId: 's1', kind: 'image', name: 'p.png', bytes: 3000 })
    channel.server({
      v: 1,
      type: 'upload-started',
      requestId: begin.requestId,
      uploadId: 'up_1',
      maxChunkBytes: 144 * 1024,
    })
    await sleep(0)
    // 窗口=1：第一片发出后等 received
    const firstChunk = channel.last('upload-chunk')
    expect(firstChunk).toMatchObject({ uploadId: 'up_1', seq: 0, final: true })
    channel.server({
      v: 1,
      type: 'upload-received',
      requestId: firstChunk.requestId,
      uploadId: 'up_1',
      seq: 0,
      received: 3000,
    })
    channel.server({
      v: 1,
      type: 'uploaded',
      requestId: firstChunk.requestId,
      uploadId: 'up_1',
      kind: 'image',
      name: 'p.png',
      mimeType: 'image/png',
      bytes: 3000,
      expiresAt: Date.now() + 60_000,
    })
    await sleep(0)
    const task = h.controller.getState().uploads[0]!
    expect(task.state).toBe('ready')
    expect(task.progress).toBe(1)
    const outgoing = h.controller.outgoingAttachment(localId)
    expect(outgoing).toMatchObject({ kind: 'image', uploadId: 'up_1', name: 'p.png', bytes: 3000 })
    // 带附件发送
    h.controller.send('看看这张图', { attachments: [outgoing!] })
    const sendFrame = channel.last('send')
    expect(sendFrame.attachments).toHaveLength(1)
    expect(sendFrame.attachments[0].uploadId).toBe('up_1')
  })

  it('上传失败进 failed，可以重试（同一个 localId 从头来）', async () => {
    const { h, channel } = await bootV2()
    await openV2Session(h, channel)
    const localId = h.controller.uploadAttachment('s1', {
      kind: 'file',
      name: 'a.pdf',
      mimeType: 'application/pdf',
      bytes: 10,
      data: bytesToBase64(new TextEncoder().encode('0123456789')),
    })!
    const begin = channel.last('upload-begin')
    channel.server({
      v: 1,
      type: 'error',
      requestId: begin.requestId,
      code: 'file-too-large',
      message: '太大了',
      retryable: false,
    })
    await sleep(0)
    expect(h.controller.getState().uploads[0]!.state).toBe('failed')
    h.controller.retryUpload(localId)
    await sleep(0)
    expect(channel.count('upload-begin')).toBe(2)
  })

  it('超过该后端上限时不发帧，直接报错（桌面 1MiB）', () => {
    const task = createUploadTask('l1', 's1', {
      kind: 'file',
      name: 'big.bin',
      mimeType: 'application/octet-stream',
      bytes: 2 * 1024 * 1024,
      data: bytesToBase64(new Uint8Array(16)),
    })
    expect(uploadView(task).progress).toBe(0)
    expect(toOutgoingAttachment(task)).toBeNull()
    // 分片切片必须 base64 对齐（每片能独立 atob）
    const chunk = nextUploadChunk(task, 3000)!
    expect(chunk.data.length % 4).toBe(0)
    expect(() => atob(chunk.data)).not.toThrow()
  })
})
