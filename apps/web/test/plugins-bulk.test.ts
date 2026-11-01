import type { AdminPluginRow } from '@dsh-hub/shared'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NMessageProvider, NSelect } from 'naive-ui'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'

import { installMockFetch } from '@/mocks/fetch'
import { setMockScenario, type MockScenario } from '@/mocks/state'
import { routes } from '@/router'
import AdminPluginsView from '@/views/admin/AdminPluginsView.vue'

/**
 * 插件库的勾选与批量（WP28c 交付物 1 / 3 / 4）与「已安装」列（交付物 2）。
 *
 * 期望的地址逐字对照契约注释（`packages/shared/src/api/delivery.ts`）：
 * `/admin/rollouts?platforms=instance&action=install&items=plugin:1,plugin:5` 等。
 * 走 `?mock=plugins-bulk` 的 11 个插件（两页、含 policy=hidden），断言只为页面行为——
 * 组件不提交任何下发，只 router.push。
 */

const restores: (() => void)[] = []
const wrappers: VueWrapper[] = []

function useMock(scenario: MockScenario = 'plugins-bulk'): void {
  setMockScenario(scenario)
  restores.push(installMockFetch(scenario))
}

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  while (restores.length > 0) restores.pop()?.()
  setMockScenario('running')
  document.body.innerHTML = ''
})

const Host = defineComponent({
  render: () => h(NMessageProvider, null, { default: () => h(AdminPluginsView) }),
})

/** 向导（WP28b 的页面）与插件详情都不在本包的测试范围里：给它们空路由，好断言跳转后的地址 */
const WIZARD_STUB = { path: '/admin/rollouts', component: { render: () => null } }
const DETAIL_STUB = { path: '/admin/plugins/:id', component: { render: () => null } }

async function mountPage(): Promise<{ wrapper: VueWrapper; router: Router }> {
  const router = createRouter({
    history: createMemoryHistory(),
    // 放在全部路由之前：路由表末尾有 404 兜底，追加在后面会被它吃掉
    routes: [WIZARD_STUB, DETAIL_STUB, ...routes],
  })
  await router.push('/admin/plugins')
  await router.isReady()
  const wrapper = mount(Host, { global: { plugins: [router] }, attachTo: document.body })
  wrappers.push(wrapper)
  await settle()
  return { wrapper, router }
}

