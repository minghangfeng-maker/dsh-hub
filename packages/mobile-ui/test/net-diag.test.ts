/**
 * 登录页「网络检测」（0.4.9）：
 *
 *  1. `diagnose()` 是纯函数——登录报网络失败时到底给用户看哪一句结论，全部在这里钉住：
 *     手机没网 / App 被禁止联网 / 网络受限 / 服务器连不上（含 DNS·超时·被拦截·TLS）/ 网络正常，
 *     以及「任何组合都能给出一句非空结论」。
 *  2. 平台封装：浏览器回退（navigator.onLine + no-cors fetch）、对照站点覆盖（e2e 注入）、
 *     Hub 探测地址、检测编排（三行状态推进、②③并行、诊断摘要不含地址）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CONTROL_SITES,
  browserProbe,
  browserStatus,
  controlSites,
  diagSummary,
  diagnose,
  errorKindLabel,
  hubNote,
  hubProbeUrl,
  hubSummaryNote,
  hubTargetsOf,
  internetNote,
  phoneNote,
  runNetDiag,
  stepLabel,
  transportLabel,
  verdictTone,
  type DiagAction,
  type DiagInput,
  type DiagVerdict,
  type NetDiagBridge,
  type NetStatus,
  type ProbeErrorKind,
  type ProbeResult,
} from '../src/lib/net-diag'

// ── 构造器 ──────────────────────────────────────────────────────────────────

function net(overrides: Partial<NetStatus> = {}): NetStatus {
  return {
    connected: true,
    transport: 'wifi',
    validated: true,
    metered: false,
    restrictBackground: false,
    ...overrides,
  }
}

function reachable(ms = 80): ProbeResult {
  return { ok: true, status: 200, ms, errorKind: null, bodyHint: null }
}

function broken(kind: ProbeErrorKind, ms = 900, extra: Partial<ProbeResult> = {}): ProbeResult {
  return { ok: false, status: null, ms, errorKind: kind, bodyHint: null, ...extra }
}

/** 云厂商拦截页：HTTP 403 的 HTML，前 2KB 命中「备案」。 */
function blockPage(): ProbeResult {
  return { ok: false, status: 403, ms: 240, errorKind: 'blocked', bodyHint: 'icp' }
}

function httpError(status: number): ProbeResult {
  return { ok: false, status, ms: 300, errorKind: 'other', bodyHint: null }
}

const CONTROL_OK = [reachable(), broken('timeout', 5000)]

// ── 结论表（表驱动） ────────────────────────────────────────────────────────

interface Case {
  name: string
  input: DiagInput
  verdict: DiagVerdict
  cause?: string
  actions?: DiagAction[]
}

