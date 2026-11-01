import { DELIVERY_MAX_ITEMS } from '@dsh-hub/shared'
import { describe, expect, it } from 'vitest'

import {
  actionAvailability,
  actionDisabledReason,
  buildDeliveryRequest,
  createDeliveryDraft,
  createPluginItem,
  describeDeliveryTargets,
  describeDeliveryItems,
  groupPreviewRows,
  installCountText,
  installOutdatedText,
  isSkippedRow,
  matchDeliveryUsers,
  nextVisibleStep,
  normalizeAction,
  parseDeliveryPrefill,
  previewSummaryText,
  previousVisibleStep,
  stepPosition,
  validateDeliveryStep,
  visibleSteps,
  type DeliveryItemDraft,
  chooseFlowAction,
  chooseFlowContent,
  chooseFlowPlatform,
  flowPlatformBlockedReason,
  otherFlowPlatform,
  parseFlowPrefill,
  validateFlowStep,
} from '@/composables/delivery-draft'

/**
 * 统一下发向导的纯逻辑（docs/21 §2）：平台/内容/动作联动、步骤门控、URL 预填、请求体与预览分组。
 * 组件级流转在 `test/delivery-wizard.test.ts`。
 */

const pluginItems = (...ids: [number | null, number | null][]): DeliveryItemDraft[] =>
  ids.map(([pluginId, versionId]) => createPluginItem(pluginId, versionId))

describe('delivery-draft：平台与内容的联动', () => {
  it('只选桌面端时策略步整步跳过（三步）', () => {
    expect(visibleSteps(['instance'])).toEqual([0, 1, 2, 3])
    expect(visibleSteps(['instance', 'desktop'])).toEqual([0, 1, 2, 3])
    expect(visibleSteps(['desktop'])).toEqual([0, 1, 3])
  })

  it('跳过的步骤不进「下一步 / 上一步」（桌面端从目标直接到预览）', () => {
    expect(nextVisibleStep(1, ['desktop'])).toBe(3)
    expect(previousVisibleStep(3, ['desktop'])).toBe(1)
    expect(stepPosition(3, ['desktop'])).toBe(3)
    expect(stepPosition(3, ['instance'])).toBe(4)
  })

  it('DSH 版本只能下发给实例：只选桌面端时第 1 步被拦住', () => {
    const draft = createDeliveryDraft({
      platforms: ['desktop'],
      items: [{ kind: 'runtime', runtimeId: 2 }],
      action: 'upgrade',
    })
    expect(validateDeliveryStep(0, draft)).toContain('DSH 版本只能下发给实例')
  })

  it('最多 20 个内容项', () => {
    const items = Array.from({ length: DELIVERY_MAX_ITEMS + 1 }, (_, index) => createPluginItem(index + 1, null))
    const draft = createDeliveryDraft({ items })
    expect(validateDeliveryStep(0, draft)).toContain(`一次最多 ${String(DELIVERY_MAX_ITEMS)} 个内容项`)
  })
})

describe('delivery-draft：动作按内容自动禁用', () => {
  it('插件：安装 / 升级 / 卸载可用，「仅应用配置」不可用', () => {
    const availability = actionAvailability(new Set(['plugin']))
    expect(availability).toEqual({
      install: true,
      upgrade: true,
      uninstall: true,
      'apply-config': false,
    })
    expect(actionDisabledReason('apply-config', new Set(['plugin']))).toBe(
      '「仅应用配置」只能用于模型与 API 配置',
    )
  })

  it('只有模型与 API 配置时：卸载不可用，「仅应用配置」可用', () => {
    const availability = actionAvailability(new Set(['models']))
    expect(availability.uninstall).toBe(false)
    expect(availability['apply-config']).toBe(true)
    expect(actionDisabledReason('uninstall', new Set(['models']))).toBe('模型与 API 配置不能卸载')
  })

  it('有 DSH 版本时只能升级（安装 / 卸载 / 仅应用配置都不可用）', () => {
    const availability = actionAvailability(new Set(['plugin', 'runtime']))
    expect(availability).toEqual({
      install: false,
      upgrade: true,
      uninstall: false,
      'apply-config': false,
    })
    expect(actionDisabledReason('install', new Set(['runtime']))).toBe('DSH 版本只有升级')
  })

  it('内容变了以后把不合法的动作收敛回去', () => {
    const base = createDeliveryDraft({ items: pluginItems([1, 11]), action: 'install' })
    // 变成只有模型：install 仍然合法，uninstall 不合法
    const modelsOnly = createDeliveryDraft({ items: [{ kind: 'models', presetId: null }], action: 'uninstall' })
    expect(normalizeAction(modelsOnly)).toBe('apply-config')
    // 混入 DSH 版本：只能升级
    const withRuntime = createDeliveryDraft({
      items: [...pluginItems([1, 11]), { kind: 'runtime', runtimeId: 2 }],
      action: 'install',
    })
    expect(normalizeAction(withRuntime)).toBe('upgrade')
    // 合法动作不动
    expect(normalizeAction(base)).toBe('install')
  })

  it('不合法动作在目标步也被拦住', () => {
    const draft = createDeliveryDraft({ items: [{ kind: 'models', presetId: null }], action: 'uninstall' })
    expect(validateDeliveryStep(1, draft)).toContain('模型与 API 配置不能卸载')
  })
})

