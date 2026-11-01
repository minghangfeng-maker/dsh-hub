import { describe, expect, it } from 'vitest'
import {
  buildCookieHeader,
  buildResponseHeaders,
  buildUpstreamHeaders,
  parseLegacyProxyTarget,
  parseProxyTarget,
  rewriteOriginHeader,
  rewriteRefererHeader,
  rewriteSetCookies,
  wantsHtml,
} from '../src/modules/proxy/headers.js'
import { injectIntoHtml, OWNS_HOST_SNIPPET } from '../src/modules/proxy/inject.js'
import { b64url } from '../src/modules/instances/dsh-cookie.js'

const COOKIE = { name: 'dsh-auth-abc', value: 'v1.body.sig' }

describe('代理路径解析（05 §5、WP16）', () => {
  it('规范地址 /dsh/<username>，用户名必须匹配 ^[a-z][a-z0-9_-]{2,31}$', () => {
    expect(parseProxyTarget('/dsh/littletao')).toEqual({
      username: 'littletao',
      hasSlash: false,
      path: '/',
      search: '',
    })
    expect(parseProxyTarget('/dsh/littletao/')).toEqual({
      username: 'littletao',
      hasSlash: true,
      path: '/',
      search: '',
    })
    expect(parseProxyTarget('/dsh/a_b-c9/assets/app.js?v=1')).toEqual({
      username: 'a_b-c9',
      hasSlash: true,
      path: '/assets/app.js',
      search: '?v=1',
    })
    expect(parseProxyTarget('/dsh/Littletao/')).toBeNull()
    expect(parseProxyTarget('/dsh/ab/')).toBeNull()
    expect(parseProxyTarget('/dsh/1abc/')).toBeNull()
    expect(parseProxyTarget('/api/me')).toBeNull()
    expect(parseProxyTarget('/dsh/')).toBeNull()
    // 旧地址不再是规范地址（只走 301）
    expect(parseProxyTarget('/u/u7k2m9xz/')).toBeNull()
  })

  it('旧地址 /u/<slug> 仍可解析（只用于 301，slug 必须匹配 ^u[a-z0-9]{7}$）', () => {
    expect(parseLegacyProxyTarget('/u/u7k2m9xz')).toEqual({
      slug: 'u7k2m9xz',
      hasSlash: false,
      path: '/',
      search: '',
    })
    expect(parseLegacyProxyTarget('/u/u7k2m9xz/api/echo?x=1')).toEqual({
      slug: 'u7k2m9xz',
      hasSlash: true,
      path: '/api/echo',
      search: '?x=1',
    })
    expect(parseLegacyProxyTarget('/u/U7K2M9XZ/')).toBeNull()
    expect(parseLegacyProxyTarget('/u/u123/')).toBeNull()
    expect(parseLegacyProxyTarget('/dsh/littletao/')).toBeNull()
  })
})

