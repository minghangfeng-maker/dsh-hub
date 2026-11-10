/**
 * 上传分片的三道兜底（0.4.14 / 2026-11-10 真机事故回归）。
 *
 * 事故：手机上发 15.9 MiB 的 HTML，`upload-chunk` 每片只花一个 RTT（窗口 = 1），
 * 5G 上就是 20~30 片/秒；老 Hub 的上行配额是 20 帧/秒且把分片也算进去，片 17 被拒，
 * 拒绝帧还没有 requestId → 上传任务没人推 → 气泡永远停在「发送中…」。
 *
 * 这里直接单测 `UploadService`（假计时器，秒级等待不花真实时间）：
 *  1. 发出节流：两片之间至少 66ms（≤15 片/秒，给控制帧留余量）；
 *  2. `rate-limited`（帧没被转发）→ 同一 seq 退避重发，不判整条失败；
 *  3. 看门狗：回包一直不来 → 同 seq 重发，超过上限 → failed（气泡可重试），绝不僵尸。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { RequestRegistry, type RequestFrame } from '../src/channel/requests.js'
import { UploadService } from '../src/channel/upload-service.js'
import { bytesToBase64 } from '../src/channel/files.js'
import type { AnyServerFrame } from '../src/channel/wire.js'
import type { WorkspaceState } from '../src/channel/workspace-state.js'

type Started = Extract<AnyServerFrame, { type: 'upload-started' }>
type Received = Extract<AnyServerFrame, { type: 'upload-received' }>

interface Harness {
  service: UploadService
  frames: RequestFrame[]
  chunks: () => Array<Extract<RequestFrame, { type: 'upload-chunk' }>>
  uploads: () => WorkspaceState['uploads']
}

function createHarness(): Harness {
  const frames: RequestFrame[] = []
  let uploads: WorkspaceState['uploads'] = []
  const state = { features: ['attachments'], uploads } as unknown as WorkspaceState
  const requests = new RequestRegistry(
    (frame) => {
      frames.push(frame)
      return true
    },
    () => 0,
  )
  const service = new UploadService({
    state: () => state,
    patch: (partial) => {
      if (partial.uploads !== undefined) uploads = partial.uploads
    },
    send: (frame) => {
      frames.push(frame)
      return true
    },
    requests,
    fail: () => undefined,
  })
  return {
    service,
    frames,
    chunks: () => frames.filter((frame): frame is Extract<RequestFrame, { type: 'upload-chunk' }> => frame.type === 'upload-chunk'),
    uploads: () => uploads,
  }
}

function startUpload(h: Harness): string {
  // 3000 字节 → base64 4000 字符；单片上限设 1500 → 两片（2000 + 2000 字符）
  const localId = h.service.uploadAttachment('s1', {
    kind: 'file',
    name: 'a.bin',
    mimeType: 'application/octet-stream',
    bytes: 3000,
    data: bytesToBase64(new TextEncoder().encode('x'.repeat(3000))),
  })!
  expect(localId).toBeTruthy()
  const begin = h.frames.find((frame) => frame.type === 'upload-begin')!
  h.service.onStarted({
    v: 1,
    type: 'upload-started',
    requestId: begin.requestId,
    uploadId: 'up_1',
    maxChunkBytes: 1500,
  } as Started)
  return localId
}

function ack(h: Harness, chunk: { requestId: string; seq: number }, received: number): void {
  h.service.onReceived({
    v: 1,
    type: 'upload-received',
    requestId: chunk.requestId,
    uploadId: 'up_1',
    seq: chunk.seq,
    received,
  } as Received)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('上传分片兜底（0.4.14）', () => {
  it('发出节流：一片确认后不立刻发下一片，至少等 66ms（≤15 片/秒）', () => {
    vi.useFakeTimers()
    const h = createHarness()
    startUpload(h)
    expect(h.chunks()).toHaveLength(1)
    expect(h.chunks()[0]).toMatchObject({ seq: 0 })

    ack(h, h.chunks()[0]!, 1500)
    // 确认到了，但下一片被节流住（不占用老 Hub 的 20 帧/秒控制配额）
    expect(h.chunks()).toHaveLength(1)
    vi.advanceTimersByTime(40)
    expect(h.chunks()).toHaveLength(1)
    vi.advanceTimersByTime(40)
    expect(h.chunks()).toHaveLength(2)
    expect(h.chunks()[1]).toMatchObject({ seq: 1, final: true })
  })

  it('rate-limited（Hub 没转发这一片）→ 同一 seq 退避重发，不判整条失败', () => {
    vi.useFakeTimers()
    const h = createHarness()
    startUpload(h)
    const first = h.chunks()[0]!
    h.service.failRequest(first.requestId, 'rate-limited', '上行过快')
    // 还在上传中（不是 failed），也没有立刻再发
    expect(h.uploads()[0]!.state).toBe('uploading')
    expect(h.chunks()).toHaveLength(1)
    vi.advanceTimersByTime(800)
    expect(h.chunks()).toHaveLength(2)
    // 同一 seq、新 requestId：服务端的 nextSeq 没动过，重发是安全的
    expect(h.chunks()[1]).toMatchObject({ seq: 0 })
    expect(h.chunks()[1]!.requestId).not.toBe(first.requestId)
  })

  it('看门狗：回包不来就同 seq 重发，超过上限整条 failed（绝不僵尸「发送中…」）', () => {
    vi.useFakeTimers()
    const h = createHarness()
    startUpload(h)
    const first = h.chunks()[0]!

    vi.advanceTimersByTime(12_000)
    expect(h.chunks()).toHaveLength(2)
    expect(h.chunks()[1]).toMatchObject({ seq: 0 })
    expect(h.chunks()[1]!.requestId).not.toBe(first.requestId)

    vi.advanceTimersByTime(12_000)
    expect(h.chunks()).toHaveLength(3)

    vi.advanceTimersByTime(12_000)
    // 重发额度用尽：判失败，UI 的待发气泡会显示「附件上传失败」+ 重试
    expect(h.uploads()[0]!.state).toBe('failed')
    expect(h.uploads()[0]!.error).toContain('上传超时')
  })

  it('通道级可重试错误（没有 requestId）→ onChannelPressure 让在飞的那一片退避重发', () => {
    vi.useFakeTimers()
    const h = createHarness()
    startUpload(h)
    expect(h.service.onChannelPressure()).toBe(true)
    expect(h.chunks()).toHaveLength(1)
    vi.advanceTimersByTime(1_000)
    expect(h.chunks()).toHaveLength(2)
    expect(h.chunks()[1]).toMatchObject({ seq: 0 })
  })

  it('没有在飞分片时 onChannelPressure 不动任何东西', () => {
    vi.useFakeTimers()
    const h = createHarness()
    expect(h.service.onChannelPressure()).toBe(false)
  })
})