describe('delivery-draft：步骤门控', () => {
  it('第 1 步必填：平台、内容、插件、DSH 版本', () => {
    expect(validateDeliveryStep(0, createDeliveryDraft({ platforms: [] }))).toContain('至少选一个平台')
    expect(validateDeliveryStep(0, createDeliveryDraft())).toContain('至少选一个内容项')
    expect(validateDeliveryStep(0, createDeliveryDraft({ items: pluginItems([null, null]) }))).toContain(
      '插件内容项还没选插件',
    )
    expect(
      validateDeliveryStep(0, createDeliveryDraft({ items: [{ kind: 'runtime', runtimeId: null }] })),
    ).toContain('请选择要下发的 DSH 版本')
  })

  it('同一个插件不能出现两次', () => {
    const draft = createDeliveryDraft({ items: pluginItems([1, 11], [1, 11]) })
    expect(validateDeliveryStep(0, draft)).toContain('同一个插件只选一次')
  })

  it('第 2 步：指定用户至少一位、条件筛选至少一个条件且要匹配到人', () => {
    const users = createDeliveryDraft({
      items: pluginItems([1, null]),
      targetMode: 'users',
      userIds: [],
    })
    expect(validateDeliveryStep(1, users)).toContain('至少勾选一位用户')

    const filter = createDeliveryDraft({ items: pluginItems([1, null]), targetMode: 'filter' })
    expect(validateDeliveryStep(1, filter)).toContain('条件筛选至少设置一个条件')

    const noMatch = createDeliveryDraft({
      items: pluginItems([1, null]),
      targetMode: 'filter',
      filter: { status: 'disabled' },
    })
    expect(validateDeliveryStep(1, noMatch, { matchedUserIds: [] })).toContain('没有用户符合这些条件')
    expect(validateDeliveryStep(1, noMatch, { matchedUserIds: [6] })).toEqual([])
    const tooMany = Array.from({ length: 501 }, (_, index) => index + 1)
    expect(validateDeliveryStep(1, noMatch, { matchedUserIds: tooMany })).toContain(
      '一次最多下发给 500 位用户，请收窄条件',
    )
  })

  it('「已安装用户」不支持 DSH 版本', () => {
    const draft = createDeliveryDraft({
      items: [{ kind: 'runtime', runtimeId: 2 }],
      action: 'upgrade',
      targetMode: 'installed',
    })
    expect(validateDeliveryStep(1, draft)).toContain('DSH 版本不支持「已安装用户」')
  })

  it('第 3 步只在选了实例时校验策略范围', () => {
    const bad = createDeliveryDraft({
      items: pluginItems([1, null]),
      strategy: { concurrency: 12, canary: 1, maxFailureRatio: 0.2, restart: 'now' },
    })
    expect(validateDeliveryStep(2, bad)).toContain('并发数需要在 1–8 之间')
    const desktopOnly = createDeliveryDraft({ platforms: ['desktop'], items: pluginItems([1, null]) })
    expect(validateDeliveryStep(2, desktopOnly)).toEqual([])
  })
})

