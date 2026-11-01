import { describe, expect, it } from 'vitest'

import {
  buildPreviewRequest,
  buildRolloutRequest,
  buildTargets,
  createDraft,
  describeTargets,
  draftFromQuery,
  validateStep,
} from '@/composables/rollout-draft'

/**
 * 下发向导（07 §7.8 / 04 §4.8）：步骤校验与请求体组装。
 * 任务的「组件测试：下发向导的步骤校验与请求体组装」主要落在这一层（纯函数），
 * 组件层的步骤流转见 `test/admin-wizard.test.ts`。
 */

describe('rollout-draft：① 动作步骤的校验', () => {
  it('插件下发必须选插件，安装 / 升级还必须选版本', () => {
    const draft = createDraft({ kind: 'plugin', action: 'install' })
    expect(validateStep(0, draft)).toEqual(['请选择要下发的插件'])

    draft.pluginId = 7
    expect(validateStep(0, draft)).toEqual(['安装 / 升级需要指定版本'])

    draft.versionId = 3
    expect(validateStep(0, draft)).toEqual([])
  })

  it('卸载 / 仅应用配置不需要版本', () => {
    const draft = createDraft({ kind: 'plugin', action: 'uninstall', pluginId: 7 })
    expect(validateStep(0, draft)).toEqual([])

    draft.action = 'apply-config'
    expect(validateStep(0, draft)).toEqual([])
  })

  it('DSH 升级要求选版本；模型下发不需要额外选项（WP12：不再选预设）', () => {
    expect(validateStep(0, createDraft({ kind: 'runtime' }))).toEqual(['请选择要升级到的 DSH 版本'])
    expect(validateStep(0, createDraft({ kind: 'runtime', runtimeId: 2 }))).toEqual([])
    // 12 §7.0：选中集合与默认模型在「模型 → 下发到 DSH」里配，向导这一步没有必填项
    expect(validateStep(0, createDraft({ kind: 'models' }))).toEqual([])
    expect(createDraft({ kind: 'models' })).not.toHaveProperty('presetMode')
  })
})

describe('rollout-draft：② 目标步骤的校验', () => {
  it('勾选用户模式至少一位用户', () => {
    const draft = createDraft({ targetMode: 'users' })
    expect(validateStep(1, draft)).toEqual(['至少勾选一位用户'])

    draft.userIds = [3]
    expect(validateStep(1, draft)).toEqual([])
  })

  it('条件筛选至少要设置一个条件', () => {
    const draft = createDraft({ targetMode: 'filter' })
    expect(validateStep(1, draft)).toEqual(['条件筛选至少设置一个条件'])

    draft.filter.status = 'active'
    expect(validateStep(1, draft)).toEqual([])
  })

  it('全部用户无需附加条件', () => {
    expect(validateStep(1, createDraft({ targetMode: 'all' }))).toEqual([])
  })
})

describe('rollout-draft：③ 策略步骤的校验', () => {
  it('并发 1–8、金丝雀 0–5、失败阈值 0–1', () => {
    const draft = createDraft()
    draft.strategy.concurrency = 9
    expect(validateStep(2, draft)).toContain('并发数需要在 1–8 之间')

    draft.strategy.concurrency = 3
    draft.strategy.canary = 6
    expect(validateStep(2, draft)).toContain('金丝雀数量需要在 0–5 之间')

    draft.strategy.canary = 1
    draft.strategy.maxFailureRatio = 1.5
    expect(validateStep(2, draft)).toContain('失败阈值需要在 0–1 之间')

    draft.strategy.maxFailureRatio = 0.2
    expect(validateStep(2, draft)).toEqual([])
  })
})

