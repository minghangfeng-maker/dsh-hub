/**
 * 多入口（0.4.11 / WP52）：切换判定、持久化、回切。
 *
 * 覆盖验收要求：
 *  - 网络层失败（TypeError）、超时、被拦截页（HTTP 403 + 非 JSON）→ 探测备用入口并重放；
 *  - Hub 正常返回的 JSON 业务错误（401 / 403 / 429 / 5xx）→ **不切**；
 *  - 上次可用入口持久化、下次启动先用它；
 *  - App 回前台（preferPrimary）：首选恢复后切回；
 *  - 单入口（覆盖/mock）与 cooldown 不探测。
 *
 * 全部用假 fetch，不连任何真实 Hub。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { HubClient, type FetchLike } from '../src/http/hub-client.js'
import {
  ORIGIN_PROBE_PATH,
  OriginManager,
  looksLikeInterceptPage,
} from '../src/http/origin-manager.js'
import { HubApiError } from '../src/errors.js'
import { MemoryTokenStore } from '../src/auth/token-store.js'
import { MemoryKeyValueStore } from '../src/prefs/selection-store.js'
import {
  MOCK_HUB_ORIGIN,
  injectedHubOrigins,
  normalizeHubOrigin,
  parseHubOriginLabels,
  parseHubOrigins,
  resolveHubOrigins,
} from '../src/config.js'
import { MOBILE, type AuthTokens } from '../src/contracts/auth-bootstrap.js'
import { makeTokens } from './helpers/tokens.js'

const NOW = Date.parse('2026-10-25T12:00:00.000Z')
const A = 'https://primary.test:8123'
const B = 'https://backup.test'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function html(status = 403): Response {
  return new Response('<!DOCTYPE html><html><body>该网站未备案</body></html>', {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', server: 'Beaver' } as Record<string, string>,
  })
}

const HEALTH = { ok: true, version: 'test', db: 'ok', docker: 'disabled' }

interface HarnessOptions {
  origins?: readonly string[]
  store?: MemoryKeyValueStore
  timeoutMs?: number
  cooldownMs?: number
  initial?: AuthTokens | null
}

interface Harness {
  client: HubClient
  store: MemoryTokenStore
  kv: MemoryKeyValueStore
  calls: string[]
  switches: Array<{ from: string; to: string; reason: string }>
}

/** 假 fetch：按 URL 前缀路由；未命中的地址一律抛 TypeError（默认主入口挂掉）。 */
function makeHarness(
  routes: Record<string, (init: RequestInit) => Response | Promise<Response>>,
  options: HarnessOptions = {},
): Harness {
  const store = new MemoryTokenStore()
  if (options.initial) void store.save(options.initial)
  const kv = options.store ?? new MemoryKeyValueStore()
  const calls: string[] = []
  const switches: Harness['switches'] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push(url)
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return handler(init ?? {})
    }
    throw new TypeError('Failed to fetch')
  }
  const client = new HubClient({
    origin: A,
    origins: options.origins ?? [A, B],
    tokenStore: store,
    fetchImpl,
    now: () => NOW,
    timeoutMs: options.timeoutMs ?? 1_000,
    originStore: kv,
    originCooldownMs: options.cooldownMs ?? 0,
    originProbeTimeoutMs: 200,
  })
  client.onOriginChange((change) => switches.push(change))
  return { client, store, kv, calls, switches }
}

function login(client: HubClient, username = 'demo'): Promise<AuthTokens> {
  return client.login({
    username,
    password: 'demo1234',
    deviceName: 'Pixel',
    platform: 'android',
  })
}

/** 一个「永远不返回、只等 abort」的 fetch：用来造超时。 */
function hanging(init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
      once: true,
    })
  })
}

describe('被拦截页判定', () => {
  it('403 + HTML（阿里云拦截页）算拦截', () => {
    expect(
      looksLikeInterceptPage({ status: 403, contentType: 'text/html', bodyHead: '<!DOCTYPE html>' }),
    ).toBe(true)
    // 没有 content-type、body 也不是 JSON：同样是被挡（TLS/网关层）
    expect(looksLikeInterceptPage({ status: 403, contentType: null, bodyHead: '<html>' })).toBe(true)
    expect(looksLikeInterceptPage({ status: 403, contentType: null, bodyHead: '' })).toBe(true)
  })

  it('403 + JSON 是 Hub 的业务错误，不切', () => {
    expect(
      looksLikeInterceptPage({
        status: 403,
        contentType: 'application/json',
        bodyHead: '{"error":{"code":"USER_PENDING"}}',
      }),
    ).toBe(false)
    // content-type 丢失但 body 确实是 JSON 信封：也不切
    expect(
      looksLikeInterceptPage({
        status: 403,
        contentType: 'text/plain',
        bodyHead: '{ "error": { "code": "RATE_LIMITED" } }',
      }),
    ).toBe(false)
  })

  it('不是 403 的 HTML（200 登录页 / 500 错误页）不算拦截', () => {
    expect(looksLikeInterceptPage({ status: 200, contentType: 'text/html', bodyHead: '<html>' })).toBe(false)
    expect(looksLikeInterceptPage({ status: 502, contentType: 'text/html', bodyHead: '<html>' })).toBe(false)
  })
})

