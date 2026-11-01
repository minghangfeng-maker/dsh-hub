import type { RelayUsageBucket, RelayUsageStatsResponse } from '@dsh-hub/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { NRadioButton, NSelect, NSwitch } from 'naive-ui'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import ModelUsageChart from '@/components/relay/ModelUsageChart.vue'
import ModelUsageSection from '@/components/user/usage/ModelUsageSection.vue'
import { routes } from '@/router'
import { OTHER_SERIES_NAME, type DailyModelRow } from '@/utils/usage-series'

/**
 * 19 §2.2：「模型消耗」整块——筛选改变 → 图系列变化；只有来源 / 区间变化才重新请求；
 * 最多选 8 个模型；筛选状态写进查询串；空状态。
 */

function bucket(partial: Partial<RelayUsageBucket> = {}): RelayUsageBucket {
  return {
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMicro: 0,
    ...partial,
  }
}

function daysBetween(from: string, to: string): string[] {
  const days: string[] = []
  for (let time = Date.parse(`${from}T00:00:00Z`); time <= Date.parse(`${to}T00:00:00Z`); time += 86_400_000) {
    days.push(new Date(time).toISOString().slice(0, 10))
  }
  return days
}

/** 造一份带 `dailyByModel` 的统计响应（模型积分依次递减，顺序稳定） */
function makeStats(modelCount = 10): RelayUsageStatsResponse {
  const days = daysBetween('2026-10-01', '2026-10-05')
  const rows: DailyModelRow[] = []
  for (let index = 0; index < modelCount; index += 1) {
    const name = `model-${String(index + 1).padStart(2, '0')}`
    const cost = (modelCount - index) * 1_000_000
    for (const day of [days[0]!, days[2]!]) {
      rows.push({ day, model: name, ...bucket({ requests: 1, costMicro: cost, inputTokens: 100 }) })
    }
  }
  const daily = days.map((day) => ({
    day,
    ...bucket({
      requests: rows.filter((row) => row.day === day).reduce((sum, row) => sum + row.requests, 0),
      costMicro: rows.filter((row) => row.day === day).reduce((sum, row) => sum + row.costMicro, 0),
    }),
  }))
  return {
    from: days[0]!,
    to: days.at(-1)!,
    total: bucket({
      requests: daily.reduce((sum, item) => sum + item.requests, 0),
      costMicro: daily.reduce((sum, item) => sum + item.costMicro, 0),
      inputTokens: daily.reduce((sum, item) => sum + item.inputTokens, 0),
    }),
    daily,
    byModel: [],
    byUser: [],
    byChannel: [],
    byScope: [{ scope: 'dsh', ...bucket({ costMicro: 100 }) }],
    dailyByModel: rows,
  }
}

const mounted: { unmount: () => void }[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount()
  document.body.innerHTML = ''
})

async function mountSection(
  usage: RelayUsageStatsResponse | null,
  path = '/usage',
  props: Record<string, unknown> = {},
) {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  await router.isReady()

  const wrapper = mount(ModelUsageSection, {
    props: { usage, showScope: true, models: [], ...props },
    global: { plugins: [router] },
    attachTo: document.body,
  })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router }
}

function queryEvents(wrapper: ReturnType<typeof mount>): unknown[][] {
  return (wrapper.emitted('query') ?? []) as unknown[][]
}

function legendNames(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('.model-chart__legend-name').map((node) => node.text())
}

function radio(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAllComponents(NRadioButton).find((item) => item.text() === text)
}