const CASES: Case[] = [
  {
    name: '手机没连网 → 打开网络设置（哪怕探测结果都是通的，也是没网优先）',
    input: { status: net({ connected: false, transport: 'none', validated: false }), control: [], hub: null },
    verdict: 'offline',
    actions: ['openNetworkSettings', 'retry'],
  },
  {
    name: '手机没连网但系统仍报 validated → 依然是没网',
    input: {
      status: net({ connected: false, transport: 'none' }),
      control: [reachable()],
      hub: reachable(),
    },
    verdict: 'offline',
  },
  {
    name: '对照站点与 Hub 都通 → 网络正常',
    input: { status: net(), control: CONTROL_OK, hub: reachable() },
    verdict: 'ok',
    actions: ['relogin', 'retry'],
  },
  {
    name: '对照站点不通但 Hub 通 → 网络正常（能连上 Hub 就够了）',
    input: { status: net(), control: [broken('timeout'), broken('reset')], hub: reachable() },
    verdict: 'ok',
  },
  {
    name: '对照站点通、Hub DNS 失败 → 服务器问题',
    input: { status: net(), control: CONTROL_OK, hub: broken('dns', 120) },
    verdict: 'server',
    cause: 'dns',
    actions: ['retry'],
  },
  {
    name: '对照站点通、Hub 超时 → 服务器问题',
    input: { status: net(), control: CONTROL_OK, hub: broken('timeout', 5000) },
    verdict: 'server',
    cause: 'timeout',
  },
  {
    name: '对照站点通、Hub 连接被拒 → 服务器问题',
    input: { status: net(), control: CONTROL_OK, hub: broken('refused', 60) },
    verdict: 'server',
    cause: 'refused',
  },
  {
    name: '对照站点通、Hub TLS 失败 → 服务器问题',
    input: { status: net(), control: CONTROL_OK, hub: broken('tls', 300) },
    verdict: 'server',
    cause: 'tls',
  },
  {
    name: '对照站点通、Hub 连接被重置 → 服务器问题',
    input: { status: net(), control: CONTROL_OK, hub: broken('reset', 400) },
    verdict: 'server',
    cause: 'reset',
  },
  {
    name: '对照站点通、Hub 被拦截页挡住（备案）→ 服务器问题，cause=blocked-page',
    input: { status: net(), control: CONTROL_OK, hub: blockPage() },
    verdict: 'server',
    cause: 'blocked-page',
  },
  {
    name: '对照站点通、Hub 500 → 服务器自己出错',
    input: { status: net(), control: CONTROL_OK, hub: httpError(500) },
    verdict: 'server',
    cause: 'http',
  },
  {
    name: '两组都不通 + 系统说网络可用 + 全部瞬间失败 → App 可能被禁止联网',
    input: {
      status: net(),
      control: [broken('refused', 12), broken('refused', 18)],
      hub: broken('refused', 15),
    },
    verdict: 'blocked',
    actions: ['openAppSettings', 'retry'],
  },
  {
    name: '连接层直接报 EPERM（errorKind=blocked）→ App 被禁止联网（与快慢无关）',
    input: {
      status: net(),
      control: [broken('blocked', 800), broken('blocked', 900)],
      hub: broken('blocked', 850),
    },
    verdict: 'blocked',
  },
  {
    name: '两组都不通 + validated=false（Wi-Fi 连着但上不了网）→ 网络受限',
    input: {
      status: net({ validated: false }),
      control: [broken('timeout', 5000), broken('timeout', 5000)],
      hub: broken('timeout', 5000),
    },
    verdict: 'limited',
    actions: ['openNetworkSettings', 'retry'],
  },
  {
    name: '两组都不通 + validated=true 但都是慢超时 → 网络受限（不轻易说被禁）',
    input: {
      status: net(),
      control: [broken('timeout', 5000), broken('timeout', 5000)],
      hub: broken('timeout', 5000),
    },
    verdict: 'limited',
  },
  {
    name: '拦截页不算「App 被禁」（它说明网络是通的）→ 网络受限',
    input: {
      status: net(),
      control: [broken('timeout', 5000)],
      hub: blockPage(),
    },
    verdict: 'limited',
  },
  {
    name: '拿不到系统状态（插件异常）+ 对照站点通 + Hub 不通 → 服务器问题',
    input: { status: null, control: CONTROL_OK, hub: broken('refused', 40) },
    verdict: 'server',
  },
  {
    name: '拿不到系统状态 + 两组都不通 → 网络受限（不能武断说 App 被禁）',
    input: { status: null, control: [broken('refused', 20)], hub: broken('refused', 20) },
    verdict: 'limited',
  },
  {
    name: '后台流量被限制 + 全部瞬间失败 → 仍判 App 被禁，但说明里点出后台限制',
    input: {
      status: net({ restrictBackground: true }),
      control: [broken('refused', 10)],
      hub: broken('refused', 12),
    },
    verdict: 'blocked',
  },
]