describe('delivery-draft：请求体组装', () => {
  it('多内容项 + 两个平台 + 策略', () => {
    const draft = createDeliveryDraft({
      platforms: ['instance', 'desktop'],
      items: [...pluginItems([1, 11], [3, null]), { kind: 'models', presetId: 7 }],
      action: 'upgrade',
      targetMode: 'role',
      role: 'admin',
    })
    expect(buildDeliveryRequest(draft)).toEqual({
      platforms: ['instance', 'desktop'],
      items: [
        { kind: 'plugin', pluginId: 1, versionId: 11 },
        { kind: 'plugin', pluginId: 3 },
        { kind: 'models', presetId: 7 },
      ],
      action: 'upgrade',
      targets: { mode: 'role', role: 'admin' },
      strategy: { concurrency: 3, canary: 1, maxFailureRatio: 0.2, restart: 'now' },
    })
  })

  it('只选桌面端时不带策略（策略只影响实例侧）', () => {
    const draft = createDeliveryDraft({ platforms: ['desktop'], items: pluginItems([1, 11]) })
    expect(buildDeliveryRequest(draft).strategy).toBeUndefined()
  })

  it('卸载忽略版本号；「已安装」带 outdatedOnly；条件筛选变成明确的用户清单', () => {
    const uninstall = createDeliveryDraft({
      items: pluginItems([1, 11]),
      action: 'uninstall',
      targetMode: 'installed',
      outdatedOnly: true,
    })
    expect(buildDeliveryRequest(uninstall)).toEqual({
      platforms: ['instance'],
      items: [{ kind: 'plugin', pluginId: 1 }],
      action: 'uninstall',
      targets: { mode: 'installed', outdatedOnly: true },
      strategy: { concurrency: 3, canary: 1, maxFailureRatio: 0.2, restart: 'now' },
    })

    const filter = createDeliveryDraft({
      items: pluginItems([1, 11]),
      targetMode: 'filter',
      filter: { status: 'active' },
    })
    expect(buildDeliveryRequest(filter, { matchedUserIds: [1, 2, 4] }).targets).toEqual({
      mode: 'users',
      userIds: [1, 2, 4],
    })
  })
})

describe('delivery-draft：URL 预填', () => {
  it('认契约里的四个键（平台 / 动作 / 目标 / 内容项）', () => {
    const { draft, prefilled, ignored } = parseDeliveryPrefill({
      platforms: 'instance,desktop',
      action: 'upgrade',
      targets: 'installed-outdated',
      items: 'plugin:12,plugin:15:345,models:3,runtime:2',
    })

    expect(prefilled).toBe(true)
    expect(ignored).toEqual([])
    expect(draft.platforms).toEqual(['instance', 'desktop'])
    expect(draft.action).toBe('upgrade')
    expect(draft.targetMode).toBe('installed')
    expect(draft.outdatedOnly).toBe(true)
    expect(draft.items).toEqual([
      { kind: 'plugin', pluginId: 12, versionId: null, desktopVersionId: null },
      { kind: 'plugin', pluginId: 15, versionId: 345, desktopVersionId: null },
      { kind: 'models', presetId: 3 },
      { kind: 'runtime', runtimeId: 2 },
    ])
  })

  it('非法值忽略并回到默认（不抛错、不半截生效）', () => {
    const { draft, prefilled, ignored } = parseDeliveryPrefill({
      platforms: 'instance,moon',
      action: 'explode',
      targets: 'everyone',
      items: 'plugin:0,models:x,tee:1,runtime:9',
    })

    // platforms 有一项非法 → 整个键忽略，回落默认（instance）
    expect(draft.platforms).toEqual(['instance'])
    // 动作键虽然非法、内容项里却有 DSH 版本：收敛成「升级」
    expect(draft.action).toBe('upgrade')
    expect(draft.targetMode).toBe('all')
    // 非法项被丢掉，合法的 runtime:9 留下
    expect(draft.items).toEqual([{ kind: 'runtime', runtimeId: 9 }])
    expect(prefilled).toBe(true)
    expect(ignored.sort()).toEqual(['action', 'items', 'platforms', 'targets'])
  })

  it('空查询串 = 没有预填（用向导自己的默认值）', () => {
    const { draft, prefilled, ignored } = parseDeliveryPrefill({})
    expect(prefilled).toBe(false)
    expect(ignored).toEqual([])
    expect(draft).toEqual(createDeliveryDraft())
  })

  it('认旧的跳转链接（插件库 / 用户详情 / DSH 版本页还在用）', () => {
    const plugin = parseDeliveryPrefill({ kind: 'plugin', pluginId: '1', versionId: '11' })
    expect(plugin.draft.items).toEqual([
      { kind: 'plugin', pluginId: 1, versionId: 11, desktopVersionId: null },
    ])

    const runtime = parseDeliveryPrefill({ kind: 'runtime', runtimeId: '2' })
    expect(runtime.draft.items).toEqual([{ kind: 'runtime', runtimeId: 2 }])
    expect(runtime.draft.platforms).toEqual(['instance'])
    expect(runtime.draft.action).toBe('upgrade')

    const models = parseDeliveryPrefill({ kind: 'models', userIds: '1,2' })
    expect(models.draft.items).toEqual([{ kind: 'models', presetId: null }])
    expect(models.draft.targetMode).toBe('users')
    expect(models.draft.userIds).toEqual([1, 2])
  })

  it('卸载没有默认目标：只给 action + items 时目标留空（绝不预选「全部」）', () => {
    const { draft } = parseDeliveryPrefill({ action: 'uninstall', items: 'plugin:1' })
    expect(draft.action).toBe('uninstall')
    expect(draft.targetMode).toBe('none')
    expect(validateDeliveryStep(1, draft)).toContain('请选择下发给谁')
    expect(() => buildDeliveryRequest(draft)).toThrow('还没有选择下发给谁')

    // 明确给了 targets 就按它来
    const explicit = parseDeliveryPrefill({ action: 'uninstall', items: 'plugin:1', targets: 'installed' })
    expect(explicit.draft.targetMode).toBe('installed')
    expect(buildDeliveryRequest(explicit.draft).targets).toEqual({ mode: 'installed', outdatedOnly: false })
  })

  it('预填了 runtime 却写着 install 时收敛成 upgrade', () => {
    const { draft } = parseDeliveryPrefill({ platforms: 'instance', action: 'install', items: 'runtime:2' })
    expect(draft.action).toBe('upgrade')
  })
})

