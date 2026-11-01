import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NMessageProvider, NSelect } from 'naive-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import RoleChoiceField from '@/components/admin/RoleChoiceField.vue'
import { installMockFetch } from '@/mocks/fetch'
import { resetRelayMock } from '@/mocks/relay'
import { setMockScenario } from '@/mocks/state'
import { routes } from '@/router'
import AdminUsersView from '@/views/admin/AdminUsersView.vue'

/**
 * 新建用户弹窗的角色（WP13，07 §7.2）：四处共用的 `RoleChoiceField` 在这里收尾 ——
 * 「＋ 新建角色…」→ 输入自定义名 → 提交体里必须是 `role: 'user'` + `roleLabel: <名字>`；
 * 空名时提交被拦下（不发请求，报「请输入角色名」）。
 *
 * 走 `?mock=admin` 假接口，只用它自己的假状态；请求体单独拦一层记录下来。
 */

const restores: (() => void)[] = []
const wrappers: { unmount: () => void }[] = []

function useMock(): void {
  resetRelayMock()
  setMockScenario('admin')
  restores.push(installMockFetch('admin'))
}

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  while (restores.length > 0) restores.pop()?.()
  setMockScenario('running')
  resetRelayMock()
  document.body.innerHTML = ''
})

const Host = defineComponent({
  render: () => h(NMessageProvider, null, { default: () => h(AdminUsersView) }),
})

async function mountView() {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/admin/users')
  await router.isReady()
  const wrapper = mount(Host, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  wrappers.push(wrapper)
  return wrapper
}

/** 记下新建用户的 POST 体（假 fetch 照常回数据） */
function capturePosts(): Record<string, unknown>[] {
  const captured: Record<string, unknown>[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/admin/users') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
      captured.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    }
    return original(input, init)
  }) as typeof fetch
  restores.push(() => {
    globalThis.fetch = original
  })
  return captured
}

/** 假接口带 90ms 的假网络延迟，角色标签要等它回来 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 160))
  await flushPromises()
}

function bodyButton(text: string): HTMLElement {
  const button = [...document.body.querySelectorAll('button')].find((node) => node.textContent?.trim() === text)
  expect(button, `页面上应有「${text}」按钮`).toBeTruthy()
  return button as HTMLElement
}

async function clickBodyButton(text: string): Promise<void> {
  bodyButton(text).click()
  await flushPromises()
}

/** 弹窗里的角色下拉（`RoleChoiceField` 内部那个 NSelect） */
function roleSelect(wrapper: VueWrapper) {
  const field = wrapper.findComponent(RoleChoiceField)
  expect(field.exists(), '应有 RoleChoiceField').toBe(true)
  const select = field.findComponent(NSelect)
  expect(select.exists(), '角色控件里应有下拉').toBe(true)
  return select
}

/** 按候选的文字选中它（jsdom 里点开 naive 的下拉菜单不稳，直接驱动组件的 value） */
async function pickOption(wrapper: VueWrapper, label: string): Promise<void> {
  const select = roleSelect(wrapper)
  const options = select.props('options') as { label: string; value: string }[]
  const option = options.find((item) => item.label === label)
  expect(option, `候选里应有「${label}」，实际：${options.map((item) => item.label).join(' / ')}`).toBeTruthy()
  select.vm.$emit('update:value', option!.value)
  await flushPromises()
  await nextTick()
}

const pickNewRole = (wrapper: VueWrapper) => pickOption(wrapper, '＋ 新建角色…')

async function typeRoleName(name: string): Promise<void> {
  const input = document.body.querySelector<HTMLInputElement>('[data-testid="role-choice-input"] input')
  expect(input, '选「新建角色…」后应出现输入框').toBeTruthy()
  input!.value = name
  input!.dispatchEvent(new Event('input'))
  await nextTick()
}

describe('新建用户弹窗：角色（07 §7.2，WP13）', () => {
  it('「＋ 新建角色…」输入的自定义名 → 提交体 role=user + roleLabel=名字', async () => {
    useMock()
    const posts = capturePosts()
    const wrapper = await mountView()

    await clickBodyButton('新建用户')
    await vi.waitFor(() => expect(roleSelect(wrapper).exists()).toBe(true), { timeout: 5000 })
    await settle()
    await pickNewRole(wrapper)
    await typeRoleName('表姐')

    const username = document.body.querySelector<HTMLInputElement>('input[placeholder="小写字母、数字、- 和 _"]')
    expect(username, '应有用户名输入框').toBeTruthy()
    username!.value = 'biao-jie'
    username!.dispatchEvent(new Event('input'))
    await nextTick()

    await clickBodyButton('创建')
    await flushPromises()

    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({ username: 'biao-jie', role: 'user', roleLabel: '表姐' })
  })

  it('输入框空着点「创建」：报「请输入角色名」，不发请求', async () => {
    useMock()
    const posts = capturePosts()
    const wrapper = await mountView()

    await clickBodyButton('新建用户')
    await vi.waitFor(() => expect(roleSelect(wrapper).exists()).toBe(true), { timeout: 5000 })
    await settle()
    await pickNewRole(wrapper)

    await clickBodyButton('创建')
    await flushPromises()

    expect(document.querySelector('[data-testid="role-choice-error"]')?.textContent?.trim()).toBe('请输入角色名')
    expect(posts).toHaveLength(0)
  })

  it('下拉里选「家人」→ 提交体 role=user + roleLabel=家人', async () => {
    useMock()
    const posts = capturePosts()
    const wrapper = await mountView()

    await clickBodyButton('新建用户')
    await vi.waitFor(() => expect(roleSelect(wrapper).exists()).toBe(true), { timeout: 5000 })
    await settle()
    await pickOption(wrapper, '家人')

    const username = document.body.querySelector<HTMLInputElement>('input[placeholder="小写字母、数字、- 和 _"]')
    username!.value = 'mint-2'
    username!.dispatchEvent(new Event('input'))
    await nextTick()

    await clickBodyButton('创建')
    await flushPromises()

    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({ username: 'mint-2', role: 'user', roleLabel: '家人' })
  })
})
