/**
 * api-client 的关键行为：Bearer、401 单飞刷新、刷新失败回登录、中文错误映射、超时。
 *
 * 这些用例直接用假 fetch，不连任何真实 Hub。
 */

import { describe, expect, it } from 'vitest'
import { HubClient, type FetchLike } from '../src/http/hub-client.js'
import { HubApiError } from '../src/errors.js'
import { MemoryTokenStore } from '../src/auth/token-store.js'
import type { AuthTokens, Bootstrap } from '../src/contracts/auth-bootstrap.js'
import { MOBILE } from '../src/contracts/auth-bootstrap.js'
import { makeTokens } from './helpers/tokens.js'

const NOW = Date.parse('2026-10-25T12:00:00.000Z')
const ORIGIN = 'https://hub.test:8123'
const AT = `Bearer dshm_at_${'a'.repeat(40)}`

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function bootstrapBody(overrides: Partial<Bootstrap> = {}): Bootstrap {
  return {
    user: { id: 1, username: 'demo', displayName: 'demo' },
    points: { balance: 12.5, enabled: true },
    backends: [
      {
        id: 'cloud:self',
        kind: 'cloud',
        name: '云服务器',
        status: 'running',
        connectable: true,
        capabilities: {
          sessions: true,
          history: true,
          send: true,
          stop: true,
          stream: true,
          questions: true,
          approvals: false,
          create: true,
        },
      },
    ],
    instance: { status: 'running', capacityFull: false },
    app: { minVersionCode: 1, latestVersionCode: 10, downloadUrl: null },
    serverTime: new Date(NOW).toISOString(),
    ...overrides,
  }
}

interface Harness {
  client: HubClient
  store: MemoryTokenStore
  calls: Array<{ url: string; method: string; auth: string | null; body: any }>
  authLost: string[]
}

function makeClient(
  handler: (call: { url: string; method: string; auth: string | null; body: any }) => Response | Promise<Response>,
  options: { initial?: AuthTokens | null; timeoutMs?: number; createSocket?: any } = {},
): Harness {
  const store = new MemoryTokenStore()
  if (options.initial) void store.save(options.initial)
  const calls: Harness['calls'] = []
  const authLost: string[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const call = {
      url,
      method: init?.method ?? 'GET',
      auth: headers.Authorization ?? null,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    }
    calls.push(call)
    return handler(call)
  }
  const client = new HubClient({
    origin: ORIGIN,
    tokenStore: store,
    fetchImpl,
    now: () => NOW,
    timeoutMs: options.timeoutMs ?? 1_000,
    createSocket: options.createSocket,
  })
  client.onAuthLost((reason) => authLost.push(reason))
  return { client, store, calls, authLost }
}

describe('登录', () => {
  it('不带 Authorization，成功后保存令牌', async () => {
    const tokens = makeTokens()
    const h = makeClient((call) => {
      expect(call.url).toBe(`${ORIGIN}${MOBILE.login}`)
      expect(call.method).toBe('POST')
      expect(call.auth).toBeNull()
      expect(call.body).toMatchObject({ username: 'demo', platform: 'android' })
      return json(tokens)
    })
    const result = await h.client.login({
      username: 'demo',
      password: 'demo1234',
      deviceName: 'Pixel',
      platform: 'android',
    })
    expect(result.deviceId).toBe(`dv_${'0'.repeat(32)}`)
    expect((await h.store.load())?.refreshToken).toBe(tokens.refreshToken)
  })

  it('错误码映射成中文（待审批/停用/必须改密码/限流）', async () => {
    const cases: Array<[number, string, string]> = [
      [403, 'USER_PENDING', '审批'],
      [403, 'USER_DISABLED', '停用'],
      [403, 'MUST_CHANGE_PASSWORD', '修改密码'],
      [429, 'RATE_LIMITED', '太频繁'],
      [401, 'INVALID_CREDENTIALS', '密码不正确'],
    ]
    for (const [status, code, expected] of cases) {
      const h = makeClient(() => json({ error: { code, message: 'english detail' } }, status))
      const error = await h.client
        .login({ username: 'x', password: 'y', deviceName: 'd', platform: 'android' })
        .catch((e) => e)
      expect(error).toBeInstanceOf(HubApiError)
      expect(error.code).toBe(code)
      expect(error.message).toContain(expected)
      // 服务端英文原文不进 message，只留在 detail
      expect(error.message).not.toContain('english')
    }
  })

  it('没有错误 body 时按 HTTP 状态兜底', async () => {
    const h = makeClient(() => new Response('', { status: 429 }))
    const error = await h.client
      .login({ username: 'x', password: 'y', deviceName: 'd', platform: 'android' })
      .catch((e) => e)
    expect(error.code).toBe('RATE_LIMITED')
  })
})

