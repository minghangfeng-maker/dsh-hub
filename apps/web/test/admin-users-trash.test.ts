import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NMessageProvider, NSelect } from 'naive-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import { reauthDialog, resetReauthDialog, resolveReauth } from '@/composables/useReauth'
import { installMockFetch } from '@/mocks/fetch'
import { resetRelayMock } from '@/mocks/relay'
import { setMockScenario } from '@/mocks/state'
import { routes } from '@/router'
import AdminUsersView from '@/views/admin/AdminUsersView.vue'

/**
 * 用户回收站（WP22，07 §7.2 / 任务书 §1.5）：**不做独立回收站页**，
 * 用户列表的「状态」筛选切到「已删除」就地列出回收站用户，可以「恢复 / 彻底删除」。
 *
 * 走 `?mock=admin` 假接口（`mocks/admin.ts` 里有两条删除态假数据）；
 * 恢复 / 彻底删除都是敏感操作，先弹二次密码确认，确认后才发请求。
 */

const restores: (() => void)[] = []
const wrappers: { unmount: () => void }[] = []

interface Captured {
  url: string
  method: string
  body: Record<string, unknown> | null
}

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
  resetReauthDialog()
  document.body.innerHTML = ''
})

const Host = defineComponent({
  render: () => h(NMessageProvider, null, { default: () => h(AdminUsersView) }),
})

/** 假接口带 90ms 的假网络延迟：等它回来再断言 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 160))
  await flushPromises()
}

async function mountView(path = '/admin/users'): Promise<VueWrapper> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(Host, { global: { plugins: [router] }, attachTo: document.body })
  await settle()
  wrappers.push(wrapper)
  return wrapper
}

/** 记下所有 /api 请求的 URL / 方法 / JSON 体（假 fetch 照常回数据） */
function captureRequests(): Captured[] {
  const captured: Captured[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawBody = init?.body
    captured.push({
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      body: typeof rawBody === 'string' ? (JSON.parse(rawBody) as Record<string, unknown>) : null,
    })
    return original(input, init)
  }) as typeof fetch
  restores.push(() => {
    globalThis.fetch = original
  })
  return captured
}

/** 工具栏里的「状态」筛选（候选里有 value=deleted 的那个 NSelect） */
function statusFilter(wrapper: VueWrapper): VueWrapper {
  const select = wrapper
    .findAllComponents(NSelect)
    .find((item) =>
      (item.props('options') as { value: string }[]).some((option) => option.value === 'deleted'),
    )
  expect(select, '「状态」筛选里应有「已删除」一项').toBeTruthy()
  return select as VueWrapper
}

function bodyButton(text: string): HTMLElement {
  const button = [...document.body.querySelectorAll('button')].find(
    (node) => node.textContent?.trim() === text,
  )
  expect(button, `页面上应有「${text}」按钮`).toBeTruthy()
  return button as HTMLElement
}

function restoreInput(): HTMLInputElement {
  const input = document.body.querySelector<HTMLInputElement>('[data-testid="restore-username"] input')
  expect(input, '恢复弹窗里应有用户输入框').toBeTruthy()
  return input as HTMLInputElement
}

async function typeUsername(value: string): Promise<void> {
  const input = restoreInput()
  input.value = value
  input.dispatchEvent(new Event('input'))
  await flushPromises()
}

