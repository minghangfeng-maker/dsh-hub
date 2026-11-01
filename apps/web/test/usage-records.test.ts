import type { ComputeLeaseRow, ToolUsageRow } from '@dsh-hub/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { NDatePicker, NSelect } from 'naive-ui'
import { afterEach, describe, expect, it } from 'vitest'

import UsageRecordsCard, {
  type LogFilters,
  type PagedCalls,
  type PagedCompute,
  type PagedTools,
  type UsageLogTab,
} from '@/components/user/usage/UsageRecordsCard.vue'

/**
 * 19 §2.5：「使用记录」三个标签按条件出现；只有一个标签时不显示标签头；
 * 「模型调用」筛选行（日期区间 / 来源 / 模型 / 状态 / 重置）把参数交给页面。
 */

const CALLS: PagedCalls = { rows: [], total: 0, loading: false, page: 1, pageSize: 20 }
const TOOLS: PagedTools = { rows: [] as ToolUsageRow[], total: 0, loading: false, page: 1, pageSize: 20 }
const COMPUTE: PagedCompute = {
  rows: [] as ComputeLeaseRow[],
  total: 0,
  loading: false,
  page: 1,
  pageSize: 20,
}
const FILTERS: LogFilters = { from: '2026-09-21', to: '2026-10-20', scope: '', model: '', status: '' }

const mounted: { unmount: () => void }[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount()
  document.body.innerHTML = ''
})

function mountCard(overrides: Record<string, unknown> = {}) {
  const wrapper = mount(UsageRecordsCard, {
    props: {
      tab: 'calls' as UsageLogTab,
      showSource: true,
      calls: CALLS,
      tools: null,
      compute: null,
      filters: FILTERS,
      modelOptions: [{ label: 'm@a', value: 'm@a' }],
      maxRangeDays: 368,
      ...overrides,
    },
    attachTo: document.body,
  })
  mounted.push(wrapper)
  return wrapper
}

describe('「使用记录」标签（19 §2.5）', () => {
  it('只有「模型调用」时不显示标签头', () => {
    const wrapper = mountCard()
    expect(wrapper.findAll('.n-tabs').length).toBe(0)
    expect(wrapper.text()).toContain('使用记录')
    expect(wrapper.find('.usage-log').exists()).toBe(true)
  })

  it('搜索池开着 → 两个标签；算力计费开着 → 三个标签', async () => {
    const wrapper = mountCard({ tools: TOOLS })
    expect(wrapper.findAll('.n-tabs-tab').map((node) => node.text())).toEqual(['模型调用', '搜索与抓取'])
    expect(wrapper.text()).not.toContain('算力租赁')

    const full = mountCard({ tools: TOOLS, compute: COMPUTE })
    expect(full.findAll('.n-tabs-tab').map((node) => node.text())).toEqual([
      '模型调用',
      '搜索与抓取',
      '算力租赁',
    ])
    await full.findAll('.n-tabs-tab')[2]!.trigger('click')
    await flushPromises()
    expect(full.emitted('tab-change')?.at(-1)).toEqual(['compute'])
  })

  it('当前标签不在可用列表里时回落到「模型调用」', () => {
    const wrapper = mountCard({ tab: 'tools' as UsageLogTab, tools: null })
    expect(wrapper.find('.usage-log').exists()).toBe(true)
  })

  it('筛选行：日期区间 / 来源 / 模型 / 状态 / 重置 都把参数交给页面', async () => {
    const wrapper = mountCard()

    const picker = wrapper.findComponent(NDatePicker)
    const from = new Date(2026, 9, 1).getTime()
    const to = new Date(2026, 9, 10).getTime()
    picker.vm.$emit('update:value', [from, to])
    await flushPromises()
    expect(wrapper.emitted('filters-change')?.at(-1)?.[0]).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-10',
    })

    const selects = wrapper.findAllComponents(NSelect)
    const statusSelect = selects.find((item) =>
      (item.props('options') as { label: string }[]).some((option) => option.label === '全部状态'),
    )
    expect(statusSelect, '应有状态筛选').toBeTruthy()
    statusSelect!.vm.$emit('update:value', 'ok')
    await flushPromises()
    expect(wrapper.emitted('filters-change')?.at(-1)?.[0]).toMatchObject({ status: 'ok' })

    const sourceSelect = selects.find((item) =>
      (item.props('options') as { label: string }[]).some((option) => option.label === 'Claude Code'),
    )
    sourceSelect!.vm.$emit('update:value', 'claude-code')
    await flushPromises()
    expect(wrapper.emitted('filters-change')?.at(-1)?.[0]).toMatchObject({ scope: 'claude-code' })

    await wrapper.find('[data-testid="usage-log-reset"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('filters-change')?.at(-1)?.[0]).toEqual({
      from: '',
      to: '',
      scope: '',
      model: '',
      status: '',
    })
  })

  it('没开通对话模式时不显示来源筛选', () => {
    const wrapper = mountCard({ showSource: false })
    const labels = wrapper
      .findAllComponents(NSelect)
      .flatMap((item) => (item.props('options') as { label: string }[]).map((option) => option.label))
    expect(labels).not.toContain('Claude Code')
  })
})
