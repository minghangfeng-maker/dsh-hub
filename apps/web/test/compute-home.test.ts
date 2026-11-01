import type {
  ComputeLease,
  MyComputePlan,
  MyComputeResponse,
  MyInstanceResponse,
  MyRelayResponse,
  UserPublic,
} from '@dsh-hub/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { NDialogProvider, NMessageProvider } from 'naive-ui'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import { fetchMyCompute, selectMyComputePlan } from '@/api/compute'
import { createExport, estimateExport, listExports, removeExport } from '@/api/exports'
import { fetchMyInstance, startInstance, stopInstance, restartInstance } from '@/api/instance'
import { fetchMyPlugins } from '@/api/plugins'
import { fetchMyRelay } from '@/api/relay'
import { resetRelayStatus } from '@/composables/useRelayStatus'
import { routes } from '@/router'
import ComputeBalanceBar from '@/components/user/compute/ComputeBalanceBar.vue'
import ComputeLeasePanel from '@/components/user/compute/ComputeLeasePanel.vue'
import ComputePlans from '@/components/user/compute/ComputePlans.vue'
import { useAuthStore } from '@/stores/auth'
import HomeView from '@/views/user/HomeView.vue'

vi.mock('@/api/instance', () => ({
  fetchMyInstance: vi.fn(),
  startInstance: vi.fn(),
  stopInstance: vi.fn(),
  restartInstance: vi.fn(),
  MY_INSTANCE_EVENTS_URL: '/api/me/instance/events',
}))
vi.mock('@/api/plugins', () => ({ fetchMyPlugins: vi.fn() }))
vi.mock('@/api/exports', () => ({
  createExport: vi.fn(),
  estimateExport: vi.fn(),
  listExports: vi.fn(),
  removeExport: vi.fn(),
  exportDownloadUrl: (id: number) => `/api/me/exports/${id}/download`,
  exportEventsUrl: (id: number) => `/api/me/exports/${id}/events`,
}))
vi.mock('@/api/compute', () => ({
  fetchMyCompute: vi.fn(),
  selectMyComputePlan: vi.fn(),
  listMyComputeLeases: vi.fn(),
}))
vi.mock('@/api/relay', () => ({ fetchMyRelay: vi.fn() }))

/**
 * 工作台算力租赁（13 §7，15 §2.1 改版）：当前配置行、切换配置弹窗、运行中先确认、
 * 余额不足禁用启动、计费关闭时不显示切换入口、管理员免计费。
 */

const USER: UserPublic = {
  id: 12,
  slug: 'u7k2m9xr',
  username: 'littletao',
  displayName: '小桃',
  bio: '',
  avatarUrl: null,
  role: 'user',
  status: 'active',
  mustChangePassword: false,
  createdAt: '2026-09-01T02:10:00.000Z',
  lastLoginAt: '2026-10-12T05:30:00.000Z',
  usernameChangedAt: null,
}

const PLANS: MyComputePlan[] = [
  {
    id: 'c2m4',
    name: '2 核 4 GB',
    cpus: 2,
    memoryMb: 4096,
    pricePerHourMicro: 300_000,
    blockPriceMicro: 50_000,
    custom: false,
  },
  {
    id: 'c4m8',
    name: '4 核 8 GB',
    cpus: 4,
    memoryMb: 8192,
    pricePerHourMicro: 500_000,
    blockPriceMicro: 83_334,
    custom: false,
  },
  {
    id: 'custom-16c',
    name: '16 核 32 GB',
    cpus: 16,
    memoryMb: 32_768,
    pricePerHourMicro: 2_000_000,
    blockPriceMicro: 333_334,
    custom: true,
  },
]

function computeResponse(overrides: Partial<MyComputeResponse> = {}): MyComputeResponse {
  return {
    billingEnabled: true,
    exempt: false,
    plans: PLANS,
    selectedPlanId: 'c2m4',
    lease: null,
    balanceMicro: 2_400_000,
    dailyBonusLeftMicro: 600_000,
    dailyBonusMicro: 600_000,
    blockMinutes: 10,
    graceMinutes: 10,
    contactText: '需要更高配置？请联系管理员定制。',
    ...overrides,
  }
}

function makeLease(overrides: Partial<ComputeLease> = {}): ComputeLease {
  const now = Date.now()
  return {
    id: 1,
    userId: USER.id,
    planId: 'c4m8',
    planName: '4 核 8 GB',
    cpus: 4,
    memoryMb: 8192,
    pricePerHourMicro: 500_000,
    blockPriceMicro: 83_334,
    billed: true,
    startedAt: new Date(now - 25 * 60_000).toISOString(),
    paidUntil: new Date(now + 5 * 60_000).toISOString(),
    graceUntil: null,
    endedAt: null,
    endReason: null,
    blocks: 3,
    chargedMicro: 250_002,
    ...overrides,
  }
}

