/**
 * 手机网页版（WP54）的界面差异：`lib/web-ui.ts` 的纯逻辑单测。
 *
 * 这里钉住四件容易做错的事：
 *  1. 版本区文案（「手机网页版 0.4.11」，没有 versionCode；有构建号才带括号）；
 *  2. 「电脑版」入口地址（`/?view=desktop`，C8）与 mock 开发版没有网页入口时的 null；
 *  3. Hub 网页（注册/找回密码/隐私）在网页版里**同页跳转**、跨源时退回新标签；
 *  4. 「下载 App」的地址解析（Hub 的匿名接口给的是站根相对路径，要补成本入口的绝对地址；
 *     接口坏了/没发布 APK 都返回 null，界面只 toast，不误跳）。
 */

import { describe, expect, it, vi } from 'vitest'

// 固定一套「网页构建、广州入口」的构建信息（真实模块里 IS_WEB_BUILD 来自 vite define）。
vi.mock('../src/lib/app-info', () => ({
  APP_VERSION: '0.4.11',
  HUB_ORIGIN: 'https://hub.example.com:8123',
  IS_WEB_BUILD: true,
  webPage: (path: string) => `https://hub.example.com:8123${path}`,
}))

import {
  APP_DOWNLOAD_API,
  WEB_VERSION_TITLE,
  absoluteUrl,
  desktopPageUrl,
  fetchAppDownloadUrl,
  hubPageTarget,
  isStandaloneDisplay,
  pickAppDownloadUrl,
  sameOrigin,
  webVersionText,
} from '../src/lib/web-ui'

/** 造一个只回固定值的 fetch（记录请求地址，方便断言「打的是哪个接口」）。 */
function fakeFetch(
  reply: { ok?: boolean; body?: unknown; throw?: boolean },
  calls: string[] = [],
): typeof fetch {
  return (async (url: string | URL | Request) => {
    calls.push(String(url))
    if (reply.throw === true) throw new TypeError('Failed to fetch')
    return {
      ok: reply.ok !== false,
      status: reply.ok === false ? 404 : 200,
      json: async () => reply.body,
    }
  }) as unknown as typeof fetch
}

describe('版本区文案', () => {
  it('网页版没有 versionCode：只写名字 + 版本号', () => {
    expect(WEB_VERSION_TITLE).toBe('手机网页版')
    expect(webVersionText()).toBe('手机网页版 0.4.11')
    expect(webVersionText('0.5.0')).toBe('手机网页版 0.5.0')
  })

  it('有构建号时附在括号里（W1 以后注入常量才用得到）', () => {
    expect(webVersionText('0.4.11', 'abc1234')).toBe('手机网页版 0.4.11（abc1234）')
    expect(webVersionText('0.4.11', '')).toBe('手机网页版 0.4.11')
    expect(webVersionText('0.4.11', null)).toBe('手机网页版 0.4.11')
  })
})

describe('电脑版入口（C8）', () => {
  it('是带 view=desktop 的首页地址（手机 UA 才不会又被 302 回 /m/）', () => {
    expect(desktopPageUrl()).toBe('https://hub.example.com:8123/?view=desktop')
  })

  it('mock 开发版（webPage 为 null）不显示这一行', async () => {
    // 单独造一份「mock 构建」的模块实例（app-info 不同）
    vi.resetModules()
    vi.doMock('../src/lib/app-info', () => ({
      APP_VERSION: '0.4.11',
      HUB_ORIGIN: 'mock',
      IS_WEB_BUILD: true,
      webPage: () => null,
    }))
    const mocked = await import('../src/lib/web-ui')
    expect(mocked.desktopPageUrl()).toBeNull()
    vi.doUnmock('../src/lib/app-info')
    vi.resetModules()
  })
})

describe('Hub 网页怎么打开（注册 / 找回密码 / 隐私）', () => {
  it('同源判定只看 origin，不看路径', () => {
    expect(sameOrigin('https://hub.example.com:8123/register', 'https://hub.example.com:8123')).toBe(true)
    expect(sameOrigin('https://hub.example.com:8123/x', 'https://hub.example.com:8123/m/')).toBe(true)
    expect(sameOrigin('https://backup.example.com/register', 'https://hub.example.com:8123')).toBe(false)
    expect(sameOrigin('mock', 'https://hub.example.com:8123')).toBe(false)
    expect(sameOrigin('/register', 'https://hub.example.com:8123')).toBe(false)
  })

  it('网页版 + 同源 → 同页跳转（返回手势即回 App）', () => {
    expect(
      hubPageTarget('https://hub.example.com:8123/register', {
        web: true,
        origin: 'https://hub.example.com:8123',
      }),
    ).toBe('same')
  })

  it('网页版 + 跨源（开发/e2e 的 VITE_HUB_ORIGIN）→ 新标签，别把 dev server 带走', () => {
    expect(
      hubPageTarget('http://127.0.0.1:5301/register', {
        web: true,
        origin: 'http://127.0.0.1:5302',
      }),
    ).toBe('new')
  })

  it('APK 构建永远走 openExternal（原生 Browser 插件）', () => {
    expect(
      hubPageTarget('https://hub.example.com:8123/register', {
        web: false,
        origin: 'https://hub.example.com:8123',
      }),
    ).toBe('new')
  })
})

