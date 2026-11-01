import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp, json, type TestApp } from './helpers.js'
import { HUB_VERSION } from '../src/config.js'

let ctx: TestApp
let app: FastifyInstance

beforeEach(async () => {
  ctx = await createTestApp()
  app = ctx.app
})

afterEach(async () => {
  await ctx.close()
})

describe('GET /api/health（04 §1）', () => {
  it('返回 ok/version/db/docker，且不缓存', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const body = json<{ ok: boolean; version: string; db: string; docker: string }>(res)
    expect(body).toEqual({ ok: true, version: HUB_VERSION, db: 'ok', docker: 'disabled' })
  })

  it('fake 驱动下 docker 是 disabled；docker 驱动连不上时是 error', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(json<{ docker: string }>(res).docker).toBe('disabled')

    // 明确指一个不存在的 socket：开发机上 Docker 可能是好的，不能靠「连不上」碰运气
    const other = await createTestApp({
      env: { HUB_CONTAINER_DRIVER: 'docker', DOCKER_HOST: 'unix:///tmp/dshhub-no-such-docker.sock' },
      driver: null,
    })
    try {
      const dockerRes = await other.app.inject({ method: 'GET', url: '/api/health' })
      expect(json<{ docker: string }>(dockerRes).docker).toBe('error')
      expect(json<{ ok: boolean }>(dockerRes).ok).toBe(true)
    } finally {
      await other.close()
    }
  })

  it('不需要登录、不受 CSRF 限制（GET）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://evil.example' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('数据库不可用时 ok=false、db=error（不抛 500）', async () => {
    ctx.app.deps.db.close()
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(json<{ ok: boolean; db: string }>(res)).toMatchObject({ ok: false, db: 'error' })
  })
})