describe('OriginManager', () => {
  it('启动时用持久化的上次可用入口', async () => {
    const kv = new MemoryKeyValueStore()
    await kv.set('dsh-hub:origin:v1', B)
    const switches: string[] = []
    const manager = new OriginManager({
      origins: [A, B],
      store: kv,
      fetchImpl: async () => json(HEALTH),
      now: () => NOW,
    })
    manager.subscribe((change) => switches.push(`${change.from}->${change.to}:${change.reason}`))
    expect(manager.current).toBe(A)
    await manager.ensureReady()
    expect(manager.current).toBe(B)
    expect(switches).toEqual([`${A}->${B}:restore`])
    expect(manager.onSecondary).toBe(true)
  })

  it('持久化里是不认识的地址就忽略（换了部署也不乱连）', async () => {
    const kv = new MemoryKeyValueStore()
    await kv.set('dsh-hub:origin:v1', 'https://old.example')
    const manager = new OriginManager({ origins: [A, B], store: kv, fetchImpl: async () => json(HEALTH) })
    await manager.ensureReady()
    expect(manager.current).toBe(A)
  })

  it('备用入口 health 不通就不切', async () => {
    const kv = new MemoryKeyValueStore()
    const manager = new OriginManager({
      origins: [A, B],
      store: kv,
      now: () => NOW,
      fetchImpl: async (url) => {
        if (url === `${B}${ORIGIN_PROBE_PATH}`) return new Response('', { status: 502 })
        return json(HEALTH)
      },
    })
    expect(await manager.failover('network')).toBe(false)
    expect(manager.current).toBe(A)
    expect(await kv.get('dsh-hub:origin:v1')).toBeNull()
  })

  it('切过去会落盘；回前台首选通了再切回并清掉「坏入口」标记', async () => {
    const kv = new MemoryKeyValueStore()
    let primaryHealthy = false
    const manager = new OriginManager({
      origins: [A, B],
      store: kv,
      now: () => NOW,
      fetchImpl: async (url) => {
        if (url === `${A}${ORIGIN_PROBE_PATH}`) {
          if (primaryHealthy) return json(HEALTH)
          throw new TypeError('blocked')
        }
        return json(HEALTH)
      },
    })
    // 主入口探测抛异常 → failover 会尝试 A，但当前就是 A；直接探 B
    expect(await manager.failover('network')).toBe(true)
    expect(manager.current).toBe(B)
    expect(await kv.get('dsh-hub:origin:v1')).toBe(B)

    // 首选仍然不通：不切回
    primaryHealthy = false
    expect(await manager.preferPrimary()).toBe(false)
    expect(manager.current).toBe(B)

    // 首选恢复：回前台切回
    primaryHealthy = true
    expect(await manager.preferPrimary()).toBe(true)
    expect(manager.current).toBe(A)
    expect(await kv.get('dsh-hub:origin:v1')).toBe(A)
  })

  it('刚失败过的入口不会被反复探测（cooldown + badOrigin）', async () => {
    let probes = 0
    const manager = new OriginManager({
      origins: [A, B],
      now: () => NOW,
      cooldownMs: 8_000,
      fetchImpl: async (url) => {
        probes += 1
        if (url === `${B}${ORIGIN_PROBE_PATH}`) return new Response('', { status: 500 })
        return json(HEALTH)
      },
    })
    expect(await manager.failover('network')).toBe(false)
    expect(probes).toBe(1)
    // 冷却窗口内：直接 false，不再探测
    expect(await manager.failover('network')).toBe(false)
    expect(probes).toBe(1)
  })

  it('单入口时所有切换都是 no-op', async () => {
    const manager = new OriginManager({ origins: [A], fetchImpl: async () => json(HEALTH) })
    expect(manager.multi).toBe(false)
    expect(await manager.failover('network')).toBe(false)
    expect(await manager.preferPrimary()).toBe(false)
    expect(manager.current).toBe(A)
  })
})