describe('diagnose()：登录报网络失败时给哪一句结论', () => {
  for (const item of CASES) {
    it(item.name, () => {
      const outcome = diagnose(item.input)
      expect(outcome.verdict).toBe(item.verdict)
      // 任何组合都要有非空结论（不允许出现空结论 / 卡在检测中）
      expect(outcome.title.trim().length).toBeGreaterThan(0)
      expect(outcome.detail.trim().length).toBeGreaterThan(0)
      expect(outcome.actions.length).toBeGreaterThan(0)
      if (item.cause !== undefined) expect(outcome.cause).toBe(item.cause)
      if (item.actions) expect(outcome.actions).toEqual(item.actions)
      expect(outcome.controlOk).toBe(item.input.control.some((one) => one.ok))
      expect(outcome.hubOk).toBe(item.input.hub?.ok === true)
    })
  }

  it('服务器类结论：标题点明「不是手机的问题」，原因按 errorKind 换一句', () => {
    const dns = diagnose({ status: net(), control: CONTROL_OK, hub: broken('dns', 100) })
    expect(dns.title).toContain('不是手机的问题')
    expect(dns.detail).toContain('域名')

    const timeout = diagnose({ status: net(), control: CONTROL_OK, hub: broken('timeout', 5000) })
    expect(timeout.detail).toContain('响应')

    const blocked = diagnose({ status: net(), control: CONTROL_OK, hub: blockPage() })
    expect(blocked.detail).toContain('备案')

    const tls = diagnose({ status: net(), control: CONTROL_OK, hub: broken('tls', 300) })
    expect(tls.detail).toContain('TLS')

    const server500 = diagnose({ status: net(), control: CONTROL_OK, hub: httpError(503) })
    expect(server500.detail).toContain('503')
  })

  it('App 被禁止联网：附一句「在应用详情里打开…权限」的指路', () => {
    const outcome = diagnose({
      status: net(),
      control: [broken('refused', 10)],
      hub: broken('refused', 10),
    })
    expect(outcome.title).toContain('禁止联网')
    expect(outcome.hint).toContain('应用详情')
    expect(outcome.hint).toContain('WLAN与移动数据')
  })

  it('只有「App 被禁止联网」带指路文案，其它结论不带', () => {
    const cases: DiagInput[] = [
      { status: net({ connected: false, transport: 'none' }), control: [], hub: null },
      { status: net(), control: CONTROL_OK, hub: reachable() },
      { status: net(), control: CONTROL_OK, hub: broken('dns', 100) },
      { status: net({ validated: false }), control: [broken('timeout', 5000)], hub: broken('timeout', 5000) },
    ]
    for (const input of cases) expect(diagnose(input).hint).toBe('')
  })

  it('网络受限：连上了但系统说上不了网，文案落在「不能上网」上', () => {
    const outcome = diagnose({
      status: net({ validated: false }),
      control: [broken('timeout', 5000)],
      hub: broken('timeout', 5000),
    })
    expect(outcome.title).toContain('受限')
    expect(outcome.detail).toContain('不能上网')
  })

  it('网络正常：网络与 Hub 都通时说「都通」，只有 Hub 通时不说谎', () => {
    expect(diagnose({ status: net(), control: CONTROL_OK, hub: reachable() }).detail).toContain('DSH Hub')
    expect(
      diagnose({ status: net(), control: [broken('timeout')], hub: reachable() }).detail,
    ).toBe('能连上 DSH Hub')
  })
})

// ── 平台封装的回退逻辑 ──────────────────────────────────────────────────────

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as { __dshNetDiagControlSites?: unknown }).__dshNetDiagControlSites
  delete (import.meta.env as Record<string, unknown>).VITE_NET_DIAG_CONTROL_SITES
})

describe('浏览器回退', () => {
  it('navigator.onLine=false → 没连网，且不冒充「系统验证过可上网」', () => {
    vi.stubGlobal('navigator', { onLine: false })
    const status = browserStatus()
    expect(status.connected).toBe(false)
    expect(status.transport).toBe('none')
    expect(status.validated).toBe(false)
  })

  it('navigator.onLine=true → 已连接；validated 仍为 false（浏览器验证不了）', () => {
    vi.stubGlobal('navigator', { onLine: true })
    const status = browserStatus()
    expect(status.connected).toBe(true)
    expect(status.transport).toBe('other')
    expect(status.validated).toBe(false)
  })

  it('no-cors 探测：请求到达 → ok，读不到状态码与正文', async () => {
    const calls: Array<{ url: string; mode?: string }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, mode: init.mode })
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch
    const result = await browserProbe('http://127.0.0.1:9/__test/health', 1000, fetchImpl)
    expect(result.ok).toBe(true)
    expect(result.status).toBeNull()
    expect(result.errorKind).toBeNull()
    expect(calls[0]?.mode).toBe('no-cors')
  })

  it('请求被拒（浏览器里一律 TypeError）→ 不通，errorKind=other', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const result = await browserProbe('http://127.0.0.1:9/__test/health', 1000, fetchImpl)
    expect(result.ok).toBe(false)
    expect(result.errorKind).toBe('other')
    expect(result.ms).toBeGreaterThanOrEqual(0)
  })

  it('超过 timeoutMs 没响应 → errorKind=timeout', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as unknown as typeof fetch
    const result = await browserProbe('http://127.0.0.1:9/slow', 20, fetchImpl)
    expect(result.ok).toBe(false)
    expect(result.errorKind).toBe('timeout')
  })
})