describe('delivery-draft：文案与人数提示', () => {
  it('内容项 / 目标摘要', () => {
    const items: DeliveryItemDraft[] = [...pluginItems([1, 11], [3, null]), { kind: 'models', presetId: null }]
    expect(
      describeDeliveryItems(createDeliveryDraft({ items }), {
        plugins: [
          { id: 1, displayName: '邮件助手', packageName: 'dsh-email', latestVersion: '0.16.0', versions: [{ id: 11, version: '0.16.0' }] },
          { id: 3, displayName: '文件下载器', packageName: 'dsh-file', latestVersion: '1.0.0', versions: [{ id: 31, version: '1.0.0' }] },
        ],
      }),
    ).toBe('邮件助手 0.16.0、文件下载器 1.0.0、模型与 API 配置')

    expect(
      describeDeliveryTargets(createDeliveryDraft({ targetMode: 'installed', outdatedOnly: true }), () => 'x'),
    ).toBe('已安装用户（只选版本较旧的）')
    expect(describeDeliveryTargets(createDeliveryDraft({ targetMode: 'filter', filter: { status: 'active' } }), () => 'x', { matchedUserIds: [1, 2] })).toBe(
      '条件：状态=正常（匹配 2 人）',
    )
  })

  it('「已安装」的人数：实例 N 人 · 桌面 M 台（多个插件逐个显示，靠调用方逐项渲染）', () => {
    const stat = {
      pluginId: 1,
      instance: { users: 7, outdated: 2 },
      desktop: { devices: 4, users: 3, outdated: 1, bundledDevices: 0 },
      latestVersion: '0.16.0',
    }
    expect(installCountText(stat, ['instance', 'desktop'])).toBe('实例 7 人 · 桌面 4 台')
    expect(installCountText(stat, ['desktop'])).toBe('桌面 4 台')
    expect(installOutdatedText(stat, ['instance', 'desktop'])).toBe('实例 2 人 · 桌面 1 台')
    expect(installOutdatedText(stat, ['instance'])).toBe('实例 2 人')
  })
})