describe('bootstrap 与 Bearer', () => {
  it('带 Bearer，并解析出积分与后端', async () => {
    const h = makeClient((call) => {
      expect(call.auth).toBe(AT)
      return json(bootstrapBody())
    }, { initial: makeTokens() })
    const data = await h.client.bootstrap()
    expect(data.points.balance).toBe(12.5)
    expect(data.backends[0]!.id).toBe('cloud:self')
  })

  it('401 → 刷新一次 → 重试成功', async () => {
    const newTokens = makeTokens({ accessToken: `dshm_at_${'c'.repeat(40)}`, refreshToken: `dshm_rt_${'d'.repeat(40)}` })
    const h = makeClient((call) => {
      if (call.url.endsWith(MOBILE.refresh)) return json(newTokens)
      if (call.auth === AT) {
        return json({ code: 'UNAUTHENTICATED' }, 401)
      }
      return json(bootstrapBody())
    }, { initial: makeTokens() })
    const data = await h.client.bootstrap()
    expect(data.user.username).toBe('demo')
    expect(h.calls.filter((c) => c.url.endsWith(MOBILE.refresh))).toHaveLength(1)
    expect(h.calls.filter((c) => c.url.endsWith(MOBILE.bootstrap))).toHaveLength(2)
    expect((await h.store.load())?.accessToken).toBe(`dshm_at_${'c'.repeat(40)}`)
  })

  it('并发 401 只刷新一次（refresh token 轮换不能并发）', async () => {
    const newTokens = makeTokens({ accessToken: `dshm_at_${'c'.repeat(40)}` })
    let refreshCount = 0
    const h = makeClient(async (call) => {
      if (call.url.endsWith(MOBILE.refresh)) {
        refreshCount += 1
        await new Promise((r) => setTimeout(r, 10))
        return json(newTokens)
      }
      if (call.auth === AT) return json({ code: 'UNAUTHENTICATED' }, 401)
      return json(bootstrapBody())
    }, { initial: makeTokens() })
    const results = await Promise.all([h.client.bootstrap(), h.client.bootstrap(), h.client.bootstrap()])
    expect(results.map((r) => r.user.username)).toEqual(['demo', 'demo', 'demo'])
    expect(refreshCount).toBe(1)
  })

  it('access 过期时先本地刷新，再带新令牌发请求', async () => {
    const expired = makeTokens({ accessExpiresAt: new Date(NOW - 10_000).toISOString() })
    const fresh = makeTokens({ accessToken: `dshm_at_${'e'.repeat(40)}` })
    const h = makeClient((call) => {
      if (call.url.endsWith(MOBILE.refresh)) return json(fresh)
      expect(call.auth).toBe(`Bearer ${'dshm_at_' + 'e'.repeat(40)}`)
      return json(bootstrapBody())
    }, { initial: expired })
    await h.client.bootstrap()
    expect(h.calls[0]!.url).toContain(MOBILE.refresh)
  })

  it('刷新失败 → 清令牌 + 通知回登录页', async () => {
    const h = makeClient((call) => {
      if (call.url.endsWith(MOBILE.refresh)) return json({ code: 'DEVICE_REVOKED' }, 401)
      return json({ code: 'UNAUTHENTICATED' }, 401)
    }, { initial: makeTokens() })
    const error = await h.client.bootstrap().catch((e) => e)
    expect(error.code).toBe('DEVICE_REVOKED')
    expect(await h.store.load()).toBeNull()
    expect(h.authLost.length).toBe(1)
  })

  it('刷新时网络错误不清令牌（可能只是断网）', async () => {
    const h = makeClient((call) => {
      if (call.url.endsWith(MOBILE.refresh)) throw new TypeError('fetch failed')
      return json({ code: 'UNAUTHENTICATED' }, 401)
    }, { initial: makeTokens() })
    const error = await h.client.bootstrap().catch((e) => e)
    expect(error.code).toBe('network')
    expect(await h.store.load()).not.toBeNull()
    expect(h.authLost).toHaveLength(0)
  })

  it('响应不符合 schema → protocol，而不是把脏数据交给 UI', async () => {
    const h = makeClient(() => json({ user: { id: 'x' } }), { initial: makeTokens() })
    const error = await h.client.bootstrap().catch((e) => e)
    expect(error.code).toBe('protocol')
  })

  it('超时映射成 timeout', async () => {
    const h = makeClient(
      (_call) =>
        new Promise<Response>((_resolve, reject) => {
          // 永不返回，等 AbortController 触发
          setTimeout(() => reject(new Error('aborted')), 50)
        }),
      { initial: makeTokens(), timeoutMs: 10 },
    )
    const error = await h.client.bootstrap().catch((e) => e)
    expect(error.code).toBe('timeout')
    expect(error.retryable).toBe(true)
  })

  it('401 DEVICE_REVOKED 直接清令牌回登录页，不尝试 refresh', async () => {
    let refreshCount = 0
    const h = makeClient((call) => {
      if (call.url.endsWith(MOBILE.refresh)) {
        refreshCount += 1
        return json(makeTokens())
      }
      return json({ error: { code: 'DEVICE_REVOKED', message: 'revoked' } }, 401)
    }, { initial: makeTokens() })
    const error = await h.client.bootstrap().catch((e) => e)
    expect(error.code).toBe('DEVICE_REVOKED')
    expect(refreshCount).toBe(0)
    expect(await h.store.load()).toBeNull()
    expect(h.authLost).toHaveLength(1)
  })

  it('401 DEVICE_TOKEN_INVALID 才去 refresh', async () => {
    const fresh = makeTokens({ accessToken: `dshm_at_${'f'.repeat(40)}` })
    let refreshCount = 0
    const h = makeClient((call) => {
      if (call.url.endsWith(MOBILE.refresh)) {
        refreshCount += 1
        return json(fresh)
      }
      if (call.auth?.endsWith('a'.repeat(40))) {
        return json({ error: { code: 'DEVICE_TOKEN_INVALID' } }, 401)
      }
      return json(bootstrapBody())
    }, { initial: makeTokens() })
    await h.client.bootstrap()
    expect(refreshCount).toBe(1)
  })

  it('429 带 details.retryAfterSec：解析成倒计时', async () => {
    const h = makeClient(
      () =>
        json(
          { error: { code: 'RATE_LIMITED', message: 'too many', details: { retryAfterSec: 42 } } },
          429,
        ),
    )
    const error = await h.client
      .login({ username: 'x', password: 'y', deviceName: 'd', platform: 'android' })
      .catch((e) => e)
    expect(error.code).toBe('RATE_LIMITED')
    expect(error.retryAfterSec).toBe(42)
    expect(error.message).toContain('太频繁')
  })

  it('网络错误映射成 network', async () => {
    const h = makeClient(() => {
      throw new TypeError('fetch failed')
    }, { initial: makeTokens() })
    const error = await h.client.bootstrap().catch((e) => e)
    expect(error.code).toBe('network')
  })

  it('没有令牌直接报 UNAUTHENTICATED，不发请求', async () => {
    const h = makeClient(() => json(bootstrapBody()))
    const error = await h.client.bootstrap().catch((e) => e)
    expect(error.code).toBe('UNAUTHENTICATED')
    expect(h.calls).toHaveLength(0)
  })
})