describe('地址与覆盖', () => {
  it('默认对照站点是国内两个稳定的 HTTPS 地址', () => {
    expect(controlSites()).toEqual([...DEFAULT_CONTROL_SITES])
    expect(DEFAULT_CONTROL_SITES.length).toBeGreaterThanOrEqual(2)
  })

  it('运行时注入优先（e2e 用，CI 里不依赖外网）', () => {
    ;(globalThis as { __dshNetDiagControlSites?: unknown }).__dshNetDiagControlSites = [
      'http://127.0.0.1:5401/__test/health',
    ]
    expect(controlSites()).toEqual(['http://127.0.0.1:5401/__test/health'])
  })

  it('注入值不合法时回退到默认，不带坏地址去探测', () => {
    ;(globalThis as { __dshNetDiagControlSites?: unknown }).__dshNetDiagControlSites = ['not-a-url', 42]
    expect(controlSites()).toEqual([...DEFAULT_CONTROL_SITES])
  })

  it('构建参数 VITE_NET_DIAG_CONTROL_SITES（逗号分隔）也能覆盖', () => {
    ;(import.meta.env as Record<string, unknown>).VITE_NET_DIAG_CONTROL_SITES =
      'http://a.test/x, http://b.test/y'
    expect(controlSites()).toEqual(['http://a.test/x', 'http://b.test/y'])
  })

  it('Hub 探测地址：bootstrap；mock（进程内假 Hub）没有真实地址', () => {
    expect(hubProbeUrl('https://example.test:8123/')).toBe(
      'https://example.test:8123/api/mobile/bootstrap',
    )
    expect(hubProbeUrl('http://127.0.0.1:5400')).toBe(
      'http://127.0.0.1:5400/api/mobile/bootstrap',
    )
    expect(hubProbeUrl('mock')).toBeNull()
  })
})

describe('三行短说明', () => {
  it('手机网络：没连 / Wi-Fi / 移动数据 / 读不到状态', () => {
    expect(phoneNote(null)).toContain('读不到')
    expect(phoneNote(net({ connected: false, transport: 'none' }))).toBe('没有连接网络')
    expect(phoneNote(net())).toBe('已连接Wi-Fi')
    expect(phoneNote(net({ transport: 'cellular' }))).toBe('已连接移动数据')
  })

  it('互联网 / Hub：一行说明带失败原因', () => {
    expect(internetNote(CONTROL_OK)).toBe('对照站点可达')
    expect(internetNote([broken('timeout'), broken('dns')])).toContain('超时')
    expect(hubNote(null)).toContain('没有')
    expect(hubNote(reachable())).toBe('已连上服务器')
    expect(hubNote(broken('dns', 30))).toContain('域名解析失败')
    expect(hubNote(blockPage())).toBe('被拦截页挡住')
  })

  it('文案与色调映射齐全', () => {
    expect(transportLabel('ethernet')).toBe('以太网')
    expect(errorKindLabel('reset')).toBe('连接被重置')
    expect(verdictTone('ok')).toBe('ok')
    expect(verdictTone('server')).toBe('warn')
    expect(verdictTone('blocked')).toBe('bad')
    expect(verdictTone('offline')).toBe('bad')
  })
})

// ── 检测编排 ────────────────────────────────────────────────────────────────

/** 假原生桥：按 URL 给结果，并记录调用顺序。 */
function fakeBridge(options: {
  status: NetStatus
  results: Record<string, ProbeResult>
  calls?: string[]
}): NetDiagBridge {
  return {
    status: async () => options.status,
    probe: async (url) => {
      options.calls?.push(url)
      return options.results[url] ?? reachable()
    },
    openAppSettings: async () => {},
    openNetworkSettings: async () => {},
  }
}

