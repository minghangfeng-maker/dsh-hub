import type { RelayKey, RelayUsageBucket, RelayWalletRow } from '@dsh-hub/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider, NRadioButton } from 'naive-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import InfoTip from '@/components/base/InfoTip.vue'
import DailyUsageChart from '@/components/relay/DailyUsageChart.vue'
import ModelCard from '@/components/user/ModelCard.vue'
import WalletAdjustDialog from '@/components/admin/relay/WalletAdjustDialog.vue'
import RelayKeysPanel from '@/components/user/relay/RelayKeysPanel.vue'
import { resetRelayStatus, useRelayStatus } from '@/composables/useRelayStatus'
import { installMockFetch } from '@/mocks/fetch'
import { relayState, resetRelayMock } from '@/mocks/relay'
import { setMockScenario, type MockScenario } from '@/mocks/state'
import { routes } from '@/router'
import UsageView from '@/views/user/UsageView.vue'

/**
 * `/usage` 积分与用量（WP10b 交付物 2）：
 * 页面级渲染（统计卡 / 图 / 表）、未开通空状态、密钥一次性明文、加/扣积分弹窗的正负号与确认金额。
 *
 * 这里**不 mock 接口模块**，走 `?mock=1` 的假接口（http → mocks），顺手验证契约链路。
 * 弹窗（NModal）内容会传送到 body，断言要查 `document.body`。
 */

const restores: (() => void)[] = []

function useMock(scenario: MockScenario): void {
  resetRelayMock()
  resetRelayStatus()
  setMockScenario(scenario)
  restores.push(installMockFetch(scenario))
}

afterEach(() => {
  while (restores.length > 0) restores.pop()?.()
  setMockScenario('running')
  resetRelayMock()
  resetRelayStatus()
  window.localStorage.clear()
  document.body.innerHTML = ''
})

beforeEach(() => {
  resetRelayStatus()
})

/** 包一层 NMessageProvider（`useMessage` 需要它） */
function withMessages(component: unknown, props: Record<string, unknown> = {}) {
  return defineComponent({
    render: () => h(NMessageProvider, null, { default: () => h(component as never, props) }),
  })
}

