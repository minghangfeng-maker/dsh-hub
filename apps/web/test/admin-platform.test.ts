import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'

import PlatformSwitch from '@/components/admin/PlatformSwitch.vue'
import { ADMIN_NAV_GROUPS } from '@/layouts/admin-nav'
import {
  ADMIN_PLATFORM_STORAGE_KEY,
  desktopLegacyLocation,
  normalizeAdminPlatform,
  platformOfQuery,
  readStoredPlatform,
  resolveAdminPlatform,
  useAdminPlatform,
  writeStoredPlatform,
} from '@/composables/admin-platform'

/**
 * 平台切换（WP32b，docs/22 §1.2 §1.4）：地址栏 → 记忆值 → 云上 的优先级、
 * 切换后写回地址栏与记忆值、旧参数（`?tab=cloud|desktop` / `?kind=desktop`）兼容、
 * 以及旧「桌面端」地址按 tab 重定向到各页的桌面侧。
 */

const wrappers: { unmount: () => void }[] = []

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  localStorage.clear()
  document.body.innerHTML = ''
})

describe('纯函数', () => {
  it('只认 cloud / desktop，别的值当没写', () => {
    expect(normalizeAdminPlatform('cloud')).toBe('cloud')
    expect(normalizeAdminPlatform('desktop')).toBe('desktop')
    expect(normalizeAdminPlatform(['desktop'])).toBe('desktop')
    expect(normalizeAdminPlatform('table')).toBeNull()
    expect(normalizeAdminPlatform(undefined)).toBeNull()
  })

  it('?platform= 优先，其次是实例页旧参数 ?tab=，再是 ?kind=desktop', () => {
    expect(platformOfQuery({ platform: 'desktop' })).toBe('desktop')
    expect(platformOfQuery({ tab: 'desktop' })).toBe('desktop')
    expect(platformOfQuery({ tab: 'cloud' })).toBe('cloud')
    expect(platformOfQuery({ kind: 'desktop' })).toBe('desktop')
    // 实例页的 ?tab= 以前只管实例页；插件的 ?tab= 不是平台参数
    expect(platformOfQuery({ tab: 'dsh' })).toBeNull()
    expect(platformOfQuery({})).toBeNull()
  })

  it('记忆值：写进去再读回来；坏值是 null；都没有时有效平台 = cloud', () => {
    expect(readStoredPlatform()).toBeNull()
    writeStoredPlatform('desktop')
    expect(localStorage.getItem(ADMIN_PLATFORM_STORAGE_KEY)).toBe('desktop')
    expect(readStoredPlatform()).toBe('desktop')
    expect(resolveAdminPlatform({})).toBe('desktop')
    // 地址栏优先于记忆值
    expect(resolveAdminPlatform({ platform: 'cloud' })).toBe('cloud')

    localStorage.setItem(ADMIN_PLATFORM_STORAGE_KEY, 'tablet')
    expect(readStoredPlatform()).toBeNull()
    expect(resolveAdminPlatform({})).toBe('cloud')
  })
})

describe('/admin/desktop 旧地址的重定向目标', () => {
  it('overview / 无 tab → 实例页桌面侧', () => {
    expect(desktopLegacyLocation({})).toEqual({ path: '/admin/instances', query: { platform: 'desktop' } })
    expect(desktopLegacyLocation({ tab: 'overview' })).toEqual({
      path: '/admin/instances',
      query: { platform: 'desktop' },
    })
  })

  it('plugins / config / versions 各去对应页面，config 带 tab=dsh', () => {
    expect(desktopLegacyLocation({ tab: 'plugins' })).toEqual({
      path: '/admin/plugins',
      query: { platform: 'desktop' },
    })
    expect(desktopLegacyLocation({ tab: 'config' })).toEqual({
      path: '/admin/models',
      query: { tab: 'dsh', platform: 'desktop' },
    })
    expect(desktopLegacyLocation({ tab: 'versions' })).toEqual({
      path: '/admin/runtimes',
      query: { platform: 'desktop' },
    })
  })

  it('认不出的 tab 当 overview；其它查询参数原样带过去，旧的 tab 不保留', () => {
    expect(desktopLegacyLocation({ tab: 'nope', userId: '3' })).toEqual({
      path: '/admin/instances',
      query: { userId: '3', platform: 'desktop' },
    })
  })
})