describe('runNetDiag()', () => {
  it('三行依次推进；对照站点与 Hub 并行；摘要里没有地址', async () => {
    const calls: string[] = []
    const snapshots: string[][] = []
    const run = await runNetDiag({
      bridge: fakeBridge({
        status: net({ transport: 'cellular' }),
        results: { 'https://hub.test/api/mobile/bootstrap': reachable() },
        calls,
      }),
      controlSites: ['https://a.test/', 'https://b.test/'],
      hubUrl: 'https://hub.test/api/mobile/bootstrap',
      record: false,
      onProgress: (steps) => snapshots.push(steps.map((step) => `${step.key}:${step.state}`)),
    })

    expect(run.outcome.verdict).toBe('ok')
    expect(run.steps.map((step) => step.state)).toEqual(['ok', 'ok', 'ok'])
    // 对照站点两个都探测了 + Hub
    expect(calls).toHaveLength(3)
    // ② 和 ③ 同时是 running（并行）
    expect(snapshots.some((one) => one.includes('internet:running') && one.includes('hub:running'))).toBe(true)

    const summary = diagSummary(run)
    expect(summary).toContain('verdict=ok')
    expect(summary).toContain('control=2/2')
    expect(summary).not.toContain('http')
    expect(summary).not.toContain('hub.test')
  })

  it('Hub 不通、对照站点通 → 服务器结论，Hub 行是 fail', async () => {
    const run = await runNetDiag({
      bridge: fakeBridge({
        status: net(),
        results: { 'https://hub.test/api/mobile/bootstrap': broken('dns', 80) },
      }),
      controlSites: ['https://a.test/'],
      hubUrl: 'https://hub.test/api/mobile/bootstrap',
      record: false,
    })
    expect(run.outcome.verdict).toBe('server')
    const hubRow = run.steps.find((step) => step.key === 'hub')
    expect(hubRow?.state).toBe('fail')
    expect(hubRow?.note).toContain('域名解析失败')
    expect(diagSummary(run)).toContain('hub=fail:dns')
  })

  it('浏览器回退（bridge=null）走 fetch：对照站点通、Hub 不通', async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('hub')) throw new TypeError('Failed to fetch')
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch

    const run = await runNetDiag({
      bridge: null,
      fetchImpl,
      controlSites: ['http://control.test/'],
      hubUrl: 'http://hub.test/api/mobile/bootstrap',
      record: false,
    })
    expect(run.outcome.verdict).toBe('server')
    expect(run.control[0]?.ok).toBe(true)
    expect(run.hub?.ok).toBe(false)
    expect(run.steps.map((step) => step.state)).toEqual(['ok', 'ok', 'fail'])
  })

  it('没有 Hub 地址（mock 构建）时 Hub 行直接 fail，不空转', async () => {
    const run = await runNetDiag({
      bridge: null,
      fetchImpl: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      controlSites: ['http://control.test/'],
      hubUrl: null,
      record: false,
    })
    expect(run.hub).toBeNull()
    expect(run.steps.find((step) => step.key === 'hub')?.state).toBe('fail')
    expect(run.outcome.title.trim().length).toBeGreaterThan(0)
  })

  it('桥接抛错不会把界面卡在检测中', async () => {
    const bridge: NetDiagBridge = {
      status: async () => {
        throw new Error('plugin missing')
      },
      probe: async () => {
        throw new Error('plugin missing')
      },
      openAppSettings: async () => {},
      openNetworkSettings: async () => {},
    }
    const run = await runNetDiag({
      bridge,
      controlSites: ['https://a.test/'],
      hubUrl: 'https://hub.test/api/mobile/bootstrap',
      record: false,
    })
    expect(run.steps.every((step) => step.state !== 'running' && step.state !== 'pending')).toBe(true)
    expect(run.outcome.title.trim().length).toBeGreaterThan(0)
  })
})


// ── 多入口（0.4.11 / WP52）──────────────────────────────────────────────────

