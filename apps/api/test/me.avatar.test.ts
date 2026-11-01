import { existsSync, readdirSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { AVATAR_MAX_BYTES } from '@dsh-hub/shared'
import { createTestApp, createUser, json, loginAs, type TestApp, type TestUser } from './helpers.js'
import { errorCode, htmlBytes, jpegBytes, multipart, nextIp, pngBytes, webpBytes } from './wp1-helpers.js'

let ctx: TestApp
let app: FastifyInstance
let alice: TestUser
let session: ReturnType<typeof loginAs>

beforeEach(async () => {
  ctx = await createTestApp()
  app = ctx.app
  alice = await createUser(app, { username: 'alice' })
  session = loginAs(app, alice)
})

afterEach(async () => {
  await ctx.close()
})

function upload(
  data: Buffer,
  opts: { field?: string; filename?: string; contentType?: string; csrf?: boolean } = {},
) {
  const body = multipart(data, opts)
  const headers: Record<string, string> = { ...session.headers, ...body.headers }
  if (opts.csrf === false) delete headers['x-hub-csrf']
  return app.inject({ method: 'POST', url: '/api/me/avatar', headers, payload: body.payload })
}

function avatarFiles(): string[] {
  return readdirSync(ctx.app.deps.paths.avatarsDir)
}

describe('头像上传/删除/读取（04 §3 / 10 §B9）', () => {
  it('合法 png：返回 avatarUrl、落盘文件名含哈希、旧文件被删除', async () => {
    const first = await upload(pngBytes())
    expect(first.statusCode, first.body).toBe(200)
    const firstUrl = json<{ user: { avatarUrl: string } }>(first).user.avatarUrl
    expect(firstUrl).toMatch(new RegExp(`^/api/avatars/${alice.id}-[a-f0-9]{12}\\.png$`))
    expect(avatarFiles()).toEqual([firstUrl!.split('/').pop()])

    // 换一张内容不同的图：文件名变化，旧文件被清理
    const second = await upload(pngBytes(128))
    expect(second.statusCode).toBe(200)
    const secondUrl = json<{ user: { avatarUrl: string } }>(second).user.avatarUrl
    expect(secondUrl).not.toBe(firstUrl)
    expect(avatarFiles()).toEqual([secondUrl!.split('/').pop()])

    // 扩展名由魔数决定，而不是上传者给的文件名
    const jpeg = await upload(jpegBytes(), { filename: 'photo.png', contentType: 'image/jpeg' })
    expect(json<{ user: { avatarUrl: string } }>(jpeg).user.avatarUrl).toMatch(/\.jpg$/)

    const webp = await upload(webpBytes(), { filename: 'whatever', contentType: 'image/webp' })
    expect(json<{ user: { avatarUrl: string } }>(webp).user.avatarUrl).toMatch(/\.webp$/)
    expect(avatarFiles()).toHaveLength(1)
  })

  it('B9 超过 1MB → PAYLOAD_TOO_LARGE（413）', async () => {
    const big = Buffer.concat([pngBytes(), Buffer.alloc(AVATAR_MAX_BYTES + 1, 7)])
    const res = await upload(big)
    expect(res.statusCode).toBe(413)
    expect(errorCode(json(res))).toBe('PAYLOAD_TOO_LARGE')
    expect(avatarFiles()).toHaveLength(0)
  })

  it('B9 伪装成 png 的 HTML → UNSUPPORTED_MEDIA（415）', async () => {
    const res = await upload(htmlBytes(), { filename: 'avatar.png', contentType: 'image/png' })
    expect(res.statusCode).toBe(415)
    expect(errorCode(json(res))).toBe('UNSUPPORTED_MEDIA')
    expect(avatarFiles()).toHaveLength(0)
  })

  it('声明 MIME 与魔数不一致 → UNSUPPORTED_MEDIA', async () => {
    const res = await upload(pngBytes(), { contentType: 'image/gif' })
    expect(res.statusCode).toBe(415)
    expect(errorCode(json(res))).toBe('UNSUPPORTED_MEDIA')
  })

  it('删除头像：avatarUrl 变 null 且文件被删', async () => {
    await upload(pngBytes())
    expect(avatarFiles()).toHaveLength(1)
    const res = await app.inject({ method: 'DELETE', url: '/api/me/avatar', headers: session.headers })
    expect(res.statusCode).toBe(200)
    expect(json<{ user: { avatarUrl: string | null } }>(res).user.avatarUrl).toBeNull()
    expect(avatarFiles()).toHaveLength(0)
    // 重复删除是幂等的
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/me/avatar', headers: session.headers })).statusCode,
    ).toBe(200)
  })

  it('读取头像：固定 Content-Type + 一年强缓存 + nosniff（02 §T12）', async () => {
    const uploaded = await upload(pngBytes())
    const url = json<{ user: { avatarUrl: string } }>(uploaded).user.avatarUrl!
    const res = await app.inject({ method: 'GET', url, remoteAddress: nextIp() })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(String(res.headers['cache-control'])).toContain('max-age=31536000')
    expect(res.headers['cache-control']).toContain('immutable')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.rawPayload.subarray(0, 4).toString('hex')).toBe('89504e47')
  })

  it('读取头像：文件名不合法/穿越/不存在一律 404，不泄漏路径', async () => {
    for (const url of [
      '/api/avatars/not-a-valid-name.png',
      `/api/avatars/${alice.id}-aaaaaaaaaaaa.html`,
      '/api/avatars/..%2F..%2Fsecrets%2Fmaster.key',
      '/api/avatars/..%2f..%2fhub.db',
      `/api/avatars/${alice.id}-aaaaaaaaaaaa.png`,
    ]) {
      const res = await app.inject({ method: 'GET', url, remoteAddress: nextIp() })
      expect(res.statusCode, url).toBe(404)
    }
  })

  it('上传需要登录 + X-Hub-Csrf 头（04 §0）', async () => {
    const body = multipart(pngBytes())
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/me/avatar',
      headers: body.headers,
      payload: body.payload,
    })
    expect(anonymous.statusCode).toBe(401)

    const noCsrf = await upload(pngBytes(), { csrf: false })
    expect(noCsrf.statusCode).toBe(403)
    expect(errorCode(json(noCsrf))).toBe('FORBIDDEN')
  })

  it('字段名不是 file → VALIDATION_FAILED', async () => {
    const res = await upload(pngBytes(), { field: 'upload' })
    expect(res.statusCode).toBe(400)
    expect(errorCode(json(res))).toBe('VALIDATION_FAILED')
  })

  it('审计记录 user.avatar.change', async () => {
    await upload(pngBytes())
    const actions = app.deps.db.all<{ action: string }>('SELECT action FROM audit_logs').map((r) => r.action)
    expect(actions).toContain('user.avatar.change')
    expect(existsSync(ctx.app.deps.paths.avatarsDir)).toBe(true)
  })
})