function instanceResponse(status: MyInstanceResponse['instance']['status']): MyInstanceResponse {
  return {
    instance: {
      status,
      runtimeVersion: '0.9.4',
      startedAt: status === 'running' ? new Date(Date.now() - 25 * 60_000).toISOString() : null,
      lastActiveAt: '2026-10-12T11:56:00.000Z',
      needsRecreate: false,
      error: null,
      openUrl: '/dsh/littletao/',
    },
    quota: {
      cpus: 2,
      memoryMb: 4096,
      pidsLimit: 512,
      diskGb: 20,
      idleStopMinutes: 60,
      idleNoClientMinutes: 30,
      allowUserPlugins: true,
    },
    stats: null,
    modelSummary: {
      policy: 'managed',
      preset: '默认预设',
      defaultModel: 'deepseek-v4.1-flash',
      providers: ['DSH Hub'],
    },
  }
}

function relayOff(): MyRelayResponse {
  return {
    enabled: false,
    wallet: {
      userId: USER.id,
      balanceMicro: 0,
      ratePercent: 100,
      maxConcurrency: null,
      dailyLimitMicro: null,
      enabled: true,
      totalSpentMicro: 0,
      lastUsedAt: null,
    },
    today: {
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicro: 0,
    },
    month: {
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicro: 0,
    },
    publicBaseUrl: 'https://hub.example.com/v1',
    dshAttached: false,
    models: [],
  }
}