describe('「模型消耗」筛选与图（19 §2.2）', () => {
  it('默认选中积分前 5，其余合并成「其他」', async () => {
    const { wrapper } = await mountSection(makeStats(10))
    expect(legendNames(wrapper)).toEqual([
      'model-01',
      'model-02',
      'model-03',
      'model-04',
      'model-05',
      OTHER_SERIES_NAME,
    ])
    // 「其他」= 后 5 个模型的合计
    expect(wrapper.findAll('.model-chart__legend-item')).toHaveLength(6)
  })

  it('模型 / 指标 / 图形 / 合并渠道切换都不重新请求；来源与区间才重新请求', async () => {
    const { wrapper } = await mountSection(makeStats(10))
    const before = queryEvents(wrapper).length
    expect(before).toBe(1) // 挂载时给一次初始查询

    // 模型多选：不请求
    wrapper.findAllComponents(NSelect)[1]!.vm.$emit('update:value', ['model-01', 'model-02'])
    await flushPromises()
    expect(queryEvents(wrapper).length).toBe(before)
    expect(legendNames(wrapper)).toEqual(['model-01', 'model-02', OTHER_SERIES_NAME])

    // 指标：不请求，但图例的数值口径变了
    await radio(wrapper, 'token')!.find('input').setValue()
    await flushPromises()
    expect(queryEvents(wrapper).length).toBe(before)

    // 图形：不请求
    await radio(wrapper, '堆叠')!.find('input').setValue()
    await flushPromises()
    expect(queryEvents(wrapper).length).toBe(before)
    expect(wrapper.findComponent(ModelUsageChart).props('chartType')).toBe('stack')

    // 合并渠道：不请求
    const merge = wrapper.findComponent(NSwitch)
    merge.vm.$emit('update:value', true)
    await flushPromises()
    expect(queryEvents(wrapper).length).toBe(before)

    // 来源：请求
    wrapper.findAllComponents(NSelect)[0]!.vm.$emit('update:value', 'claude-code')
    await flushPromises()
    expect(queryEvents(wrapper).length).toBe(before + 1)
    expect(queryEvents(wrapper).at(-1)![0]).toMatchObject({ scope: 'claude-code' })

    // 区间：请求
    await radio(wrapper, '7 天')!.find('input').setValue()
    await flushPromises()
    expect(queryEvents(wrapper).length).toBe(before + 2)
    expect(queryEvents(wrapper).at(-1)![0]).toMatchObject({ scope: 'claude-code' })
  })

  it('最多选 8 个：第 9 个选项禁用，点第 9 行也不会被选中', async () => {
    const { wrapper } = await mountSection(makeStats(10))
    const names = Array.from({ length: 8 }, (_, index) => `model-0${String(index + 1)}`)
    wrapper.findAllComponents(NSelect)[1]!.vm.$emit('update:value', names)
    await flushPromises()

    const options = wrapper.findAllComponents(NSelect)[1]!.props('options') as {
      value: string
      disabled?: boolean
    }[]
    expect(options.filter((item) => item.disabled).map((item) => item.value)).toEqual([
      'model-09',
      'model-10',
    ])

    // 点第 9 个模型那一行：已经是 8 个，不再增加
    const rows = wrapper.findAll('.model-usage__row')
    expect(rows).toHaveLength(10)
    await rows[8]!.trigger('click')
    await flushPromises()
    expect(legendNames(wrapper)).toEqual([...names, OTHER_SERIES_NAME])

    // 取消一个之后再点就能选上
    await rows[0]!.trigger('click')
    await flushPromises()
    await rows[8]!.trigger('click')
    await flushPromises()
    expect(legendNames(wrapper)).toContain('model-09')
  })

  it('筛选状态写进查询串（刷新保持），且不动其它键', async () => {
    const { wrapper, router } = await mountSection(makeStats(10), '/usage?log=tools&page=2')
    await radio(wrapper, '堆叠')!.find('input').setValue()
    await flushPromises()
    expect(router.currentRoute.value.query['chart']).toBe('stack')
    // 使用记录的键原样保留
    expect(router.currentRoute.value.query['log']).toBe('tools')
    expect(router.currentRoute.value.query['page']).toBe('2')
  })

  it('从查询串读回筛选状态', async () => {
    const { wrapper } = await mountSection(
      makeStats(10),
      '/usage?range=90&metric=tokens&chart=stack&merge=1&models=model-02,model-03',
    )
    expect(wrapper.findComponent(ModelUsageChart).props('chartType')).toBe('stack')
    expect(legendNames(wrapper)).toEqual(['model-02', 'model-03', OTHER_SERIES_NAME])
    expect(radio(wrapper, '90 天')!.find('input').element.checked).toBe(true)
  })

  it('区间内没有用量 → 图显示空状态，不画坐标', async () => {
    const stats = makeStats(10)
    const { wrapper } = await mountSection({ ...stats, dailyByModel: [] })
    expect(wrapper.text()).toContain('这段时间还没有用量')
    expect(wrapper.find('.model-chart__svg').exists()).toBe(false)
  })

  it('合计行是整个区间的合计，不随模型多选变化', async () => {
    const { wrapper } = await mountSection(makeStats(10))
    const before = wrapper.find('[data-testid="usage-total"]').text()
    wrapper.findAllComponents(NSelect)[1]!.vm.$emit('update:value', ['model-01'])
    await flushPromises()
    expect(wrapper.find('[data-testid="usage-total"]').text()).toBe(before)
  })
})
