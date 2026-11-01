import type {
  InstanceSummary,
  MyComputeResponse,
  MyInstanceResponse,
  MyRelayModel,
  MyRelayResponse,
  UserPublic,
} from '@dsh-hub/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { NDialogProvider, NMessageProvider } from 'naive-ui'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import { fetchMyCompute } from '@/api/compute'
import { createExport, estimateExport, listExports, removeExport } from '@/api/exports'
import { fetchMyInstance } from '@/api/instance'
import { fetchMyPlugins } from '@/api/plugins'
import { fetchMyRelay } from '@/api/relay'
import { resetRelayStatus } from '@/composables/useRelayStatus'
import { routes } from '@/router'
import HomeModelsSection from '@/components/user/home/HomeModelsSection.vue'
import InstanceMainCard from '@/components/user/InstanceMainCard.vue'
import { useAuthStore } from '@/stores/auth'
import HomeView from '@/views/user/HomeView.vue'

vi.mock('@/api/instance', () => ({
  fetchMyInstance: vi.fn(),
  startInstance: vi.fn(),
  stopInstance: vi.fn(),
  restartInstance: vi.fn(),
  MY_INSTANCE_EVENTS_URL: '/api/me/instance/events',
}))
vi.mock('@/api/plugins', () => ({
  fetchMyPlugins: vi.fn(),
  installMyPlugin: vi.fn(),
  uninstallMyPlugin: vi.fn(),
}))
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
 * 工作台区块顺序 / 锚点（15 §2.1）、我的模型过滤与默认标签（15 §2.2）、
 * 头像状态环的 class（15 §2.5）。接口全部走 mock，不连后端。
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

const COMPUTE_OFF: MyComputeResponse = {
  billingEnabled: false,
  exempt: false,
  plans: [],
  selectedPlanId: null,
  lease: null,
  balanceMicro: 0,
  dailyBonusLeftMicro: 0,
  dailyBonusMicro: 0,
  blockMinutes: 10,
  graceMinutes: 10,
  contactText: '',
}

const MODEL_SUMMARY = {
  policy: 'managed' as const,
  preset: 'Hub 中转站',
  defaultModel: 'deepseek-v4.1-flash',
  providers: ['DSH Hub'],
}

function instanceResponse(status: InstanceSummary['status']): MyInstanceResponse {
  return {
    instance: {
      status,
      runtimeVersion: '0.9.4',
      startedAt: status === 'running' ? '2026-10-12T09:47:00.000Z' : null,
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
    modelSummary: MODEL_SUMMARY,
  }
}

function relayResponse(models: MyRelayModel[], ratePercent = 100): MyRelayResponse {
  return {
    enabled: true,
    wallet: {
      userId: USER.id,
      balanceMicro: 12_345_000,
      ratePercent,
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
      costMicro: 2_000_000,
    },
    publicBaseUrl: 'https://hub.example.com/v1',
    dshAttached: true,
    models,
  }
}

const MODEL = (overrides: Partial<MyRelayModel> & Pick<MyRelayModel, 'name'>): MyRelayModel => ({
  displayName: overrides.name,
  apis: ['openai-completions'],
  price: {
    inputMicro: 500_000,
    outputMicro: 1_000_000,
    cacheReadMicro: 50_000,
    cacheWriteMicro: 500_000,
    perRequestMicro: 0,
  },
  channelRate: { minPermille: 1000, maxPermille: 1000 },
  info: { contextWindow: 131_072, maxTokens: 8192, input: ['text'] },
  ...overrides,
})

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
  vi.mocked(fetchMyPlugins).mockReset()
  vi.mocked(listExports).mockReset()
  vi.mocked(createExport).mockReset()
  vi.mocked(estimateExport).mockReset()
  vi.mocked(removeExport).mockReset()
  vi.mocked(fetchMyCompute).mockReset()
  vi.mocked(fetchMyRelay).mockReset()

  vi.mocked(fetchMyInstance).mockResolvedValue(instanceResponse('running'))
  vi.mocked(fetchMyCompute).mockResolvedValue(COMPUTE_OFF)
  vi.mocked(fetchMyPlugins).mockResolvedValue({ items: [] })
  vi.mocked(estimateExport).mockResolvedValue({ parts: {}, totalBytes: 0 })
  vi.mocked(listExports).mockResolvedValue({ items: [] })
  vi.mocked(fetchMyRelay).mockResolvedValue(relayResponse([]))
})