describe('delivery-draft：预览分组', () => {
  const rows = [
    {
      platform: 'instance' as const,
      userId: 1,
      username: 'admin',
      deviceId: null,
      deviceName: null,
      itemLabel: '邮件助手 0.16.0',
      current: '0.15.0',
      after: '0.16.0',
      needsRestart: true,
      skipReason: null,
    },
    {
      platform: 'desktop' as const,
      userId: 2,
      username: 'mint',
      deviceId: 'dv_2',
      deviceName: '薄荷茶的 MacBook',
      itemLabel: '邮件助手 0.16.0',
      current: '0.16.0',
      after: '0.16.0',
      needsRestart: false,
      skipReason: '已是该版本',
    },
  ]

  it('按平台分组，跳过的行带原因', () => {
    const groups = groupPreviewRows(rows)
    expect(groups.instance.map((row) => row.username)).toEqual(['admin'])
    expect(groups.desktop.map((row) => row.deviceName)).toEqual(['薄荷茶的 MacBook'])
    expect(groups.instance.filter(isSkippedRow)).toHaveLength(0)
    expect(groups.desktop.filter(isSkippedRow)).toHaveLength(1)
  })

  it('顶部摘要只写选中的平台', () => {
    const summary = {
      instance: { willRun: 7, skipped: 2, users: 9 },
      desktop: { willRun: 4, skipped: 0, users: 3, devices: 4 },
    }
    expect(previewSummaryText(summary, ['instance'])).toBe('实例 7 项会执行、2 项跳过（9 人）')
    expect(previewSummaryText(summary, ['instance', 'desktop'])).toBe(
      '实例 7 项会执行、2 项跳过（9 人） · 桌面端 4 项会执行（4 台设备 / 3 人）',
    )
  })
})

describe('delivery-draft：条件筛选在提交前解析成用户清单', () => {
  const users = [
    { id: 1, status: 'active' as const, instance: { runtimeVersion: '0.2.1-rc.2' }, modelPresetId: 1 },
    { id: 2, status: 'active' as const, instance: { runtimeVersion: '0.2.0' }, modelPresetId: 1 },
    { id: 3, status: 'pending' as const, instance: { runtimeVersion: null }, modelPresetId: null },
    { id: 4, status: 'active' as const, instance: { runtimeVersion: '0.2.1-rc.2' }, modelPresetId: 2 },
  ]

  it('按状态 / DSH 版本 / 预设过滤', () => {
    expect(matchDeliveryUsers(users, { status: 'active' }).map((user) => user.id)).toEqual([1, 2, 4])
    expect(matchDeliveryUsers(users, { dshVersion: '0.2.1-rc.2' }).map((user) => user.id)).toEqual([1, 4])
    expect(matchDeliveryUsers(users, { status: 'active', presetId: 1 }).map((user) => user.id)).toEqual([1, 2])
    expect(matchDeliveryUsers(users, {})).toHaveLength(4)
  })
})

// ── WP57：五步下发流程 ──────────────────────────────────────────────────────

describe('五步流程（WP57）：内容 / 端 / 动作的联动', () => {
  it('选内容：模型与 DSH 版本直接放一个占位项；DSH 版本把端落成云端；同一类再点一次不动', () => {
    const models = chooseFlowContent(createDeliveryDraft({ platforms: ['desktop'] }), 'models')
    expect(models.items).toEqual([{ kind: 'models', presetId: null }])
    expect(models.action).toBe('apply-config')
    expect(models.platforms).toEqual(['desktop'])
    expect(chooseFlowContent(models, 'models')).toBe(models)

    const runtime = chooseFlowContent(models, 'runtime')
    expect(runtime.items).toEqual([{ kind: 'runtime', runtimeId: null }])
    expect(runtime.platforms).toEqual(['instance'])
    expect(runtime.action).toBe('upgrade')

    const plugin = chooseFlowContent(runtime, 'plugin')
    expect(plugin.items).toEqual([])
    expect(plugin.action).toBe('install')
  })

  it('选端：单选；换端时插件的另一端版本清空', () => {
    const draft = createDeliveryDraft({ items: [createPluginItem(1, 11, 1101)] })
    const desktop = chooseFlowPlatform(draft, 'desktop')
    expect(desktop.platforms).toEqual(['desktop'])
    expect(desktop.items[0]).toMatchObject({ versionId: null, desktopVersionId: 1101 })
    expect(otherFlowPlatform('desktop')).toBe('instance')
    expect(otherFlowPlatform('instance')).toBe('desktop')
  })

  it('插件动作：升级 → 已安装且版本较旧；卸载 → 没有默认目标；装回来 → 全部', () => {
    const upgrade = chooseFlowAction(createDeliveryDraft(), 'upgrade')
    expect(upgrade).toMatchObject({ targetMode: 'installed', outdatedOnly: true })
    const uninstall = chooseFlowAction(upgrade, 'uninstall')
    expect(uninstall).toMatchObject({ targetMode: 'none', outdatedOnly: false })
    expect(chooseFlowAction(uninstall, 'install').targetMode).toBe('all')
  })

  it('DSH 版本不能发桌面端', () => {
    expect(flowPlatformBlockedReason('runtime', 'desktop')).toContain('桌面端')
    expect(flowPlatformBlockedReason('runtime', 'instance')).toBeNull()
    expect(flowPlatformBlockedReason('plugin', 'desktop')).toBeNull()
  })
})