describe('rollout-draft：请求体组装', () => {
  it('全部用户 → { all: true }', () => {
    const draft = createDraft({ targetMode: 'all' })
    expect(buildTargets(draft)).toEqual({ all: true })
  })

  it('勾选用户 → { userIds }', () => {
    const draft = createDraft({ targetMode: 'users', userIds: [4, 9] })
    expect(buildTargets(draft)).toEqual({ userIds: [4, 9] })
  })

  it('条件筛选只带上设置过的条件', () => {
    const draft = createDraft({ targetMode: 'filter' })
    draft.filter = { status: 'active', presetId: 6, pluginId: undefined, runtimeId: undefined }
    expect(buildTargets(draft)).toEqual({ filter: { status: 'active', presetId: 6 } })
  })

  it('插件安装：kind/action/pluginId/versionId/targets/strategy 齐备', () => {
    const draft = createDraft({
      kind: 'plugin',
      action: 'install',
      pluginId: 12,
      versionId: 34,
      targetMode: 'users',
      userIds: [1, 2],
      strategy: { concurrency: 2, canary: 1, maxFailureRatio: 0.25, restart: 'next-start' },
    })

    expect(buildRolloutRequest(draft)).toEqual({
      kind: 'plugin',
      action: 'install',
      pluginId: 12,
      versionId: 34,
      targets: { userIds: [1, 2] },
      strategy: { concurrency: 2, canary: 1, maxFailureRatio: 0.25, restart: 'next-start' },
    })
  })

  it('插件卸载不带 versionId', () => {
    const draft = createDraft({ kind: 'plugin', action: 'uninstall', pluginId: 12, versionId: null })
    expect(buildRolloutRequest(draft)).toEqual({
      kind: 'plugin',
      action: 'uninstall',
      pluginId: 12,
      targets: { all: true },
      strategy: { concurrency: 3, canary: 1, maxFailureRatio: 0.2, restart: 'now' },
    })
  })

  it('DSH 升级与模型下发（模型下发不带 presetId）', () => {
    expect(buildRolloutRequest(createDraft({ kind: 'runtime', runtimeId: 9 }))).toMatchObject({
      kind: 'runtime',
      runtimeId: 9,
    })

    // 12 §7.0：模型下发只有 targets + strategy，**永远不带 presetId**
    expect(buildRolloutRequest(createDraft({ kind: 'models' }))).toEqual({
      kind: 'models',
      targets: { all: true },
      strategy: { concurrency: 3, canary: 1, maxFailureRatio: 0.2, restart: 'now' },
    })
    expect(buildRolloutRequest(createDraft({ kind: 'models' }))).not.toHaveProperty('presetId')
  })

  it('预览请求与创建请求同体（同一份组装逻辑）', () => {
    const draft = createDraft({ kind: 'runtime', runtimeId: 2, targetMode: 'users', userIds: [5] })
    expect(buildPreviewRequest(draft)).toEqual(buildRolloutRequest(draft))
  })
})

describe('rollout-draft：URL 预填与目标摘要', () => {
  it('从查询串预填插件 / 版本与用户（旧的 presetId 忽略）', () => {
    expect(draftFromQuery({ kind: 'plugin', pluginId: '12' })).toMatchObject({
      kind: 'plugin',
      pluginId: 12,
      targetMode: 'all',
    })

    expect(draftFromQuery({ kind: 'models' }).kind).toBe('models')
    expect(draftFromQuery({ kind: 'models', presetId: '3' })).not.toHaveProperty('presetId')

    const draft = draftFromQuery({ kind: 'runtime', runtimeId: '3', userIds: '1,2,3' })
    expect(draft.kind).toBe('runtime')
    expect(draft.runtimeId).toBe(3)
    expect(draft.targetMode).toBe('users')
    expect(draft.userIds).toEqual([1, 2, 3])

    expect(draftFromQuery({ kind: '未知' }).kind).toBe('plugin')
    expect(draftFromQuery({ userIds: '0,abc' }).targetMode).toBe('all')
  })

  it('目标摘要：全部 / 用户名单（超过 3 位折叠）/ 条件', () => {
    const name = (id: number): string => `u${id}`

    expect(describeTargets(createDraft({ targetMode: 'all' }), name)).toBe('全部用户')
    expect(describeTargets(createDraft({ targetMode: 'users', userIds: [1, 2] }), name)).toBe('u1、u2')
    expect(describeTargets(createDraft({ targetMode: 'users', userIds: [1, 2, 3, 4] }), name)).toBe(
      'u1、u2、u3 等 4 位用户',
    )

    const filter = createDraft({ targetMode: 'filter' })
    filter.filter = { status: 'active', runtimeId: 2 }
    expect(describeTargets(filter, name)).toBe('条件：状态=active，版本=#2')
    expect(describeTargets(createDraft({ targetMode: 'filter' }), name)).toBe('条件：未设置')
  })
})