describe('工作台区块顺序与锚点（15 §2.1）', () => {
  it('依次是 我的 DSH → 我的模型 → 我的插件 → 我的数据，id 可被旧链接定位', async () => {
    const wrapper = await mountHome()

    const sections = wrapper.findAll('[data-testid^="home-section-"]')
    expect(sections.map((section) => section.attributes('data-testid'))).toEqual([
      'home-section-dsh',
      'home-section-models',
      'home-section-plugins',
      'home-section-data',
    ])
    expect(sections.map((section) => section.attributes('id'))).toEqual(['dsh', 'models', 'plugins', 'data'])

    expect(wrapper.get('#plugins').text()).toContain('我的插件')
    expect(wrapper.get('#data').text()).toContain('我的数据')
    // 工作台不再出现旧「个人中心 → 数据导出」卡片
    expect(wrapper.text()).not.toContain('去导出')
    wrapper.unmount()
  })
})

describe('我的模型（15 §2.2）', () => {
  it('统一管理且带 inDsh 时只列 inDsh === true；dshDefault 优先做默认标签', () => {
    const wrapper = mount(HomeModelsSection, {
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
      props: {
        summary: MODEL_SUMMARY,
        relay: relayResponse([
          MODEL({ name: 'deepseek-v4.1-flash', inDsh: true, dshDefault: true }),
          MODEL({ name: 'not-delivered', inDsh: false }),
          MODEL({
            name: 'claude-sonnet-4.6',
            inDsh: true,
            dshDefault: false,
            channelRate: { minPermille: 800, maxPermille: 1200 },
          }),
        ]),
      },
    })

    const rows = wrapper.findAll('[data-testid="home-model-row"]')
    expect(rows.map((row) => row.attributes('data-model'))).toEqual([
      'deepseek-v4.1-flash',
      'claude-sonnet-4.6',
    ])
    expect(rows[0]?.find('[data-testid="home-model-default"]').exists()).toBe(true)
    expect(rows[1]?.find('[data-testid="home-model-default"]').exists()).toBe(false)
    // 价格按渠道倍率显示：区间用 –，缓存读同输入
    expect(rows[1]?.text()).toContain('0.4–0.6')
    wrapper.unmount()
  })

  it('没有 inDsh 字段时列全部；默认标签退回名字比较', () => {
    const wrapper = mount(HomeModelsSection, {
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
      props: {
        summary: MODEL_SUMMARY,
        relay: relayResponse([MODEL({ name: 'deepseek-v4.1-flash' }), MODEL({ name: 'deepseek-v3' })]),
      },
    })

    const rows = wrapper.findAll('[data-testid="home-model-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.find('[data-testid="home-model-default"]').exists()).toBe(true)
    expect(rows[1]?.find('[data-testid="home-model-default"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('钱包倍率不是 100% 时显示「你的价格为标价的 N%」', () => {
    const wrapper = mount(HomeModelsSection, {
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
      props: {
        summary: MODEL_SUMMARY,
        relay: relayResponse([MODEL({ name: 'deepseek-v4.1-flash', inDsh: true, dshDefault: true })], 85),
      },
    })

    expect(wrapper.get('[data-testid="home-wallet-rate"]').text()).toContain('你的价格为标价的 85%')
    wrapper.unmount()
  })

  it('中转站未开通：只显示默认模型和提供方', () => {
    const wrapper = mount(HomeModelsSection, {
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
      props: { summary: MODEL_SUMMARY, relay: null },
    })

    expect(wrapper.text()).toContain('deepseek-v4.1-flash')
    expect(wrapper.text()).toContain('DSH Hub')
    expect(wrapper.find('[data-testid="home-model-row"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('头像状态环（15 §2.5）', () => {
  const baseInstance = (status: InstanceSummary['status']): InstanceSummary => ({
    status,
    runtimeVersion: '0.9.4',
    startedAt: null,
    lastActiveAt: null,
    needsRecreate: false,
    error: null,
    openUrl: '/dsh/littletao/',
  })

  it.each([
    ['running', 'avatar-status--running'],
    ['starting', 'avatar-status--busy'],
    ['stopping', 'avatar-status--busy'],
    ['stopped', 'avatar-status--stopped'],
    ['absent', 'avatar-status--stopped'],
    ['error', 'avatar-status--error'],
  ] as const)('%s → %s', (status, className) => {
    const wrapper = mount(InstanceMainCard, {
      props: { instance: baseInstance(status), displayName: '小桃', avatarSeed: 'u7k2m9xr' },
    })

    const ring = wrapper.get('[data-testid^="avatar-status-"]')
    expect(ring.classes()).toContain(className)
    // 头像本身也在（没有头像图时用昵称首字）
    expect(ring.text()).toContain('小')
    wrapper.unmount()
  })
})
