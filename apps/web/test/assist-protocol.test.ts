import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import CockpitFrame from '@/components/admin/cockpit/CockpitFrame.vue'
import {
  cockpitFrameUrl,
  cockpitLayoutMessage,
  parseCockpitMessage,
} from '@/utils/cockpit'

/**
 * 嵌入协议 v2 的父页面一侧（WP58，docs/26 §5）：
 * - 子 → 父：带 `caps` 的 `cockpit.ready`、新的 `cockpit.status`（老消息形状不回归）；
 * - 父 → 子：`cockpit.layout { scale, sessions }`，ready 之后发一次、档位变化时再发；
 * - iframe URL 用 `theme=console`（老 App 不认识时当作不传）。
 */

const ORIGIN = 'https://hub.example'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('嵌入协议 v2 · 解析（WP58）', () => {
  it('cockpit.ready 带 caps：收下并原样给出（新 App）', () => {
    expect(
      parseCockpitMessage(ORIGIN, ORIGIN, {
        type: 'cockpit.ready',
        caps: ['status', 'layout', 'console'],
      }),
    ).toEqual({ type: 'cockpit.ready', caps: ['status', 'layout', 'console'] })
  })

  it('cockpit.ready 不带 caps：与老消息形状完全一致（老 App 兜底）', () => {
    expect(parseCockpitMessage(ORIGIN, ORIGIN, { type: 'cockpit.ready' })).toEqual({
      type: 'cockpit.ready',
    })
  })

  it('caps 形状不对当没带：非数组 / 全是非字符串 / 空数组', () => {
    expect(parseCockpitMessage(ORIGIN, ORIGIN, { type: 'cockpit.ready', caps: 'status' })).toEqual({
      type: 'cockpit.ready',
    })
    expect(parseCockpitMessage(ORIGIN, ORIGIN, { type: 'cockpit.ready', caps: [1, 2] })).toEqual({
      type: 'cockpit.ready',
    })
    expect(parseCockpitMessage(ORIGIN, ORIGIN, { type: 'cockpit.ready', caps: [] })).toEqual({
      type: 'cockpit.ready',
    })
    // 混着来：只留字符串那几项
    expect(
      parseCockpitMessage(ORIGIN, ORIGIN, { type: 'cockpit.ready', caps: ['status', 3, '', null] }),
    ).toEqual({ type: 'cockpit.ready', caps: ['status'] })
  })

  it('cockpit.status：六个阶段都收，message 可选（去空白、截断 200 字）', () => {
    for (const phase of ['auth', 'waking', 'connecting', 'ready', 'offline', 'blocked'] as const) {
      expect(parseCockpitMessage(ORIGIN, ORIGIN, { type: 'cockpit.status', phase })).toEqual({
        type: 'cockpit.status',
        phase,
      })
    }
    expect(
      parseCockpitMessage(ORIGIN, ORIGIN, {
        type: 'cockpit.status',
        phase: 'connecting',
        message: '  正在连接对话…  ',
      }),
    ).toEqual({ type: 'cockpit.status', phase: 'connecting', message: '正在连接对话…' })

    const long = 'x'.repeat(400)
    const parsed = parseCockpitMessage(ORIGIN, ORIGIN, {
      type: 'cockpit.status',
      phase: 'offline',
      message: long,
    })
    expect(parsed).toEqual({ type: 'cockpit.status', phase: 'offline', message: 'x'.repeat(200) })
  })

  it('cockpit.status 形状不对一律丢：未知 phase / 缺 phase / message 不是字符串', () => {
    expect(parseCockpitMessage(ORIGIN, ORIGIN, { type: 'cockpit.status', phase: 'done' })).toBeNull()
    expect(parseCockpitMessage(ORIGIN, ORIGIN, { type: 'cockpit.status' })).toBeNull()
    expect(
      parseCockpitMessage(ORIGIN, ORIGIN, { type: 'cockpit.status', phase: 3 }),
    ).toBeNull()
    // message 不是字符串：当没带（阶段本身是合法的）
    expect(
      parseCockpitMessage(ORIGIN, ORIGIN, { type: 'cockpit.status', phase: 'ready', message: 42 }),
    ).toEqual({ type: 'cockpit.status', phase: 'ready' })
  })

  it('异源 / 空 origin 仍然一律丢（同源规则不变）', () => {
    expect(
      parseCockpitMessage('https://evil.example', ORIGIN, {
        type: 'cockpit.status',
        phase: 'ready',
      }),
    ).toBeNull()
    expect(parseCockpitMessage(ORIGIN, '', { type: 'cockpit.status', phase: 'ready' })).toBeNull()
  })

  it('父 → 子消息不会被当子消息收下（cockpit.layout 进来是 null）', () => {
    expect(
      parseCockpitMessage(ORIGIN, ORIGIN, { type: 'cockpit.layout', scale: 1.25, sessions: 'docked' }),
    ).toBeNull()
  })
})

