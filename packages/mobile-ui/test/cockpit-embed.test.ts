/**
 * 管理座舱嵌入模式（WP56d / docs/24 §6）的前端逻辑单测。
 *
 * 这里钉住四件最容易做错的事（任务书「测试」一节的四条中的三条，第四条第 4 条「过程行
 * 识别方案」在 core 的 `test/cockpit-embed.test.ts`）：
 *  1. 入口判定只看 `?embed=cockpit`，且码只认 hash 里的 `code`；
 *  2. 交接码**只用一次**，并且立刻从地址栏抹掉（`history.replaceState`，不新增历史）；
 *  3. 座舱令牌的 sessionStorage 与普通 `/m/` 的 localStorage 登录互不覆盖；
 *  4. postMessage 双向都校验 `event.origin === location.origin`（父页面不存在时不报错）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 固定成「网页构建」：真实模块里 IS_WEB_BUILD 来自 vite define（单测配置里是 false）。
vi.mock('../src/lib/app-info', () => ({
  APP_VERSION: '0.4.12',
  APP_VERSION_CODE: 52,
  APP_PACKAGE: 'tech.dshhub.app',
  IS_WEB_BUILD: true,
  IS_MOCK: false,
  IS_PROD_BUILD: true,
  HUB_ORIGIN: 'https://hub.test',
  HUB_ORIGINS: ['https://hub.test'],
  BUILD_INFO: { version: '0.4.12', build: 'testsha', builtAt: '1970-01-01T00:00:00.000Z' },
  webPage: (path: string) => `https://hub.test${path}`,
}))

import {
  COCKPIT_BRIDGE_CLASS,
  COCKPIT_BRIDGE_THEME,
  CockpitBridge,
  isCockpitEmbedSearch,
  parseCockpitEntry,
  parseCockpitIncoming,
  readCockpitCode,
  readCockpitTheme,
  sessionInitiatorOf,
  stripCockpitCode,
} from '../src/lib/cockpit'
import {
  initCockpitEmbed,
  isCockpitBridgeTheme,
  isCockpitEmbed,
  postCockpitMessage,
  resetCockpitEmbedForTests,
  setCockpitCode,
  takeCockpitCode,
} from '../src/lib/cockpit-embed'
import { ModeAwareTokenStore } from '../src/lib/storage'
import { MemoryTokenStore, COCKPIT_TOKEN_STORAGE_KEY } from '@dsh-hub/mobile-core'
import { makeTokens } from '../../mobile-core/test/helpers/tokens'

const ORIGIN = 'https://hub.test'

/** 造一个假的 location/history 并装到 globalThis 上（node 环境本来没有）。 */
function installLocation(search: string, hash: string): { replaced: string[] } {
  const replaced: string[] = []
  const locationLike = {
    search,
    hash,
    origin: ORIGIN,
    pathname: '/m/',
  }
  const historyLike = {
    state: { back: 1 },
    replaceState: (_state: unknown, _title: string, url: string) => {
      replaced.push(url)
      const at = url.indexOf('#')
      locationLike.hash = at >= 0 ? url.slice(at) : ''
      const q = url.indexOf('?')
      if (q >= 0) locationLike.search = url.slice(q, at >= 0 ? at : undefined)
    },
  }
  vi.stubGlobal('location', locationLike)
  vi.stubGlobal('history', historyLike)
  return { replaced }
}

beforeEach(() => {
  resetCockpitEmbedForTests()
})

afterEach(() => {
  resetCockpitEmbedForTests()
  vi.unstubAllGlobals()
})