async function mountHome() {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/home')
  await router.isReady()

  const pinia = createPinia()
  useAuthStore(pinia).setUser(USER)

  const Host = defineComponent({
    components: { HomeView, NMessageProvider, NDialogProvider },
    template: '<NMessageProvider><NDialogProvider><HomeView /></NDialogProvider></NMessageProvider>',
  })

  const wrapper = mount(Host, { global: { plugins: [pinia, router] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  window.localStorage.clear()
  resetRelayStatus()
  vi.mocked(fetchMyInstance).mockReset()
  vi.mocked(startInstance).mockReset()
  vi.mocked(stopInstance).mockReset()
  vi.mocked(restartInstance).mockReset()
  vi.mocked(fetchMyPlugins).mockReset()
  vi.mocked(listExports).mockReset()
  vi.mocked(createExport).mockReset()
  vi.mocked(estimateExport).mockReset()
  vi.mocked(removeExport).mockReset()
  vi.mocked(fetchMyCompute).mockReset()
  vi.mocked(selectMyComputePlan).mockReset()
  vi.mocked(fetchMyRelay).mockReset()

  vi.mocked(fetchMyPlugins).mockResolvedValue({ items: [] })
  vi.mocked(estimateExport).mockResolvedValue({ parts: {}, totalBytes: 0 })
  vi.mocked(listExports).mockResolvedValue({ items: [] })
  vi.mocked(fetchMyRelay).mockResolvedValue(relayOff())
  vi.mocked(fetchMyInstance).mockResolvedValue(instanceResponse('stopped'))
})

describe('规格卡片 ComputePlans（13 §7.1）', () => {
  it('显示名称 / N 核 / 价格 / 每 10 分钟 / 定制标，选中项高亮', () => {
    const wrapper = mount(ComputePlans, {
      props: { plans: PLANS, selectedPlanId: 'c4m8', contactText: '需要更高配置请联系管理员' },
    })

    const text = wrapper.text()
    expect(text).toContain('2 核 4 GB')
    expect(text).toContain('每 10 分钟 0.05')
    expect(text).toContain('16 核 32 GB')
    expect(text).toContain('定制')
    expect(text).toContain('需要更高配置请联系管理员')

    expect(wrapper.get('[data-testid="compute-plan-c4m8"]').attributes('data-selected')).toBe('true')
    expect(wrapper.get('[data-testid="compute-plan-c2m4"]').attributes('data-selected')).toBe('false')
  })

  it('点另一张卡片 → 发出 select（选中项自己不发）', async () => {
    const wrapper = mount(ComputePlans, { props: { plans: PLANS, selectedPlanId: 'c2m4' } })

    await wrapper.get('[data-testid="compute-plan-c2m4"]').trigger('click')
    expect(wrapper.emitted('select')).toBeUndefined()

    await wrapper.get('[data-testid="compute-plan-c4m8"]').trigger('click')
    expect(wrapper.emitted('select')).toHaveLength(1)
    expect(wrapper.emitted('select')?.[0]).toEqual(['c4m8'])
  })
})

describe('余额条与启动按钮（13 §7.2 §7.4）', () => {
  it('余额 < 一块：红色「余额不足，无法启动」', () => {
    const wrapper = mount(ComputeBalanceBar, {
      props: {
        balanceMicro: 20_000,
        blockPriceMicro: 50_000,
        dailyBonusMicro: 600_000,
        dailyBonusLeftMicro: 0,
      },
    })
    expect(wrapper.get('[data-testid="compute-insufficient"]').text()).toBe('余额不足，无法启动')
    expect(wrapper.get('[data-testid="compute-balance-value"]').text()).toBe('0.02')
  })

  it('余额充足：不出现余额不足；今日赠送显示 min(赠送, 余额)', () => {
    const wrapper = mount(ComputeBalanceBar, {
      props: {
        balanceMicro: 2_400_000,
        blockPriceMicro: 50_000,
        dailyBonusMicro: 600_000,
        dailyBonusLeftMicro: 600_000,
      },
    })
    expect(wrapper.find('[data-testid="compute-insufficient"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="compute-daily-bonus"]').text()).toContain('今日赠送剩余 0.6')
  })

  it('管理员免租：显示「管理员账号不计费」，余额再少也不报不足', () => {
    const wrapper = mount(ComputeBalanceBar, {
      props: { balanceMicro: 0, blockPriceMicro: 50_000, exempt: true },
    })
    expect(wrapper.get('[data-testid="compute-exempt"]').text()).toContain('管理员账号不计费')
    expect(wrapper.find('[data-testid="compute-insufficient"]').exists()).toBe(false)
  })

  it('工作台：余额不足时主按钮「打开 DSH」禁用（仍以接口 402 为准）', async () => {
    vi.mocked(fetchMyCompute).mockResolvedValue(
      computeResponse({ balanceMicro: 20_000, dailyBonusMicro: 0, dailyBonusLeftMicro: 0 }),
    )

    const wrapper = await mountHome()
    expect(wrapper.find('[data-testid="compute-insufficient"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="instance-primary"]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
})

describe('运行中的租约与宽限倒计时（13 §7.3）', () => {
  const fixedNow = new Date('2026-10-18T12:00:00.000Z').getTime()

  it('显示规格、已运行、已扣与下次扣费', () => {
    const lease = makeLease({
      startedAt: new Date(fixedNow - 65 * 60_000).toISOString(),
      paidUntil: new Date(fixedNow + 5 * 60_000).toISOString(),
      chargedMicro: 500_004,
    })
    const wrapper = mount(ComputeLeasePanel, { props: { lease, now: fixedNow } })

    expect(wrapper.get('[data-testid="compute-lease-plan"]').text()).toBe('4 核 8 GB')
    expect(wrapper.get('[data-testid="compute-lease-uptime"]').text()).toBe('1 小时 5 分')
    expect(wrapper.get('[data-testid="compute-lease-charged"]').text()).toContain('0.5')
    expect(wrapper.get('[data-testid="compute-lease-next"]').text()).toMatch(/^\d{2}:\d{2}$/)
    expect(wrapper.find('[data-testid="compute-grace"]').exists()).toBe(false)
  })

  it('宽限中：醒目横幅 + 倒计时随时间减少（假时钟）', async () => {
    const graceUntil = new Date(fixedNow + 7 * 60_000).toISOString()
    const lease = makeLease({
      graceUntil,
      paidUntil: new Date(fixedNow - 12 * 60_000).toISOString(),
    })
    const wrapper = mount(ComputeLeasePanel, { props: { lease, now: fixedNow } })

    expect(wrapper.get('[data-testid="compute-grace"]').text()).toContain('余额不足，将于')
    expect(wrapper.get('[data-testid="compute-grace"]').text()).toContain('请联系管理员充值')
    expect(wrapper.get('[data-testid="compute-grace-countdown"]').text()).toBe('07:00')

    await wrapper.setProps({ now: fixedNow + 60_000 })
    expect(wrapper.get('[data-testid="compute-grace-countdown"]').text()).toBe('06:00')

    await wrapper.setProps({ now: fixedNow + 8 * 60_000 })
    expect(wrapper.get('[data-testid="compute-grace-countdown"]').text()).toBe('00:00')
  })

  it('免费租约：写「本次不计费」，没有下次扣费', () => {
    const lease = makeLease({ billed: false, paidUntil: null, blocks: 0, chargedMicro: 0 })
    const wrapper = mount(ComputeLeasePanel, { props: { lease, now: fixedNow } })

    expect(wrapper.get('[data-testid="compute-lease-free"]').text()).toBe('本次不计费')
    expect(wrapper.find('[data-testid="compute-lease-next"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="compute-lease-state-free"]').text()).toBe('免费')
  })
})

describe('当前配置行（15 §2.1）', () => {
  it('计费开启、未运行：显示选中规格与价格，可切换配置', async () => {
    vi.mocked(fetchMyCompute).mockResolvedValue(computeResponse())

    const wrapper = await mountHome()
    const line = wrapper.get('[data-testid="instance-current-plan"]')
    expect(line.text()).toContain('当前配置 2 核 / 4 GB')
    expect(line.text()).toContain('0.3 积分/小时')
    expect(line.text()).toContain('每 10 分钟 0.05')
    expect(wrapper.find('[data-testid="instance-switch-plan"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('计费开启、运行中：用租约规格快照（不是 selectedPlanId），并显示余额条与租约', async () => {
    vi.mocked(fetchMyInstance).mockResolvedValue(instanceResponse('running'))
    vi.mocked(fetchMyCompute).mockResolvedValue(
      computeResponse({ selectedPlanId: 'c2m4', lease: makeLease() }),
    )

    const wrapper = await mountHome()
    const line = wrapper.get('[data-testid="instance-current-plan"]')
    expect(line.text()).toContain('当前配置 4 核 / 8 GB')
    expect(line.text()).toContain('0.5 积分/小时')
    expect(wrapper.find('[data-testid="compute-balance"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="compute-lease"]').exists()).toBe(true)
    // 改版后不再有独立的「算力租赁」大区块
    expect(wrapper.text()).not.toContain('算力租赁')
    wrapper.unmount()
  })

  it('计费关闭：显示 Quota 规格与「暂不计费」，不显示切换配置', async () => {
    vi.mocked(fetchMyCompute).mockResolvedValue(
      computeResponse({ billingEnabled: false, plans: [], selectedPlanId: null }),
    )

    const wrapper = await mountHome()
    const line = wrapper.get('[data-testid="instance-current-plan"]')
    expect(line.text()).toContain('当前配置 2 核 / 4 GB · 暂不计费')
    expect(wrapper.find('[data-testid="instance-switch-plan"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="compute-balance"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('管理员免计费：价格后加「（管理员免计费）」', async () => {
    vi.mocked(fetchMyCompute).mockResolvedValue(computeResponse({ exempt: true }))

    const wrapper = await mountHome()
    const line = wrapper.get('[data-testid="instance-current-plan"]')
    expect(line.text()).toContain('（管理员免计费）')
    expect(wrapper.find('[data-testid="compute-exempt"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('没有可选规格：显示暂无可选规格、无切换入口、启动禁用', async () => {
    vi.mocked(fetchMyCompute).mockResolvedValue(computeResponse({ plans: [], selectedPlanId: null }))

    const wrapper = await mountHome()
    expect(wrapper.get('[data-testid="instance-current-plan"]').text()).toContain('暂无可选规格')
    expect(wrapper.find('[data-testid="instance-switch-plan"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="instance-primary"]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
})

describe('切换配置弹窗（15 §2.1）', () => {
  it('停止中：选规格直接发请求，不弹确认框，成功后关闭弹窗', async () => {
    vi.mocked(fetchMyCompute).mockResolvedValue(computeResponse())
    vi.mocked(selectMyComputePlan).mockResolvedValue({
      compute: computeResponse({ selectedPlanId: 'c4m8' }),
      restarted: false,
    })

    const wrapper = await mountHome()
    await wrapper.get('[data-testid="instance-switch-plan"]').trigger('click')
    await flushPromises()

    expect(document.body.textContent).toContain('切换配置')
    ;[...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('4 核 8 GB'))
      ?.click()
    await flushPromises()

    expect(selectMyComputePlan).toHaveBeenCalledWith('c4m8')
    expect(document.body.textContent).not.toContain('将按新规格重启，并开始按新价格计费')
    wrapper.unmount()
  })

  it('运行中：先弹 13 §7 的确认框，确认后才发请求并刷新实例', async () => {
    vi.mocked(fetchMyInstance).mockResolvedValue(instanceResponse('running'))
    vi.mocked(fetchMyCompute).mockResolvedValue(computeResponse({ lease: makeLease() }))
    vi.mocked(selectMyComputePlan).mockResolvedValue({
      compute: computeResponse({ selectedPlanId: 'c4m8', lease: makeLease({ planId: 'c4m8' }) }),
      restarted: true,
    })

    const wrapper = await mountHome()
    await wrapper.get('[data-testid="instance-switch-plan"]').trigger('click')
    await flushPromises()

    ;[...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('4 核 8 GB'))
      ?.click()
    await flushPromises()

    expect(document.body.textContent).toContain('将按新规格重启，并开始按新价格计费')
    expect(selectMyComputePlan).not.toHaveBeenCalled()

    const positive = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('切换并重启'),
    )
    positive?.click()
    await flushPromises()

    expect(selectMyComputePlan).toHaveBeenCalledWith('c4m8')
    wrapper.unmount()
  })
})