/** 假接口带 90ms 假延迟：列表 + 统计两次请求，留足时间 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 320))
  await flushPromises()
}

const HEADER_CHECKBOX = '[aria-label="选择本页全部插件"]'

function rowCheckbox(wrapper: VueWrapper, name: string) {
  const node = wrapper.find(`[aria-label="选择 ${name}"]`)
  expect(node.exists(), `应有「${name}」这一行的勾选框`).toBe(true)
  return node
}

async function toggleRow(wrapper: VueWrapper, name: string): Promise<void> {
  await rowCheckbox(wrapper, name).trigger('click')
  await flushPromises()
}

function batchBar(wrapper: VueWrapper) {
  return wrapper.find('.plugins__batch')
}

function batchButton(wrapper: VueWrapper, text: string) {
  const button = wrapper.findAll('.plugins__batch button').find((node) => node.text().trim() === text)
  expect(button, `批量条应有「${text}」按钮`).toBeTruthy()
  return button!
}

function isDisabled(button: { attributes: (name: string) => string | undefined; classes: () => string[] }): boolean {
  return button.attributes('disabled') !== undefined || button.classes().includes('n-button--disabled')
}

async function clickPage(wrapper: VueWrapper, page: number): Promise<void> {
  const item = wrapper
    .findAll('.n-pagination-item')
    .find((node) => node.text().trim() === String(page))
  expect(item, `分页应有第 ${page} 页`).toBeTruthy()
  await item!.trigger('click')
  await flushPromises()
}

describe('插件库 · 勾选与批量', () => {
  it('勾选出现批量条，本页全选 / 清空都跟着走', async () => {
    useMock()
    const { wrapper } = await mountPage()

    // 一开始没有批量条
    expect(batchBar(wrapper).exists()).toBe(false)

    await toggleRow(wrapper, '邮件助手')
    expect(batchBar(wrapper).exists()).toBe(true)
    expect(batchBar(wrapper).text()).toContain('已选 1 个')

    // 表头勾选框 = 本页全选（11 个插件，第一页 10 个）
    await wrapper.find(HEADER_CHECKBOX).trigger('click')
    await flushPromises()
    expect(batchBar(wrapper).text()).toContain('已选 10 个')

    // 再点一次取消本页
    await wrapper.find(HEADER_CHECKBOX).trigger('click')
    await flushPromises()
    expect(batchBar(wrapper).exists()).toBe(false)
  })

  it('已隐藏（policy=hidden）的插件也能勾选', async () => {
    useMock()
    const { wrapper } = await mountPage()

    // 旧版便签是很久以前下线的插件（policy=hidden），列表里仍然可以选它去卸载 / 升级
    await toggleRow(wrapper, '旧版便签')
    expect(batchBar(wrapper).text()).toContain('已选 1 个')
    expect(rowCheckbox(wrapper, '旧版便签').classes()).toContain('n-checkbox--checked')
  })

  it('翻页 / 搜索 / 切换策略后已选都保留（按插件 id）', async () => {
    useMock()
    const { wrapper } = await mountPage()

    await toggleRow(wrapper, '邮件助手')
    await toggleRow(wrapper, '记忆库')
    expect(batchBar(wrapper).text()).toContain('已选 2 个')

    // 翻到第 2 页：条还在，还是 2 个；回到第 1 页仍然勾着
    await clickPage(wrapper, 2)
    expect(batchBar(wrapper).text()).toContain('已选 2 个')
    await clickPage(wrapper, 1)
    expect(rowCheckbox(wrapper, '邮件助手').classes()).toContain('n-checkbox--checked')

    // 搜索只留一个：已选仍是 2 个（另一个只是被筛掉了）
    await wrapper.find('.plugins__search input').setValue('memory')
    await flushPromises()
    expect(wrapper.text()).toContain('共 1 / 11 个插件')
    expect(batchBar(wrapper).text()).toContain('已选 2 个')

    // 清空搜索 + 切到「下线」策略：已选不丢
    await wrapper.find('.plugins__search input').setValue('')
    await wrapper.findAllComponents(NSelect)[0]!.vm.$emit('update:value', 'hidden')
    await flushPromises()
    expect(wrapper.text()).toContain('共 1 / 11 个插件')
    expect(batchBar(wrapper).text()).toContain('已选 2 个')

    // 清空 = 全部取消
    await batchButton(wrapper, '清空').trigger('click')
    await flushPromises()
    expect(batchBar(wrapper).exists()).toBe(false)
  })

  it('批量条三个按钮生成的向导地址合契约', async () => {
    useMock()
    const { wrapper, router } = await mountPage()

    await toggleRow(wrapper, '记忆库')
    await toggleRow(wrapper, '邮件助手')

    // 下发 / 安装：platforms=instance、action=install、版本缺省最新、items 按 id 升序
    await batchButton(wrapper, '下发 / 安装').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe(
      '/admin/rollouts?platforms=instance&action=install&items=plugin:1,plugin:5',
    )

    // 升级已安装用户：两个平台 + targets=installed-outdated
    await batchButton(wrapper, '升级已安装用户').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe(
      '/admin/rollouts?platforms=instance,desktop&action=upgrade&targets=installed-outdated&items=plugin:1,plugin:5',
    )
    expect(router.currentRoute.value.query).toMatchObject({
      platforms: 'instance,desktop',
      action: 'upgrade',
      targets: 'installed-outdated',
      items: 'plugin:1,plugin:5',
    })

    // 卸载：只带动作与内容项，平台 / 目标交给向导
    await batchButton(wrapper, '卸载').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe(
      '/admin/rollouts?action=uninstall&items=plugin:1,plugin:5',
    )
  })

  it('行操作菜单：详情 / 下发 / 安装 / 升级已安装用户（等价于只选这一行）', async () => {
    useMock()
    const { wrapper, router } = await mountPage()

    const dropdowns = wrapper.findAllComponents({ name: 'Dropdown' })
    expect(dropdowns.length).toBe(10)
    dropdowns[0]!.vm.$emit('select', 'upgrade')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe(
      '/admin/rollouts?platforms=instance,desktop&action=upgrade&targets=installed-outdated&items=plugin:1',
    )

    dropdowns[1]!.vm.$emit('select', 'install')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe(
      '/admin/rollouts?platforms=instance&action=install&items=plugin:2',
    )

    dropdowns[2]!.vm.$emit('select', 'detail')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/admin/plugins/3')
  })

  it('超过 20 个：提示并禁用三个按钮（25 个插件的假接口）', async () => {
    useMock()
    stubPlugins(25)
    const { wrapper, router } = await mountPage()

    // 三页：10 + 10 + 5
    await wrapper.find(HEADER_CHECKBOX).trigger('click')
    await flushPromises()
    await clickPage(wrapper, 2)
    await wrapper.find(HEADER_CHECKBOX).trigger('click')
    await flushPromises()
    expect(batchBar(wrapper).text()).toContain('已选 20 个')

    // 20 个没有超，按钮可用
    expect(isDisabled(batchButton(wrapper, '下发 / 安装'))).toBe(false)

    await clickPage(wrapper, 3)
    await wrapper.find(HEADER_CHECKBOX).trigger('click')
    await flushPromises()
    expect(batchBar(wrapper).text()).toContain('已选 25 个')
    expect(batchBar(wrapper).text()).toContain('一次最多 20 个')
    for (const text of ['下发 / 安装', '升级已安装用户', '卸载']) {
      expect(isDisabled(batchButton(wrapper, text)), `「${text}」应被禁用`).toBe(true)
    }

    // 点了也不跳
    await batchButton(wrapper, '下发 / 安装').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/admin/plugins')

    // 清空后按钮恢复可用
    await batchButton(wrapper, '清空').trigger('click')
    await flushPromises()
    expect(batchBar(wrapper).exists()).toBe(false)
  })
})

describe('插件库 · 「已安装」列', () => {
  it('正常：实例 N 人 · 桌面 M 台，版本较旧时加「X 待升级」徽标', async () => {
    useMock()
    const { wrapper } = await mountPage()

    const text = wrapper.text()
    expect(text).toContain('实例 4 人')
    expect(text).toContain('桌面 3 台')
    expect(text).toContain('3 待升级') // 实例 2 人 + 桌面 1 台
    expect(text).toContain('实例 2 人')
    expect(text).toContain('桌面 0 台') // IM 机器人：桌面没人装
    expect(text).toContain('实例 0 人') // 视频渲染：无人安装
    expect(text).toContain('桌面 5 台') // 文件下载器：全最新，没有徽标
    // 全最新的那两行没有徽标
    // 第一页 10 行里 5 行有「待升级」徽标（邮件助手 / 记忆库 / 旧版便签 / 定时任务 / 消息通知）
    expect(wrapper.findAll('.mini-tag').filter((tag) => tag.text().includes('待升级'))).toHaveLength(5)
  })

  it('失败：整列显示「—」，列表照常（不阻塞）', async () => {
    useMock()
    stubInstallStatsFailure()
    const { wrapper } = await mountPage()

    // 列表有 10 行，插件名都在
    expect(wrapper.text()).toContain('邮件助手')
    expect(wrapper.text()).toContain('共 11 / 11 个插件')
    // 每行「已安装」都是「—」
    expect(wrapper.findAll('.plugins__dash')).toHaveLength(10)
    // 反证：不是「还没加载好」，而是真的没有数字
    expect(wrapper.text()).not.toContain('实例 4 人')
    expect(wrapper.text()).not.toContain('待升级')
  })

  it('插件库为空：不发统计请求，显示空状态', async () => {
    useMock('admin-empty')
    const counter = countInstallStatsRequests()
    const { wrapper } = await mountPage()

    expect(wrapper.text()).toContain('还没有登记插件')
    expect(counter.count).toBe(0)
  })

  it('页面加载 + 点刷新各取一次（一次请求，不是每行一个）', async () => {
    useMock()
    const counter = countInstallStatsRequests()
    const { wrapper } = await mountPage()

    expect(counter.count).toBe(1)

    const refresh = wrapper.findAll('button').find((node) => node.text().trim() === '刷新')
    expect(refresh, '页面上应有「刷新」').toBeTruthy()
    await refresh!.trigger('click')
    await settle()
    expect(counter.count).toBe(2)
  })
})

// ── 假接口的小改造 ──────────────────────────────────────────────────────────

/** 25 个插件的列表（用来撞 20 个的上限），其余请求照旧交给假接口 */
function stubPlugins(count: number): void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/admin/plugins') && (init?.method ?? 'GET').toUpperCase() === 'GET')
      return json(Array.from({ length: count }, (_, index) => pluginRow(index + 1)))
    return original(input, init)
  }) as typeof fetch
  restores.push(() => {
    globalThis.fetch = original
  })
}

/** 安装统计接口 500：页面应该只把那一列变成「—」 */
function stubInstallStatsFailure(): void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/admin/plugins/install-stats'))
      return json({ error: { code: 'INTERNAL', message: '统计炸了', details: {} } }, 500)
    return original(input, init)
  }) as typeof fetch
  restores.push(() => {
    globalThis.fetch = original
  })
}

function countInstallStatsRequests(): { count: number } {
  const counter = { count: 0 }
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/admin/plugins/install-stats')) counter.count += 1
    return original(input, init)
  }) as typeof fetch
  restores.push(() => {
    globalThis.fetch = original
  })
  return counter
}

function pluginRow(index: number): AdminPluginRow {
  return {
    id: index,
    packageName: `@mock/plugin-${index}`,
    displayName: `插件 ${index}`,
    description: `第 ${index} 个`,
    icon: null,
    homepage: null,
    policy: 'optional',
    isBundle: true,
    bundleOrder: index,
    needsRestart: false,
    latestVersion: '1.0.0',
    configYaml: '',
    platform: 'cloud',
    platforms: {},
    versions: [],
    stats: { installed: 0, pending: 0, failed: 0 },
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
