import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'

import { resetReauthDialog, reauthDialog, resolveReauth } from '@/composables/useReauth'
import { pluginDeliveryLocation } from '@/utils/plugin-delivery'
import { routes } from '@/router'
import AdminRolloutWizardView from '@/views/admin/AdminRolloutWizardView.vue'

/**
 * 下发流程（WP57，docs/25）的组件级流转：内容 → 端 → 配置 → 下发 → 完成。
 * 每步只回答一个问题；URL 预填决定从哪一步开始；下发步实时预览 + 二次密码；完成页可「再下发到另一端」。
 *
 * 纯逻辑（预填解析、动作可用性、请求体、分组）在 `test/delivery-draft.test.ts`；
 * 假数据在 `test/delivery-mocks.test.ts`。
 */

const iso = '2026-10-01T10:00:00.000Z'

const USER = {
  id: 1,
  slug: 'u7k2m9x1',
  username: 'mint',
  displayName: '薄荷茶',
  bio: '',
  avatarUrl: null,
  role: 'user',
  roleLabel: '',
  status: 'active',
  mustChangePassword: false,
  createdAt: iso,
  lastLoginAt: iso,
  usernameChangedAt: null,
  quota: {
    cpus: 2,
    memoryMb: 2048,
    pidsLimit: 1024,
    diskGb: 20,
    idleStopMinutes: 120,
    idleNoClientMinutes: 30,
    allowUserPlugins: true,
  },
  quotaIsDefault: true,
  runtimeId: null,
  modelPresetId: 3,
  modelPolicy: 'managed',
  instance: {
    status: 'running',
    runtimeVersion: '0.2.1-rc.2',
    startedAt: iso,
    lastActiveAt: iso,
    needsRecreate: false,
    error: null,
    openUrl: '/dsh/mint/',
  },
  lastLoginIp: '127.0.0.1',
  deletedAt: null,
}

const PLUGIN = {
  id: 1,
  packageName: 'dsh-email',
  displayName: '邮件助手',
  description: '',
  icon: null,
  homepage: null,
  policy: 'default',
  isBundle: true,
  bundleOrder: 10,
  needsRestart: true,
  latestVersion: '0.16.0',
  configYaml: '',
  platform: 'cloud',
  versions: [
    {
      id: 11,
      platform: 'cloud',
      version: '0.16.0',
      sourceType: 'npm',
      sourceRef: 'dsh-email@0.16.0',
      spec: '0.16.0',
      sha256: null,
      minDsh: '0.2.0',
      createdAt: iso,
    },
  ],
  stats: { installed: 7, pending: 0, failed: 0 },
  platforms: {
    cloud: {
      policy: 'default',
      bundleOrder: 10,
      configYaml: '',
      needsRestart: true,
      createdAt: iso,
      updatedAt: iso,
    },
  },
}

/** 只在云上库里的插件（docs/22 §2：桌面侧应显示「不在桌面插件库」） */
const CLOUD_ONLY_PLUGIN = {
  ...PLUGIN,
  id: 2,
  packageName: '@xmanrui/dsh-im',
  displayName: 'IM 机器人',
  versions: [
    {
      ...PLUGIN.versions[0],
      id: 21,
      sourceRef: '@xmanrui/dsh-im@4.35.1',
      version: '4.35.1',
      spec: '4.35.1',
    },
  ],
}

/** docs/22 §2：桌面库里的同一个插件（版本 id 与云上不同） */
const DESKTOP_PLUGIN = {
  ...PLUGIN,
  platform: 'desktop',
  versions: [
    {
      ...PLUGIN.versions[0],
      id: 1101,
      platform: 'desktop',
    },
    {
      ...PLUGIN.versions[0],
      id: 1102,
      platform: 'desktop',
      version: '0.15.0',
      spec: '0.15.0',
      sourceRef: 'dsh-email@0.15.0',
    },
  ],
  platforms: {
    desktop: {
      policy: 'default',
      bundleOrder: 10,
      configYaml: '',
      needsRestart: true,
      createdAt: iso,
      updatedAt: iso,
    },
  },
}