describe('用户回收站：状态筛选「已删除」（WP22）', () => {
  it('切到「已删除」：改走 /api/admin/users/deleted，表格换成删除态列', async () => {
    useMock()
    const requests = captureRequests()
    const wrapper = await mountView()

    // 普通模式没有删除态列
    expect(document.body.textContent).not.toContain('剩余可恢复')

    statusFilter(wrapper).vm.$emit('update:value', 'deleted')
    await settle()

    const deletedGets = requests.filter((item) => item.url.includes('/api/admin/users/deleted'))
    expect(deletedGets).toHaveLength(1)
    expect(deletedGets[0]?.method).toBe('GET')

    const text = document.body.textContent ?? ''
    expect(text).toContain('剩余可恢复')
    expect(text).toContain('删除时间')
    // 两条假数据：还剩 4 天 / 已过期
    expect(text).toContain('demo-carl')
    expect(text).toContain('大王')
    expect(text).toContain('剩 4 天')
    expect(text).toContain('已过期')
    expect(text).toContain('已保留')
    expect(text).toContain('无数据')
    // 已删除用户点不进详情（GET /users/:id 返回 404）：不给详情链接
    expect(document.body.querySelector('a[href="/admin/users/8"]')).toBeNull()
    // 回收站里没有批量操作，也没有启停 / 重置密码的「更多」菜单
    expect(text).not.toContain('仅运行中')
  })

  it('刷新 / 分享带 ?status=deleted 的地址也能直接进回收站', async () => {
    useMock()
    const requests = captureRequests()
    await mountView('/admin/users?status=deleted')

    expect(requests.some((item) => item.url.includes('/api/admin/users/deleted'))).toBe(true)
    expect(document.body.textContent).toContain('demo-carl')
  })

  it('普通列表搜不到：提示去回收站，点「查看已删除」保留搜索词', async () => {
    useMock()
    const requests = captureRequests()
    await mountView('/admin/users?q=demo-carl')

    expect(document.body.textContent).toContain('没找到？')

    bodyButton('查看已删除').click()
    await settle()

    const deletedGets = requests.filter((item) => item.url.includes('/api/admin/users/deleted'))
    expect(deletedGets[0]?.url).toContain('q=demo-carl')
    expect(document.body.textContent).toContain('demo-carl')
  })

  it('恢复：默认删除时的原名，改名后带 username 提交；先二次密码确认', async () => {
    useMock()
    const requests = captureRequests()
    await mountView('/admin/users?status=deleted')

    bodyButton('恢复').click()
    await flushPromises()
    expect(restoreInput().value).toBe('demo-carl')

    await typeUsername('wangwei-old')
    document.body.querySelector<HTMLElement>('[data-testid="restore-submit"]')!.click()
    await flushPromises()

    // 敏感操作：先弹二次密码，还没发恢复请求
    expect(reauthDialog.visible).toBe(true)
    expect(reauthDialog.title).toContain('恢复用户')
    expect(requests.filter((item) => item.url.includes('/restore'))).toHaveLength(0)

    resolveReauth()
    await settle()

    const restorePosts = requests.filter((item) => item.url.includes('/restore'))
    expect(restorePosts).toHaveLength(1)
    expect(restorePosts[0]?.method).toBe('POST')
    expect(restorePosts[0]?.body).toEqual({ username: 'wangwei-old' })

    // 成功后提示 + 刷新列表：恢复掉的那条从回收站消失
    // （jsdom 没有过渡事件，关掉的弹窗 DOM 会留在 body 里，所以不看 DOM 是否移除）
    await vi.waitFor(() => expect(document.body.textContent).toContain('已恢复 wangwei-old'), {
      timeout: 3000,
    })
    await vi.waitFor(() => expect(document.body.textContent).toContain('回收站 1 位'), { timeout: 3000 })
  })

  it('恢复失败（用户名被占用）：错误显示在弹窗里，弹窗不关', async () => {
    useMock()
    await mountView('/admin/users?status=deleted')

    bodyButton('恢复').click()
    await flushPromises()
    // mint 是普通列表里还在的用户 → 假接口返回 409 USERNAME_TAKEN
    await typeUsername('mint')
    document.body.querySelector<HTMLElement>('[data-testid="restore-submit"]')!.click()
    await flushPromises()

    resolveReauth()
    await settle()

    expect(document.body.querySelector('.users__error')?.textContent ?? '').toContain('已被占用')
    expect(document.body.querySelector('[data-testid="restore-username"]')).toBeTruthy()
    // 失败不刷新列表：两条都还在
    expect(document.body.textContent).toContain('回收站 2 位')
  })

  it('彻底删除：二次确认（说明不可恢复），确认后才发 purge 请求', async () => {
    useMock()
    const requests = captureRequests()
    await mountView('/admin/users?status=deleted')

    document.body.querySelector<HTMLElement>('[data-testid="user-purge"]')!.click()
    await flushPromises()

    expect(reauthDialog.visible).toBe(true)
    expect(reauthDialog.title).toContain('彻底删除')
    expect(reauthDialog.description).toContain('无法恢复')
    expect(requests.filter((item) => item.url.includes('/purge'))).toHaveLength(0)

    resolveReauth()
    await settle()

    const purges = requests.filter((item) => item.url.includes('/purge'))
    expect(purges).toHaveLength(1)
    expect(purges[0]?.method).toBe('POST')
    expect(purges[0]?.url).toContain('/api/admin/users/8/purge')
    await vi.waitFor(() => expect(document.body.textContent).toContain('已彻底删除 demo-carl'), {
      timeout: 3000,
    })
    await vi.waitFor(() => expect(document.body.textContent).toContain('回收站 1 位'), { timeout: 3000 })
  })

  it('过期条目不能恢复（按钮禁用），只剩「彻底删除」', async () => {
    useMock()
    await mountView('/admin/users?status=deleted')

    const restoreButtons = [
      ...document.body.querySelectorAll<HTMLButtonElement>('[data-testid="user-restore"]'),
    ]
    expect(restoreButtons).toHaveLength(2)
    // 第一行还剩 4 天 → 可恢复；第二行已过期 → 禁用
    expect(restoreButtons[0]?.disabled).toBe(false)
    expect(restoreButtons[1]?.disabled).toBe(true)
  })
})