describe('HubClient 自动切换', () => {
  it('网络层失败（TypeError）：探备用 /api/health，通了就切并重放登录', async () => {
    const tokens = makeTokens()
    const h = makeHarness({
      [`${B}${ORIGIN_PROBE_PATH}`]: () => json(HEALTH),
      [`${B}${MOBILE.login}`]: () => json(tokens),
    })
    const result = await login(h.client)
    expect(result.accessToken).toBe(tokens.accessToken)
    expect(h.client.origin).toBe(B)
    expect(await h.kv.get('dsh-hub:origin:v1')).toBe(B)
    expect(h.switches).toEqual([{ from: A, to: B, reason: 'network' }])
    // 请求顺序：A 登录 → B 健康检查 → B 登录（重放）
    expect(h.calls).toEqual([`${A}${MOBILE.login}`, `${B}${ORIGIN_PROBE_PATH}`, `${B}${MOBILE.login}`])
  })

  it('超时：切到备用并重放', async () => {
    const tokens = makeTokens()
    const h = makeHarness(
      {
        [`${A}${MOBILE.login}`]: hanging,
        [`${B}${ORIGIN_PROBE_PATH}`]: () => json(HEALTH),
        [`${B}${MOBILE.login}`]: () => json(tokens),
      },
      { timeoutMs: 40 },
    )
    const result = await login(h.client)
    expect(result.accessToken).toBe(tokens.accessToken)
    expect(h.client.origin).toBe(B)
    expect(h.switches[0]?.reason).toBe('timeout')
  })

  it('被拦截页（403 + HTML）：切到备用并重放（POST body 完整重发）', async () => {
    const tokens = makeTokens()
    const bodies: unknown[] = []
    const h = makeHarness({
      [`${A}${MOBILE.login}`]: () => html(403),
      [`${B}${ORIGIN_PROBE_PATH}`]: () => json(HEALTH),
      [`${B}${MOBILE.login}`]: (init) => {
        bodies.push(JSON.parse(String(init.body)))
        return json(tokens)
      },
    })
    await login(h.client)
    expect(h.client.origin).toBe(B)
    expect(h.switches[0]?.reason).toBe('blocked-page')
    expect(bodies).toEqual([{ username: 'demo', password: 'demo1234', deviceName: 'Pixel', platform: 'android' }])
  })

  it('被拦截页且没有可用备用入口：按网络错误上报（不是 403 业务错误）', async () => {
    const h = makeHarness({
      [`${A}${MOBILE.login}`]: () => html(403),
      [`${B}${ORIGIN_PROBE_PATH}`]: () => html(403),
    })
    const error = await login(h.client).catch((e) => e)
    expect(error).toBeInstanceOf(HubApiError)
    expect(error.code).toBe('network')
    expect(error.status).toBe(403)
    expect(h.client.origin).toBe(A)
    // 只撞了主入口一次 + 探了备用一次，没有重放
    expect(h.calls).toEqual([`${A}${MOBILE.login}`, `${B}${ORIGIN_PROBE_PATH}`])
  })

  it('单入口时被拦截页也按网络错误上报', async () => {
    const h = makeHarness(
      { [`${A}${MOBILE.login}`]: () => html(403) },
      { origins: [A] },
    )
    const error = await login(h.client).catch((e) => e)
    expect(error.code).toBe('network')
    expect(h.calls).toEqual([`${A}${MOBILE.login}`])
  })

  it('Hub 的 JSON 403（业务错误）不切', async () => {
    const h = makeHarness({
      [`${A}${MOBILE.login}`]: () => json({ error: { code: 'USER_PENDING', message: 'pending' } }, 403),
      [`${B}${ORIGIN_PROBE_PATH}`]: () => json(HEALTH),
      [`${B}${MOBILE.login}`]: () => json(makeTokens()),
    })
    const error = await login(h.client).catch((e) => e)
    expect(error).toBeInstanceOf(HubApiError)
    expect(error.code).toBe('USER_PENDING')
    expect(h.client.origin).toBe(A)
    expect(h.calls).toEqual([`${A}${MOBILE.login}`])
    expect(h.switches).toEqual([])
  })

  it('Hub 的 JSON 401（密码错）不切', async () => {
    const h = makeHarness({
      [`${A}${MOBILE.login}`]: () => json({ error: { code: 'INVALID_CREDENTIALS' } }, 401),
      [`${B}${ORIGIN_PROBE_PATH}`]: () => json(HEALTH),
    })
    const error = await login(h.client).catch((e) => e)
    expect(error.code).toBe('INVALID_CREDENTIALS')
    expect(h.calls).toEqual([`${A}${MOBILE.login}`])
  })

  it('Hub 的 JSON 5xx 不切', async () => {
    const h = makeHarness({
      [`${A}${MOBILE.login}`]: () => json({ error: { code: 'INTERNAL' } }, 503),
      [`${B}${ORIGIN_PROBE_PATH}`]: () => json(HEALTH),
    })
    const error = await login(h.client).catch((e) => e)
    expect(error.code).toBe('INTERNAL')
    expect(h.calls).toEqual([`${A}${MOBILE.login}`])
  })

  it('备用入口 health 不通时保留原始错误（不静默换到坏入口）', async () => {
    const h = makeHarness({
      [`${B}${ORIGIN_PROBE_PATH}`]: () => html(403),
    })
    const error = await login(h.client).catch((e) => e)
    expect(error).toBeInstanceOf(HubApiError)
    expect(error.code).toBe('network')
    expect(h.client.origin).toBe(A)
    // 主入口 + 备用探测各一次，没有第三次（不重放）
    expect(h.calls).toEqual([`${A}${MOBILE.login}`, `${B}${ORIGIN_PROBE_PATH}`])
  })

  it('启动时直接用持久化的备用入口，不再撞主入口', async () => {
    const kv = new MemoryKeyValueStore()
    await kv.set('dsh-hub:origin:v1', B)
    const tokens = makeTokens()
    const h = makeHarness(
      {
        [`${B}${MOBILE.login}`]: () => json(tokens),
      },
      { store: kv },
    )
    await login(h.client)
    expect(h.client.origin).toBe(B)
    expect(h.calls).toEqual([`${B}${MOBILE.login}`])
  })

  it('只配置一个入口（VITE_HUB_ORIGIN 覆盖 / mock）时没有切换', async () => {
    const h = makeHarness({}, { origins: [A] })
    const error = await login(h.client).catch((e) => e)
    expect(error.code).toBe('network')
    expect(h.calls).toEqual([`${A}${MOBILE.login}`])
    expect(h.switches).toEqual([])
  })

  it('bootstrap 走的也是同一套切换，且能解析 downloadMirrors', async () => {
    const kv = new MemoryKeyValueStore()
    await kv.set('dsh-hub:origin:v1', B)
    const bootstrap = {
      user: { id: 1, username: 'demo', displayName: 'demo' },
      points: { balance: 0, enabled: false },
      backends: [],
      instance: { status: 'running', capacityFull: false },
      app: {
        minVersionCode: 1,
        latestVersionCode: 10,
        downloadUrl: 'https://cdn.test/app.apk',
        downloadMirrors: ['https://cdn.test/app.apk', 'https://mirror.test/app.apk'],
      },
      serverTime: new Date(NOW).toISOString(),
    }
    const h = makeHarness(
      { [`${B}${MOBILE.bootstrap}`]: () => json(bootstrap) },
      { store: kv, initial: makeTokens() },
    )
    const result = await h.client.bootstrap()
    expect(result.app.downloadMirrors).toEqual([
      'https://cdn.test/app.apk',
      'https://mirror.test/app.apk',
    ])
    expect(h.calls).toEqual([`${B}${MOBILE.bootstrap}`])
  })
})


