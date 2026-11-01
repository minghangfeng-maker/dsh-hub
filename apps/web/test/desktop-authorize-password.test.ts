import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import { fetchDesktopAuthorizeRequest } from '@/api/desktop'
import { HubApiError } from '@/api/http'
import { routes } from '@/router'
import DesktopAuthorizeView from '@/views/desktop/DesktopAuthorizeView.vue'

/**
 * 授权页对「必须改密」的专门提示（WP25f 交付物 7）：
 * - `details.loginCode=password_change_required`（后端 WP25e 已返回）→ 明确文案 + 改密页链接；
 * - `account_blocked` 只用于停用 / 待审批（不夹带「去改密码」的歧义）；
 * - 网页会话被全局网关拦住（`MUST_CHANGE_PASSWORD`）时也给同一条提示。
 */
vi.mock('@/api/desktop', () => ({
  fetchDesktopAuthorizeRequest: vi.fn(),
  decideDesktopAuthorize: vi.fn(),
  listMyDesktopDevices: vi.fn(),
  revokeMyDesktopDevice: vi.fn(),
}))

const wrappers: VueWrapper[] = []

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

async function mountView(): Promise<VueWrapper> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/desktop/authorize?req=req_password')
  await router.isReady()
  const Host = defineComponent({
    render: () => h(NMessageProvider, null, { default: () => h(DesktopAuthorizeView) }),
  })
  const wrapper = mount(Host, { global: { plugins: [router] }, attachTo: document.body })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

function problemBlock(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="desktop-authorize-problem"]')
}

describe('授权页：必须改密 vs 账号不可用', () => {
  it('password_change_required → 「请先在网页端修改初始密码」+ 改密页链接', async () => {
    vi.mocked(fetchDesktopAuthorizeRequest).mockRejectedValue(
      new HubApiError('FORBIDDEN', '请先在网页端修改初始密码，再登录桌面端', 403, {
        loginCode: 'password_change_required',
      }),
    )
    await mountView()

    const block = problemBlock()
    expect(block).toBeTruthy()
    expect(block!.textContent).toContain('请先在网页端修改初始密码')
    expect(block!.textContent).toContain('再登录桌面端')
    // 不再走通用的「账号不可用」
    expect(block!.textContent).not.toContain('账号当前不可用')
    const link = block!.querySelector<HTMLAnchorElement>('[data-testid="desktop-authorize-password-link"]')
    expect(link, '必须带改密页链接').toBeTruthy()
    expect(link!.getAttribute('href')).toBe('/me/password')
  })

  it('account_blocked → 只说停用 / 待审批，不给改密链接', async () => {
    vi.mocked(fetchDesktopAuthorizeRequest).mockRejectedValue(
      new HubApiError('FORBIDDEN', '账号已被停用', 403, { loginCode: 'account_blocked' }),
    )
    await mountView()

    const block = problemBlock()
    expect(block!.textContent).toContain('停用')
    expect(block!.textContent).toContain('等待审批')
    expect(block!.textContent).not.toContain('修改初始密码')
    expect(block!.querySelector('[data-testid="desktop-authorize-password-link"]')).toBeNull()
  })

  it('网页会话被全局网关拦住（MUST_CHANGE_PASSWORD）→ 同一条提示 + 链接', async () => {
    vi.mocked(fetchDesktopAuthorizeRequest).mockRejectedValue(
      new HubApiError('MUST_CHANGE_PASSWORD', '请先修改初始密码', 403),
    )
    await mountView()

    const block = problemBlock()
    expect(block!.textContent).toContain('请先在网页端修改初始密码')
    expect(block!.querySelector('[data-testid="desktop-authorize-password-link"]')?.getAttribute('href')).toBe(
      '/me/password',
    )
  })
})
