/**
 * 手机网页版的版本检查（WP54 / 契约 C7）。
 *
 * 网页版没有 APK：`./version.json` 与构建期注入的 `{version, build, builtAt}` 不同，
 * 就说明 Hub 上换了新构建 → `webUpdateAvailable`，用户点刷新（`location.reload()`）。
 *
 * 这里用假 fetch / 假 document / 假定时器锁住：
 *  - version.json 的解析与坏数据自愈（坏 JSON → 当没更新，不能把人卡在提示里）；
 *  - 比较口径是 version + build（同一版本重打包也算新构建；builtAt 不比）；
 *  - 触发点：冷启动一次、回前台一次（hidden 不算）、定时器一轮一次；
 *  - 频率限制（切页签很密时别打 Hub）；
 *  - 一旦提示就停止观察（不再重复回调）。
 */

import { describe, expect, it } from 'vitest'
import {
  WEB_VERSION_INTERVAL_MS,
  WebVersionWatch,
  isNewerWebVersion,
  parseWebVersion,
} from '@/lib/web-version'

const CURRENT = { version: '0.4.11', build: 'abc1234', builtAt: '2026-10-29T05:00:00.000Z' }

function jsonResponse(body: unknown, status = 200): {
  ok: boolean
  status: number
  json(): Promise<unknown>
} {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

/** 假 document：手动触发 visibilitychange。 */
function fakeDoc(state: { visibility: string }): {
  source: never
  fire(): void
  listeners: number
} {
  const handlers = new Set<() => void>()
  const source = {
    get visibilityState() {
      return state.visibility
    },
    get hidden() {
      return state.visibility === 'hidden'
    },
    addEventListener: (_type: string, listener: () => void) => handlers.add(listener),
    removeEventListener: (_type: string, listener: () => void) => handlers.delete(listener),
  }
  return {
    source: source as never,
    fire: () => {
      for (const handler of [...handlers]) handler()
    },
    get listeners() {
      return handlers.size
    },
  }
}

describe('parseWebVersion / isNewerWebVersion', () => {
  it('正常解析 {version, build, builtAt}', () => {
    expect(parseWebVersion(CURRENT)).toEqual(CURRENT)
    // builtAt 缺了也能用（只用于诊断展示）
    expect(parseWebVersion({ version: '1.0.0', build: 'deadbee' })).toEqual({
      version: '1.0.0',
      build: 'deadbee',
      builtAt: '',
    })
  })

  it('坏数据/少字段一律 null（当作没有新版本）', () => {
    expect(parseWebVersion(null)).toBeNull()
    expect(parseWebVersion('0.4.11')).toBeNull()
    expect(parseWebVersion([])).toBeNull()
    expect(parseWebVersion({ build: 'abc' })).toBeNull()
    expect(parseWebVersion({ version: '1.0.0' })).toBeNull()
    expect(parseWebVersion({ version: '', build: 'abc' })).toBeNull()
  })

  it('比较口径：version 或 build 变了就是新构建；builtAt 变了不算', () => {
    expect(isNewerWebVersion(CURRENT, CURRENT)).toBe(false)
    expect(isNewerWebVersion(CURRENT, { ...CURRENT, builtAt: '2027-01-01T00:00:00.000Z' })).toBe(false)
    expect(isNewerWebVersion(CURRENT, { ...CURRENT, build: 'def5678' })).toBe(true)
    expect(isNewerWebVersion(CURRENT, { ...CURRENT, version: '0.4.12' })).toBe(true)
  })
})

describe('WebVersionWatch：回前台 + 每 30 分钟（C7）', () => {
  it('冷启动查一次：线上同构建 → 不提示', async () => {
    let fetches = 0
    const watch = new WebVersionWatch({
      current: CURRENT,
      doc: null,
      setIntervalImpl: () => 1,
      clearIntervalImpl: () => {},
      fetchImpl: async (url, init) => {
        fetches += 1
        expect(url).toBe('./version.json')
        expect(init?.cache).toBe('no-store')
        return jsonResponse(CURRENT)
      },
    })
    watch.start()
    await watch.checkNow()
    expect(fetches).toBe(1)
    expect(watch.updateAvailable).toBe(false)
  })

  it('线上是新构建 → 回调一次 onUpdate 并停止观察', async () => {
    const updates: unknown[] = []
    const timers: number[] = []
    const cleared: unknown[] = []
    const doc = fakeDoc({ visibility: 'visible' })
    const watch = new WebVersionWatch({
      current: CURRENT,
      doc: doc.source,
      setIntervalImpl: (_fn, ms) => {
        timers.push(ms)
        return timers.length
      },
      clearIntervalImpl: (handle) => cleared.push(handle),
      fetchImpl: async () => jsonResponse({ ...CURRENT, build: 'newsha1' }),
      onUpdate: (remote) => updates.push(remote),
    })
    watch.start()
    await watch.checkNow()
    await Promise.resolve()
    expect(updates).toEqual([{ ...CURRENT, build: 'newsha1' }])
    expect(watch.updateAvailable).toBe(true)
    // 提示出现后不再观察：定时器被清、监听被摘
    expect(cleared).toEqual([1])
    expect(doc.listeners).toBe(0)
    // 定时器间隔就是 30 分钟
    expect(timers).toEqual([WEB_VERSION_INTERVAL_MS])
  })

  it('只在「回到可见」时检查，切走（hidden）不查', async () => {
    const state = { visibility: 'visible' as string }
    const doc = fakeDoc(state)
    let fetches = 0
    const watch = new WebVersionWatch({
      current: CURRENT,
      doc: doc.source,
      minGapMs: 0,
      setIntervalImpl: () => 1,
      clearIntervalImpl: () => {},
      fetchImpl: async () => {
        fetches += 1
        return jsonResponse(CURRENT)
      },
    })
    watch.start()
    await watch.checkNow()
    const baseline = fetches
    state.visibility = 'hidden'
    doc.fire()
    await Promise.resolve()
    expect(fetches).toBe(baseline)
    state.visibility = 'visible'
    doc.fire()
    // 触发是 fire-and-forget：等到 fetch 真的发生
    await viWait(() => fetches > baseline)
    expect(fetches).toBe(baseline + 1)
  })

  it('最小间隔：切页签很密时跳过（不每切一次就打一次 Hub）', async () => {
    let clock = 10_000
    let fetches = 0
    const doc = fakeDoc({ visibility: 'visible' })
    const watch = new WebVersionWatch({
      current: CURRENT,
      doc: doc.source,
      minGapMs: 3_000,
      now: () => clock,
      setIntervalImpl: () => 1,
      clearIntervalImpl: () => {},
      fetchImpl: async () => {
        fetches += 1
        return jsonResponse(CURRENT)
      },
    })
    watch.start()
    await watch.checkNow()
    expect(fetches).toBe(1)
    clock += 1_000 // 1 秒后再回前台：跳过
    expect(await watch.checkNow()).toBe(false)
    expect(fetches).toBe(1)
    clock += 5_000 // 过了 3 秒：照常查
    await watch.checkNow()
    expect(fetches).toBe(2)
  })

  it('网络失败 / 404 / 坏 JSON：安静地当作「没有新版本」', async () => {
    const events: string[] = []
    const cases: Array<() => Promise<unknown>> = [
      async () => jsonResponse({}, 404),
      async () => jsonResponse({ version: '1.0.0' }),
      async () => {
        throw new Error('offline')
      },
    ]
    for (const impl of cases) {
      const watch = new WebVersionWatch({
        current: CURRENT,
        doc: null,
        minGapMs: 0,
        setIntervalImpl: () => 1,
        clearIntervalImpl: () => {},
        fetchImpl: impl as never,
        onEvent: (name, detail) => events.push(`${name}=${detail}`),
      })
      watch.start()
      expect(await watch.checkNow()).toBe(false)
      expect(watch.updateAvailable).toBe(false)
    }
    expect(events).toEqual(['web:version=http-404', 'web:version=bad-json', 'web:version=network'])
  })

  it('并发调用合并成一次请求', async () => {
    let fetches = 0
    let release: (() => void) | null = null
    const watch = new WebVersionWatch({
      current: CURRENT,
      doc: null,
      minGapMs: 0,
      setIntervalImpl: () => 1,
      clearIntervalImpl: () => {},
      fetchImpl: async () => {
        fetches += 1
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return jsonResponse(CURRENT)
      },
    })
    const a = watch.checkNow()
    const b = watch.checkNow()
    release?.()
    await Promise.all([a, b])
    expect(fetches).toBe(1)
  })
})

/** 轮询等待一个条件（fire-and-forget 的 fetch 完成）。 */
async function viWait(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
