import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { openSse, pipeEvents } from '../src/lib/sse.js'
import { createEventBus } from '../src/lib/events.js'
import { createTestApp, type TestApp } from './helpers.js'

let ctx: TestApp
let app: FastifyInstance

beforeEach(async () => {
  ctx = await createTestApp()
  app = ctx.app
})

afterEach(async () => {
  await ctx.close()
})

describe('SSE（04 §0）', () => {
  it('按 event/data 格式输出，含心跳注释行，close 后结束', async () => {
    app.get('/api/test/sse', async (_req, reply) => {
      const stream = openSse(reply, { pingMs: 15 })
      stream.send('status', { ok: true })
      setTimeout(() => {
        stream.send('done', { n: 1 })
        stream.close()
      }, 60)
      return reply
    })

    const res = await app.inject({ method: 'GET', url: '/api/test/sse' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.headers['cache-control']).toContain('no-store')
    expect(res.body).toContain('event: status\ndata: {"ok":true}\n\n')
    expect(res.body).toContain('event: done\ndata: {"n":1}\n\n')
    expect(res.body).toContain(': connected')
    expect(res.body).toContain(': ping')
  })

  it('close 之后 send/comment 是空操作', async () => {
    app.get('/api/test/sse-close', async (_req, reply) => {
      const stream = openSse(reply, { pingMs: 1000 })
      stream.close()
      expect(stream.closed).toBe(true)
      stream.send('status', { ignored: true })
      stream.comment('ignored')
      return reply
    })
    const res = await app.inject({ method: 'GET', url: '/api/test/sse-close' })
    expect(res.body).not.toContain('ignored')
  })

  it('pipeEvents 把总线事件转发成 SSE 事件，流关闭后退订', async () => {
    const bus = createEventBus()
    app.get('/api/test/sse-bus', async (_req, reply) => {
      const stream = openSse(reply, { pingMs: 1000 })
      pipeEvents(stream, (emit) => {
        const off = bus.on('job.updated', (payload) => emit('job', payload))
        return off
      })
      setTimeout(() => bus.emit('job.updated', { job: { id: 1 } as never }), 20)
      setTimeout(() => stream.close(), 80)
      return reply
    })
    const res = await app.inject({ method: 'GET', url: '/api/test/sse-bus' })
    expect(res.body).toContain('event: job')
    expect(res.body).toContain('"id":1')
  })
})

describe('事件总线', () => {
  it('on/emit/once/退订/清理', () => {
    const bus = createEventBus()
    const seen: string[] = []
    const off = bus.on('export.progress', (p) => seen.push(`progress:${p.progress.filesDone}`))
    bus.emit('export.progress', {
      userId: 1,
      exportId: 1,
      progress: { bytesWritten: 0, filesDone: 2, filesTotal: 5 },
    })
    off()
    bus.emit('export.progress', {
      userId: 1,
      exportId: 1,
      progress: { bytesWritten: 0, filesDone: 3, filesTotal: 5 },
    })
    expect(seen).toEqual(['progress:2'])

    let onceCount = 0
    bus.once('export.done', () => (onceCount += 1))
    bus.emit('export.done', { userId: 1, exportId: 1, item: {} as never })
    bus.emit('export.done', { userId: 1, exportId: 1, item: {} as never })
    expect(onceCount).toBe(1)

    expect(bus.listenerCount()).toBe(0)
  })

  it('订阅者抛错不影响其它订阅者', () => {
    const errors: unknown[] = []
    const bus = createEventBus({ onError: (error) => errors.push(error) })
    const seen: number[] = []
    bus.on('job.log', () => {
      throw new Error('boom')
    })
    bus.on('job.log', (p) => seen.push(p.taskId))
    bus.emit('job.log', { jobId: 1, taskId: 7, chunk: 'x' })
    expect(seen).toEqual([7])
    expect(errors).toHaveLength(1)
  })
})