describe('入口解析（?embed=cockpit#code=…）', () => {
  it('只有 embed=cockpit 才算嵌入模式（大小写不敏感、其它值不算）', () => {
    expect(isCockpitEmbedSearch('?embed=cockpit')).toBe(true)
    expect(isCockpitEmbedSearch('?embed=Cockpit')).toBe(true)
    expect(isCockpitEmbedSearch('?embed=1')).toBe(false)
    expect(isCockpitEmbedSearch('')).toBe(false)
    expect(isCockpitEmbedSearch('?other=cockpit')).toBe(false)
  })

  it('从 hash 里读码；不是嵌入模式就不认（普通 /m/ 的 #code= 不该被当成交接码）', () => {
    expect(parseCockpitEntry('?embed=cockpit', '#code=hc_1')).toEqual({
      embed: true,
      code: 'hc_1',
      cleanedHash: '',
      theme: null,
    })
    expect(parseCockpitEntry('?embed=cockpit', '#code=hc_1&x=1')).toEqual({
      embed: true,
      code: 'hc_1',
      cleanedHash: '#x=1',
      theme: null,
    })
    expect(parseCockpitEntry('?embed=cockpit', '#/c/s1?code=hc_1')).toEqual({
      embed: true,
      code: 'hc_1',
      cleanedHash: '#/c/s1',
      theme: null,
    })
    expect(parseCockpitEntry('?embed=cockpit&theme=bridge', '#code=hc_1').theme).toBe('bridge')
    expect(parseCockpitEntry('', '#code=hc_1').code).toBeNull()
    expect(parseCockpitEntry('?embed=cockpit', '#/c/s1').code).toBeNull()
  })

  it('没有 code 的 hash 原样返回（不把别的参数弄丢）', () => {
    expect(stripCockpitCode('')).toBe('')
    expect(stripCockpitCode('#')).toBe('')
    expect(stripCockpitCode('#/c/s1')).toBe('#/c/s1')
    expect(stripCockpitCode('#code=')).toBe('')
    expect(readCockpitCode('#code=')).toBeNull()
    // 超长（> 200，Hub 契约上限）当没有
    expect(readCockpitCode(`#code=${'x'.repeat(201)}`)).toBeNull()
  })
})

describe('交接码：只用一次、从地址栏抹掉', () => {
  it('initCockpitEmbed 抹掉 hash 里的码并记住它；随后只能取走一次', () => {
    const { replaced } = installLocation('?embed=cockpit', '#code=hc_once')
    expect(initCockpitEmbed()).toBe(true)
    expect(isCockpitEmbed()).toBe(true)
    // 地址栏已经干净：查询串留着，hash 清空
    expect(replaced).toEqual(['/m/?embed=cockpit'])
    expect(takeCockpitCode()).toBe('hc_once')
    // 第二次：已经被取走，不会再给同一个码（Hub 侧是一次性的）
    expect(takeCockpitCode()).toBeNull()
  })

  it('带 hash 路由路径的入口：只删 code，路径保留', () => {
    const { replaced } = installLocation('?embed=cockpit', '#/c/s_1?code=hc_2')
    expect(initCockpitEmbed()).toBe(true)
    expect(replaced).toEqual(['/m/?embed=cockpit#/c/s_1'])
    expect(takeCockpitCode()).toBe('hc_2')
  })

  it('不是嵌入模式：什么都不改、也不认码', () => {
    const { replaced } = installLocation('', '#code=hc_3')
    expect(initCockpitEmbed()).toBe(false)
    expect(isCockpitEmbed()).toBe(false)
    expect(replaced).toEqual([])
    expect(takeCockpitCode()).toBeNull()
  })

  it('父页面之后又发来新码（handoff）：只覆盖待用码，并同样一次性', () => {
    installLocation('?embed=cockpit', '#code=hc_a')
    initCockpitEmbed()
    expect(takeCockpitCode()).toBe('hc_a')
    setCockpitCode('hc_b')
    expect(takeCockpitCode()).toBe('hc_b')
    expect(takeCockpitCode()).toBeNull()
    setCockpitCode('   ')
    expect(takeCockpitCode()).toBeNull()
  })
})

describe('令牌隔离：sessionStorage 的 cockpit 键 vs 普通 localStorage 登录', () => {
  it('嵌入模式只动 cockpit 那份；退出登录也不清普通登录', async () => {
    const normal = new MemoryTokenStore()
    const cockpit = new MemoryTokenStore()
    await normal.save(makeTokens({ accessToken: `dshm_at_${'n'.repeat(40)}` }))
    let embed = true
    const store = new ModeAwareTokenStore(normal, cockpit, () => embed)

    const embedTokens = makeTokens({ accessToken: `dshm_at_${'c'.repeat(40)}` })
    await store.save(embedTokens)
    expect((await store.load())?.accessToken).toBe(embedTokens.accessToken)
    // 普通那份没有被覆盖
    expect((await normal.load())?.accessToken).toBe(`dshm_at_${'n'.repeat(40)}`)

    await store.clear()
    expect(await store.load()).toBeNull()
    expect((await normal.load())?.accessToken).toBe(`dshm_at_${'n'.repeat(40)}`)

    // 换回普通形态：读到的是原来那份（座舱令牌不会「漏」进普通登录）
    embed = false
    expect((await store.load())?.accessToken).toBe(`dshm_at_${'n'.repeat(40)}`)
  })

  it('cockpit 键名带 cockpit（与 dshm.web.auth-v1 不同）', () => {
    expect(COCKPIT_TOKEN_STORAGE_KEY).toContain('cockpit')
    expect(COCKPIT_TOKEN_STORAGE_KEY).not.toContain('dshm.web.')
  })
})