describe('嵌入协议 v2 · cockpit.layout 载荷（WP58）', () => {
  it('scale 夹在 1–1.5，sessions 只出 docked / menu', () => {
    expect(cockpitLayoutMessage({ scale: 1, sessions: 'menu' })).toEqual({
      type: 'cockpit.layout',
      scale: 1,
      sessions: 'menu',
    })
    expect(cockpitLayoutMessage({ scale: 1.125, sessions: 'docked' })).toEqual({
      type: 'cockpit.layout',
      scale: 1.125,
      sessions: 'docked',
    })
    // 越界 / 非有限数兜底
    expect(cockpitLayoutMessage({ scale: 9, sessions: 'docked' }).scale).toBe(1.5)
    expect(cockpitLayoutMessage({ scale: 0.2, sessions: 'menu' }).scale).toBe(1)
    expect(cockpitLayoutMessage({ scale: Number.NaN, sessions: 'menu' }).scale).toBe(1)
    // 未知 sessions 按 menu
    expect(
      cockpitLayoutMessage({ scale: 1.25, sessions: 'rail' as unknown as 'docked' }).sessions,
    ).toBe('menu')
  })

  it('iframe 地址带 theme=console（WP58 的控制台主题）', () => {
    expect(cockpitFrameUrl('c1', { theme: 'console' })).toBe('/m/?embed=cockpit&theme=console#code=c1')
    // 老 App 不认识就当作没传（Hub 的浅色兜底仍在）：URL 只是多一个参数
    expect(cockpitFrameUrl(null, { theme: 'console' })).toBe('/m/?embed=cockpit&theme=console')
  })
})

describe('CockpitFrame · 发送 cockpit.layout（WP58）', () => {
  const sessions = [{ id: 'sess_weekly_usage', title: '本周用量', owner: 'admin' }]

  function mountFrame(overrides: Record<string, unknown> = {}) {
    return mount(CockpitFrame, {
      attachTo: document.body,
      props: {
        mode: 'iframe',
        code: 'code-boot',
        sessionId: null,
        prefill: null,
        sessions,
        placeholderPrefill: '',
        theme: 'console',
        layout: { scale: 1.25, sessions: 'docked' },
        ...overrides,
      },
    })
  }

  function spyPost(wrapper: ReturnType<typeof mountFrame>) {
    const frame = wrapper.find('iframe').element as HTMLIFrameElement
    const target = frame.contentWindow as Window
    const posted = vi.spyOn(target, 'postMessage').mockImplementation(() => undefined)
    const ofType = (type: string) =>
      posted.mock.calls
        .map(([message]) => message as { type?: string })
        .filter((message) => message.type === type)
    return { target, ofType }
  }

  async function dispatchReady(target: Window, caps?: string[]): Promise<void> {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: caps ? { type: 'cockpit.ready', caps } : { type: 'cockpit.ready' },
        origin: window.location.origin,
        source: target,
      }),
    )
    await flushPromises()
  }

  it('收到 ready 后发一次 layout；档位变化时再发（ready 之前不发）', async () => {
    const wrapper = mountFrame()
    const { target, ofType } = spyPost(wrapper)

    // ready 之前改档位：不发（App 还没接管 postMessage）
    await wrapper.setProps({ layout: { scale: 1, sessions: 'menu' } })
    await flushPromises()
    expect(ofType('cockpit.layout')).toHaveLength(0)

    await dispatchReady(target, ['status', 'layout', 'console'])
    expect(ofType('cockpit.layout')).toHaveLength(1)
    expect(ofType('cockpit.layout')[0]).toEqual({
      type: 'cockpit.layout',
      scale: 1,
      sessions: 'menu',
    })

    // 拖窗口跨档：再发一次
    await wrapper.setProps({ layout: { scale: 1.125, sessions: 'docked' } })
    await flushPromises()
    expect(ofType('cockpit.layout')).toHaveLength(2)
    expect(ofType('cockpit.layout')[1]).toEqual({
      type: 'cockpit.layout',
      scale: 1.125,
      sessions: 'docked',
    })

    wrapper.unmount()
  })

  it('ready 带上 caps 时父页面收得到（老 App 不带 = undefined）', async () => {
    const wrapper = mountFrame()
    const { target } = spyPost(wrapper)

    await dispatchReady(target, ['status', 'layout', 'console'])
    expect(wrapper.emitted('ready')?.[0]).toEqual([['status', 'layout', 'console']])

    const legacy = mountFrame()
    const legacySpy = spyPost(legacy)
    await dispatchReady(legacySpy.target)
    expect(legacy.emitted('ready')?.[0]).toEqual([undefined])

    wrapper.unmount()
    legacy.unmount()
  })

  it('cockpit.status 原样转给父页面（阶段与那句中文）', async () => {
    const wrapper = mountFrame()
    const { target } = spyPost(wrapper)

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'cockpit.status', phase: 'connecting', message: '正在连接对话…' },
        origin: window.location.origin,
        source: target,
      }),
    )
    await flushPromises()
    expect(wrapper.emitted('status')?.[0]).toEqual([{ phase: 'connecting', message: '正在连接对话…' }])

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'cockpit.status', phase: 'ready' },
        origin: window.location.origin,
        source: target,
      }),
    )
    await flushPromises()
    expect(wrapper.emitted('status')?.[1]).toEqual([{ phase: 'ready' }])

    wrapper.unmount()
  })

  it('没有 layout 时不发 cockpit.layout', async () => {
    const wrapper = mountFrame({ layout: null, theme: 'console' })
    const { target, ofType } = spyPost(wrapper)
    await dispatchReady(target)
    expect(ofType('cockpit.layout')).toHaveLength(0)
    wrapper.unmount()
  })
})