const RUNTIME = {
  id: 2,
  dshVersion: '0.2.1-rc.2',
  image: 'dshhub/runtime:0.2.1-rc.2',
  status: 'ready',
  isDefault: true,
  sizeBytes: null,
  usersOnIt: 3,
  createdAt: iso,
  notes: '',
}

const PRESET = {
  id: 3,
  platform: 'cloud',
  name: '默认预设',
  description: '',
  providerIds: [1],
  defaultProvider: 'deepseek',
  defaultModel: 'deepseek-v4.1-flash',
  isDefault: true,
  revision: 1,
  usersOnIt: 5,
  createdAt: iso,
  updatedAt: iso,
}

const DESKTOP_PRESET = {
  ...PRESET,
  id: 4,
  platform: 'desktop',
  name: '桌面默认预设',
}

const PREVIEW = {
  rows: [
    {
      platform: 'instance',
      userId: 1,
      username: 'mint',
      deviceId: null,
      deviceName: null,
      itemLabel: '邮件助手 0.16.0',
      current: '0.15.0',
      after: '0.16.0',
      needsRestart: true,
      skipReason: null,
    },
    {
      platform: 'instance',
      userId: 3,
      username: 'skywalker',
      deviceId: null,
      deviceName: null,
      itemLabel: '邮件助手 0.16.0',
      current: '0.15.0',
      after: '0.16.0',
      needsRestart: true,
      skipReason: '用户待审批',
    },
    {
      platform: 'desktop',
      userId: 2,
      username: 'mint',
      deviceId: 'dv_0002',
      deviceName: '薄荷茶的 MacBook',
      itemLabel: '邮件助手 0.16.0',
      current: '0.15.0',
      after: '0.16.0',
      needsRestart: true,
      skipReason: null,
    },
    {
      platform: 'desktop',
      userId: 4,
      username: 'sakura',
      deviceId: 'dv_0004',
      deviceName: '樱花饼的联想小新',
      itemLabel: '邮件助手 0.16.0',
      current: '0.16.0',
      after: '0.16.0',
      needsRestart: false,
      skipReason: '已是该版本',
    },
  ],
  summary: {
    instance: { willRun: 1, skipped: 1, users: 1 },
    desktop: { willRun: 1, skipped: 1, users: 1, devices: 1 },
  },
  warnings: ['视频渲染 0.3.2 没有桌面整包，桌面端这一项会被跳过'],
  truncated: false,
  // 契约 d12d925：预览就带「整项跳过」，与提交结果同形同口径
  skippedItems: [
    { itemLabel: '视频渲染 0.3.2', platform: 'desktop', reason: '该插件不在桌面插件库' },
    { itemLabel: 'DSH 0.2.1-rc.2', platform: 'desktop', reason: 'DSH 版本只对实例生效' },
  ],
}

const CREATED = {
  jobs: [{ jobId: 1043, itemLabel: '邮件助手 0.16.0' }],
  desktop: { revision: 42, users: 1, devices: 1 },
  skippedItems: [{ itemLabel: '视频渲染 0.3.2', platform: 'desktop', reason: '缺桌面整包' }],
}

const INSTALL_STATS = {
  items: [
    {
      pluginId: 1,
      instance: { users: 7, outdated: 2 },
      desktop: { devices: 4, users: 3, outdated: 1, bundledDevices: 2 },
      latestVersion: '0.16.0',
    },
  ],
}

const ARTIFACTS = {
  items: [
    {
      pluginId: 1,
      packageName: 'dsh-email',
      versionId: 11,
      version: '0.16.0',
      fileName: 'dsh-email-0.16.0.tgz',
      bytes: 41_216,
      sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      uploadedAt: iso,
    },
    {
      pluginId: 1,
      packageName: 'dsh-email',
      versionId: 1101,
      version: '0.16.0',
      fileName: 'dsh-email-0.16.0-desktop.tgz',
      bytes: 41_216,
      sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      uploadedAt: iso,
    },
  ],
}