describe('唤醒与 ticket', () => {
  it('409 → CAPACITY_FULL（中文提示）', async () => {
    const h = makeClient(() => json({ code: 'CAPACITY_FULL' }, 409), { initial: makeTokens() })
    const error = await h.client.wake().catch((e) => e)
    expect(error.code).toBe('CAPACITY_FULL')
    expect(error.message).toContain('人数较多')
  })

  it('402 → INSUFFICIENT_POINTS', async () => {
    const h = makeClient(() => json({ code: 'INSUFFICIENT_POINTS' }, 402), { initial: makeTokens() })
    const error = await h.client.wake().catch((e) => e)
    expect(error.code).toBe('INSUFFICIENT_POINTS')
    expect(error.message).toContain('积分不足')
  })

  it('openChannel 用 ticket 拼 WS 地址（http → ws）', async () => {
    const captured: string[] = []
    const socket = {
      send: () => {},
      close: () => {},
      addEventListener: () => {},
    }
    const h = makeClient(
      (call) => {
        expect(call.url).toContain('/nodes/cloud%3Aself/ticket')
        return json({ ticket: 'tk_1234567890abcdefghij', expiresAt: new Date(NOW + 30_000).toISOString() })
      },
      {
        initial: makeTokens(),
        createSocket: (url: string) => {
          captured.push(url)
          return socket
        },
      },
    )
    // 这个 client 的 origin 是 https，先验证 wss；再单独验证 http→ws
    await h.client.openChannel('cloud:self')
    expect(captured[0]).toBe(
      `wss://hub.test:8123/api/mobile/nodes/cloud%3Aself/channel?ticket=tk_1234567890abcdefghij`,
    )

    const captured2: string[] = []
    const store2 = new MemoryTokenStore()
    await store2.save(makeTokens())
    const httpClient = new HubClient({
      origin: 'http://127.0.0.1:5243',
      tokenStore: store2,
      now: () => NOW,
      fetchImpl: async () => json({ ticket: 'tk_abcdefghijklmnopqrst', expiresAt: new Date(NOW + 30_000).toISOString() }),
      createSocket: (url) => {
        captured2.push(url)
        return socket
      },
    })
    await httpClient.openChannel('cloud:self')
    expect(captured2[0]).toBe('ws://127.0.0.1:5243/api/mobile/nodes/cloud%3Aself/channel?ticket=tk_abcdefghijklmnopqrst')
  })
})

