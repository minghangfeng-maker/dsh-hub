import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'

import { installMockFetch } from '@/mocks/fetch'
import { setMockScenario, type MockScenario } from '@/mocks/state'
import { routes } from '@/router'
import AdminPluginDetailView from '@/views/admin/AdminPluginDetailView.vue'

/**
 * 插件详情页顶部的两个下发按钮（WP28c 交付物 3）：与插件库列表上的批量按钮同一个行为 ——
 * 「下发 / 安装」预填 `platforms=instance&action=install&items=plugin:<id>`，
 * 「升级已安装用户」预填 `platforms=instance,desktop&action=upgrade&targets=installed-outdated&items=…`。
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
  render: () => h(NMessageProvider, null, { default: () => h(AdminPluginDetailView) }),
})

const WIZARD_STUB = { path: '/admin/rollouts', component: { render: () => null } }

async function mountDetail(path = '/admin/plugins/1'): Promise<{ wrapper: VueWrapper; router: Router }> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [WIZARD_STUB, ...routes],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(Host, { global: { plugins: [router] }, attachTo: document.body })
  wrappers.push(wrapper)
  await new Promise((resolve) => setTimeout(resolve, 320))
  await flushPromises()
  return { wrapper, router }
}

function button(wrapper: VueWrapper, text: string) {
  const found = wrapper.findAll('.admin-page button').find((node) => node.text().trim() === text)
  expect(found, `详情页应有「${text}」按钮`).toBeTruthy()
  return found!
}

describe('插件详情 · 下发按钮', () => {
  it('顶部有两个按钮（下发 / 安装、升级已安装用户）', async () => {
    useMock()
    const { wrapper } = await mountDetail()

    expect(wrapper.text()).toContain('邮件助手')
    expect(button(wrapper, '下发 / 安装').exists()).toBe(true)
    expect(button(wrapper, '升级已安装用户').exists()).toBe(true)
  })

  it('「下发 / 安装」预填实例 + install + 这个插件（版本缺省最新）', async () => {
    useMock()
    const { wrapper, router } = await mountDetail()
    await button(wrapper, '下发 / 安装').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe(
      '/admin/rollouts?platforms=instance&action=install&items=plugin:1',
    )
  })

  it('「升级已安装用户」预填两个平台 + targets=installed-outdated', async () => {
    useMock()
    const { wrapper, router } = await mountDetail()
    await button(wrapper, '升级已安装用户').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toMatchObject({
      platforms: 'instance,desktop',
      action: 'upgrade',
      targets: 'installed-outdated',
      items: 'plugin:1',
    })
    expect(router.currentRoute.value.fullPath).toBe(
      '/admin/rollouts?platforms=instance,desktop&action=upgrade&targets=installed-outdated&items=plugin:1',
    )
  })
})