describe('多入口：每个入口各自一行', () => {
  const ORIGINS = ['https://hub.example.com:8123', 'https://backup.example.com']

  it('hubTargetsOf：按候选顺序给探测地址，标出当前入口，去重、跳过 mock', () => {
    const targets = hubTargetsOf(ORIGINS, ORIGINS[1])
    expect(targets.map((target) => target.url)).toEqual([
      'https://hub.example.com:8123/api/mobile/bootstrap',
      'https://backup.example.com/api/mobile/bootstrap',
    ])
    expect(targets.map((target) => target.current)).toEqual([false, true])
    expect(hubTargetsOf(['mock'], 'mock')).toEqual([])
    expect(hubTargetsOf([ORIGINS[0]!, ORIGINS[0]!], ORIGINS[0])).toHaveLength(1)
  })

  it('runNetDiag 探测每个入口：hubs 顺序/current 与 bridge 一致，结论用当前入口', async () => {
    const calls: string[] = []
    const run = await runNetDiag({
      bridge: fakeBridge({
        status: net(),
        results: {
          'https://hub.example.com:8123/api/mobile/bootstrap': blockPage(),
          'https://backup.example.com/api/mobile/bootstrap': reachable(42),
        },
        calls,
      }),
      controlSites: ['https://a.test/'],
      hubTargets: hubTargetsOf(ORIGINS, ORIGINS[1]),
      record: false,
    })

    expect(calls).toHaveLength(3) // 对照站点 1 + 两个入口
    expect(run.hubs.map((entry) => entry.origin)).toEqual(ORIGINS)
    expect(run.hubs.map((entry) => entry.current)).toEqual([false, true])
    expect(run.hubs.map((entry) => entry.result.ok)).toEqual([false, true])
    // 当前入口（备用）通 → 结论「网络正常」，不会被主入口的拦截页带偏
    expect(run.outcome.verdict).toBe('ok')
    expect(run.hub?.ok).toBe(true)
    // Hub 行说明：当前入口通
    expect(run.steps.find((step) => step.key === 'hub')?.note).toContain('当前入口')
    expect(diagSummary(run)).toContain('hubs=fail:blocked,ok')
  })

  it('当前入口（首选）被拦截、备用通 → Hub 行说「备用入口可用」', async () => {
    const hubs = hubTargetsOf(ORIGINS, ORIGINS[0]).map((target, index) => ({
      origin: target.origin,
      current: target.current,
      result: index === 0 ? blockPage() : reachable(),
    }))
    expect(hubSummaryNote(hubs)).toBe('当前入口不通，备用入口可用')
    expect(hubSummaryNote([hubs[1]!])).toBe('当前入口已连上')
    expect(hubSummaryNote([])).toContain('没有')
    expect(hubSummaryNote([hubs[0]!])).toBe('被拦截页挡住')
  })
})

// ── 手机网页版（WP54）─────────────────────────────────────────────────────────

describe('网页版文案与结论口径（WP54 / C4）', () => {
  it('第一行叫「本机网络」：浏览器只知道在线/离线，没有 Wi-Fi/移动数据那种系统状态', () => {
    expect(stepLabel('phone')).toBe('手机网络')
    expect(stepLabel('phone', true)).toBe('本机网络')
    // 另外两行不变
    expect(stepLabel('internet', true)).toBe('互联网')
    expect(stepLabel('hub', true)).toBe('DSH Hub')
  })

  it('单入口的 Hub 行不说「入口」：网页版只有一个地址', () => {
    const [target] = hubTargetsOf(['https://hub.example.com:8123'], 'https://hub.example.com:8123')
    const hub = { origin: target!.origin, current: true, result: reachable() }
    expect(hubSummaryNote([hub], true)).toBe('已连上服务器')
    expect(hubSummaryNote([hub])).toBe('当前入口已连上')
    // 不通时仍是统一的失败文案
    expect(hubSummaryNote([{ ...hub, result: broken('dns', 30) }], true)).toContain('域名解析失败')
  })

  it('网页版不给「App 被禁止联网」的结论（浏览器里没有单 App 联网开关）', () => {
    // 这组输入在 APK 上是 blocked（系统说网络可用，但请求全部瞬间失败）
    const input: DiagInput = {
      status: net({ validated: true }),
      control: [broken('other', 12)],
      hub: broken('other', 10),
    }
    expect(diagnose(input).verdict).toBe('blocked')
    const webOutcome = diagnose({ ...input, web: true })
    expect(webOutcome.verdict).toBe('limited')
    expect(webOutcome.title).not.toContain('App')
    expect(webOutcome.hint).toBe('')
    expect(webOutcome.actions).not.toContain('openAppSettings')
  })

  it('runNetDiag({ web: true }) 把口径带进来：单入口 + 网页版文案', async () => {
    const calls: string[] = []
    const run = await runNetDiag({
      bridge: fakeBridge({ status: net(), results: {}, calls }),
      controlSites: ['https://a.test/'],
      hubTargets: hubTargetsOf(['https://hub.example.com:8123'], 'https://hub.example.com:8123'),
      web: true,
      record: false,
    })
    expect(run.hubs).toHaveLength(1)
    expect(calls).toHaveLength(2) // 对照站点 1 + 当前入口 1（不探别的入口）
    expect(run.steps.find((step) => step.key === 'hub')?.note).toBe('已连上服务器')
    expect(run.outcome.verdict).toBe('ok')
  })
})