describe('退出', () => {
  it('网络失败也清本地令牌', async () => {
    const h = makeClient(() => {
      throw new TypeError('offline')
    }, { initial: makeTokens() })
    await h.client.logout()
    expect(await h.store.load()).toBeNull()
  })

  it('带 Bearer 调 logout', async () => {
    const h = makeClient((call) => {
      expect(call.auth).toBe(AT)
      return new Response('', { status: 204 })
    }, { initial: makeTokens() })
    await h.client.logout()
    expect(h.calls).toHaveLength(1)
    expect(await h.store.load()).toBeNull()
  })
})

describe('地址解析', () => {
  it('地址去掉末尾斜杠；没配置入口时是空串（不发明一个默认域名）', async () => {
    const { resolveHubOrigin, MOCK_HUB_ORIGIN } = await import('../src/config.js')
    // 仓库里不写死任何 Hub 地址：没有构建参数/用户地址时就是空串
    expect(resolveHubOrigin()).toBe('')
    expect(resolveHubOrigin('https://hub.example.com:8443/')).toBe('https://hub.example.com:8443')
    expect(resolveHubOrigin(MOCK_HUB_ORIGIN)).toBe(MOCK_HUB_ORIGIN)
    // 非法值当作没给（不退到任何真实地址）
    expect(resolveHubOrigin('ftp://evil.test')).toBe('')
    expect(resolveHubOrigin('   ')).toBe('')
  })
})