describe('postMessage 桥（双向验 origin）', () => {
  interface Posted {
    message: unknown
    targetOrigin: string
  }

  function makeWindow(name: string): {
    window: {
      postMessage: (message: unknown, targetOrigin: string) => void
      addEventListener: (type: 'message', handler: (event: unknown) => void) => void
      removeEventListener: (type: 'message', handler: (event: unknown) => void) => void
    }
    posted: Posted[]
    handlers: Array<(event: unknown) => void>
    name: string
  } {
    const posted: Posted[] = []
    const handlers: Array<(event: unknown) => void> = []
    return {
      name,
      posted,
      handlers,
      window: {
        postMessage: (message, targetOrigin) => posted.push({ message, targetOrigin }),
        addEventListener: (_type, handler) => handlers.push(handler),
        removeEventListener: (_type, handler) => {
          const at = handlers.indexOf(handler)
          if (at >= 0) handlers.splice(at, 1)
        },
      },
    }
  }

  it('收到的消息必须同源，且来源是父窗口', () => {
    const self = makeWindow('self')
    const parent = makeWindow('parent')
    const received: unknown[] = []
    const bridge = new CockpitBridge({
      selfWindow: self.window,
      parentWindow: parent.window,
      origin: ORIGIN,
      onMessage: (message) => received.push(message),
    })
    bridge.start()
    expect(self.handlers).toHaveLength(1)
    const handler = self.handlers[0]!

    // 同源 + 来源是 parent → 收下
    handler({ origin: ORIGIN, source: parent.window, data: { type: 'cockpit.prefill', text: '你好' } })
    // 跨源 → 丢掉
    handler({ origin: 'https://evil.test', source: parent.window, data: { type: 'cockpit.prefill', text: 'x' } })
    // 同源但不是父窗口 → 丢掉
    handler({ origin: ORIGIN, source: self.window, data: { type: 'cockpit.handoff', code: 'hc' } })
    // 同源但消息不合法 → 丢掉
    handler({ origin: ORIGIN, source: parent.window, data: { type: 'cockpit.prefill', text: '' } })
    handler({ origin: ORIGIN, source: parent.window, data: { type: 'cockpit.unknown' } })
    handler({ origin: ORIGIN, source: parent.window, data: 'not-an-object' })

    expect(received).toEqual([{ type: 'cockpit.prefill', text: '你好' }])
    bridge.stop()
    expect(self.handlers).toHaveLength(0)
  })

  it('发送用 location.origin 作 targetOrigin（不是 *）', () => {
    const self = makeWindow('self')
    const parent = makeWindow('parent')
    const bridge = new CockpitBridge({
      selfWindow: self.window,
      parentWindow: parent.window,
      origin: ORIGIN,
      onMessage: () => undefined,
    })
    expect(bridge.post({ type: 'cockpit.ready' })).toBe(true)
    expect(bridge.post({ type: 'cockpit.focus-canvas', id: 'cv_1' })).toBe(true)
    expect(bridge.post({ type: 'cockpit.turn', running: true })).toBe(true)
    expect(parent.posted).toEqual([
      { message: { type: 'cockpit.ready' }, targetOrigin: ORIGIN },
      { message: { type: 'cockpit.focus-canvas', id: 'cv_1' }, targetOrigin: ORIGIN },
      { message: { type: 'cockpit.turn', running: true }, targetOrigin: ORIGIN },
    ])
  })

  it('父页面不存在（顶层打开）时不发、不抛错', () => {
    const self = makeWindow('self')
    const bridge = new CockpitBridge({
      selfWindow: self.window,
      parentWindow: self.window,
      origin: ORIGIN,
      onMessage: () => undefined,
    })
    expect(bridge.attached).toBe(false)
    expect(() => bridge.post({ type: 'cockpit.ready' })).not.toThrow()
    expect(bridge.post({ type: 'cockpit.ready' })).toBe(false)
    // 也拿不到别人的消息
    const received: unknown[] = []
    const listening = new CockpitBridge({
      selfWindow: self.window,
      parentWindow: null,
      origin: ORIGIN,
      onMessage: (message) => received.push(message),
    })
    listening.handleMessage({ origin: ORIGIN, data: { type: 'cockpit.prefill', text: 'x' } })
    expect(received).toEqual([])
  })

  it('postCockpitMessage 在没有桥时静默返回 false', () => {
    expect(postCockpitMessage({ type: 'cockpit.ready' })).toBe(false)
  })

  it('消息归一化：只认三条，字段长度有上限', () => {
    expect(parseCockpitIncoming({ type: 'cockpit.focus-session', sessionId: ' s1 ' })).toEqual({
      type: 'cockpit.focus-session',
      sessionId: 's1',
    })
    expect(parseCockpitIncoming({ type: 'cockpit.handoff', code: 'hc' })).toEqual({
      type: 'cockpit.handoff',
      code: 'hc',
    })
    expect(parseCockpitIncoming({ type: 'cockpit.prefill', text: ' 看看这一行 ' })).toEqual({
      type: 'cockpit.prefill',
      text: '看看这一行',
    })
    expect(parseCockpitIncoming({ type: 'cockpit.handoff', code: 'x'.repeat(201) })).toBeNull()
    expect(parseCockpitIncoming({ type: 'cockpit.focus-session', sessionId: 1 })).toBeNull()
  })
})

