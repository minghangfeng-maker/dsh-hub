import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import { installMockFetch } from '@/mocks/fetch'
import { setMockScenario } from '@/mocks/state'
import { routes } from '@/router'
import AdminSettingsView from '@/views/admin/AdminSettingsView.vue'

/**
 * WP45：系统设置「默认配额」面板补上「没人看时休眠（分钟）」（`idleNoClientMinutes`）。
 *
 * 这个字段以前只在「用户详情 → 环境」的单用户配额表单（`QuotaForm.vue`）里有，全局默认面板
 * 漏了它：管理员把「空闲回收」调到 120 之后，无人在看的实例仍然按 `idleNoClientMinutes` 的默认值
 * 30 分钟被回收（audit `rule: unattended`，见 docs/22 §6.2、instances/service.ts §③）。
 * 这里锁住：面板能看见、能改、保存体里带得上。
 */

const restores: (() => void)[] = []
const wrappers: VueWrapper[] = []

function useMock(): void {
  setMockScenario('admin')
  restores.push(installMockFetch('admin'))
}

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  while (restores.length > 0) restores.pop()?.()
  setMockScenario('running')
  document.body.innerHTML = ''
})

const Host = defineComponent({
  render: () => h(NMessageProvider, null, { default: () => h(AdminSettingsView) }),
})

async function mountView(): Promise<VueWrapper> {
  // AdminPage 的头部有「返回」按钮，需要 router 注入
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/admin/settings')
  await router.isReady()
  const wrapper = mount(Host, { global: { plugins: [router] }, attachTo: document.body })
  // 假接口带 ~90ms 的假网络延迟（mocks/fetch.ts），等它回完再断言
  await settle()
  wrappers.push(wrapper)
  return wrapper
}

/** 等假接口回完（与其它 view 测试一致的节奏） */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 120))
  await flushPromises()
}

/** 找到「默认配额」卡片 */
function quotaCard(wrapper: VueWrapper) {
  const card = wrapper
    .findAll('.soft-card')
    .find((item) => item.text().includes('默认配额') && item.text().includes('空闲回收'))
  if (!card) throw new Error('没有找到「默认配额」卡片')
  return card
}

/** 卡片里某个标签对应的表单项 */
function formItem(card: ReturnType<typeof quotaCard>, label: string) {
  const item = card.findAll('.n-form-item').find((node) => node.text().includes(label))
  if (!item) throw new Error(`没有找到「${label}」表单项`)
  return item
}

describe('系统设置 · 默认配额（WP45）', () => {
  it('渲染「没人看时休眠（分钟）」，并回填默认值 30', async () => {
    useMock()
    const wrapper = await mountView()

    const item = formItem(quotaCard(wrapper), '没人看时休眠（分钟）')
    const input = item.find('input')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('30')
  })

  it('改完保存：PATCH 体里的 default_quota 带上 idleNoClientMinutes', async () => {
    useMock()
    const wrapper = await mountView()

    // 记下 PATCH /api/admin/settings 的请求体（假接口照常回数据）
    const patched: Record<string, unknown>[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      if (
        String(input).includes('/api/admin/settings') &&
        (init?.method ?? 'GET').toUpperCase() === 'PATCH'
      ) {
        patched.push(JSON.parse(body || '{}') as Record<string, unknown>)
      }
      return original(input, init)
    }) as typeof fetch
    restores.push(() => {
      globalThis.fetch = original
    })

    const card = quotaCard(wrapper)
    const input = formItem(card, '没人看时休眠（分钟）').find('input')
    await input.setValue('240')
    await input.trigger('change')
    await settle()

    // 该卡片的「保存」按钮（卡片头部 extra 槽里那一个）
    const save = card.findAll('button').find((node) => node.text().includes('保存'))
    expect(save).toBeTruthy()
    expect(save!.attributes('disabled')).toBeUndefined()
    await save!.trigger('click')
    await settle()

    const body = patched.find((item) => 'default_quota' in item)
    expect(body).toBeTruthy()
    expect(body!.default_quota).toMatchObject({ idleNoClientMinutes: 240 })
  })
})