describe('设备合并（0.2.9：一台手机一条设备记录）', () => {
  it('登录请求带 installId（Hub 用它复用同一条设备记录）', async () => {
    const tokens = makeTokens()
    const h = makeClient((call) => {
      expect(call.body).toMatchObject({
        username: 'demo',
        deviceName: 'Pixel',
        installId: 'install-abc-123',
      })
      return json(tokens)
    })
    await h.client.login({
      username: 'demo',
      password: 'demo1234',
      deviceName: 'Pixel',
      platform: 'android',
      installId: 'install-abc-123',
    })
  })

  it('consolidateDevices：Bearer 调 /auth/consolidate，返回被合并条数；失败/未登录静默 0', async () => {
    const tokens = makeTokens()
    const h = makeClient((call) => {
      if (call.url === `${ORIGIN}${MOBILE.consolidate}`) {
        expect(call.method).toBe('POST')
        expect(call.auth).toBe(`Bearer ${tokens.accessToken}`)
        return json({ removed: 3 })
      }
      return json({}, 500)
    }, { initial: tokens })
    expect(await h.client.consolidateDevices()).toBe(3)

    // 服务端错误 → 0（不影响主流程）
    const failing = makeClient(() => json({ error: { code: 'INTERNAL', message: 'x' } }, 500), {
      initial: tokens,
    })
    expect(await failing.client.consolidateDevices()).toBe(0)

    // 没有令牌 → 不请求直接 0
    const anonymous = makeClient(() => json({ removed: 9 }))
    expect(await anonymous.client.consolidateDevices()).toBe(0)
    expect(anonymous.calls).toHaveLength(0)
  })
})

// ── 0.2.14：consolidate 不再出现「refresh 200 后紧跟 consolidate 401」 ────────
//
// 生产 Hub 日志里冷启动偶发 `POST /auth/refresh 200` 后紧跟 `POST /auth/consolidate 401`：
// 旧实现直接拿 tokenStore 里（bootstrap 刷新前）的 access 去调 consolidate，必然 401。
// consolidate 只是设备台账清理，401 本身不影响登录，但会干扰排查；现在按需刷新 + 401 重试一次。

