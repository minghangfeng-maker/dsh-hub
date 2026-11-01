import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MOBILE_WEB_BASE_PATH } from '@dsh-hub/shared'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './helpers.js'
import { markPublicSocket } from '../src/server/public-request.js'
import {
  MOBILE_WEB_CONTENT_SECURITY_POLICY,
  isMobileUserAgent,
  mobileWebCacheControl,
  registerStatic,
} from '../src/server/static.js'

/**
 * WP54b：`/m/` 手机网页版托管（契约 C2/C5/C6）+ 首页手机跳转（C8）。
 *
 * 全程 `app.inject`（不监听端口），网页版产物用 mkdtemp 造的假目录 + 符号链接模拟真实发布
 * （`<data>/mobile-web/current -> releases/<版本>`，发布脚本原子切换 current）。
 */

const DESKTOP_INDEX = '<!doctype html><html><body>DESKTOP_INDEX</body></html>'
const WAKE_HTML = '<!doctype html><html><body>HUB_WAKE</body></html>'

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36'
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
const IPOD_UA =
  'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'
const HARMONY_UA =
  'Mozilla/5.0 (Phone; HarmonyOS 4.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0 Mobile Safari/537.36'
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
const ANDROID_TABLET_UA =
  'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 契约 §3 WP54b 那一行给的 `/m/` 专用 CSP，逐字钉住 */
const EXPECTED_MOBILE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"