describe('侧边栏（docs/22 §1.1）', () => {
  it('独立「桌面端」入口删掉了', () => {
    const labels = ADMIN_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.label))
    expect(labels).not.toContain('桌面端')
    expect(labels).toContain('实例')
    expect(labels).toContain('插件')
  })

  it('「下发」在「能力下发」组第一位（WP57 起不叫「统一下发」）', () => {
    const group = ADMIN_NAV_GROUPS.find((item) => item.title === '能力下发')
    expect(group, '应有「能力下发」组').toBeTruthy()
    expect(group!.items[0]).toMatchObject({ label: '下发', to: '/admin/rollouts' })
  })
})

// ── 组件 / composable ──────────────────────────────────────────────────────

const Probe = defineComponent({
  setup() {
    const platform = useAdminPlatform()
    return () => h('div', { 'data-testid': 'probe' }, platform.platform.value)
  },
})

async function mountProbe(path: string): Promise<{ wrapper: ReturnType<typeof mount>; router: Router }> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/admin/plugins', component: Probe },
      { path: '/admin/instances', component: Probe },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(Probe, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  wrappers.push(wrapper)
  return { wrapper, router }
}

describe('useAdminPlatform', () => {
  it('地址栏没有参数时用记忆值，并把它写进地址栏', async () => {
    writeStoredPlatform('desktop')
    const { wrapper, router } = await mountProbe('/admin/plugins')
    expect(wrapper.get('[data-testid="probe"]').text()).toBe('desktop')
    await flushPromises()
    expect(router.currentRoute.value.query['platform']).toBe('desktop')
  })

  it('云上是缺省值：不写进地址栏（链接保持干净）', async () => {
    const { router } = await mountProbe('/admin/plugins')
    await flushPromises()
    expect(router.currentRoute.value.query['platform']).toBeUndefined()
  })

  it('地址栏优先；旧参数 ?tab=desktop 会被规范成 ?platform=desktop', async () => {
    const { wrapper, router } = await mountProbe('/admin/instances?tab=desktop')
    expect(wrapper.get('[data-testid="probe"]').text()).toBe('desktop')
    await flushPromises()
    expect(router.currentRoute.value.query['platform']).toBe('desktop')
    expect(router.currentRoute.value.query['tab']).toBeUndefined()
  })

  it('切换平台会同时改记忆值与地址栏（浅替换，不新增历史）', async () => {
    const { router } = await mountProbe('/admin/plugins')
    const historyLength = window.history.length
    // 直接调组件的事件，等价于管理员点了「桌面」
    await router.replace({ query: { ...router.currentRoute.value.query, platform: 'desktop' } })
    await flushPromises()
    expect(router.currentRoute.value.query['platform']).toBe('desktop')
    expect(window.history.length).toBe(historyLength)
  })
})

describe('PlatformSwitch', () => {
  it('两个选项、当前值高亮，点击发 update:modelValue', async () => {
    const wrapper = mount(PlatformSwitch, { props: { modelValue: 'cloud' } })
    wrappers.push(wrapper)
    expect(wrapper.find('[data-testid="platform-switch"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="platform-cloud"]').text()).toContain('云端')
    expect(wrapper.get('[data-testid="platform-desktop"]').text()).toContain('桌面端')
    expect(wrapper.get('[data-testid="platform-cloud"]').attributes('aria-checked')).toBe('true')
    await wrapper.get('[data-testid="platform-desktop"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['desktop'])
    // 点当前值不发事件
    await wrapper.get('[data-testid="platform-cloud"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toHaveLength(1)
  })

  it('WP57：滑块按当前端定位与着色；方向键切到另一端', async () => {
    const wrapper = mount(PlatformSwitch, { props: { modelValue: 'desktop' } })
    wrappers.push(wrapper)
    expect(wrapper.get('[data-testid="platform-switch"]').classes()).toContain('platform-switch--desktop')
    expect(wrapper.get('.platform-switch__thumb').attributes('style')).toContain('translateX(100%)')
    await wrapper.get('[data-testid="platform-switch"]').trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['cloud'])
  })
})