// ── 入口列表解析 ────────────────────────────────────────────────────────────

describe('入口列表解析', () => {
  const scope = globalThis as { __dshHubOrigins?: unknown }

  afterEach(() => {
    delete scope.__dshHubOrigins
  })

  it('没有任何配置 → 空列表（登录页要求用户填服务器地址）', () => {
    expect(resolveHubOrigins()).toEqual([])
    expect(resolveHubOrigins({})).toEqual([])
    expect(parseHubOrigins('')).toEqual([])
    expect(parseHubOrigins(undefined)).toEqual([])
    expect(parseHubOrigins('  ,  ,')).toEqual([])
  })

  it('构建期列表（VITE_HUB_ORIGINS）：有序、去重、去非法值', () => {
    expect(parseHubOrigins('https://hub.example.com, https://backup.example.com')).toEqual([
      'https://hub.example.com',
      'https://backup.example.com',
    ])
    // 末尾斜杠归一；重复项去掉（顺序不变）
    expect(parseHubOrigins('https://hub.example.com/,https://hub.example.com')).toEqual([
      'https://hub.example.com',
    ])
    // 非法项被丢掉，合法的还在
    expect(parseHubOrigins('ftp://bad.test,https://hub.example.com')).toEqual([
      'https://hub.example.com',
    ])
    // 全都不合法 = 没配
    expect(parseHubOrigins('ftp://bad.test,nonsense')).toEqual([])
  })

  it('VITE_HUB_ORIGINS=mock → 进程内假 Hub', () => {
    expect(parseHubOrigins('mock')).toEqual([MOCK_HUB_ORIGIN])
    expect(resolveHubOrigins({ builtIn: parseHubOrigins('mock') })).toEqual([MOCK_HUB_ORIGIN])
  })

  it('用户手填的地址优先于构建期列表（APK 没内置入口时就是它）', () => {
    expect(resolveHubOrigins({ saved: ['https://mine.example.com'] })).toEqual([
      'https://mine.example.com',
    ])
    expect(
      resolveHubOrigins({
        saved: ['https://mine.example.com'],
        builtIn: ['https://hub.example.com'],
      }),
    ).toEqual(['https://mine.example.com'])
    // 手填值非法（历史遗留/手改了 localStorage）→ 当作没填，用构建期列表
    expect(
      resolveHubOrigins({ saved: ['not a url'], builtIn: ['https://hub.example.com'] }),
    ).toEqual(['https://hub.example.com'])
  })

  it('VITE_HUB_ORIGIN 覆盖仍然只用一个地址（单入口行为不变）', () => {
    expect(resolveHubOrigins({ override: 'http://127.0.0.1:5245/' })).toEqual([
      'http://127.0.0.1:5245',
    ])
    // 覆盖值非法：当作没覆盖，继续看用户手填 / 构建期列表（别把用户丢到「没有服务器」）
    expect(resolveHubOrigins({ override: 'ftp://evil.test', builtIn: ['https://hub.example.com'] })).toEqual([
      'https://hub.example.com',
    ])
    expect(resolveHubOrigins({ override: '   ' })).toEqual([])
    // 覆盖值优先于手填地址（开发/联调要能盖住任何持久化值）
    expect(
      resolveHubOrigins({ override: 'http://127.0.0.1:5300', saved: ['https://mine.example.com'] }),
    ).toEqual(['http://127.0.0.1:5300'])
  })

  it('mock 构建还是 mock（不联网）', () => {
    expect(resolveHubOrigins({ override: MOCK_HUB_ORIGIN })).toEqual([MOCK_HUB_ORIGIN])
  })

  it('运行时注入（e2e）优先于构建参数覆盖，并去重/去非法值', () => {
    scope.__dshHubOrigins = ['http://127.0.0.1:5400', 'http://127.0.0.1:5402', 'http://127.0.0.1:5400']
    expect(injectedHubOrigins()).toEqual(['http://127.0.0.1:5400', 'http://127.0.0.1:5402'])
    expect(resolveHubOrigins({ override: 'http://127.0.0.1:9999' })).toEqual([
      'http://127.0.0.1:5400',
      'http://127.0.0.1:5402',
    ])
  })

  it('注入值全是非法时整份忽略，退回构建参数', () => {
    scope.__dshHubOrigins = ['ftp://bad', 42, null]
    expect(injectedHubOrigins()).toEqual([])
    expect(resolveHubOrigins({ builtIn: ['https://hub.example.com'] })).toEqual([
      'https://hub.example.com',
    ])
    expect(resolveHubOrigins()).toEqual([])
  })

  it('normalizeHubOrigin 只接受 http(s) 并去掉路径与末尾斜杠', () => {
    expect(normalizeHubOrigin('https://backup.example.com/')).toBe('https://backup.example.com')
    expect(normalizeHubOrigin('https://hub.example.com:8123/some/path')).toBe(
      'https://hub.example.com:8123',
    )
    expect(normalizeHubOrigin('wss://backup.example.com')).toBeNull()
    expect(normalizeHubOrigin('')).toBeNull()
  })

  it('入口标签（VITE_HUB_ORIGIN_LABELS）只在配了的时候才有', () => {
    expect(parseHubOriginLabels('')).toEqual({})
    expect(parseHubOriginLabels('https://hub.example.com=主站,https://backup.example.com=备用')).toEqual({
      'https://hub.example.com': '主站',
      'https://backup.example.com': '备用',
    })
    // 没有 `=`、空标签、非法地址：整条忽略（标签只影响展示）
    expect(parseHubOriginLabels('https://hub.example.com,=空,https://x.example.com= ,ftp://bad=坏')).toEqual({})
  })
})