describe('会话行的发起人（接口给了才显示）', () => {
  it('字符串与对象两种形状都认，displayName 优先', () => {
    expect(sessionInitiatorOf({ initiator: 'alice' })).toBe('alice')
    expect(sessionInitiatorOf({ owner: { username: 'bob', displayName: '鲍勃' } })).toBe('鲍勃')
    expect(sessionInitiatorOf({ createdBy: { username: 'carol' } })).toBe('carol')
    expect(sessionInitiatorOf({ startedBy: 'dave' })).toBe('dave')
  })

  it('没有/空/非字符串一律 null（界面不占位置，也不编造）', () => {
    expect(sessionInitiatorOf({ sessionId: 's1' })).toBeNull()
    expect(sessionInitiatorOf({ initiator: '' })).toBeNull()
    expect(sessionInitiatorOf({ initiator: 42 })).toBeNull()
    expect(sessionInitiatorOf(null)).toBeNull()
  })

  it('超长名字截断（列表行不换行）', () => {
    const text = sessionInitiatorOf({ initiator: 'a'.repeat(60) })
    expect(text).not.toBeNull()
    expect(text!.length).toBeLessThanOrEqual(32)
    expect(text!.endsWith('…')).toBe(true)
  })
})

describe('舰桥主题（theme=bridge，docs/24 §1/§6）', () => {
  it('只认 theme=bridge（其它值/没给 → null，跟随 App 自己的主题设置）', () => {
    expect(readCockpitTheme('?theme=bridge')).toBe('bridge')
    expect(readCockpitTheme('?embed=cockpit&theme=Bridge')).toBe('bridge')
    expect(readCockpitTheme('?theme=dark')).toBeNull()
    expect(readCockpitTheme('')).toBeNull()
    expect(COCKPIT_BRIDGE_THEME).toBe('bridge')
    expect(COCKPIT_BRIDGE_CLASS).toBe('cockpit-bridge')
  })

  it('initCockpitEmbed：给 <html> 打 cockpit-bridge + 强制深色（不写 inline 背景）', () => {
    const classes = new Set<string>(['is-web'])
    const style = {
      removed: [] as string[],
      removeProperty(name: string) {
        this.removed.push(name)
      },
    }
    const root = {
      classList: {
        add: (name: string) => classes.add(name),
        contains: (name: string) => classes.has(name),
      },
      dataset: {} as Record<string, string>,
      style,
    }
    vi.stubGlobal('document', { documentElement: root })
    installLocation('?embed=cockpit&theme=bridge', '')
    expect(initCockpitEmbed()).toBe(true)
    expect(isCockpitBridgeTheme()).toBe(true)
    expect(root.classList.contains(COCKPIT_BRIDGE_CLASS)).toBe(true)
    expect(root.dataset.theme).toBe('dark')
    expect(style.removed).toContain('background')
    vi.unstubAllGlobals()
  })

  it('没有 theme=bridge 时不进舰桥主题', () => {
    const classes = new Set<string>()
    const root = {
      classList: {
        add: (name: string) => classes.add(name),
        contains: (name: string) => classes.has(name),
      },
      dataset: {} as Record<string, string>,
      style: { removeProperty: () => undefined },
    }
    vi.stubGlobal('document', { documentElement: root })
    installLocation('?embed=cockpit', '')
    expect(initCockpitEmbed()).toBe(true)
    expect(isCockpitBridgeTheme()).toBe(false)
    expect(classes.has(COCKPIT_BRIDGE_CLASS)).toBe(false)
    vi.unstubAllGlobals()
  })
})
