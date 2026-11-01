import type { MyInstanceResponse, UserPublic } from '@dsh-hub/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { NDialogProvider, NMessageProvider } from 'naive-ui'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import { fetchMyCompute } from '@/api/compute'
import { fetchMyInstance, startInstance, stopInstance, restartInstance } from '@/api/instance'
import { fetchMyPlugins } from '@/api/plugins'
import { createExport, estimateExport, listExports, removeExport } from '@/api/exports'
import { fetchMyRelay } from '@/api/relay'
import { resetRelayStatus } from '@/composables/useRelayStatus'
import { routes } from '@/router'
import { useAuthStore } from '@/stores/auth'
import HomeView from '@/views/user/HomeView.vue'

vi.mock('@/api/instance', () => ({
  fetchMyInstance: vi.fn(),
  startInstance: vi.fn(),
  stopInstance: vi.fn(),
  restartInstance: vi.fn(),
  MY_INSTANCE_EVENTS_URL: '/api/me/instance/events',
}))

vi.mock('@/api/compute', () => ({
  fetchMyCompute: vi.fn(),
  selectMyComputePlan: vi.fn(),
  listMyComputeLeases: vi.fn(),
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
vi.mock('@/api/relay', () => ({ fetchMyRelay: vi.fn() }))

/**
 * 工作台页面级交互（任务书「测试」节）：
 * 「打开 DSH」在未运行时的完整流程 —— 同步开占位标签 → start → 就绪后改 location。
 * 用 `vi.mock` 把接口换掉，页面其余部分走真实实现。
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

const OPEN_URL = '/dsh/littletao/'

function instanceResponse(status: MyInstanceResponse['instance']['status']): MyInstanceResponse {
  return {
    instance: {
      status,
      runtimeVersion: '0.9.4',
      startedAt: status === 'running' ? '2026-10-12T09:47:00.000Z' : null,
      lastActiveAt: '2026-10-12T11:56:00.000Z',
      needsRecreate: false,
      error: null,
      openUrl: OPEN_URL,
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
      defaultModel: 'deepseek-chat',
      providers: ['DeepSeek'],
    },
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
  vi.mocked(fetchMyRelay).mockReset()

  // 默认计费关闭：工作台与改版前一致（算力租赁整块不出现）
  vi.mocked(fetchMyCompute).mockResolvedValue({
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
  })
  vi.mocked(fetchMyPlugins).mockResolvedValue({ items: [] })
  vi.mocked(estimateExport).mockResolvedValue({ parts: {}, totalBytes: 0 })
  vi.mocked(listExports).mockResolvedValue({ items: [] })
  vi.mocked(fetchMyRelay).mockResolvedValue({
    enabled: false,
    wallet: {
      userId: 12,
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
  })
})

describe('我的工作台 /home（07 §6.1）', () => {
  it('渲染问候、主卡与次级卡', async () => {
    vi.mocked(fetchMyInstance).mockResolvedValue(instanceResponse('running'))

    const wrapper = await mountHome()

    expect(wrapper.text()).toContain('小桃')
    expect(wrapper.text()).toContain('我的 DSH')
    expect(wrapper.text()).toContain('打开 DSH')
    expect(wrapper.text()).toContain('运行中')
    expect(wrapper.text()).toContain('我的模型')
    expect(wrapper.text()).toContain('deepseek-chat')
    expect(wrapper.text()).toContain('我的插件')
    expect(wrapper.text()).toContain('我的数据')
    wrapper.unmount()
  })

  it('未运行：点「打开 DSH」→ 同步开占位页 → start → 就绪后跳转（mock API）', async () => {
    let polls = 0
    vi.mocked(fetchMyInstance).mockImplementation(async () => {
      polls += 1
      return instanceResponse(polls >= 3 ? 'running' : 'stopped')
    })
    vi.mocked(startInstance).mockResolvedValue({ instance: instanceResponse('starting').instance })

    const tab = { location: { href: '' }, document: null }
    const openWindow = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)

    const wrapper = await mountHome()
    expect(wrapper.get('[data-testid="instance-primary"]').text()).toContain('打开 DSH')

    await wrapper.get('[data-testid="instance-primary"]').trigger('click')
    await flushPromises()

    await vi.waitFor(
      () => {
        expect(tab.location.href).toBe(OPEN_URL)
      },
      { timeout: 3000 },
    )

    expect(openWindow).toHaveBeenCalledWith('about:blank', '_blank')
    expect(startInstance).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('已经打开了')
    })
    // 顺利打开时不需要手动兜底链接
    expect(wrapper.text()).not.toContain('手动打开')

    openWindow.mockRestore()
    wrapper.unmount()
  })

  it('弹窗被浏览器拦住：给出「手动打开」链接（07 §6.1 兜底）', async () => {
    vi.mocked(fetchMyInstance).mockResolvedValue(instanceResponse('running'))
    const openWindow = vi.spyOn(window, 'open').mockReturnValue(null)

    const wrapper = await mountHome()
    await wrapper.get('[data-testid="instance-primary"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('浏览器拦住了新标签页')
    const link = wrapper.get('a[href="/dsh/littletao/"]')
    expect(link.text()).toContain('打开 DSH')

    openWindow.mockRestore()
    wrapper.unmount()
  })

  it('启动失败：显示错误提示，不跳转', async () => {
    vi.mocked(fetchMyInstance).mockResolvedValue(instanceResponse('stopped'))
    vi.mocked(startInstance).mockRejectedValue(
      Object.assign(new Error('busy'), {
        name: 'HubApiError',
        code: 'CAPACITY_FULL',
        status: 503,
        details: { running: 12, max: 12 },
      }),
    )

    const tab = { location: { href: '' }, document: null }
    const openWindow = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)

    const wrapper = await mountHome()
    // 造一个真正的 HubApiError（上面那个只是为了不 import 业务类）
    const { HubApiError } = await import('@/api/http')
    vi.mocked(startInstance).mockRejectedValue(
      new HubApiError('CAPACITY_FULL', '同时在用的人有点多，稍后再试试', 503, { running: 12, max: 12 }),
    )

    await wrapper.get('[data-testid="instance-primary"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="instance-error"]').text()).toContain('12/12')
    expect(tab.location.href).toBe('')

    openWindow.mockRestore()
    wrapper.unmount()
  })

  it('首次进入会请求欢迎引导（localStorage 记住后不再请求）', async () => {
    vi.mocked(fetchMyInstance).mockResolvedValue(instanceResponse('running'))

    const wrapper = await mountHome()
    const { welcomePending, markWelcomeSeen } = await import('@/composables/useWelcomeGuide')

    expect(welcomePending.value).toBe(true)
    markWelcomeSeen()
    expect(window.localStorage.getItem('hub.welcome.done')).toBe('1')

    wrapper.unmount()
  })
})