interface Captured {
  preview?: unknown
  create?: unknown
  saveModels?: unknown
}

/** 模型配置（`GET /api/admin/relay/dsh`）：老界面（没有 routes），两个模型、一个已选 */
const PRICE = { inputMicro: 1, outputMicro: 2, cacheReadMicro: null, cacheWriteMicro: null, perRequestMicro: 0 }
const RELAY_DSH = {
  models: [
    {
      id: 1,
      name: 'deepseek-v4.1-flash',
      displayName: 'DeepSeek V4.1 Flash',
      enabled: true,
      visibility: 'all',
      apis: ['openai-completions'],
      deliverApi: 'openai-completions',
      channelNames: ['Upstream B'],
      defaultThinking: null,
      price: PRICE,
      priced: true,
      selected: true,
      blockedReason: null,
    },
    {
      id: 2,
      name: 'deepseek-v3',
      displayName: 'DeepSeek V3',
      enabled: true,
      visibility: 'all',
      apis: ['openai-completions'],
      deliverApi: 'openai-completions',
      channelNames: ['Upstream B'],
      defaultThinking: null,
      price: PRICE,
      priced: true,
      selected: false,
      blockedReason: null,
    },
  ],
  defaultModelId: 1,
  revision: 3,
  updatedAt: iso,
  pending: true,
  lastRollout: null,
  users: { total: 1, running: 1 },
  warnings: [],
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function stubFetch(captured: Captured, preview: unknown = PREVIEW, users = [USER]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'

      if (url.includes('/api/admin/deliveries/preview') && method === 'POST') {
        captured.preview = JSON.parse(String(init?.body ?? '{}'))
        return json(preview)
      }
      if (/\/api\/admin\/deliveries$/.test(url) && method === 'POST') {
        captured.create = JSON.parse(String(init?.body ?? '{}'))
        return json(CREATED, 202)
      }
      if (url.includes('/api/admin/relay/dsh')) {
        if (method === 'PUT') {
          captured.saveModels = JSON.parse(String(init?.body ?? '{}'))
          return json({ ...RELAY_DSH, models: RELAY_DSH.models.map((model) => ({ ...model, selected: true })) })
        }
        return json(RELAY_DSH)
      }
      if (url.includes('/api/admin/plugins/install-stats')) return json(INSTALL_STATS)
      if (url.includes('/api/admin/desktop/artifacts')) return json(ARTIFACTS)
      if (url.includes('/api/admin/plugins')) {
        const platform = new URL(url, 'http://localhost').searchParams.get('platform')
        return json(platform === 'desktop' ? [DESKTOP_PLUGIN] : [PLUGIN, CLOUD_ONLY_PLUGIN])
      }
      if (url.includes('/api/admin/runtimes/available')) {
        return json({ versions: ['0.2.1-rc.2'], latest: '0.2.1-rc.2', next: null })
      }
      if (url.includes('/api/admin/runtimes')) return json([RUNTIME])
      if (url.includes('/api/admin/models/presets')) {
        const platform = new URL(url, 'http://localhost').searchParams.get('platform')
        return json(platform === 'desktop' ? [DESKTOP_PRESET] : [PRESET])
      }
      if (url.includes('/api/admin/users')) {
        const page = Number(new URL(url, 'http://localhost').searchParams.get('page') ?? '1')
        return json({ items: users.slice((page - 1) * 100, page * 100), total: users.length, page, pageSize: 100 })
      }
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
  render: () => h(NMessageProvider, null, { default: () => h(AdminRolloutWizardView) }),
})

const wrappers: { unmount: () => void }[] = []