async function mountAt(component: unknown, path: string, props: () => Record<string, unknown> = () => ({})) {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  await router.isReady()

  const wrapper = mount(withMessages(component, props()), {
    global: { plugins: [router] },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

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

function modalInput(index = 0): HTMLInputElement {
  const inputs = [...document.body.querySelectorAll<HTMLInputElement>('.n-modal input')]
  expect(inputs.length, '弹窗里应有输入框').toBeGreaterThan(index)
  return inputs[index]!
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value
  input.dispatchEvent(new Event('input'))
  await flushPromises()
}

describe('/usage 积分与用量（12 §10；19 §1 五块重排）', () => {
  it('五块从上到下：积分 → 模型消耗 → 可用模型 → 搜索与抓取 → 使用记录', async () => {
    useMock('running')
    const wrapper = await mountAt(UsageView, '/usage')

    await vi.waitFor(
      () => {
        expect(wrapper.text()).toContain('积分余额')
        expect(wrapper.findAll('.model-chart__hit')).toHaveLength(30)
      },
      { timeout: 5000 },
    )

    const text = wrapper.text()
    // ① 积分：三张统计卡 + 「今日赠送剩余」数据行；顶部不再有红色 NAlert（19 §2.1）
    expect(text).toContain('今日消耗')
    expect(text).toContain('本月消耗')
    expect(wrapper.find('[aria-label="积分余额说明"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="daily-bonus-left"]').text()).toContain('今日赠送剩余')
    expect(wrapper.find('.usage__alert').exists()).toBe(false)
    // ② 模型消耗：筛选条 + 合计 + 自绘图 + 按模型表（19 §2.2）
    expect(text).toContain('模型消耗')
    expect(wrapper.find('[data-testid="usage-filters"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="usage-total"]').exists()).toBe(true)
    expect(wrapper.find('.model-chart__svg').exists()).toBe(true)
    expect(wrapper.find('[data-testid="usage-by-model"]').exists()).toBe(true)
    // ③ 可用模型（价格单位在分组列标题里、模型名可复制）
    expect(text).toContain('可用模型')
    expect(text).toContain('deepseek-v4.1-flash')
    expect(text).toContain('积分 / 百万 token')
    // ④ 搜索与抓取：只剩三格用量
    expect(text).toContain('搜索与抓取')
    expect(text).toContain('本月免费')
    expect(text).toContain('本月调用')
    expect(text).toContain('本月花费')
    expect(text).not.toContain('超出后单价')
    // ⑤ 使用记录
    expect(text).toContain('使用记录')
    // 19 D2 / D3：积分流水不渲染、外接（密钥 / 接入说明）不渲染
    expect(text).not.toContain('积分流水')
    expect(text).not.toContain('新建密钥')
    expect(text).not.toContain('DSH 内置密钥')
    expect(text).not.toContain('接入说明')

    wrapper.unmount()
  })

  it('7 / 30 / 90 天切换会重新拉取（图上列数跟着变）', async () => {
    useMock('running')
    const wrapper = await mountAt(UsageView, '/usage')
    await vi.waitFor(() => expect(wrapper.findAll('.model-chart__hit')).toHaveLength(30), {
      timeout: 5000,
    })

    const ninety = wrapper
      .findAllComponents(NRadioButton)
      .find((radio) => radio.text().includes('90'))
    expect(ninety, '应有 90 天按钮').toBeTruthy()
    await ninety!.find('input').setValue()

    await vi.waitFor(() => expect(wrapper.findAll('.model-chart__hit')).toHaveLength(90), {
      timeout: 5000,
    })
    wrapper.unmount()
  })

  it('可用模型平铺成「模型@渠道」：一行一条渠道，价格按该渠道倍率算死（不再显示区间）', async () => {
    useMock('running')
    const wrapper = await mountAt(UsageView, '/usage')
    await vi.waitFor(() => expect(wrapper.text()).toContain('可用模型'), { timeout: 5000 })
    await vi.waitFor(() => expect(wrapper.text()).toContain('deepseek-v4.1-flash@upstream-b'), {
      timeout: 5000,
    })

    const text = wrapper.text()
    // 同一个 deepseek 模型在 upstream-b（×0.1）与 official（×1）上各是一行、各自一条价格
    expect(text).toContain('deepseek-v4.1-flash@upstream-b')
    expect(text).toContain('deepseek-v4.1-flash@official')
    expect(text).toContain('upstream-b ×0.1')
    expect(text).toContain('official ×1')
    expect(text).toContain('0.1')
    expect(text).toContain('0.2')
    expect(text).toContain('0.01')
    // 只挂一条渠道的模型只出现一行
    expect(text).toContain('qwen3-coder@upstream-b')
    expect(text).not.toContain('qwen3-coder@official')
    // 表头 InfoTip 解释 @
    const tip = wrapper
      .findAllComponents(InfoTip)
      .find((item) => String(item.props('text')).includes('模型名后面的 @'))
    expect(tip, '模型列表头应有 @ 的 InfoTip').toBeTruthy()
    wrapper.unmount()
  })

  it('可用模型表的模型名列：超长「模型@渠道」单行省略，完整名字在 title 里（07 §2.8）', async () => {
    useMock('running')
    const wrapper = await mountAt(UsageView, '/usage')
    await vi.waitFor(() => expect(wrapper.text()).toContain('可用模型'), { timeout: 5000 })
    const longName = 'deepseek-v4.1-flash-preview-2026q4@official'
    await vi.waitFor(() => expect(wrapper.text()).toContain(longName), { timeout: 5000 })

    const cells = wrapper.findAll('.relay-models__cell code')
    const long = cells.find((cell) => cell.text() === longName)
    expect(long, '超长模型名应出现在表里').toBeTruthy()
    expect(long!.classes()).toContain('copy-text__value--truncate')
    expect(long!.attributes('title')).toBe(longName)
    wrapper.unmount()
  })

  it('钱包倍率不是 100% 时，可用模型表上方加一行「你的计费倍率」', async () => {
    useMock('running')
    const seed = (
      relayState() as unknown as { walletSeeds: Map<number, { ratePercent: number }> }
    ).walletSeeds.get(12)!
    seed.ratePercent = 85

    const wrapper = await mountAt(UsageView, '/usage')
    await vi.waitFor(() => expect(wrapper.text()).toContain('可用模型'), { timeout: 5000 })
    await vi.waitFor(() => expect(wrapper.text()).toContain('你的计费倍率 85%'), { timeout: 5000 })
    expect(wrapper.find('[data-testid="wallet-rate"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('使用记录的积分单元格悬停说明含渠道倍率（拿不到倍率的不写）', async () => {
    useMock('running')
    const wrapper = await mountAt(UsageView, '/usage')
    await vi.waitFor(() => expect(wrapper.text()).toContain('使用记录'), { timeout: 5000 })
    await vi.waitFor(() => expect(wrapper.findAll('.usage-log__cost').length).toBeGreaterThan(0), {
      timeout: 5000,
    })

    const titles = wrapper.findAll('.usage-log__cost').map((cell) => cell.attributes('title'))
    expect(titles.some((title) => title?.startsWith('含渠道倍率 ×'))).toBe(true)

    // 16 §4.3：模型列是请求时的原始名字（带 @ 的照原样），渠道列是「slug ×倍率」
    const text = wrapper.text()
    expect(text).toContain('@')
    expect(text).toContain('upstream-b ×0.1')
    expect(wrapper.findAll('.usage-log__channel').length).toBeGreaterThan(0)
    wrapper.unmount()
  })

  it('中转站未开通（?mock=relay-off）：空状态插画 +「中转站未开通」+ 引导，导航也隐藏', async () => {
    useMock('relay-off')
    const wrapper = await mountAt(UsageView, '/usage')

    await vi.waitFor(() => expect(wrapper.text()).toContain('中转站未开通'), { timeout: 5000 })
    expect(wrapper.text()).toContain('请找管理员开通')
    expect(wrapper.text()).not.toContain('每日消耗')
    expect(wrapper.find('.empty-state__art').exists()).toBe(true)

    // UserLayout 的导航判断共用同一个 composable
    await vi.waitFor(() => expect(useRelayStatus().relayEnabled.value).toBe(false), { timeout: 5000 })
    wrapper.unmount()
  })
})

describe('每日消耗柱状图（07 §2.8：提示单行、宽度按内容、精确值走 title）', () => {
  function day(day: string, over: Partial<RelayUsageBucket> = {}): RelayUsageBucket & { day: string } {
    return {
      day,
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicro: 0,
      ...over,
    }
  }

  it('悬停显示当天的积分 / 请求 / token 三行，token 只渲染一个值，精确值在 title', async () => {
    const wrapper = mount(DailyUsageChart, {
      props: {
        daily: [
          day('2026-10-13', { requests: 3, costMicro: 1_500_000, inputTokens: 12_000, outputTokens: 3_000 }),
          day('2026-10-14', {
            requests: 386,
            costMicro: 136_400_000,
            inputTokens: 108_000_000,
            cacheReadTokens: 24_000_000,
            outputTokens: 12_400_000,
          }),
        ],
      },
    })

    expect(wrapper.find('.daily-chart__tip').exists()).toBe(false)
    await wrapper.findAll('.daily-chart__col')[1]!.trigger('mouseenter')

    const tip = wrapper.find('.daily-chart__tip')
    expect(tip.exists()).toBe(true)
    expect(tip.attributes('aria-live')).toBe('polite')

    const rows = tip.findAll('.daily-chart__tip-row')
    expect(rows.map((row) => row.find('span').text())).toEqual(['积分', '请求', 'token'])
    const token = rows[2]!.find('strong')
    expect(token.text()).toBe('1.4亿')
    expect(token.attributes('title')).toBe('144,400,000')
    // 浮层里不再重复一遍精确值（07 §2.7：重复的精确值二选一）
    expect(rows[2]!.findAll('strong')).toHaveLength(1)

    wrapper.unmount()
  })

  it('没有用量的日子不显示提示行以外的内容（0 积分也照常显示）', async () => {
    const wrapper = mount(DailyUsageChart, { props: { daily: [day('2026-10-14')] } })
    expect(wrapper.text()).toContain('这段时间还没有用量')
    await wrapper.findAll('.daily-chart__col')[0]!.trigger('mouseenter')
    expect(wrapper.find('.daily-chart__tip').text()).toContain('0')
    wrapper.unmount()
  })
})

describe('/home「我的模型」卡片：积分一行（12 §10 第 6 条）', () => {
  const SUMMARY = { preset: '默认预设', defaultModel: 'deepseek-v4.1-flash', providers: ['Hub 中转站'] }

  it('开通时显示余额与本月消耗，并链到 /usage', () => {
    const wrapper = mount(ModelCard, {
      props: { summary: SUMMARY, points: { balanceMicro: 8_660_000, monthCostMicro: 1_300_000 } },
      global: { stubs: { RouterLink: { template: '<a :href="to"><slot /></a>', props: ['to'] } } },
    })

    // 两组「标签 + 值」各自不断行，组之间才允许换行（07 §2.8）
    expect(wrapper.text()).toContain('积分余额 8.66')
    expect(wrapper.text()).toContain('本月已用 1.30')
    expect(wrapper.findAll('.model-card__points-text > span')).toHaveLength(2)
    expect(wrapper.get('a').attributes('href')).toBe('/usage')
    wrapper.unmount()
  })

  it('未开通（points = null）时不显示这一行', () => {
    const wrapper = mount(ModelCard, { props: { summary: SUMMARY, points: null } })
    expect(wrapper.text()).not.toContain('积分余额')
    wrapper.unmount()
  })

  it('统一管理时提供方胶囊显示「DSH Hub」（WP13：DSH_HUB_PROVIDER_NAME）', () => {
    const wrapper = mount(ModelCard, { props: { summary: SUMMARY, points: null } })
    expect(wrapper.text()).toContain('DSH Hub')
    expect(wrapper.text()).not.toContain('Hub 中转站')
    wrapper.unmount()
  })
})

describe('API 密钥：明文只显示一次', () => {
  const KEYS: RelayKey[] = [
    {
      id: 1,
      kind: 'system',
      name: 'DSH 内置密钥',
      preview: 'sk-dsh-7f3ac2…c91d',
      enabled: true,
      lastUsedAt: null,
      createdAt: '2026-09-01T00:00:00.000Z',
    },
  ]

  function mountKeys() {
    useMock('running')
    return mount(withMessages(RelayKeysPanel, { keys: KEYS }), { attachTo: document.body })
  }

  it('新建后弹出明文；关掉弹窗后页面上再也找不到它', async () => {
    const wrapper = mountKeys()

    await clickBodyButton('新建密钥')
    await typeInto(modalInput(), 'CI 机器人')
    await clickBodyButton('创建')

    await vi.waitFor(() => expect(document.body.textContent).toContain('这是你的新密钥（只显示这一次）'), {
      timeout: 5000,
    })
    const secretMatch = /sk-dsh-[A-Za-z0-9]{40}/.exec(document.body.textContent ?? '')
    expect(secretMatch, '一次性弹窗里应有完整明文').toBeTruthy()
    const secret = secretMatch?.[0] ?? ''
    expect(document.body.textContent).toContain('关闭后无法再次查看')

    await clickBodyButton('我已保存')
    await flushPromises()

    // 弹窗容器在 jsdom 里不会真的被移除（过渡事件不触发），但明文必须已经销毁：
    // 一次性弹窗只在内存里留过那一份，关掉后页面上再也找不到它（列表里只有 preview）
    expect(document.body.textContent).not.toContain(secret)
    expect(document.body.textContent).toContain('关闭后无法再次查看')
    wrapper.unmount()
  })

  it('DSH 内置密钥只能重置：二次确认里说明要重启 DSH', async () => {
    const wrapper = mountKeys()

    await clickBodyButton('重置')
    await nextTick()

    expect(document.body.textContent).toContain('重置后需要重启 DSH 才生效')
    expect(
      [...document.body.querySelectorAll('button')].some((b) => b.textContent?.trim() === '确认重置'),
    ).toBe(true)
    wrapper.unmount()
  })
})

describe('加 / 扣积分弹窗（12 §10 积分 Tab 与用户详情共用）', () => {
  const WALLET: RelayWalletRow = {
    userId: 2,
    username: 'mint',
    displayName: '薄荷茶',
    avatarUrl: null,
    balanceMicro: 42_180_000,
    ratePercent: 100,
    maxConcurrency: null,
    dailyLimitMicro: null,
    enabled: true,
    totalSpentMicro: 0,
    lastUsedAt: null,
    todayCostMicro: 0,
    monthCostMicro: 0,
    monthRequests: 0,
  }

  function mountDialog() {
    return mount(withMessages(WalletAdjustDialog, { show: true, wallet: WALLET }), {
      attachTo: document.body,
    })
  }

  it('正数：确认步骤显示 +金额与调整后的余额', async () => {
    const wrapper = mountDialog()
    await typeInto(modalInput(), '7.82')

    await clickBodyButton('下一步')
    expect(document.body.textContent).toContain('确认调整')
    expect(document.body.textContent).toContain('+7.82')
    // 42.18 + 7.82 = 50.00
    expect(document.body.textContent).toContain('50.00')
    wrapper.unmount()
  })

  it('负数：显示 -金额、调整后余额变小；0 与非法输入被挡住', async () => {
    const wrapper = mountDialog()
    await typeInto(modalInput(), '-2.18')
    await clickBodyButton('下一步')

    expect(document.body.textContent).toContain('-2.18')
    expect(document.body.textContent).toContain('40.00')

    await clickBodyButton('返回修改')
    await typeInto(modalInput(), '0')
    await clickBodyButton('下一步')
    expect(document.body.textContent).toContain('金额不能是 0')

    await typeInto(modalInput(), 'abc')
    await clickBodyButton('下一步')
    expect(document.body.textContent).toContain('金额得是数字')
    wrapper.unmount()
  })

  it('确认后真的调接口：余额变化 + 写流水（走假接口）', async () => {
    useMock('admin')
    const wrapper = mountDialog()

    await typeInto(modalInput(), '5')
    await clickBodyButton('下一步')
    await clickBodyButton('确认调整')
    await flushPromises()

    const response = await fetch('/api/admin/relay/wallets/2')
    const payload = (await response.json()) as { wallet: RelayWalletRow }
    expect(payload.wallet.balanceMicro).toBe(WALLET.balanceMicro + 5_000_000)

    const ledger = await fetch('/api/admin/relay/ledger?userId=2')
    const rows = (await ledger.json()) as { items: { note: string; amountMicro: number }[] }
    expect(rows.items[0]?.amountMicro).toBe(5_000_000)
    wrapper.unmount()
  })
})