describe('「下载 App」：Hub 的匿名 APK 接口', () => {
  it('相对站根的 url 补成本入口的绝对地址，并打对接口', async () => {
    const calls: string[] = []
    const url = await fetchAppDownloadUrl({
      origin: 'https://hub.example.com:8123',
      fetchImpl: fakeFetch({ body: { app: { url: '/android/bin/dsh-hub-app-0.4.11-abc.apk' } } }, calls),
    })
    expect(calls).toEqual(['https://hub.example.com:8123/api/public/android/download'])
    expect(calls[0]).toContain(APP_DOWNLOAD_API)
    expect(url).toBe('https://hub.example.com:8123/android/bin/dsh-hub-app-0.4.11-abc.apk')
  })

  it('接口给绝对地址（独立资产基址）就原样用', async () => {
    const url = await fetchAppDownloadUrl({
      origin: 'https://hub.example.com:8123',
      fetchImpl: fakeFetch({
        body: { app: { url: 'https://cdn.example.com/mobile-app/dsh-hub-app-0.4.11.apk' } },
      }),
    })
    expect(url).toBe('https://cdn.example.com/mobile-app/dsh-hub-app-0.4.11.apk')
  })

  it('没发布 APK / 结构不对 / 404 / 网络失败 / mock 入口 → 一律 null（界面只 toast）', async () => {
    const base = { origin: 'https://hub.example.com:8123' }
    expect(await fetchAppDownloadUrl({ ...base, fetchImpl: fakeFetch({ body: { app: null } }) })).toBeNull()
    expect(await fetchAppDownloadUrl({ ...base, fetchImpl: fakeFetch({ body: {} }) })).toBeNull()
    expect(
      await fetchAppDownloadUrl({ ...base, fetchImpl: fakeFetch({ body: { app: { url: 42 } } }) }),
    ).toBeNull()
    expect(
      await fetchAppDownloadUrl({ ...base, fetchImpl: fakeFetch({ ok: false, body: {} }) }),
    ).toBeNull()
    expect(await fetchAppDownloadUrl({ ...base, fetchImpl: fakeFetch({ throw: true }) })).toBeNull()
    expect(await fetchAppDownloadUrl({ origin: 'mock', fetchImpl: fakeFetch({ body: {} }) })).toBeNull()
  })

  it('只认站根相对路径与 http(s)：协议相对/相对文件名都不跳', () => {
    expect(absoluteUrl('/android/bin/a.apk', 'https://hub.example.com:8123/')).toBe(
      'https://hub.example.com:8123/android/bin/a.apk',
    )
    expect(absoluteUrl('//evil.example/x.apk', 'https://hub.example.com:8123')).toBeNull()
    expect(absoluteUrl('android/bin/a.apk', 'https://hub.example.com:8123')).toBeNull()
    expect(absoluteUrl('/android/bin/a.apk', 'mock')).toBeNull()
  })

  it('pickAppDownloadUrl 宽容地认 {app:{url}}', () => {
    expect(pickAppDownloadUrl({ app: { url: ' /x.apk ' } })).toBe('/x.apk')
    expect(pickAppDownloadUrl({ app: { url: '' } })).toBeNull()
    expect(pickAppDownloadUrl(null)).toBeNull()
    expect(pickAppDownloadUrl('x')).toBeNull()
    expect(pickAppDownloadUrl({ app: 'x' })).toBeNull()
  })
})

describe('是否 standalone（诊断面板要如实写）', () => {
  it('matchMedia 命中即 standalone', () => {
    expect(isStandaloneDisplay(() => ({ matches: true }))).toBe(true)
    expect(isStandaloneDisplay(() => ({ matches: false }))).toBe(false)
  })

  it('没有 matchMedia / 它抛错 → 当作不是', () => {
    expect(isStandaloneDisplay(undefined)).toBe(false)
    expect(
      isStandaloneDisplay(() => {
        throw new Error('unsupported')
      }),
    ).toBe(false)
  })

  it('查的就是 display-mode: standalone', () => {
    const queries: string[] = []
    isStandaloneDisplay((query) => {
      queries.push(query)
      return { matches: false }
    })
    expect(queries).toEqual(['(display-mode: standalone)'])
  })
})
