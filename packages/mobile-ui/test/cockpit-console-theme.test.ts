/**
 * 控制台主题（WP58 / docs/26 §3.1）：`?embed=cockpit&theme=console` → 强制浅色。
 *
 * 验收里最要紧的一条是「系统深色 + 用户在 App 里也设了深色，仍然是浅色」——
 * 所以这里把三个口子都测到：
 *  1. 入口解析（`readCockpitTheme` 认 console，其它主题不变）；
 *  2. `initCockpitEmbed()` 落到 DOM（`html.cockpit-console` + `data-theme=light` + 不写背景）；
 *  3. `stores/settings.ts` 的 `applyTheme()` 看到 console 就让路（用户设置与系统深色都不生效）。
 * 同时钉住「theme 不传 / theme=bridge 行为一字不改」。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

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
  COCKPIT_CONSOLE_CLASS,
  COCKPIT_CONSOLE_THEME,
  readCockpitTheme,
} from '../src/lib/cockpit'
import {
  initCockpitEmbed,
  isCockpitBridgeTheme,
  isCockpitConsoleTheme,
  resetCockpitEmbedForTests,
} from '../src/lib/cockpit-embed'
import { useSettingsStore } from '../src/stores/settings'

const ORIGIN = 'https://hub.test'

interface FakeRoot {
  classes: Set<string>
  dataset: Record<string, string>
  removed: string[]
}

/** 造一个假的 `<html>` + location/history（node 环境本来没有这些）。 */
function installEnv(search: string, options: { systemDark?: boolean; saved?: unknown } = {}): {
  root: FakeRoot
  stored: Map<string, string>
} {
  const root: FakeRoot = { classes: new Set(['is-web']), dataset: {}, removed: [] }
  const documentElement = {
    classList: {
      add: (name: string) => root.classes.add(name),
      contains: (name: string) => root.classes.has(name),
      remove: (name: string) => root.classes.delete(name),
    },
    dataset: root.dataset,
    style: {
      removeProperty: (name: string) => {
        root.removed.push(name)
      },
    },
  }
  const locationLike = { search, hash: '', origin: ORIGIN, pathname: '/m/' }
  const historyLike = { state: null, replaceState: () => undefined }
  const stored = new Map<string, string>()
  if (options.saved !== undefined) stored.set('dsh-hub:ui:v1', JSON.stringify(options.saved))

  vi.stubGlobal('location', locationLike)
  vi.stubGlobal('history', historyLike)
  vi.stubGlobal('document', { documentElement })
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  })
  vi.stubGlobal('window', {
    matchMedia: () => ({
      matches: options.systemDark === true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  })
  return { root, stored }
}

beforeEach(() => {
  resetCockpitEmbedForTests()
  setActivePinia(createPinia())
})

afterEach(() => {
  resetCockpitEmbedForTests()
  vi.unstubAllGlobals()
})

describe('入口解析（theme=console）', () => {
  it('认 console；bridge 与「没给 / 别的值」保持原样', () => {
    expect(COCKPIT_CONSOLE_THEME).toBe('console')
    expect(readCockpitTheme('?embed=cockpit&theme=console')).toBe('console')
    expect(readCockpitTheme('?embed=cockpit&theme=Console')).toBe('console')
    expect(readCockpitTheme('?embed=cockpit&theme=bridge')).toBe('bridge')
    expect(readCockpitTheme('?embed=cockpit&theme=Bridge')).toBe('bridge')
    expect(readCockpitTheme('?embed=cockpit')).toBeNull()
    expect(readCockpitTheme('?embed=cockpit&theme=dark')).toBeNull()
    expect(readCockpitTheme('')).toBeNull()
  })
})

describe('initCockpitEmbed：控制台主题落到 DOM 上', () => {
  it('加 cockpit-console 类 + 强制浅色 + 删掉 inline 背景', () => {
    const { root } = installEnv('?embed=cockpit&theme=console')
    expect(initCockpitEmbed()).toBe(true)
    expect(isCockpitConsoleTheme()).toBe(true)
    expect(isCockpitBridgeTheme()).toBe(false)
    expect(root.classes.has(COCKPIT_CONSOLE_CLASS)).toBe(true)
    expect(root.classes.has(COCKPIT_BRIDGE_CLASS)).toBe(false)
    expect(root.dataset.theme).toBe('light')
    expect(root.removed).toContain('background')
  })

  it('theme=bridge 一字不改：深色 + cockpit-bridge，不是控制台', () => {
    const { root } = installEnv('?embed=cockpit&theme=bridge')
    expect(initCockpitEmbed()).toBe(true)
    expect(isCockpitBridgeTheme()).toBe(true)
    expect(isCockpitConsoleTheme()).toBe(false)
    expect(root.classes.has(COCKPIT_BRIDGE_CLASS)).toBe(true)
    expect(root.classes.has(COCKPIT_CONSOLE_CLASS)).toBe(false)
    expect(root.dataset.theme).toBe('dark')
  })

  it('theme 不传：两个主题都不进（跟随 App 自己的设置）', () => {
    const { root } = installEnv('?embed=cockpit')
    expect(initCockpitEmbed()).toBe(true)
    expect(isCockpitConsoleTheme()).toBe(false)
    expect(isCockpitBridgeTheme()).toBe(false)
    expect(root.classes.has(COCKPIT_CONSOLE_CLASS)).toBe(false)
    expect(root.classes.has(COCKPIT_BRIDGE_CLASS)).toBe(false)
    // 入口没动过 data-theme（由 stores/settings 决定）
    expect(root.dataset.theme).toBeUndefined()
  })
})

describe('stores/settings：控制台主题强制浅色', () => {
  /** 建一次 store（setup 里就会跑 applyTheme，正是要测的那一步）。 */
  function settingsWith(): { store: ReturnType<typeof useSettingsStore> } {
    return { store: useSettingsStore() }
  }

  it('系统深色 + 用户设了深色：console 下仍然浅色', async () => {
    const { root } = installEnv('?embed=cockpit&theme=console', {
      systemDark: true,
      saved: { theme: 'dark' },
    })
    initCockpitEmbed()
    const { store } = settingsWith()
    expect(store.isDark).toBe(true) // 用户设置本身还是深色（不改用户数据）
    expect(store.theme).toBe('dark')
    expect(root.dataset.theme).toBe('light') // 但落到 DOM 上是浅色
    expect(root.removed).toContain('background') // 不写 inline 背景（透明交给 CSS）
  })

  it('系统深色 + 用户「跟随系统」：console 下也是浅色', async () => {
    const { root } = installEnv('?embed=cockpit&theme=console', {
      systemDark: true,
      saved: { theme: 'system' },
    })
    initCockpitEmbed()
    settingsWith()
    expect(root.dataset.theme).toBe('light')
  })

  it('theme=bridge：仍然强制深色（老行为）', async () => {
    const { root } = installEnv('?embed=cockpit&theme=bridge', {
      systemDark: false,
      saved: { theme: 'light' },
    })
    initCockpitEmbed()
    settingsWith()
    expect(root.dataset.theme).toBe('dark')
    expect(root.removed).toContain('background')
  })

  it('theme 不传：仍然是「用户设置 + 系统深色」的老逻辑', async () => {
    const { root } = installEnv('?embed=cockpit', { systemDark: true, saved: { theme: 'dark' } })
    initCockpitEmbed()
    settingsWith()
    expect(root.dataset.theme).toBe('dark')
  })

  it('普通 /m/（不是嵌入）：用户深色就是深色', async () => {
    const { root } = installEnv('', { systemDark: true, saved: { theme: 'dark' } })
    expect(initCockpitEmbed()).toBe(false)
    settingsWith()
    expect(root.dataset.theme).toBe('dark')
  })
})
