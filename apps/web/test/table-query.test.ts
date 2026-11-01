import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { beforeEach, describe, expect, it } from 'vitest'

import { parseTableQuery, toTableQuery, useTableQuery } from '@/composables/table-query'

/**
 * 表格筛选参数与 URL 同步（07 §7.2 用户列表、§7.9 任务中心、§7.10 审计）。
 */

const DEFAULTS = { q: '', status: '', role: '', instance: '', sort: 'createdAt:desc', page: 1, pageSize: 20 }
type UsersQuery = typeof DEFAULTS

describe('table-query：纯函数', () => {
  it('URL → 状态：只认已知键，数字/布尔按默认值类型转换', () => {
    const parsed = parseTableQuery(DEFAULTS, { q: '薄荷', page: '3', role: 'admin', 未知键: 'x' })
    expect(parsed).toEqual({ ...DEFAULTS, q: '薄荷', page: 3, role: 'admin' })

    const boolDefaults = { onlyRunning: false, page: 1 }
    expect(parseTableQuery(boolDefaults, { onlyRunning: '1' }).onlyRunning).toBe(true)
    expect(parseTableQuery(boolDefaults, { onlyRunning: 'false' }).onlyRunning).toBe(false)
  })

  it('URL → 状态：非法值与数组取值都有兜底', () => {
    expect(parseTableQuery(DEFAULTS, { page: 'abc' }).page).toBe(1)
    expect(parseTableQuery(DEFAULTS, { q: ['a', 'b'] }).q).toBe('a')
    expect(parseTableQuery(DEFAULTS, { q: null }).q).toBe('')
  })

  it('状态 → URL：与默认值相同的键不写进地址栏', () => {
    expect(toTableQuery(DEFAULTS, { ...DEFAULTS, q: 'abc', page: 2 })).toEqual({ q: 'abc', page: '2' })
    expect(toTableQuery(DEFAULTS, { ...DEFAULTS })).toEqual({})
    expect(toTableQuery(DEFAULTS, { ...DEFAULTS, status: 'pending', instance: '' })).toEqual({
      status: 'pending',
    })
  })

  it('空串与空值不进 URL（查询串保持干净）', () => {
    expect(toTableQuery(DEFAULTS, { ...DEFAULTS, role: '' })).toEqual({})
  })
})

// 用一个最小宿主组件驱动组合式函数（useRoute/useRouter 需要组件实例）
function makeHarness() {
  return defineComponent({
    setup() {
      const { state, update, reset } = useTableQuery<UsersQuery>(DEFAULTS)
      return { state, update, reset }
    },
    render: () => h('div'),
  })
}

async function routerAt(path: string): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/admin/users', component: { render: () => null } }],
  })
  await router.push(path)
  await router.isReady()
  return router
}

describe('useTableQuery：与当前路由双向同步', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('进入页面时从 URL 读取筛选条件（外部链接 / 刷新保持）', async () => {
    const router = await routerAt('/admin/users?q=薄荷&status=pending&page=2')
    const wrapper = mount(makeHarness(), { global: { plugins: [router] } })
    const state = (wrapper.vm as unknown as { state: UsersQuery }).state

    expect(state.q).toBe('薄荷')
    expect(state.status).toBe('pending')
    expect(state.page).toBe(2)
    expect(state.sort).toBe('createdAt:desc')
  })

  it('update 写回 URL，改动筛选时自动回到第 1 页', async () => {
    const router = await routerAt('/admin/users?page=3')
    const wrapper = mount(makeHarness(), { global: { plugins: [router] } })
    const vm = wrapper.vm as unknown as {
      state: UsersQuery
      update: (patch: Partial<UsersQuery>) => Promise<void>
    }

    await vm.update({ q: '薄荷' })
    await flushPromises()

    expect(router.currentRoute.value.query['q']).toBe('薄荷')
    expect(router.currentRoute.value.query['page']).toBeUndefined()
    expect(vm.state.page).toBe(1)
  })

  it('只翻页时保留其它筛选条件', async () => {
    const router = await routerAt('/admin/users?q=薄荷&status=active')
    const wrapper = mount(makeHarness(), { global: { plugins: [router] } })
    const vm = wrapper.vm as unknown as {
      state: UsersQuery
      update: (patch: Partial<UsersQuery>, options?: { resetPage?: boolean }) => Promise<void>
    }

    await vm.update({ page: 2 }, { resetPage: false })
    await flushPromises()

    expect(router.currentRoute.value.query).toMatchObject({ q: '薄荷', status: 'active', page: '2' })
  })

  it('浏览器前进 / 后退（URL 变化）会同步回状态', async () => {
    const router = await routerAt('/admin/users')
    const wrapper = mount(makeHarness(), { global: { plugins: [router] } })
    const vm = wrapper.vm as unknown as { state: UsersQuery }

    await router.push('/admin/users?role=admin&sort=username:asc')
    await wrapper.vm.$nextTick()

    expect(vm.state.role).toBe('admin')
    expect(vm.state.sort).toBe('username:asc')
  })

  it('reset 清空筛选并回到干净 URL', async () => {
    const router = await routerAt('/admin/users?q=abc&page=4')
    const wrapper = mount(makeHarness(), { global: { plugins: [router] } })
    const vm = wrapper.vm as unknown as { state: UsersQuery; reset: () => Promise<void> }

    await vm.reset()
    await flushPromises()

    expect(vm.state).toEqual(DEFAULTS)
    expect(router.currentRoute.value.query).toEqual({})
  })
})
