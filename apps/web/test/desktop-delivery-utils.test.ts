import type { AuditItem, DesktopDeviceAdminItem } from '@dsh-hub/shared'
import { DesktopConfigFragmentInputSchema } from '@dsh-hub/shared'
import { describe, expect, it } from 'vitest'

import {
  buildConfigFragments,
  channelDraftOf,
  channelLabel,
  channelRequest,
  composePresetFragments,
  configDraftOf,
  describeDeliveryAudit,
  emptyConfigDraft,
  groupDevicesByRevision,
  isPrerelease,
  parseRolloutPercent,
  readPreset,
  scopeKey,
  scopeText,
  selectedModelsOf,
  shortHash,
  splitNoProxy,
  summarizeDevices,
  targetOfDraft,
  validateChannelDraft,
  validateConfigRequest,
  validateFloor,
  validateRolloutPercent,
  validateVersion,
} from '@/utils/desktop-delivery'

/**
 * 桌面下发页的纯逻辑（WP25d 验证项「表单校验」）：
 * 白名单外不可提交、灰度 0–100、版本号格式，外加模型预设的勾选/默认与 revision 汇总。
 */

const PRESET_FRAGMENTS = [
  {
    id: 'llm-pi-ai',
    config: {
      providers: {
        hub: {
          displayName: 'DSH Hub',
          api: 'openai-completions',
          baseURL: 'https://hub.example/v1',
          apiKeyEnv: 'HUB_MK_HUB',
          models: [
            { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
            { id: 'deepseek-v4.1', name: 'DeepSeek V4.1' },
          ],
        },
      },
    },
  },
  { id: 'agent-default-model', config: { provider: 'hub', model: 'deepseek-v4.1-flash' } },
]

describe('版本号与灰度校验', () => {
  it('版本号必须是 1.2.3 或 1.2.3-rc.1', () => {
    expect(validateVersion('0.2.2')).toBeNull()
    expect(validateVersion('0.3.0-rc.1')).toBeNull()
    expect(validateVersion('0.2')).toContain('版本号格式')
    expect(validateVersion('v0.2.2')).toContain('版本号格式')
    expect(validateVersion('')).toContain('填写版本号')
    expect(validateVersion('', false)).toBeNull()
  })

  it('latest 通道拒预发布', () => {
    expect(isPrerelease('0.3.0-rc.1')).toBe(true)
    expect(isPrerelease('0.3.0')).toBe(false)
  })

  it('灰度只收 0–100 的整数', () => {
    expect(parseRolloutPercent('0')).toBe(0)
    expect(parseRolloutPercent('55')).toBe(55)
    expect(parseRolloutPercent('100')).toBe(100)
    expect(parseRolloutPercent('101')).toBeNull()
    expect(parseRolloutPercent('-1')).toBeNull()
    expect(parseRolloutPercent('5.5')).toBeNull()
    expect(parseRolloutPercent('')).toBeNull()
    expect(validateRolloutPercent('120')).toBe('填 0–100 的整数')
    expect(validateRolloutPercent('20')).toBeNull()
  })

  it('渠道草稿：空串变成 null（清掉这一项），百分比带上', () => {
    const draft = channelDraftOf({
      targetVersion: '0.2.2',
      minVersion: null,
      minVersionHard: true,
      rolloutPercent: 30,
    })
    expect(channelRequest('latest', draft)).toEqual({
      channel: 'latest',
      targetVersion: '0.2.2',
      minVersion: null,
      minVersionHard: true,
      rolloutPercent: 30,
    })
    expect(channelRequest('nightly', { ...draft, targetVersion: '  ' }).targetVersion).toBeNull()
  })

  it('渠道草稿的字段错误按字段返回', () => {
    expect(validateChannelDraft({ targetVersion: 'x', minVersion: '0.1.0', minVersionHard: false, rolloutPercent: '10' }))
      .toEqual({ targetVersion: '版本号格式应为 1.2.3 / 1.2.3-rc.1' })
    expect(
      validateChannelDraft({ targetVersion: '', minVersion: '', minVersionHard: false, rolloutPercent: '200' }),
    ).toEqual({ rolloutPercent: '填 0–100 的整数' })
  })

  it('强更地板：标题 / 说明字数、https 链接', () => {
    expect(validateFloor({ minVersion: '0.2.1', title: '标题', detail: '说明', appLink: 'https://x/y' })).toEqual({})
    expect(validateFloor({ minVersion: 'bad', title: 't', detail: 'd', appLink: '' })['minVersion']).toContain(
      '版本号格式',
    )
    expect(
      validateFloor({ minVersion: '', title: 'x'.repeat(257), detail: 'd', appLink: '' })['title'],
    ).toContain('256')
    expect(
      validateFloor({ minVersion: '', title: 't', detail: 'd', appLink: 'http://x' })['appLink'],
    ).toContain('https://')
  })
})

describe('配置片段：白名单表单', () => {
  it('空白草稿提交不了（要说清没选条目）', () => {
    const built = buildConfigFragments(emptyConfigDraft())
    expect(built.fragments).toEqual([])
    expect(built.errors).toEqual(['还没选要下发的条目'])
  })

  it('pilot 只生成 hubMode 一个键', () => {
    const draft = emptyConfigDraft()
    draft.claudePilot = { enabled: true, mode: 'default', hubMode: true }
    const built = buildConfigFragments(draft)
    expect(built.errors).toEqual([])
    expect(built.fragments).toEqual([{ id: 'claude-pilot', mode: 'default', config: { hubMode: true } }])
  })

  it('连接器：代理与 pip 镜像至少一项，noProxy 按逗号/空格切开', () => {
    const draft = emptyConfigDraft()
    draft.hubConnector = {
      enabled: true,
      mode: 'enforce',
      http: 'http://127.0.0.1:7890',
      https: ' ',
      noProxy: '127.0.0.1, hub.example  localhost',
      mirror: 'https://pypi.tuna.tsinghua.edu.cn/simple',
      trustedHost: 'pypi.tuna.tsinghua.edu.cn',
    }
    expect(splitNoProxy('a, b，c\n d ')).toEqual(['a', 'b', 'c', 'd'])
    const built = buildConfigFragments(draft)
    expect(built.errors).toEqual([])
    expect(built.fragments[0]).toEqual({
      id: 'hub-connector',
      mode: 'enforce',
      config: {
        hubProxy: { http: 'http://127.0.0.1:7890', noProxy: ['127.0.0.1', 'hub.example', 'localhost'] },
        python: { mirror: 'https://pypi.tuna.tsinghua.edu.cn/simple', trustedHost: 'pypi.tuna.tsinghua.edu.cn' },
      },
    })

    draft.hubConnector = {
      enabled: true,
      mode: 'enforce',
      http: '',
      https: '',
      noProxy: '',
      mirror: '',
      trustedHost: '',
    }
    expect(buildConfigFragments(draft).errors).toEqual(['hub-connector：代理和 pip 镜像至少填一项'])
  })

  it('整体过契约：未知条目 / 未知键都提交不了（白名单外不可提交）', () => {
    expect(validateConfigRequest({ scope: 'all' }, [{ id: 'claude-pilot', mode: 'enforce', config: { hubMode: true } }]))
      .toBeNull()

    // 未知键（strictObject）
    const withUnknownKey = validateConfigRequest(
      { scope: 'all' },
      [{ id: 'claude-pilot', mode: 'enforce', config: { hubMode: true, temperature: 0.7 } }] as never,
    )
    expect(withUnknownKey).toContain('不在白名单里')

    // 未知条目 id（判别联合直接失败）
    const withUnknownEntry = validateConfigRequest(
      { scope: 'all' },
      [{ id: 'not-allowed', mode: 'enforce', config: {} }] as never,
    )
    expect(withUnknownEntry).not.toBeNull()

    // 契约本身也拒绝同一条请求
    expect(
      DesktopConfigFragmentInputSchema.safeParse({ id: 'claude-pilot', mode: 'enforce', config: { temperature: 1 } })
        .success,
    ).toBe(false)
  })

  it('已有片段回填成表单（默认模型 / 连接器 / hubMode）', () => {
    const draft = configDraftOf([
      { entryId: 'llm-pi-ai', mode: 'enforce', config: PRESET_FRAGMENTS[0]!.config },
      { entryId: 'agent-default-model', mode: 'default', config: { provider: 'hub', model: 'deepseek-v4.1' } },
      { entryId: 'codex-pilot', mode: 'enforce', config: { hubMode: false } },
      {
        entryId: 'hub-connector',
        mode: 'enforce',
        config: { hubProxy: { http: 'http://p', noProxy: ['a', 'b'] }, python: { mirror: 'https://m' } },
      },
    ])
    expect(draft.llmPiAi.enabled).toBe(true)
    expect(draft.defaultModel).toMatchObject({ enabled: true, mode: 'default' })
    expect(draft.codexPilot).toMatchObject({ enabled: true, hubMode: false })
    expect(draft.hubConnector).toMatchObject({
      enabled: true,
      http: 'http://p',
      noProxy: 'a, b',
      mirror: 'https://m',
    })
    // 再次提交不丢键
    const built = buildConfigFragments(draft)
    expect(built.errors).toEqual([])
    expect(built.fragments.map((fragment) => fragment.id)).toEqual([
      'llm-pi-ai',
      'agent-default-model',
      'codex-pilot',
      'hub-connector',
    ])
  })
})

describe('模型预设', () => {
  it('读出提供方、模型与默认模型', () => {
    const preset = readPreset(PRESET_FRAGMENTS)
    expect(preset.providers).toHaveLength(1)
    expect(preset.providers[0]?.models.map((model) => model.key)).toEqual([
      'hub/deepseek-v4.1-flash',
      'hub/deepseek-v4.1',
    ])
    expect(preset.defaultKey).toBe('hub/deepseek-v4.1-flash')
  })

  it('勾一个模型 + 选默认 → 生成两条片段（未勾的模型被摘掉）', () => {
    const preset = readPreset(PRESET_FRAGMENTS)
    const composed = composePresetFragments(preset, ['hub/deepseek-v4.1'], 'hub/deepseek-v4.1')
    expect(composed.errors).toEqual([])
    const providers = composed.llmPiAi?.['providers'] as Record<string, { models: { id: string }[] }>
    expect(providers['hub']?.models.map((model) => model.id)).toEqual(['deepseek-v4.1'])
    expect(composed.defaultModel).toEqual({ provider: 'hub', model: 'deepseek-v4.1' })
  })

  it('一个都不勾 / 默认没勾都报错', () => {
    const preset = readPreset(PRESET_FRAGMENTS)
    expect(composePresetFragments(preset, [], null).errors).toEqual(['至少勾一个模型'])
    expect(composePresetFragments(preset, ['hub/deepseek-v4.1'], null).errors).toEqual(['选一个默认模型'])
  })

  it('已选模型能从 config 读回来', () => {
    expect(selectedModelsOf(PRESET_FRAGMENTS[0]!.config)).toEqual([
      'hub/deepseek-v4.1-flash',
      'hub/deepseek-v4.1',
    ])
    expect(selectedModelsOf(null)).toEqual([])
  })
})

describe('设备汇总与发布日志', () => {
  const device = (
    id: number,
    revision: number | null,
    state: 'applied' | 'pending' | 'failed' | 'partial' | 'unknown',
    presence: 'online' | 'offline' = 'online',
  ) =>
    ({
      user: { id: 2, slug: 'u3p8q1z2', username: 'mint', displayName: '薄荷茶', avatarUrl: null },
      device: {
        deviceId: `dv_${String(id).padStart(32, '0')}`,
        name: `设备 ${String(id)}`,
        platform: 'win32',
        osMajor: '11',
        arch: 'x64',
        appVersion: '0.2.1',
        appChannel: 'latest',
        runtimeVersion: null,
        capabilities: null,
        appliedRevision: revision,
        desiredRevision: 42,
        appliedAt: null,
        applyState: state,
        applyErrorCode: state === 'failed' || state === 'partial' ? 'disk_full' : null,
        errorCount: state === 'failed' || state === 'partial' ? 2 : 0,
        presence,
        firstSeenAt: '2026-10-01T00:00:00.000Z',
        registeredAt: null,
        lastReportAt: '2026-10-20T00:00:00.000Z',
        lastAuthAt: null,
        revokedAt: null,
        revokeReason: null,
        createdAt: '2026-10-01T00:00:00.000Z',
      },
      pluginCount: 3,
    }) satisfies DesktopDeviceAdminItem

  it('按 revision 分组：已应用 / 待应用 / 失败，新版本在前、未上报最后', () => {
    const groups = groupDevicesByRevision([
      device(1, 42, 'applied'),
      device(2, 42, 'failed'),
      device(3, 41, 'pending'),
      device(4, null, 'unknown'),
      device(5, 42, 'partial'),
    ])
    expect(groups.map((group) => group.revision)).toEqual([42, 41, null])
    expect(groups[0]).toMatchObject({ total: 3, applied: 1, pending: 0, failed: 2 })
    expect(groups[0]?.failures.map((failure) => failure.errorText)).toEqual(['磁盘空间不足', '磁盘空间不足'])
    expect(groups[1]).toMatchObject({ total: 1, applied: 0, pending: 1, failed: 0 })
    expect(groups[2]).toMatchObject({ total: 1, pending: 1 })
  })

  it('概览的四个数：总数 / 在线 / 待应用 / 失败 + 按渠道', () => {
    const summary = summarizeDevices([
      device(1, 42, 'applied', 'online'),
      device(2, 40, 'pending', 'offline'),
      device(3, 41, 'failed', 'online'),
    ])
    expect(summary).toMatchObject({ total: 3, online: 2, pending: 1, failed: 1 })
    expect(summary.byChannel['latest']).toBe(3)
  })

  it('发布日志：三类下发 + 发布时间线各有一句中文', () => {
    const audit = (detail: Record<string, unknown>, action = 'desktop.deliver'): AuditItem => ({
      id: 1,
      at: '2026-10-22T00:00:00.000Z',
      actorId: 1,
      actorIp: null,
      actorUsername: 'admin',
      action,
      targetType: 'desktop.delivery',
      targetId: '9',
      detail,
    })
    expect(
      describeDeliveryAudit(
        audit({ action: 'deliver', packageName: 'dsh-email', version: '0.16.0', scope: 'all' }),
      ),
    ).toBe('全部设备 · 下发插件 dsh-email 0.16.0')
    expect(describeDeliveryAudit(audit({ entryIds: ['llm-pi-ai'], scope: 'role', role: 'user' }))).toBe(
      '普通用户 · 配置片段：llm-pi-ai',
    )
    expect(
      describeDeliveryAudit(
        audit({ channel: 'latest', targetVersion: '0.2.2', minVersion: '0.2.1', rolloutPercent: 25, scope: 'all' }),
      ),
    ).toBe('全部设备 · 稳定渠道 目标 0.2.2 / 最低 0.2.1 / 灰度 25%')
    expect(
      describeDeliveryAudit(audit({ target: 'win-x64', channel: 'latest', version: '0.2.1' }, 'desktop.release.publish')),
    ).toBe('发布安装包 0.2.1（稳定 · win-x64）')
  })

  it('目标与作用域：指定用户没选人时折不出请求体', () => {
    expect(targetOfDraft({ scope: 'all', role: 'user', userId: null })).toEqual({ scope: 'all' })
    expect(targetOfDraft({ scope: 'role', role: 'admin', userId: null })).toEqual({ scope: 'role', role: 'admin' })
    expect(targetOfDraft({ scope: 'user', role: 'user', userId: null })).toBeNull()
    expect(targetOfDraft({ scope: 'user', role: 'user', userId: 7 })).toEqual({ scope: 'user', userId: 7 })
    expect(scopeKey({ scope: 'user', role: null, userId: 7 })).toBe('user:7')
    expect(scopeKey({ scope: 'role', role: 'admin', userId: null })).toBe('role:admin')
    expect(scopeText({ scope: 'all', role: null, userId: null })).toBe('全部设备')
    expect(scopeText({ scope: 'role', role: 'admin', userId: null })).toBe('管理员')
    expect(scopeText({ scope: 'user', role: null, userId: 7 })).toBe('用户 #7')
  })

  it('通道文案与 sha512 截断', () => {
    expect(channelLabel('nightly')).toBe('测试')
    expect(channelLabel('latest')).toBe('稳定')
    expect(shortHash('a'.repeat(86))).toBe(`${'a'.repeat(12)}…`)
    expect(shortHash('short')).toBe('short')
  })
})