async function mountWizard(path: string, captured: Captured = {}, preview: unknown = PREVIEW, users = [USER]) {
  stubFetch(captured, preview, users)
  const router = await routerAt(path)
  const wrapper = mount(Host, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  await flushPromises()
  wrappers.push(wrapper)
  return { wrapper, router }
}

type Wrapper = Awaited<ReturnType<typeof mountWizard>>['wrapper']

async function click(wrapper: Wrapper, testid: string): Promise<void> {
  const element = wrapper.get(`[data-testid="${testid}"]`).element as HTMLElement
  const radio = element.matches('.n-radio') ? element : element.querySelector<HTMLElement>('.n-radio')
  if (radio) {
    // jsdom 里点 <label> 不会把激活行为转发给内部 input（Naive 的单选框是 label + input），
    // 直接派发 change 才能触发 NRadioGroup 的 update:value
    const input = radio.querySelector<HTMLInputElement>('input[type="radio"]')
    if (input) {
      input.checked = true
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await flushPromises()
      return
    }
  }
  element.click()
  await flushPromises()
}

function testid(wrapper: Wrapper, id: string) {
  return wrapper.find(`[data-testid="${id}"]`)
}

/** 卡片选了以后流程停一拍才自动往下走（260ms）；测试里用假定时器推过去 */
async function pick(wrapper: Wrapper, id: string): Promise<void> {
  await click(wrapper, id)
  await vi.advanceTimersByTimeAsync(300)
  await flushPromises()
}

/** 下发步的预览有 350ms 防抖 */
async function settlePreview(): Promise<void> {
  await vi.advanceTimersByTimeAsync(400)
  await flushPromises()
  await flushPromises()
}

function currentStep(wrapper: Wrapper): string | undefined {
  return wrapper.find('[aria-current="step"]').attributes('data-testid')
}

beforeEach(() => {
  resetReauthDialog()
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('下发流程：内容 → 端（WP57）', () => {
  it('没有预填时从「内容」开始；点卡片自动进入「端」，步骤条回显已选', async () => {
    const { wrapper } = await mountWizard('/admin/rollouts')
    expect(currentStep(wrapper)).toBe('flow-step-content')
    expect(wrapper.text()).toContain('发什么？')
    // 卡片上是数据，不是说明小字
    expect(testid(wrapper, 'flow-content-plugin').text()).toContain('云端 2 个 · 桌面端 1 个')

    await pick(wrapper, 'flow-content-plugin')
    expect(currentStep(wrapper)).toBe('flow-step-platform')
    expect(testid(wrapper, 'flow-step-content').text()).toContain('插件')
  })

  it('「下一步」在没选内容时被拦住', async () => {
    const { wrapper } = await mountWizard('/admin/rollouts')
    await click(wrapper, 'delivery-next')
    expect(currentStep(wrapper)).toBe('flow-step-content')
  })

  it('DSH 版本只能发云端：桌面端卡片置灰并给原因，点了不动', async () => {
    const { wrapper } = await mountWizard('/admin/rollouts')
    await pick(wrapper, 'flow-content-runtime')
    const desktop = testid(wrapper, 'flow-platform-desktop')
    expect(desktop.attributes('aria-disabled')).toBe('true')
    expect(desktop.text()).toContain('桌面端的版本在「DSH 版本 · 桌面端」发布安装包')
    await pick(wrapper, 'flow-platform-desktop')
    expect(currentStep(wrapper)).toBe('flow-step-platform')
    await pick(wrapper, 'flow-platform-instance')
    expect(currentStep(wrapper)).toBe('flow-step-config')
  })

  it('选了端整页换成该端颜色（桌面端 = 紫）', async () => {
    const { wrapper } = await mountWizard('/admin/rollouts')
    await pick(wrapper, 'flow-content-plugin')
    await pick(wrapper, 'flow-platform-desktop')
    expect(wrapper.find('[data-testid="delivery-flow"]').classes()).toContain('flow--desktop')
    expect(wrapper.find('section.admin-page').attributes('data-platform')).toBe('desktop')
  })

  it('点步骤条上走过的步骤可以回去', async () => {
    const { wrapper } = await mountWizard('/admin/rollouts')
    await pick(wrapper, 'flow-content-plugin')
    await pick(wrapper, 'flow-platform-instance')
    await click(wrapper, 'flow-step-content')
    expect(currentStep(wrapper)).toBe('flow-step-content')
  })
})

describe('下发流程：配置', () => {
  it('插件：只给当前端的版本下拉；没选插件不能往下走', async () => {
    const { wrapper } = await mountWizard('/admin/rollouts?platforms=desktop&items=plugin:1')
    expect(currentStep(wrapper)).toBe('flow-step-config')
    expect(wrapper.find('[data-testid="delivery-versions-desktop-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="delivery-versions-cloud-1"]').exists()).toBe(false)

    const { wrapper: empty } = await mountWizard('/admin/rollouts')
    await pick(empty, 'flow-content-plugin')
    await pick(empty, 'flow-platform-instance')
    await click(empty, 'delivery-next')
    expect(currentStep(empty)).toBe('flow-step-config')
  })

  it('插件动作：升级默认发给「已安装且版本较旧」，卸载没有默认目标', async () => {
    const { wrapper } = await mountWizard('/admin/rollouts?platforms=instance&items=plugin:1')
    await click(wrapper, 'flow-action-upgrade')
    expect(testid(wrapper, 'flow-action-upgrade').attributes('aria-checked')).toBe('true')
    await click(wrapper, 'delivery-next')
    expect(currentStep(wrapper)).toBe('flow-step-deliver')
    expect(wrapper.text()).toContain('只选版本较旧的')

    await click(wrapper, 'flow-step-config')
    await click(wrapper, 'flow-action-uninstall')
    await click(wrapper, 'delivery-next')
    await settlePreview()
    // 卸载必须自己选目标：确认按钮禁用
    expect(testid(wrapper, 'delivery-submit').attributes('disabled')).toBeDefined()
  })

  it('模型配置：直接在这一步勾模型，下一步时自动保存再进「下发」', async () => {
    const captured: Captured = {}
    const { wrapper } = await mountWizard('/admin/rollouts?platforms=instance&items=models', captured)
    expect(currentStep(wrapper)).toBe('flow-step-config')
    await vi.waitFor(() => expect(wrapper.text()).toContain('DeepSeek V3'), { timeout: 3000 })
    // 嵌入时没有本卡自己的「下发」按钮与保存条
    expect(testid(wrapper, 'dsh-rollout').exists()).toBe(false)

    const box = document.querySelector<HTMLElement>('[data-testid="dsh-check-2"] .n-checkbox')
    expect(box).toBeTruthy()
    box!.click()
    await flushPromises()
    await click(wrapper, 'delivery-next')
    await vi.waitFor(() => expect(captured.saveModels).toEqual({ modelIds: [1, 2], defaultModelId: 1 }))
    await flushPromises()
    expect(currentStep(wrapper)).toBe('flow-step-deliver')
    expect(testid(wrapper, 'flow-step-config').text()).toContain('默认 DeepSeek V4.1 Flash')
  })

  it('DSH 版本：旧链接 kind=runtime 直接落到「配置」并选好版本', async () => {
    const { wrapper } = await mountWizard('/admin/rollouts/new?kind=runtime&runtimeId=2')
    expect(currentStep(wrapper)).toBe('flow-step-config')
    expect(testid(wrapper, 'flow-step-platform').text()).toContain('云端')
    expect(wrapper.text()).toContain('0.2.1-rc.2')
  })
})

describe('下发流程：下发与完成', () => {
  async function toDeliver(path = '/admin/rollouts?platforms=instance&items=plugin:1', captured: Captured = {}, preview: unknown = PREVIEW) {
    const mounted = await mountWizard(path, captured, preview)
    await click(mounted.wrapper, 'delivery-next')
    await settlePreview()
    return mounted
  }

  it('进入「下发」自动预览；请求体只有一个端、一类内容；云端有折叠的灰度策略', async () => {
    const captured: Captured = {}
    const { wrapper } = await toDeliver(undefined, captured)
    expect(currentStep(wrapper)).toBe('flow-step-deliver')
    expect(captured.preview).toMatchObject({
      platforms: ['instance'],
      items: [{ kind: 'plugin', pluginId: 1, versionId: 11 }],
      action: 'install',
      targets: { mode: 'all' },
    })
    expect(testid(wrapper, 'flow-strategy').exists()).toBe(true)
    expect(wrapper.text()).toContain('该插件不在桌面插件库')
  })

  it('桌面端没有灰度策略', async () => {
    const { wrapper } = await toDeliver('/admin/rollouts?platforms=desktop&items=plugin:1')
    expect(testid(wrapper, 'flow-strategy').exists()).toBe(false)
  })

  it('改目标会重新预览', async () => {
    const captured: Captured = {}
    const { wrapper } = await toDeliver(undefined, captured)
    await click(wrapper, 'delivery-target-installed')
    await settlePreview()
    expect(captured.preview).toMatchObject({ targets: { mode: 'installed', outdatedOnly: false } })
  })

  it('确认走二次密码；成功后到「完成」：任务链接 + 再下发到桌面端', async () => {
    const captured: Captured = {}
    const { wrapper } = await toDeliver(undefined, captured)
    await click(wrapper, 'delivery-submit')
    expect(reauthDialog.visible).toBe(true)
    expect(reauthDialog.title).toBe('确认下发到云端')
    expect(reauthDialog.description).toContain('将在云端执行 1 项（1 人）')
    expect(captured.create).toBeUndefined()
    resolveReauth()
    await flushPromises()
    await flushPromises()
    expect(captured.create).toEqual(captured.preview)
    expect(currentStep(wrapper)).toBe('flow-step-done')
    expect(testid(wrapper, 'delivery-result').text()).toContain('已下发到云端')
    expect(testid(wrapper, 'delivery-jobs').text()).toContain('任务 #1043')
    expect(testid(wrapper, 'delivery-other').text()).toContain('再下发到桌面端')

    // 再下发到另一端：内容与动作带过去，回到「配置」，版本换成桌面端最新
    await click(wrapper, 'delivery-other')
    expect(currentStep(wrapper)).toBe('flow-step-config')
    expect(wrapper.find('[data-testid="delivery-flow"]').classes()).toContain('flow--desktop')
    await click(wrapper, 'delivery-next')
    await settlePreview()
    expect(captured.preview).toMatchObject({
      platforms: ['desktop'],
      items: [{ kind: 'plugin', pluginId: 1, desktopVersionId: 1101 }],
    })
  })

  it('全部行都被跳过：确认按钮禁用', async () => {
    const allSkipped = { ...PREVIEW, rows: PREVIEW.rows.map((row) => ({ ...row, skipReason: '已是该版本' })) }
    const { wrapper } = await toDeliver(undefined, {}, allSkipped)
    expect(testid(wrapper, 'delivery-submit').attributes('disabled')).toBeDefined()
  })
})

describe('下发流程：URL 预填与路由', () => {
  it('插件库批量按钮的地址：两个端都带时先发第一个，完成页提示再发另一个', async () => {
    const location = pluginDeliveryLocation('upgrade', [1])
    const query = new URLSearchParams(location.query).toString()
    const captured: Captured = {}
    const { wrapper } = await mountWizard(`${location.path}?${query}`, captured)
    expect(currentStep(wrapper)).toBe('flow-step-config')
    await click(wrapper, 'delivery-next')
    await settlePreview()
    expect(captured.preview).toMatchObject({ action: 'upgrade', targets: { mode: 'installed', outdatedOnly: true } })
  })

  it('/admin/rollouts/new 带查询串跳到 /admin/rollouts（预填不丢）', async () => {
    const { router } = await mountWizard('/admin/rollouts/new?kind=plugin&pluginId=1')
    expect(router.currentRoute.value.path).toBe('/admin/rollouts')
    expect(router.currentRoute.value.query['pluginId']).toBe('1')
  })

  it('只带内容没带端：从「端」开始', async () => {
    const { wrapper } = await mountWizard('/admin/rollouts?items=models')
    expect(currentStep(wrapper)).toBe('flow-step-platform')
  })
})
