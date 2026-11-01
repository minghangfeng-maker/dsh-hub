import { flushPromises, mount } from '@vue/test-utils'
import { NDropdown, NMessageProvider, NSelect } from 'naive-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'

import InfoTip from '@/components/base/InfoTip.vue'
import { routes } from '@/router'
import AdminInvitesView from '@/views/admin/AdminInvitesView.vue'

/**
 * 邀请码页的角色（07 §7.10）：列表「角色」列、生成弹窗的角色下拉（没有「管理员」）、
 * 生成后的一次性弹窗写明角色、操作菜单「修改角色」走 PATCH。
 * 纯逻辑（候选与拆分）在 `test/role-label.test.ts`。
 */

const INVITES = [
  {
    id: 1,
    code: 'ABCD2345EFGH',
    note: '给同事的码',
    maxUses: 3,
    usedCount: 2,
    expiresAt: null,
    disabled: false,
    createdBy: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    roleLabel: '家人',
    uses: [{ userId: 2, username: 'mint', usedAt: '2026-10-02T00:00:00.000Z' }],
  },
  {
    id: 2,
    code: 'JKLM6789NPQR',
    note: '',
    maxUses: 1,
    usedCount: 0,
    expiresAt: null,
    disabled: false,
    createdBy: 1,
    createdAt: '2026-10-02T00:00:00.000Z',
    roleLabel: '',
    uses: [],
  },
]

const ROLE_LABELS = {
  items: [
    { label: '家人', count: 2 },
    { label: '同事', count: 0 },
  ],
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

interface Captured {
  create?: Record<string, unknown>
  patch?: { path: string; body: Record<string, unknown> }
}

function stubFetch(captured: Captured): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const method = init?.method ?? 'GET'

      if (url.pathname === '/api/admin/invites' && method === 'GET') {
        return json({ items: INVITES, total: INVITES.length, page: 1, pageSize: 20 })
      }
      if (url.pathname === '/api/admin/invites' && method === 'POST') {
        captured.create = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        return json(
          {
            items: [
              {
                ...INVITES[0],
                id: 100,
                code: 'MOCK0001CODE',
                usedCount: 0,
                uses: [],
                roleLabel: captured.create.roleLabel ?? '',
              },
            ],
          },
          201,
        )
      }
      if (url.pathname.startsWith('/api/admin/invites/') && method === 'PATCH') {
        captured.patch = {
          path: url.pathname,
          body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        }
        return json({ invite: { ...INVITES[0], roleLabel: captured.patch.body.roleLabel ?? '' } })
      }
      if (url.pathname === '/api/admin/users/role-labels') return json(ROLE_LABELS)
      return json({ error: { code: 'NOT_FOUND', message: '没有这个接口' } }, 404)
    }),
  )
}

async function routerAt(path: string): Promise<Router> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  await router.isReady()
  return router
}

const Host = defineComponent({
  components: { AdminInvitesView },
  render: () => h(NMessageProvider, null, { default: () => h(AdminInvitesView) }),
})

