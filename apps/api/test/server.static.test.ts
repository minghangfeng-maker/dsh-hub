import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp, type TestApp } from './helpers.js'
import { registerStatic } from '../src/server/static.js'

/**
 * 静态托管与 SPA 兜底（04 §6）：`/assets/*` 一年 immutable；`index.html`/`wake.html` no-cache；
 * SPA 兜底绝不吞 `/api/*`、`/dsh/*`、`/u/*`；`/ca.crt` 阶段一文件不存在 → 404。
 */
const INDEX_HTML = '<!doctype html><html><body><div id="app">HUB_INDEX</div></body></html>'
const WAKE_HTML = '<!doctype html><html><body>HUB_WAKE</body></html>'

let ctx: TestApp
let app: FastifyInstance
let webDist: string
let caCertFile: string

function makeWebDist(options: { withIndex?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshhub-test-wp7a-web-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  mkdirSync(join(dir, 'favicon'), { recursive: true })
  if (options.withIndex !== false) writeFileSync(join(dir, 'index.html'), INDEX_HTML)
  writeFileSync(join(dir, 'wake.html'), WAKE_HTML)
  writeFileSync(join(dir, 'assets', 'app-1a2b3c4d.js'), 'console.log("hub")\n')
  writeFileSync(join(dir, 'assets', 'app-1a2b3c4d.css'), '.hub{color:#333}\n')
  writeFileSync(join(dir, 'favicon', 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  return dir
}

beforeEach(async () => {
  ctx = await createTestApp()
  webDist = makeWebDist()
  caCertFile = join(ctx.dataDir, 'secrets', 'tls', 'ca.crt')
  await registerStatic(ctx.app, { config: ctx.config, webDistDir: webDist, caCertFile })
  app = ctx.app
})

afterEach(async () => {
  await ctx.close()
  rmSync(webDist, { recursive: true, force: true })
})

describe('静态资源与缓存头（04 §6）', () => {
  it('GET / 返回 index.html，no-cache，带安全响应头', async () => {
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.headers['cache-control']).toBe('no-cache')
    expect(res.body).toBe(INDEX_HTML)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['referrer-policy']).toBe('same-origin')
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN')
    const csp = String(res.headers['content-security-policy'])
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("style-src 'self' 'unsafe-inline'") // Naive UI 运行时 inline style
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'")
  })

  it('GET /index.html 与 /wake.html 都能取到且不缓存', async () => {
    const index = await app.inject({ method: 'GET', url: '/index.html' })
    expect(index.statusCode).toBe(200)
    expect(index.headers['cache-control']).toBe('no-cache')
    expect(index.body).toBe(INDEX_HTML)

    const wake = await app.inject({ method: 'GET', url: '/wake.html' })
    expect(wake.statusCode).toBe(200)
    expect(wake.headers['cache-control']).toBe('no-cache')
    expect(wake.body).toBe(WAKE_HTML)
  })

  it('GET /assets/* 一年 immutable，且 Content-Type 正确', async () => {
    const js = await app.inject({ method: 'GET', url: '/assets/app-1a2b3c4d.js' })
    expect(js.statusCode).toBe(200)
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(js.body).toBe('console.log("hub")\n')

    const css = await app.inject({ method: 'GET', url: '/assets/app-1a2b3c4d.css' })
    expect(css.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8')
  })

  it('/assets 下不存在的文件 404（不会回落到 index.html）', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/nope-00000000.js' })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error.code).toBe('NOT_FOUND')
  })

  it('dist 里的其它真实文件按 no-cache 回送', async () => {
    const res = await app.inject({ method: 'GET', url: '/favicon/favicon.svg' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/svg+xml')
    expect(res.headers['cache-control']).toBe('no-cache')
  })

  it('HEAD / 有长度无 body', async () => {
    const res = await app.inject({ method: 'HEAD', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-length']).toBe(String(Buffer.byteLength(INDEX_HTML)))
  })
})

describe('SPA 兜底不吞业务路由（04 §6）', () => {
  it('普通前端路由回 index.html', async () => {
    for (const url of ['/dashboard', '/admin/users', '/login']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(200)
      expect(res.body).toBe(INDEX_HTML)
      expect(res.headers['cache-control']).toBe('no-cache')
    }
  })

  it('/api/* 走业务路由：已有接口 200，未知接口 404 JSON', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' })
    expect(health.statusCode).toBe(200)
    expect(health.headers['cache-control']).toBe('no-store')
    expect(health.headers['content-security-policy']).toBeUndefined()

    const missing = await app.inject({ method: 'GET', url: '/api/definitely-not-here' })
    expect(missing.statusCode).toBe(404)
    expect(JSON.parse(missing.body).error.code).toBe('NOT_FOUND')
    expect(missing.body).not.toContain('HUB_INDEX')
  })

  it('/dsh/* 与 /dsh 不被 SPA 兜底接管（04 §6、WP16）', async () => {
    // 有用户名时由代理路由接手：未登录 → 302 登录（证明没被 SPA 吞掉）；/dsh 与 /dsh/ 保留 404
    for (const url of ['/dsh/littletao/', '/dsh/littletao/api/echo']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(302)
      expect(String(res.headers.location), url).toContain('/login?next=')
      expect(res.body, url).not.toContain('HUB_INDEX')
    }
    for (const url of ['/dsh', '/dsh/']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(404)
      expect(res.body, url).not.toContain('HUB_INDEX')
      expect(JSON.parse(res.body).error.code).toBe('NOT_FOUND')
    }
  })

  it('/u/* 继续不被 SPA 兜底接管（旧地址 301 由代理路由处理）', async () => {
    const res = await app.inject({ method: 'GET', url: '/u/someone/' })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('HUB_INDEX')
    expect(JSON.parse(res.body).error.code).toBe('NOT_FOUND')
  })

  it('代理路径不带 Hub 的 CSP（02 §7.4：DSH 自己的页面自己负责）', async () => {
    // 模拟 WP2 的代理路由：注册在根作用域，不在静态插件内部
    const other = await createTestApp()
    try {
      other.app.get('/dsh/:username/probe', async (_req, reply) => reply.type('text/html').send('dsh'))
      await registerStatic(other.app, { config: other.config, webDistDir: webDist })
      const res = await other.app.inject({ method: 'GET', url: '/dsh/littletao/probe' })
      expect(res.statusCode).toBe(200)
      expect(res.body).toBe('dsh')
      expect(res.headers['content-security-policy']).toBeUndefined()
      expect(res.headers['x-content-type-options']).toBeUndefined()
    } finally {
      await other.close()
    }
  })

  it('非 GET 的未知路径是 404，不会回 HTML', async () => {
    const res = await app.inject({ method: 'POST', url: '/dashboard', payload: {} })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error.code).toBe('NOT_FOUND')
  })

  it('路径穿越不会读到 dist 之外：/assets/../index.html 归一化后仍走 index.html', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/../index.html' })
    // find-my-way 会把 `..` 归一化掉；即使落到 /assets/* 也被 resolveInside 拦住
    expect([200, 400, 404]).toContain(res.statusCode)
    if (res.statusCode === 200) {
      expect(res.body).toBe(INDEX_HTML)
      expect(res.headers['cache-control']).toBe('no-cache')
    }
  })

  it('编码后的穿越尝试同样拿不到 dist 外的文件（%2e%2e%2f）', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/%2e%2e%2f%2e%2e%2fpackage.json' })
    expect([400, 404]).toContain(res.statusCode)
    expect(res.body).not.toContain('"@dsh-hub/api"')
  })
})

describe('/ca.crt（04 §1、08 §3）', () => {
  it('阶段一没有证书文件 → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/ca.crt' })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error.code).toBe('NOT_FOUND')
    expect(res.body).not.toContain('HUB_INDEX')
  })

  it('证书文件存在时按 application/x-x509-ca-cert 回送', async () => {
    mkdirSync(join(ctx.dataDir, 'secrets', 'tls'), { recursive: true })
    writeFileSync(caCertFile, '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n')
    const res = await app.inject({ method: 'GET', url: '/ca.crt' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/x-x509-ca-cert')
    expect(res.headers['cache-control']).toBe('no-cache')
    expect(res.body).toContain('BEGIN CERTIFICATE')
  })
})

describe('前端产物缺失', () => {
  it('没有 index.html 时给 500 和明确提示，而不是空响应', async () => {
    const emptyDist = makeWebDist({ withIndex: false })
    const other = await createTestApp()
    try {
      await registerStatic(other.app, { config: other.config, webDistDir: emptyDist })
      const res = await other.app.inject({ method: 'GET', url: '/dashboard' })
      expect(res.statusCode).toBe(500)
      expect(JSON.parse(res.body).error.message).toContain('pnpm build')
    } finally {
      await other.close()
      rmSync(emptyDist, { recursive: true, force: true })
    }
  })
})