describe('请求头改写（05 §5.3）', () => {
  it('Host/Origin/Referer 改写，x-forwarded-* 重设，逐跳头丢弃', () => {
    const headers = buildUpstreamHeaders({
      headers: {
        host: 'hub.example',
        origin: 'https://hub.example',
        referer: 'https://hub.example/dsh/littletao/chat?x=1',
        cookie: 'hub_sid=abc; dsh-auth-old=zzz; theme=dark',
        connection: 'keep-alive',
        'x-forwarded-for': '1.2.3.4',
        accept: 'application/json',
      },
      authority: '127.0.0.1:3000',
      cookie: COOKIE,
      clientIp: '10.0.0.9',
      protocol: 'https',
      forceIdentity: false,
    })
    expect(headers.host).toBe('127.0.0.1:3000')
    expect(headers.origin).toBe('http://127.0.0.1:3000')
    // 05 §5.3：Referer「同理只改 origin」，路径原样保留（上游不依赖路径前缀）
    expect(headers.referer).toBe('http://127.0.0.1:3000/dsh/littletao/chat?x=1')
    expect(headers.cookie).toBe('theme=dark; dsh-auth-abc=v1.body.sig')
    expect(headers.connection).toBeUndefined()
    expect(headers['x-forwarded-for']).toBe('10.0.0.9')
    expect(headers['x-forwarded-proto']).toBe('https')
    expect(headers.accept).toBe('application/json')
  })

  it('HTML 文档把 accept-encoding 固定成 identity（压缩体没法注入）', () => {
    const headers = buildUpstreamHeaders({
      headers: { accept: 'text/html', 'accept-encoding': 'gzip, deflate, br' },
      authority: '127.0.0.1:3000',
      cookie: COOKIE,
      clientIp: '127.0.0.1',
      protocol: 'http',
      forceIdentity: true,
    })
    expect(headers['accept-encoding']).toBe('identity')
    expect(wantsHtml({ accept: 'text/html,application/xhtml+xml' })).toBe(true)
    expect(wantsHtml({ accept: 'application/json' })).toBe(false)
  })

  it('WS 升级时保留 upgrade/connection 与 sec-websocket-*', () => {
    const headers = buildUpstreamHeaders({
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'abc',
        'sec-websocket-version': '13',
      },
      authority: '127.0.0.1:3000',
      cookie: COOKIE,
      clientIp: '127.0.0.1',
      protocol: 'http',
      forceIdentity: false,
      forUpgrade: true,
    })
    expect(headers.connection).toBe('Upgrade')
    expect(headers.upgrade).toBe('websocket')
    expect(headers['sec-websocket-key']).toBe('abc')
  })

  it('cookie 过滤：丢掉 hub_sid 与所有 dsh-auth-*，保留其它', () => {
    expect(buildCookieHeader('hub_sid=x; a=1; dsh-auth-b=y; b=2', COOKIE)).toBe(
      'a=1; b=2; dsh-auth-abc=v1.body.sig',
    )
    expect(buildCookieHeader(undefined, COOKIE)).toBe('dsh-auth-abc=v1.body.sig')
  })

  it('Origin/Referer 只在确实是个 URL 时改写', () => {
    expect(rewriteOriginHeader('null', '127.0.0.1:3000')).toBeUndefined()
    expect(rewriteOriginHeader('https://a.example', '127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
    expect(rewriteRefererHeader('not a url', '127.0.0.1:3000')).toBeUndefined()
  })
})

describe('响应头改写（05 §5.7 / 02 §7.3）', () => {
  it('丢弃 dsh-auth-* 的 Set-Cookie，其它 cookie 的 Path 改到前缀下并去 Domain', () => {
    const cookies = rewriteSetCookies(
      [
        `dsh-auth-${b64url(Buffer.from('x'))}=v1.a.b; Path=/; HttpOnly`,
        'pref=1; Path=/; Domain=example.com; HttpOnly; SameSite=Lax',
        'no-path=2',
      ],
      'littletao',
    )
    expect(cookies).toHaveLength(2)
    expect(cookies[0]).toBe('pref=1; Path=/dsh/littletao/; HttpOnly; SameSite=Lax')
    expect(cookies[1]).toBe('no-path=2; Path=/dsh/littletao/')
  })

  it('加安全响应头、去逐跳头、按需去掉 content-length', () => {
    const headers = buildResponseHeaders({
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-length': '100',
        'transfer-encoding': 'chunked',
        connection: 'keep-alive',
        'x-frame-options': 'DENY',
      },
      username: 'littletao',
      dropContentLength: true,
    })
    expect(headers['x-frame-options']).toBe('SAMEORIGIN')
    expect(headers['referrer-policy']).toBe('same-origin')
    expect(headers['content-length']).toBeUndefined()
    expect(headers['transfer-encoding']).toBeUndefined()
    expect(headers.connection).toBeUndefined()
    expect(headers['content-type']).toBe('text/html; charset=utf-8')
  })
})

describe('HTML 注入（05 §5.6）', () => {
  it('命中 __DSH_BOOT__ 才注入，插在 </body> 之前', () => {
    const result = injectIntoHtml('<html><body><div>__DSH_BOOT__</div></body></html>')
    expect(result.injected).toBe(true)
    expect(result.html).toContain(OWNS_HOST_SNIPPET)
    expect(result.html).toContain('dshhub-back')
    expect(result.html.indexOf('dshhub-back')).toBeLessThan(result.html.indexOf('</body>'))
  })

  it('没有 boot 标记就不动（JSON/静态资源不受影响）', () => {
    const result = injectIntoHtml('{"ok":true}')
    expect(result).toEqual({ html: '{"ok":true}', injected: false, reason: 'no-boot-marker' })
  })

  it('可以关掉返回按钮', () => {
    const result = injectIntoHtml('<body>__DSH_BOOT__</body>', { withBackButton: false })
    expect(result.html).toContain('ownsHost')
    expect(result.html).not.toContain('dshhub-back')
  })
})