describe('五步流程（WP57）：校验', () => {
  it('内容 / 端 / 配置 各自的门槛', () => {
    const empty = createDeliveryDraft()
    expect(validateFlowStep('content', empty)).toEqual(['先选要下发的内容'])
    expect(validateFlowStep('content', empty, { content: 'plugin' })).toEqual([])

    const runtimeOnDesktop = { ...chooseFlowContent(empty, 'runtime'), platforms: ['desktop' as const] }
    expect(validateFlowStep('platform', runtimeOnDesktop)[0]).toContain('桌面端')

    expect(validateFlowStep('config', empty, { content: 'plugin' })).toContain('至少选一个插件')
    const models = chooseFlowContent(empty, 'models')
    expect(validateFlowStep('config', models, { deliverableModels: 0 })).toContain('至少勾选一个可下发的模型')
    expect(validateFlowStep('config', models, { deliverableModels: 2 })).toEqual([])
    expect(validateFlowStep('config', chooseFlowContent(empty, 'runtime'))).toContain('选一个要升级到的 DSH 版本')
  })

  it('下发：目标与策略的规则沿用旧向导', () => {
    const draft = { ...createDeliveryDraft({ items: [createPluginItem(1)] }), targetMode: 'none' as const }
    expect(validateFlowStep('deliver', draft)).toContain('请选择下发给谁')
    const badStrategy = createDeliveryDraft({
      items: [createPluginItem(1)],
      strategy: { concurrency: 9, canary: 1, maxFailureRatio: 0.2, restart: 'now' },
    })
    expect(validateFlowStep('deliver', badStrategy)).toContain('并发数需要在 1–8 之间')
  })
})

describe('五步流程（WP57）：URL 预填', () => {
  it('内容和端都有 → 从「配置」开始；两个端都带时留第一个，另一个等完成页', () => {
    const result = parseFlowPrefill({
      platforms: 'instance,desktop',
      action: 'upgrade',
      targets: 'installed-outdated',
      items: 'plugin:1,plugin:2',
    })
    expect(result.start).toBe('config')
    expect(result.content).toBe('plugin')
    expect(result.draft.platforms).toEqual(['instance'])
    expect(result.otherPlatform).toBe('desktop')
    expect(result.draft).toMatchObject({ action: 'upgrade', targetMode: 'installed', outdatedOnly: true })
  })

  it('混了几类内容只留第一类；只有内容 → 从「端」开始；什么都没有 → 从「内容」开始', () => {
    const mixed = parseFlowPrefill({ items: 'models,plugin:1' })
    expect(mixed.draft.items).toEqual([{ kind: 'models', presetId: null }])
    expect(mixed.ignored).toContain('items')
    expect(mixed.start).toBe('platform')
    expect(parseFlowPrefill({}).start).toBe('content')
  })

  it('旧链接 kind=runtime：端固定云端，直接到「配置」', () => {
    const result = parseFlowPrefill({ kind: 'runtime', runtimeId: '2' })
    expect(result.start).toBe('config')
    expect(result.draft.platforms).toEqual(['instance'])
    expect(result.draft.items).toEqual([{ kind: 'runtime', runtimeId: 2 }])
  })
})