let apps: TestApp[] = []
let tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dshhub-test-wp54b-${prefix}-`))
  tempDirs.push(dir)
  return dir
}

/** Hub 自己的前端产物（电脑版） */
function makeWebDist(): string {
  const dir = tempDir('web')
  writeFileSync(join(dir, 'index.html'), DESKTOP_INDEX)
  writeFileSync(join(dir, 'wake.html'), WAKE_HTML)
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'app-1a2b3c4d.js'), 'console.log("hub")\n')
  return dir
}

/** 一个「网页版发布」目录：index.html + version.json + assets + 常见静态文件 */
function makeRelease(root: string, name: string, marker: string, opts: { withIndex?: boolean } = {}): string {
  const dir = join(root, name)
  mkdirSync(join(dir, 'assets'), { recursive: true })
  if (opts.withIndex !== false) {
    writeFileSync(join(dir, 'index.html'), `<!doctype html><html><body>MOBILE_${marker}</body></html>`)
  }
  writeFileSync(
    join(dir, 'version.json'),
    JSON.stringify({ version: '0.4.11', build: marker.toLowerCase(), builtAt: '2026-10-29T00:00:00.000Z' }),
  )
  writeFileSync(join(dir, 'assets', `index-${marker}.js`), `console.log("${marker}")\n`)
  writeFileSync(join(dir, 'assets', `index-${marker}.css`), '.m{color:#333}\n')
  writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"DSH Hub","start_url":"./"}')
  writeFileSync(join(dir, 'icon-192.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  writeFileSync(join(dir, 'sprite.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  writeFileSync(join(dir, 'font-abc.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32]))
  writeFileSync(join(dir, 'engine-abc.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d]))
  writeFileSync(join(dir, 'notes.txt'), 'notes\n')
  return dir
}

interface Fixture {
  app: FastifyInstance
  ctx: TestApp
  /** `releases/` 目录 */
  releases: string
  /** `<mobileRoot>/current` 符号链接 */
  current: string
}

async function setup(
  opts: { mobileWebDir?: string; env?: Record<string, string>; publicRequest?: boolean } = {},
) {
  const ctx = await createTestApp({ env: opts.env })
  apps.push(ctx)
  const webDist = makeWebDist()
  const mobileRoot = tempDir('mobile')
  const releases = join(mobileRoot, 'releases')
  mkdirSync(releases, { recursive: true })
  makeRelease(releases, 'v1', 'V1')
  makeRelease(releases, 'v2', 'V2')
  const current = join(mobileRoot, 'current')
  symlinkSync(join(releases, 'v1'), current, 'dir')

  if (opts.publicRequest === true) {
    // 模拟「从 7443 TLS 网关 / edge 入口进来」：登录 cookie 的 Secure 判定读的就是这个标记
    ctx.app.addHook('onRequest', async (req) => {
      markPublicSocket(req.socket)
    })
  }

  await registerStatic(ctx.app, {
    config: ctx.config,
    webDistDir: webDist,
    mobileWebDir: opts.mobileWebDir ?? current,
  })
  const fixture: Fixture = { app: ctx.app, ctx, releases, current }
  return fixture
}

/** 切换 `current` 指向另一个 release（发布脚本就是这么做的：原子 rename 符号链接） */
function switchCurrent(current: string, target: string): void {
  unlinkSync(current)
  symlinkSync(target, current, 'dir')
}

/** `Set-Cookie` 可能有多个（一次响应里同时写/清 cookie），统一取成字符串数组 */
function setCookies(res: { headers: unknown }): string[] {
  const headers = res.headers as Record<string, string | string[] | number | undefined>
  const raw = headers['set-cookie']
  if (raw === undefined) return []
  if (Array.isArray(raw)) return raw.map(String)
  return [String(raw)]
}

beforeEach(() => {
  apps = []
  tempDirs = []
})

afterEach(async () => {
  for (const ctx of apps) await ctx.close()
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  apps = []
  tempDirs = []
})

describe('契约常量与纯函数（C2/C6/C8）', () => {
  it('`/m/` 专用 CSP 与契约逐字一致', () => {
    expect(MOBILE_WEB_CONTENT_SECURITY_POLICY).toBe(EXPECTED_MOBILE_CSP)
    // 比 Hub 页面那份多三样，少一样 form-action（契约原文如此）
    expect(EXPECTED_MOBILE_CSP).toContain("media-src 'self' blob:")
    expect(EXPECTED_MOBILE_CSP).toContain("worker-src 'self' blob:")
    expect(EXPECTED_MOBILE_CSP).toContain("manifest-src 'self'")
    expect(EXPECTED_MOBILE_CSP).not.toContain('form-action')
  })

  it('缓存策略：index.html / version.json no-store，assets 一年，其它 no-cache（C6）', () => {
    expect(mobileWebCacheControl('index.html')).toBe('no-store')
    expect(mobileWebCacheControl('version.json')).toBe('no-store')
    expect(mobileWebCacheControl('assets/index-abc.js')).toBe('public, max-age=31536000, immutable')
    expect(mobileWebCacheControl('/assets/x.css')).toBe('public, max-age=31536000, immutable')
    expect(mobileWebCacheControl('manifest.webmanifest')).toBe('no-cache')
    expect(mobileWebCacheControl('icon-192.png')).toBe('no-cache')
  })

  it('手机 UA 判定：手机算，平板与桌面不算（C8）', () => {
    for (const ua of [ANDROID_UA, IPHONE_UA, IPOD_UA, HARMONY_UA]) {
      expect(isMobileUserAgent(ua), ua).toBe(true)
    }
    for (const ua of [IPAD_UA, ANDROID_TABLET_UA, DESKTOP_UA, '', undefined]) {
      expect(isMobileUserAgent(ua), String(ua)).toBe(false)
    }
  })
})

describe('`/m` 手机网页版托管（C2/C5/C6）', () => {
  it('GET /m → 301 /m/，查询串原样带过去', async () => {
    const { app } = await setup()
    const bare = await app.inject({ method: 'GET', url: '/m' })
    expect(bare.statusCode).toBe(301)
    expect(bare.headers.location).toBe('/m/')

    const withQuery = await app.inject({ method: 'GET', url: '/m?view=desktop' })
    expect(withQuery.statusCode).toBe(301)
    expect(withQuery.headers.location).toBe('/m/?view=desktop')
  })

  it('GET /m/ 回网页版 index.html：no-store、/m/ 专用 CSP、其它安全头与 Hub 页面一致', async () => {
    const { app } = await setup()
    const res = await app.inject({ method: 'GET', url: '/m/' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('MOBILE_V1')
    expect(res.body).not.toContain('DESKTOP_INDEX')
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['content-security-policy']).toBe(MOBILE_WEB_CONTENT_SECURITY_POLICY)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['referrer-policy']).toBe('same-origin')
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN')
  })

  it('/m/index.html 与 /m/version.json 都 no-store（C6）', async () => {
    const { app } = await setup()
    const index = await app.inject({ method: 'GET', url: '/m/index.html' })
    expect(index.statusCode).toBe(200)
    expect(index.headers['cache-control']).toBe('no-store')
    expect(index.body).toContain('MOBILE_V1')

    const version = await app.inject({ method: 'GET', url: '/m/version.json' })
    expect(version.statusCode).toBe(200)
    expect(version.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(version.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(version.body)).toEqual({
      version: '0.4.11',
      build: 'v1',
      builtAt: '2026-10-29T00:00:00.000Z',
    })
  })

  it('/m/assets/* 一年 immutable，常见类型 Content-Type 正确', async () => {
    const { app } = await setup()
    const js = await app.inject({ method: 'GET', url: '/m/assets/index-V1.js' })
    expect(js.statusCode).toBe(200)
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8')

    const css = await app.inject({ method: 'GET', url: '/m/assets/index-V1.css' })
    expect(css.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8')
  })

  it('常见 MIME：webmanifest / woff2 / wasm / png / svg', async () => {
    const { app } = await setup()
    const cases: Array<[string, string]> = [
      ['/m/manifest.webmanifest', 'application/manifest+json'],
      ['/m/font-abc.woff2', 'font/woff2'],
      ['/m/engine-abc.wasm', 'application/wasm'],
      ['/m/icon-192.png', 'image/png'],
      ['/m/sprite.svg', 'image/svg+xml'],
    ]
    for (const [url, type] of cases) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(200)
      expect(res.headers['content-type'], url).toBe(type)
      // 非 index/version/assets 的其它文件 → no-cache
      expect(res.headers['cache-control'], url).toBe('no-cache')
    }
  })

  it('assets 里不存在的文件 404，绝不回 index.html', async () => {
    const { app } = await setup()
    const res = await app.inject({ method: 'GET', url: '/m/assets/nope-00000000.js' })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error.code).toBe('NOT_FOUND')
    expect(res.body).not.toContain('MOBILE_V1')
    // 404 也是 `/m/` 的 CSP：网页版页面里的 fetch 失败不该被 Hub 页面的 CSP 影响
    expect(res.headers['content-security-policy']).toBe(MOBILE_WEB_CONTENT_SECURITY_POLICY)
  })

  it('version.json 不存在时 404（机器读的文件不能拿 index.html 冒充）', async () => {
    const { app, releases, current } = await setup()
    const bare = makeRelease(releases, 'no-version', 'NV', { withIndex: true })
    unlinkSync(join(bare, 'version.json'))
    switchCurrent(current, bare)
    const res = await app.inject({ method: 'GET', url: '/m/version.json' })
    expect(res.statusCode).toBe(404)
  })

  it('不存在的无扩展名路径兜底 index.html（no-store），hash 路由用不到但不 404', async () => {
    const { app } = await setup()
    for (const url of ['/m/settings', '/m/chat/abc']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(200)
      expect(res.body, url).toContain('MOBILE_V1')
      expect(res.headers['cache-control'], url).toBe('no-store')
    }
  })
})

describe('`/m/` 安全：穿越、点文件、符号链接、原子切换（C5）', () => {
  it('解码后的 `..` 一律 404，读不到托管目录外', async () => {
    const { app } = await setup()
    const urls = [
      '/m/..%2f..%2fetc%2fpasswd',
      '/m/%2e%2e%2f%2e%2e%2fpackage.json',
      '/m/..%2f..%2f..%2f..%2fetc%2fhostname',
      '/m/assets/..%2f..%2findex.html',
    ]
    for (const url of urls) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(404)
      expect(res.body, url).not.toContain('root:x:')
      expect(res.body, url).not.toContain('MOBILE_V1')
    }

    // 字面量 `..`：浏览器（和 inject）发出前就会归一化，服务端看到的是上面的编码形式。
    // 归一化后最多落到 `/index.html`（电脑版首页），绝不会进入 `/m/`、更拿不到目录外的文件。
    const literal = await app.inject({ method: 'GET', url: '/m/../index.html' })
    expect([200, 400, 404]).toContain(literal.statusCode)
    expect(literal.body).not.toContain('MOBILE_V1')
  })

  it('NUL 字节与点文件一律 404', async () => {
    const { app, releases } = await setup()
    // 点文件真的存在也读不到（.env / .git 之类不该被静态托管）
    writeFileSync(join(releases, 'v1', '.env'), 'SECRET=1\n')
    for (const url of ['/m/%00x', '/m/.env', '/m/.git/config', '/m/assets/.hidden.js']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(404)
      expect(res.body, url).not.toContain('SECRET=1')
    }
  })

  it('目录内的符号链接指到目录外 → 404（realpath 复核）', async () => {
    const outside = tempDir('outside')
    const secret = join(outside, 'secret.txt')
    writeFileSync(secret, 'OUTSIDE_SECRET\n')
    const { app, releases } = await setup()
    symlinkSync(secret, join(releases, 'v1', 'escape.txt'))
    symlinkSync(outside, join(releases, 'v1', 'escape-dir'))

    for (const url of ['/m/escape.txt', '/m/escape-dir/secret.txt']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(404)
      expect(res.body, url).not.toContain('OUTSIDE_SECRET')
    }
  })

  it('切换 current 符号链接后下一次请求立刻生效（不需要重启 Hub）', async () => {
    const { app, current, releases } = await setup()
    const before = await app.inject({ method: 'GET', url: '/m/' })
    expect(before.body).toContain('MOBILE_V1')
    expect(JSON.parse((await app.inject({ method: 'GET', url: '/m/version.json' })).body).build).toBe('v1')

    switchCurrent(current, join(releases, 'v2'))

    const after = await app.inject({ method: 'GET', url: '/m/' })
    expect(after.statusCode).toBe(200)
    expect(after.body).toContain('MOBILE_V2')
    expect(after.body).not.toContain('MOBILE_V1')
    expect(JSON.parse((await app.inject({ method: 'GET', url: '/m/version.json' })).body).build).toBe('v2')
  })

  it('托管目录不存在 → 503 中文小页面 + 「打开电脑版」链接（no-store）', async () => {
    const missing = join(tempDir('missing-root'), 'mobile-web', 'current')
    const { app } = await setup({ mobileWebDir: missing })
    const res = await app.inject({ method: 'GET', url: '/m/' })
    expect(res.statusCode).toBe(503)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['content-security-policy']).toBe(MOBILE_WEB_CONTENT_SECURITY_POLICY)
    expect(res.body).toContain('手机网页版暂未部署')
    expect(res.body).toContain('href="/?view=desktop"')
    expect(res.body).toContain('打开电脑版')
    expect(res.body).not.toContain('DESKTOP_INDEX')
    // 资源路径同样 503（整个网页版本就不在）
    expect((await app.inject({ method: 'GET', url: '/m/assets/index-V1.js' })).statusCode).toBe(503)
  })

  it('目录在但没有 index.html → 503（不是 500，也不是空响应）', async () => {
    const { app, releases, current } = await setup()
    const noIndex = makeRelease(releases, 'no-index', 'NI', { withIndex: false })
    switchCurrent(current, noIndex)
    const res = await app.inject({ method: 'GET', url: '/m/' })
    expect(res.statusCode).toBe(503)
    expect(res.body).toContain('手机网页版暂未部署')

    // 但静态文件本身还在的话仍应给（assets 是独立的）
    const asset = await app.inject({ method: 'GET', url: '/m/assets/index-NI.js' })
    expect(asset.statusCode).toBe(200)
  })

  it('`/m/` 不会被 SPA 兜底抢走（电脑版 index.html 不出现）', async () => {
    const { app } = await setup()
    for (const url of ['/m', '/m/', '/m/settings', '/m/assets/index-V1.js']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.body, url).not.toContain('DESKTOP_INDEX')
    }
  })
})

describe('首页手机跳转（C8，只作用于 GET / 与 GET /index.html）', () => {
  it('手机 UA → 302 /m/，no-store + Vary: User-Agent, Cookie', async () => {
    const { app } = await setup()
    for (const ua of [ANDROID_UA, IPHONE_UA, IPOD_UA, HARMONY_UA]) {
      const res = await app.inject({ method: 'GET', url: '/', headers: { 'user-agent': ua } })
      expect(res.statusCode, ua).toBe(302)
      expect(res.headers.location, ua).toBe('/m/')
      expect(res.headers['cache-control'], ua).toBe('no-store')
      expect(res.headers.vary, ua).toBe('User-Agent, Cookie')
      expect(res.body, ua).not.toContain('DESKTOP_INDEX')
    }
  })

  it('iPad / Android 平板 / 桌面 Chrome → 200 电脑版首页（C8 不含平板）', async () => {
    const { app } = await setup()
    for (const ua of [IPAD_UA, ANDROID_TABLET_UA, DESKTOP_UA]) {
      const res = await app.inject({ method: 'GET', url: '/', headers: { 'user-agent': ua } })
      expect(res.statusCode, ua).toBe(200)
      expect(res.body, ua).toBe(DESKTOP_INDEX)
      expect(res.headers['cache-control'], ua).toBe('no-cache')
    }
  })

  it('手机 UA 但带 hub_view=desktop cookie → 不跳，出电脑版首页', async () => {
    const { app } = await setup()
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { 'user-agent': IPHONE_UA },
      cookies: { hub_view: 'desktop' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(DESKTOP_INDEX)
    expect(setCookies(res)).toHaveLength(0)
  })

  it('/?view=desktop 写 30 天 cookie 并直接出电脑版首页', async () => {
    const { app } = await setup()
    const res = await app.inject({
      method: 'GET',
      url: '/?view=desktop',
      headers: { 'user-agent': IPHONE_UA },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(DESKTOP_INDEX)
    expect(res.headers['cache-control']).toBe('no-store')
    const cookie = setCookies(res).find((line) => line.startsWith('hub_view='))
    expect(cookie).toBeDefined()
    expect(cookie).toContain('hub_view=desktop')
    expect(cookie).toContain('Max-Age=2592000') // 30 天
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('HttpOnly')
  })

  it('选过电脑版之后，手机 UA 再打开 / 仍然出电脑版', async () => {
    const { app } = await setup()
    const first = await app.inject({
      method: 'GET',
      url: '/?view=desktop',
      headers: { 'user-agent': ANDROID_UA },
    })
    expect(first.statusCode).toBe(200)
    const again = await app.inject({
      method: 'GET',
      url: '/',
      headers: { 'user-agent': ANDROID_UA },
      cookies: { hub_view: 'desktop' },
    })
    expect(again.statusCode).toBe(200)
    expect(again.body).toBe(DESKTOP_INDEX)
  })

  it('/?view=mobile 清 cookie 并 302 /m/', async () => {
    const { app } = await setup()
    const res = await app.inject({
      method: 'GET',
      url: '/?view=mobile',
      headers: { 'user-agent': DESKTOP_UA },
      cookies: { hub_view: 'desktop' },
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/m/')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers.vary).toBe('User-Agent, Cookie')
    const cookie = setCookies(res).find((line) => line.startsWith('hub_view='))
    expect(cookie).toBeDefined()
    expect(cookie).toContain('hub_view=;')
    expect(cookie?.toLowerCase()).toContain('expires=thu, 01 jan 1970')
  })

  it('GET /index.html 与 GET / 行为一致', async () => {
    const { app } = await setup()
    const mobile = await app.inject({
      method: 'GET',
      url: '/index.html',
      headers: { 'user-agent': ANDROID_UA },
    })
    expect(mobile.statusCode).toBe(302)
    expect(mobile.headers.location).toBe('/m/')

    const desktop = await app.inject({
      method: 'GET',
      url: '/index.html',
      headers: { 'user-agent': DESKTOP_UA },
    })
    expect(desktop.statusCode).toBe(200)
    expect(desktop.body).toBe(DESKTOP_INDEX)
  })

  it('其它路径一律不跳（注册/找回密码/业务页面/API/代理）', async () => {
    const { app } = await setup()
    for (const url of ['/login', '/register', '/reset-password', '/downloads', '/docs']) {
      const res = await app.inject({ method: 'GET', url, headers: { 'user-agent': ANDROID_UA } })
      expect(res.statusCode, url).toBe(200)
      expect(res.body, url).toBe(DESKTOP_INDEX)
      expect(res.headers.location, url).toBeUndefined()
    }

    const health = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'user-agent': ANDROID_UA },
    })
    expect(health.statusCode).toBe(200)
    expect(health.headers.location).toBeUndefined()

    // 代理路径：未登录 → 302 登录页（绝不是 /m/）
    const proxy = await app.inject({
      method: 'GET',
      url: '/dsh/littletao/',
      headers: { 'user-agent': ANDROID_UA },
    })
    expect(proxy.statusCode).toBe(302)
    expect(String(proxy.headers.location)).toContain('/login?next=')
    expect(proxy.headers.location).not.toBe(MOBILE_WEB_BASE_PATH)
  })

  it('cookie 的 Secure：公网监听器（7443/edge）加，本机不加', async () => {
    const local = await setup()
    const localRes = await local.app.inject({
      method: 'GET',
      url: '/?view=desktop',
      headers: { 'user-agent': IPHONE_UA },
    })
    expect(setCookies(localRes).find((line) => line.startsWith('hub_view='))).not.toContain('Secure')

    const pub = await setup({ publicRequest: true })
    const pubRes = await pub.app.inject({
      method: 'GET',
      url: '/?view=desktop',
      headers: { 'user-agent': IPHONE_UA },
    })
    expect(setCookies(pubRes).find((line) => line.startsWith('hub_view='))).toContain('Secure')
  })

  it('显式 HUB_COOKIE_SECURE=true 时本机也加 Secure（与 setSessionCookie 的判定一致）', async () => {
    const { app } = await setup({ env: { HUB_COOKIE_SECURE: 'true' } })
    const res = await app.inject({
      method: 'GET',
      url: '/?view=desktop',
      headers: { 'user-agent': IPHONE_UA },
    })
    expect(setCookies(res).find((line) => line.startsWith('hub_view='))).toContain('Secure')
  })
})