describe('设备合并（0.2.14：按需刷新 / 401 重试）', () => {
  it('access 过期：先 refresh 再用新令牌调 consolidate', async () => {
    const expired = makeTokens({ accessExpiresAt: new Date(NOW - 10_000).toISOString() })
    const fresh = makeTokens({ accessToken: `dshm_at_${'e'.repeat(40)}` })
    const h = makeClient((call) => {
      if (call.url.endsWith(MOBILE.refresh)) return json(fresh)
      if (call.url.endsWith(MOBILE.consolidate)) {
        expect(call.auth).toBe(`Bearer ${`dshm_at_${'e'.repeat(40)}`}`)
        return json({ removed: 2 })
      }
      return json({}, 500)
    }, { initial: expired })
    expect(await h.client.consolidateDevices()).toBe(2)
    expect(h.calls.map((c) => c.url.replace(ORIGIN, ''))).toEqual([
      MOBILE.refresh,
      MOBILE.consolidate,
    ])
  })

  it('consolidate 401：刷新后重试一次，成功返回被合并条数', async () => {
    const fresh = makeTokens({ accessToken: `dshm_at_${'g'.repeat(40)}` })
    let consolidateCount = 0
    const h = makeClient((call) => {
      if (call.url.endsWith(MOBILE.refresh)) return json(fresh)
      if (call.url.endsWith(MOBILE.consolidate)) {
        consolidateCount += 1
        if (consolidateCount === 1) return json({ code: 'DEVICE_TOKEN_INVALID' }, 401)
        expect(call.auth).toBe(`Bearer ${`dshm_at_${'g'.repeat(40)}`}`)
        return json({ removed: 5 })
      }
      return json({}, 500)
    }, { initial: makeTokens() })
    expect(await h.client.consolidateDevices()).toBe(5)
    expect(consolidateCount).toBe(2)
    expect(h.authLost).toHaveLength(0)
  })

  it('consolidate 401 时本地已被并发刷新更新：直接换新令牌重试，不再 refresh', async () => {
    const rotated = makeTokens({ accessToken: `dshm_at_${'h'.repeat(40)}` })
    let harness: Harness | null = null
    let consolidateCount = 0
    const h = makeClient((call) => {
      if (call.url.endsWith(MOBILE.consolidate)) {
        consolidateCount += 1
        if (consolidateCount === 1) {
          // 模拟并发的 bootstrap 刷新刚把令牌轮换进 store
          harness!.store.save(rotated)
          return json({ code: 'DEVICE_TOKEN_INVALID' }, 401)
        }
        expect(call.auth).toBe(`Bearer ${`dshm_at_${'h'.repeat(40)}`}`)
        return json({ removed: 1 })
      }
      return json({ code: 'DEVICE_TOKEN_INVALID' }, 401)
    }, { initial: makeTokens() })
    harness = h
    expect(await h.client.consolidateDevices()).toBe(1)
    expect(h.calls.some((c) => c.url.endsWith(MOBILE.refresh))).toBe(false)
  })

  it('刷新被拒（DEVICE_TOKEN_INVALID）：静默 0，不通知回登录页', async () => {
    const h = makeClient((call) => {
      if (call.url.endsWith(MOBILE.refresh)) return json({ code: 'DEVICE_TOKEN_INVALID' }, 401)
      return json({ code: 'UNAUTHENTICATED' }, 401)
    }, { initial: makeTokens() })
    expect(await h.client.consolidateDevices()).toBe(0)
    expect(h.authLost).toHaveLength(0)
    // 令牌交给上层恢复流程处理（这里不清）
    expect(await h.store.load()).not.toBeNull()
  })

  it('网络错误：静默 0，不抛错', async () => {
    const h = makeClient(() => {
      throw new TypeError('offline')
    }, { initial: makeTokens() })
    expect(await h.client.consolidateDevices()).toBe(0)
  })
})

describe('令牌失效的错误码语义（0.2.14：UI 据此决定静默恢复还是回登录页）', () => {
  it('access 过期 + refresh 被拒（DEVICE_TOKEN_INVALID）→ 抛 DEVICE_TOKEN_INVALID', async () => {
    const expired = makeTokens({ accessExpiresAt: new Date(NOW - 10_000).toISOString() })
    const h = makeClient((call) => {
      if (call.url.endsWith(MOBILE.refresh)) return json({ code: 'DEVICE_TOKEN_INVALID' }, 401)
      return json(bootstrapBody())
    }, { initial: expired })
    const error = await h.client.bootstrap().catch((e) => e)
    expect(error.code).toBe('DEVICE_TOKEN_INVALID')
    // 非吊销：不清令牌、不通知回登录页（由 auth 的静默恢复决定）
    expect(await h.store.load()).not.toBeNull()
    expect(h.authLost).toHaveLength(0)
  })

  it('access 过期 + refresh 被吊销（DEVICE_REVOKED）→ 抛 DEVICE_REVOKED 并清令牌', async () => {
    const expired = makeTokens({ accessExpiresAt: new Date(NOW - 10_000).toISOString() })
    const h = makeClient((call) => {
      if (call.url.endsWith(MOBILE.refresh)) return json({ code: 'DEVICE_REVOKED' }, 401)
      return json(bootstrapBody())
    }, { initial: expired })
    const error = await h.client.bootstrap().catch((e) => e)
    expect(error.code).toBe('DEVICE_REVOKED')
    expect(await h.store.load()).toBeNull()
    expect(h.authLost).toEqual(['device-revoked'])
  })
})
