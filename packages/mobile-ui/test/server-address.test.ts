/**
 * 「服务器地址」输入（APK 没有内置 Hub 入口时由登录页收集）。
 *
 * 覆盖三种输入形态与持久化：
 *  - 省略协议 → 补 https；带端口/明文 http 照原样；
 *  - 空 / 非 http(s) / 带路径 / 带账号口令 → 拒绝并给中文原因（不发请求、不落盘）；
 *  - 存进 localStorage（键 `dsh-hub:server-address`），读出来是归一后的 origin。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  SERVER_ADDRESS_KEY,
  normalizeServerAddressInput,
  readServerAddress,
  saveServerAddress,
} from '../src/lib/server-address'

/** 最小 localStorage 替身（node 环境里没有它）。 */
function installLocalStorage(): Map<string, string> {
  const map = new Map<string, string>()
  const fake = {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
  }
  vi.stubGlobal('localStorage', fake)
  return map
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('normalizeServerAddressInput：手填地址的归一与校验', () => {
  it('省略协议按 https 补；带端口照原样', () => {
    expect(normalizeServerAddressInput('hub.example.com')).toEqual({
      ok: true,
      origin: 'https://hub.example.com',
    })
    expect(normalizeServerAddressInput('hub.example.com:8443')).toEqual({
      ok: true,
      origin: 'https://hub.example.com:8443',
    })
    expect(normalizeServerAddressInput('  https://hub.example.com/  ')).toEqual({
      ok: true,
      origin: 'https://hub.example.com',
    })
  })

  it('明文 http 也接受（局域网 / 开发用的 Hub）', () => {
    expect(normalizeServerAddressInput('http://192.168.1.10:7700')).toEqual({
      ok: true,
      origin: 'http://192.168.1.10:7700',
    })
  })

  it('空串、非 http(s)、带路径、带账号口令都拒绝', () => {
    expect(normalizeServerAddressInput('   ')).toMatchObject({ ok: false, reason: 'empty' })
    expect(normalizeServerAddressInput('ftp://hub.example.com')).toMatchObject({
      ok: false,
      reason: 'scheme',
    })
    expect(normalizeServerAddressInput('https://hub.example.com/foo')).toMatchObject({
      ok: false,
      reason: 'path',
    })
    expect(normalizeServerAddressInput('https://user:pass@hub.example.com')).toMatchObject({
      ok: false,
      reason: 'host',
    })
  })

  it('拒绝时都带一条中文说明（登录页直接显示）', () => {
    for (const raw of ['', 'ftp://x.example.com', 'https://x.example.com/a', 'https://u:p@x.example.com']) {
      const result = normalizeServerAddressInput(raw)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message.length).toBeGreaterThan(0)
    }
  })
})

describe('持久化', () => {
  let store: Map<string, string>
  beforeEach(() => {
    store = installLocalStorage()
  })

  it('存进去是归一后的 origin；读出来一模一样', () => {
    expect(saveServerAddress('https://hub.example.com/')).toBe(true)
    expect(store.get(SERVER_ADDRESS_KEY)).toBe('https://hub.example.com')
    expect(readServerAddress()).toBe('https://hub.example.com')
  })

  it('没存过 / 存了非法值 → null（当作没填过）', () => {
    expect(readServerAddress()).toBeNull()
    store.set(SERVER_ADDRESS_KEY, 'not a url')
    expect(readServerAddress()).toBeNull()
  })

  it('传 null 清除；非法值不落盘', () => {
    expect(saveServerAddress('https://hub.example.com')).toBe(true)
    expect(saveServerAddress(null)).toBe(true)
    expect(readServerAddress()).toBeNull()
    expect(saveServerAddress('ftp://nope.example.com')).toBe(false)
    expect(store.has(SERVER_ADDRESS_KEY)).toBe(false)
  })

  it('localStorage 不可用时读 null、写 false（不抛错）', () => {
    vi.unstubAllGlobals()
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    })
    expect(readServerAddress()).toBeNull()
    expect(saveServerAddress('https://hub.example.com')).toBe(false)
  })
})

describe('登录页确实接了这个输入框（防止只改了逻辑没接界面）', () => {
  const source = readFileSync(new URL('../src/views/LoginView.vue', import.meta.url), 'utf8')

  it('登录页 import 了 server-address 并在提交前调用 applyServerAddress', () => {
    expect(source).toContain("from '@/lib/server-address'")
    expect(source).toContain('applyServerAddress()')
    expect(source).toContain('data-login-server')
  })

  it('没有内置入口时输入框默认展开；有内置入口时收在「服务器地址」按钮里', () => {
    expect(source).toContain('NEEDS_SERVER_ADDRESS')
    expect(source).toContain('const showServerField = ref(needsServer)')
    expect(source).toContain('CAN_EDIT_SERVER_ADDRESS')
  })
})