async function mountView(captured: Captured = {}) {
  stubFetch(captured)
  const router = await routerAt('/admin/invites')
  const wrapper = mount(Host, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

type Wrapper = Awaited<ReturnType<typeof mountView>>

/** 弹窗（NModal）内容传送到 body，按钮只能从 body 里找 */
function bodyButton(text: string): HTMLElement {
  const button = [...document.body.querySelectorAll('button')].find(
    (node) => node.textContent?.trim() === text,
  )
  expect(button, `页面上应有「${text}」按钮`).toBeTruthy()
  return button as HTMLElement
}

async function clickBodyButton(text: string): Promise<void> {
  bodyButton(text).click()
  await flushPromises()
}

/** 「更多操作」菜单的选项（NDropdown 的 options） */
function moreOptions(wrapper: Wrapper, index = 0): string[] {
  const dropdown = wrapper.findAllComponents(NDropdown)[index]!
  return (dropdown.props('options') as { label?: string }[]).flatMap((option) =>
    option.label ? [option.label] : [],
  )
}

function selectValues(select: { props: (name: string) => unknown }): string[] {
  return (select.props('options') as { value: string }[]).map((option) => option.value)
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('邀请码页：角色列', () => {
  it('列表按码上的 roleLabel 渲染角色标签（空串 = 普通用户），且不出现管理员', async () => {
    const wrapper = await mountView()

    expect(wrapper.text()).toContain('ABCD2345EFGH')
    expect(wrapper.text()).toContain('家人')
    expect(wrapper.text()).toContain('普通用户')
    expect(wrapper.text()).not.toContain('管理员')
  })
})

describe('邀请码页：生成时选角色', () => {
  it('生成弹窗有角色下拉、没有说明小字，候选不含「管理员」，默认「普通用户」', async () => {
    const wrapper = await mountView()

    await clickBodyButton('生成邀请码')
    // 07 §2.7：不放教操作的常驻小字——「邀请码不能发管理员」由下拉里没有这个候选来表达
    expect(document.querySelector('.role-choice__hint')).toBeNull()
    expect(document.body.textContent).not.toContain('下拉最后一项')

    const select = wrapper.findAllComponents(NSelect)[0]!
    // 候选 = 普通用户 + 在用标签（含只在邀请码上的「同事」）+ 最后一项「＋ 新建角色…」，没有管理员
    const values = selectValues(select)
    expect(values.slice(0, 3)).toEqual(['普通用户', '家人', '同事'])
    expect(values).toHaveLength(4)
    expect((select.props('options') as { label: string }[])[3]!.label).toBe('＋ 新建角色…')
    expect(select.props('value')).toBe('普通用户')
  })

  it('提交只发 roleLabel（默认空串），一次性弹窗写明角色', async () => {
    const captured: Captured = {}
    const wrapper = await mountView(captured)

    await clickBodyButton('生成邀请码')
    await clickBodyButton('生成')

    expect(captured.create).toEqual({ count: 5, maxUses: 1, note: '', expiresAt: null, roleLabel: '' })
    expect(document.body.textContent).toContain('角色：普通用户')
    expect(wrapper.findAllComponents(NDropdown).length).toBeGreaterThan(0)
  })

  it('下拉里输入角色名后生成：请求带 roleLabel，一次性弹窗写明「角色：家人」', async () => {
    const captured: Captured = {}
    const wrapper = await mountView(captured)

    await clickBodyButton('生成邀请码')
    wrapper.findAllComponents(NSelect)[0]!.vm.$emit('update:value', '家人')
    await flushPromises()

    await clickBodyButton('生成')
    expect(captured.create?.roleLabel).toBe('家人')
    expect(document.body.textContent).toContain('角色：家人')
  })
})

describe('邀请码页：修改角色', () => {
  it('操作菜单有「修改角色」；小弹窗 → PATCH roleLabel → 刷新列表', async () => {
    const captured: Captured = {}
    const wrapper = await mountView(captured)

    expect(moreOptions(wrapper)).toEqual(['修改角色', '删除邀请码'])
    wrapper.findAllComponents(NDropdown)[0]!.vm.$emit('select', 'role')
    await flushPromises()

    // 07 §2.7 第 5 条：这句后果收在「角色」标签的 InfoTip 里
    const tip = wrapper.findComponent(InfoTip)
    expect(tip.exists(), '「角色」标签旁应有 InfoTip').toBe(true)
    expect(tip.props('text')).toContain('只影响之后用此码注册的人')
    const select = wrapper.findAllComponents(NSelect)[0]!
    expect(select.props('value')).toBe('家人')
    select.vm.$emit('update:value', '朋友')
    await flushPromises()

    await clickBodyButton('保存')
    expect(captured.patch).toEqual({ path: '/api/admin/invites/1', body: { roleLabel: '朋友' } })
  })
})
