import type { MyPluginItem, MyPluginsResponse } from '@dsh-hub/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'

import HomePluginsSection from '@/components/user/home/HomePluginsSection.vue'
import { fetchMyPlugins, installMyPlugin, uninstallMyPlugin } from '@/api/plugins'

vi.mock('@/api/plugins', () => ({
  fetchMyPlugins: vi.fn(),
  installMyPlugin: vi.fn(),
  uninstallMyPlugin: vi.fn(),
}))

/**
 * 工作台「我的插件」（16 §7）：紧凑列表（桌面两列 / 手机一列）、必装带锁且没有开关、
 * 分段筛选并记在 localStorage（读写抛错不能崩）、切换后每 3 秒轮询直到状态稳定。
 */

function plugin(
  partial: Partial<MyPluginItem['plugin']> = {},
  item: Partial<MyPluginItem> = {},
): MyPluginItem {
  return {
    plugin: {
      id: 4,
      packageName: 'dsh-web-search',
      displayName: '联网搜索',
      description: '给模型加一个搜索工具，回答更新鲜。',
      icon: null,
      homepage: null,
      policy: 'optional',
      isBundle: false,
      bundleOrder: 0,
      needsRestart: true,
      latestVersion: '0.5.0',
      ...partial,
    },
    installed: false,
    version: null,
    state: 'synced',
    canToggle: true,
    ...item,
  }
}

const REQUIRED = plugin(
  { id: 1, packageName: 'dsh-email', displayName: '邮件通知', policy: 'required' },
  { installed: true, version: '0.3.1', canToggle: false },
)

function listResponse(items: MyPluginItem[]): MyPluginsResponse {
  return { items }
}

function mountSection() {
  const Host = defineComponent({
    components: { HomePluginsSection, NMessageProvider },
    template:
      '<NMessageProvider><HomePluginsSection :poll-interval-ms="5" :max-polls="6" /></NMessageProvider>',
  })
  return mount(Host, { attachTo: document.body })
}

function rowsText(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('[data-testid="plugin-row"]').map((row) => row.text())
}

beforeEach(() => {
  window.localStorage.clear()
  vi.mocked(fetchMyPlugins).mockReset()
  vi.mocked(installMyPlugin).mockReset()
  vi.mocked(uninstallMyPlugin).mockReset()
})

describe('工作台「我的插件」列表（16 §7）', () => {
  it('卡片头部有「已安装 N / M」；required 带锁与「必装」标签、没有开关，optional 有开关', async () => {
    vi.mocked(fetchMyPlugins).mockResolvedValue(
      listResponse([REQUIRED, plugin({}, { installed: true, version: '0.5.0' }), plugin({ id: 5 })]),
    )

    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.text()).toContain('我的插件')
    expect(wrapper.get('[data-testid="plugins-count"]').text()).toContain('已安装 2 / 3')
    expect(wrapper.text()).toContain('邮件通知')
    expect(wrapper.text()).toContain('必装')
    // required 没有开关
    expect(wrapper.find('[aria-label="卸载 邮件通知"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="安装 联网搜索"]').exists()).toBe(true)
    // 描述单行省略的完整内容放 title
    const row = wrapper.findAll('[data-testid="plugin-row"]')[0]!
    expect(row.find('.plugins__desc').attributes('title')).toBe('给模型加一个搜索工具，回答更新鲜。')
    wrapper.unmount()
  })

  it('筛选「已安装 / 可安装」只留下对应项，并写进 localStorage', async () => {
    vi.mocked(fetchMyPlugins).mockResolvedValue(
      listResponse([REQUIRED, plugin({}, { installed: true, version: '0.5.0' }), plugin({ id: 5 })]),
    )

    const wrapper = mountSection()
    await flushPromises()

    const installed = wrapper.findAll('.n-radio-button').find((item) => item.text() === '已安装')!
    await installed.trigger('click')
    await flushPromises()
    expect(rowsText(wrapper)).toHaveLength(2)
    expect(window.localStorage.getItem('home.plugins.filter')).toBe('installed')

    const available = wrapper.findAll('.n-radio-button').find((item) => item.text() === '可安装')!
    await available.trigger('click')
    await flushPromises()
    expect(rowsText(wrapper)).toHaveLength(1)
    expect(wrapper.text()).toContain('联网搜索')
    expect(wrapper.text()).not.toContain('邮件通知')
    expect(window.localStorage.getItem('home.plugins.filter')).toBe('available')
    wrapper.unmount()
  })

  it('进页面时恢复上次的筛选；筛完没有内容时给一句空状态，不留大块空白', async () => {
    window.localStorage.setItem('home.plugins.filter', 'available')
    vi.mocked(fetchMyPlugins).mockResolvedValue(listResponse([REQUIRED]))

    const wrapper = mountSection()
    await flushPromises()

    expect(rowsText(wrapper)).toHaveLength(0)
    expect(wrapper.text()).toContain('没有可安装的插件')
    wrapper.unmount()
  })

  it('localStorage 读写抛错也不崩（隐私模式）', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    vi.mocked(fetchMyPlugins).mockResolvedValue(listResponse([plugin()]))

    const wrapper = mountSection()
    await flushPromises()
    expect(wrapper.text()).toContain('联网搜索')

    const available = wrapper.findAll('.n-radio-button').find((item) => item.text() === '可安装')!
    await available.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('联网搜索')

    getItem.mockRestore()
    setItem.mockRestore()
    wrapper.unmount()
  })

  it('切换后轮询直到状态稳定，并提示「重启 DSH 后生效」', async () => {
    vi.mocked(fetchMyPlugins)
      .mockResolvedValueOnce(listResponse([plugin()]))
      .mockResolvedValueOnce(
        listResponse([plugin({}, { installed: true, version: '0.5.0', state: 'pending' })]),
      )
      .mockResolvedValue(listResponse([plugin({}, { installed: true, version: '0.5.0', state: 'synced' })]))
    vi.mocked(installMyPlugin).mockResolvedValue({ jobId: 904 })

    const wrapper = mountSection()
    await flushPromises()

    await wrapper.get('[aria-label="安装 联网搜索"]').trigger('click')
    await flushPromises()
    expect(installMyPlugin).toHaveBeenCalledWith(4)

    // 第一次轮询：进行中 → 显示转圈 / 同步中
    await vi.waitFor(
      () => {
        expect(wrapper.text()).toContain('重启 DSH 后生效')
      },
      { timeout: 1000 },
    )
    expect(vi.mocked(fetchMyPlugins).mock.calls.length).toBeGreaterThanOrEqual(3)
    wrapper.unmount()
  })

  it('失败标签点开能看到原因（红标签不常驻说明）', async () => {
    vi.mocked(fetchMyPlugins).mockResolvedValue(
      listResponse([plugin({}, { installed: true, version: null, state: 'failed' })]),
    )

    const wrapper = mountSection()
    await flushPromises()

    const failed = wrapper.get('[data-testid="plugin-state-failed"]')
    expect(failed.text()).toBe('失败')
    await failed.trigger('click')
    await flushPromises()
    expect(document.body.textContent ?? '').toContain('插件同步失败了')
    wrapper.unmount()
  })
})
