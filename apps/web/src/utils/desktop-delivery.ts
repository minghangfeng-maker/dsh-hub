import type {
  AuditItem,
  DesktopAppDeliverRequest,
  DesktopConfigFragmentInput,
  DesktopDeliveryLevel,
  DesktopDeliveryScope,
  DesktopDeliveryTarget,
  DesktopDeviceAdminItem,
  DesktopReleaseChannel,
  DesktopUpdateFloor,
} from '@dsh-hub/shared'
import { DesktopConfigDeliverRequestSchema, DesktopDeliverySemverSchema } from '@dsh-hub/shared'

import { applyErrorText, applyStateText } from '@/components/desktop/text'

/**
 * 桌面下发页（WP25d）的纯逻辑：渠道 / 级别的中文、目标作用域、版本号与灰度校验、
 * 白名单配置片段的组装与校验、模型预设的读取与裁剪、按 revision 汇总设备。
 *
 * 全部是纯函数，页面只负责渲染与事件 —— 这样「白名单外不可提交」「灰度 0–100」「版本号格式」
 * 这三类校验可以直接单测，不必把组件挂起来点。
 */

// ── 枚举文案 ────────────────────────────────────────────────────────────────

/** 通道：上游是 nightly|latest，界面写「测试 / 稳定」（裁决 #17；与设备台账同一个口径） */
export function channelLabel(channel: DesktopReleaseChannel | null | undefined): string {
  if (channel === 'nightly') return '测试'
  if (channel === 'latest') return '稳定'
  return '—'
}

/** 清单里的 level（= 插件库 policy 的映射，裁决 #17） */
export function levelLabel(level: DesktopDeliveryLevel): string {
  if (level === 'core') return '必装'
  if (level === 'default') return '默认'
  return '可选'
}

/** 目标作用域 → 一句话（列表里「下发给谁」那一列） */
export function scopeText(scope: DesktopDeliveryScope): string {
  if (scope.scope === 'all') return '全部设备'
  if (scope.scope === 'role') return scope.role === 'admin' ? '管理员' : '普通用户'
  return scope.userId === null ? '指定用户' : `用户 #${String(scope.userId)}`
}

/** 作用域的稳定键（前端做「同一个目标」比较用；不参与契约） */
export function scopeKey(scope: DesktopDeliveryScope): string {
  if (scope.scope === 'all') return 'all'
  if (scope.scope === 'role') return `role:${scope.role ?? ''}`
  return `user:${String(scope.userId ?? '')}`
}

/** 视图里的作用域 → 请求里的判别联合 */
export function targetOfScope(scope: DesktopDeliveryScope): DesktopDeliveryTarget {
  if (scope.scope === 'all') return { scope: 'all' }
  if (scope.scope === 'role') return { scope: 'role', role: scope.role ?? 'user' }
  return { scope: 'user', userId: scope.userId ?? 0 }
}

/** 请求里的目标 → 视图里的作用域（乐观更新、文案拼接用） */
export function scopeOfTarget(target: DesktopDeliveryTarget): DesktopDeliveryScope {
  if (target.scope === 'all') return { scope: 'all', role: null, userId: null }
  if (target.scope === 'role') return { scope: 'role', role: target.role, userId: null }
  return { scope: 'user', role: null, userId: target.userId }
}

export function sameScope(left: DesktopDeliveryScope, right: DesktopDeliveryScope): boolean {
  return scopeKey(left) === scopeKey(right)
}

/** 录音/表单里的「目标」草稿（角色与用户都能为空，交给校验兜底） */
export interface TargetDraft {
  scope: 'all' | 'role' | 'user'
  role: 'user' | 'admin'
  userId: number | null
}

export const DEFAULT_TARGET: TargetDraft = { scope: 'all', role: 'user', userId: null }

export function targetDraftOf(scope: DesktopDeliveryScope): TargetDraft {
  return {
    scope: scope.scope,
    role: scope.role === 'admin' ? 'admin' : 'user',
    userId: scope.userId,
  }
}

/** 草稿 → 契约目标；指定用户没选人时返回 null（由调用方提示） */
export function targetOfDraft(draft: TargetDraft): DesktopDeliveryTarget | null {
  if (draft.scope === 'all') return { scope: 'all' }
  if (draft.scope === 'role') return { scope: 'role', role: draft.role }
  if (draft.userId === null || draft.userId <= 0) return null
  return { scope: 'user', userId: draft.userId }
}

// ── 校验 ────────────────────────────────────────────────────────────────────

/** 版本号校验（与清单 schema 的 semver 同一份正则，见 `DesktopDeliverySemverSchema`） */
export function validateVersion(value: string, required = true): string | null {
  const text = value.trim()
  if (text.length === 0) return required ? '填写版本号，如 0.2.2' : null
  const parsed = DesktopDeliverySemverSchema.safeParse(text)
  return parsed.success ? null : '版本号格式应为 1.2.3 / 1.2.3-rc.1'
}

/** 是否预发布（latest 通道不收，D3 §7.2） */
export function isPrerelease(version: string): boolean {
  return version.includes('-')
}

/** 灰度百分比：0–100 的整数（按 deviceId 哈希稳定分桶，纯函数） */
export function parseRolloutPercent(value: string): number | null {
  const text = value.trim()
  if (!/^\d{1,3}$/u.test(text)) return null
  const percent = Number(text)
  return percent >= 0 && percent <= 100 ? percent : null
}

export function validateRolloutPercent(value: string): string | null {
  return parseRolloutPercent(value) === null ? '填 0–100 的整数' : null
}

/** 强更弹窗文案的长度限制（契约 `UpdateDesktopFloorRequestSchema`：标题 256 / 正文 16384） */
export const FLOOR_TITLE_MAX = 256
export const FLOOR_DETAIL_MAX = 16_384

export function validateFloor(floor: {
  minVersion: string
  title: string
  detail: string
  appLink: string
}): Record<string, string> {
  const errors: Record<string, string> = {}
  const versionError = validateVersion(floor.minVersion, false)
  if (versionError) errors['minVersion'] = versionError
  if (floor.title.length > FLOOR_TITLE_MAX) errors['title'] = `标题最多 ${String(FLOOR_TITLE_MAX)} 字`
  if (floor.detail.length > FLOOR_DETAIL_MAX) {
    errors['detail'] = `说明最多 ${String(FLOOR_DETAIL_MAX)} 字`
  }
  const link = floor.appLink.trim()
  if (link.length > 0 && !link.startsWith('https://')) errors['appLink'] = '链接必须以 https:// 开头'
  if (link.length > 2048) errors['appLink'] = '链接太长了（最多 2048 字）'
  return errors
}

/** 强更地板（服务端返回的）→ 表单草稿 */
export function floorForm(floor: DesktopUpdateFloor | null): {
  minVersion: string
  title: string
  detail: string
  appLink: string
} {
  return {
    minVersion: floor?.minVersion ?? '',
    title: floor?.title ?? '需要更新 DSH Hub 桌面端',
    detail: floor?.detail ?? '当前版本已停止支持，请安装新版本后再继续使用。',
    appLink: floor?.appLink ?? '',
  }
}

// ── 版本策略 ────────────────────────────────────────────────────────────────

/** 渠道表单草稿（`GET /delivery` 的 app.channels 拍平） */
export interface ChannelDraft {
  targetVersion: string
  minVersion: string
  minVersionHard: boolean
  rolloutPercent: string
}

export function channelDraftOf(policy: {
  targetVersion: string | null
  minVersion: string | null
  minVersionHard: boolean
  rolloutPercent: number
}): ChannelDraft {
  return {
    targetVersion: policy.targetVersion ?? '',
    minVersion: policy.minVersion ?? '',
    minVersionHard: policy.minVersionHard,
    rolloutPercent: String(policy.rolloutPercent),
  }
}

/** 渠道表单 → `PUT /api/admin/desktop/app` 的请求体（空串 = null = 清掉这一项） */
export function channelRequest(
  channel: DesktopReleaseChannel,
  draft: ChannelDraft,
): DesktopAppDeliverRequest {
  const percent = parseRolloutPercent(draft.rolloutPercent) ?? 0
  return {
    channel,
    targetVersion: draft.targetVersion.trim() === '' ? null : draft.targetVersion.trim(),
    minVersion: draft.minVersion.trim() === '' ? null : draft.minVersion.trim(),
    minVersionHard: draft.minVersionHard,
    rolloutPercent: percent,
  }
}

/** 渠道表单的字段校验（返回字段 → 错误文案） */
export function validateChannelDraft(draft: ChannelDraft): Record<string, string> {
  const errors: Record<string, string> = {}
  const target = validateVersion(draft.targetVersion, false)
  if (target) errors['targetVersion'] = target
  const min = validateVersion(draft.minVersion, false)
  if (min) errors['minVersion'] = min
  const percent = validateRolloutPercent(draft.rolloutPercent)
  if (percent) errors['rolloutPercent'] = percent
  return errors
}

// ── 配置片段：白名单表单 ────────────────────────────────────────────────────

export type FragmentMode = 'enforce' | 'default'

/** 三条简单条目（pilot / connector）的表单值；模型那两条由「模型预设」写入原始 config */
export interface ConfigDraft {
  llmPiAi: { enabled: boolean; mode: FragmentMode; config: Record<string, unknown> | null }
  defaultModel: { enabled: boolean; mode: FragmentMode; config: Record<string, unknown> | null }
  claudePilot: { enabled: boolean; mode: FragmentMode; hubMode: boolean }
  codexPilot: { enabled: boolean; mode: FragmentMode; hubMode: boolean }
  hubConnector: {
    enabled: boolean
    mode: FragmentMode
    http: string
    https: string
    noProxy: string
    mirror: string
    trustedHost: string
  }
}

export function emptyConfigDraft(): ConfigDraft {
  return {
    llmPiAi: { enabled: false, mode: 'enforce', config: null },
    defaultModel: { enabled: false, mode: 'enforce', config: null },
    claudePilot: { enabled: false, mode: 'enforce', hubMode: true },
    codexPilot: { enabled: false, mode: 'enforce', hubMode: true },
    hubConnector: { enabled: false, mode: 'enforce', http: '', https: '', noProxy: '', mirror: '', trustedHost: '' },
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function toStringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 已下发的片段（一个目标）→ 表单草稿；认不出的条目直接忽略（服务端只允许白名单） */
export function configDraftOf(
  fragments: { entryId: string; mode: FragmentMode; config: Record<string, unknown> }[],
): ConfigDraft {
  const draft = emptyConfigDraft()
  for (const fragment of fragments) {
    if (fragment.entryId === 'llm-pi-ai') {
      draft.llmPiAi = { enabled: true, mode: fragment.mode, config: fragment.config }
      continue
    }
    if (fragment.entryId === 'agent-default-model') {
      draft.defaultModel = { enabled: true, mode: fragment.mode, config: fragment.config }
      continue
    }
    if (fragment.entryId === 'claude-pilot') {
      draft.claudePilot = { enabled: true, mode: fragment.mode, hubMode: fragment.config['hubMode'] !== false }
      continue
    }
    if (fragment.entryId === 'codex-pilot') {
      draft.codexPilot = { enabled: true, mode: fragment.mode, hubMode: fragment.config['hubMode'] !== false }
      continue
    }
    if (fragment.entryId === 'hub-connector') {
      const proxy = asRecord(fragment.config['hubProxy'])
      const python = asRecord(fragment.config['python'])
      const noProxy = Array.isArray(proxy?.['noProxy'])
        ? proxy['noProxy'].filter((item): item is string => typeof item === 'string')
        : []
      draft.hubConnector = {
        enabled: true,
        mode: fragment.mode,
        http: toStringOrEmpty(proxy?.['http']),
        https: toStringOrEmpty(proxy?.['https']),
        noProxy: noProxy.join(', '),
        mirror: toStringOrEmpty(python?.['mirror']),
        trustedHost: toStringOrEmpty(python?.['trustedHost']),
      }
    }
  }
  return draft
}

/** 逗号 / 空格 / 换行分隔的 noProxy 列表 */
export function splitNoProxy(value: string): string[] {
  return value
    .split(/[,，\s]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

/**
 * 表单草稿 → 待下发的片段数组（`PUT /api/admin/desktop/config` 的 `fragments`）。
 *
 * **白名单外的键到不了这里**：模型两条是预设原样搬过来的，其余三条按白名单逐键构造；
 * 组装完再整体过 `DesktopConfigDeliverRequestSchema`，未知条目 / 未知键在这一步被挡住。
 */
export function buildConfigFragments(draft: ConfigDraft): {
  fragments: DesktopConfigFragmentInput[]
  errors: string[]
} {
  const fragments: DesktopConfigFragmentInput[] = []
  const errors: string[] = []

  if (draft.llmPiAi.enabled) {
    if (draft.llmPiAi.config === null || Object.keys(draft.llmPiAi.config).length === 0) {
      errors.push('llm-pi-ai：先用「模型预设」挑一个用户把提供方带进来')
    } else {
      fragments.push({
        id: 'llm-pi-ai',
        mode: draft.llmPiAi.mode,
        config: draft.llmPiAi.config,
      } as DesktopConfigFragmentInput)
    }
  }

  if (draft.defaultModel.enabled) {
    const config = draft.defaultModel.config
    if (config === null) {
      errors.push('agent-default-model：还没选默认模型')
    } else {
      fragments.push({
        id: 'agent-default-model',
        mode: draft.defaultModel.mode,
        config,
      } as DesktopConfigFragmentInput)
    }
  }

  if (draft.claudePilot.enabled) {
    fragments.push({
      id: 'claude-pilot',
      mode: draft.claudePilot.mode,
      config: { hubMode: draft.claudePilot.hubMode },
    })
  }

  if (draft.codexPilot.enabled) {
    fragments.push({
      id: 'codex-pilot',
      mode: draft.codexPilot.mode,
      config: { hubMode: draft.codexPilot.hubMode },
    })
  }

  if (draft.hubConnector.enabled) {
    const form = draft.hubConnector
    const noProxy = splitNoProxy(form.noProxy)
    const hubProxy: Record<string, unknown> = {}
    if (form.http.trim() !== '') hubProxy['http'] = form.http.trim()
    if (form.https.trim() !== '') hubProxy['https'] = form.https.trim()
    if (noProxy.length > 0) hubProxy['noProxy'] = noProxy
    const config: Record<string, unknown> = {}
    if (Object.keys(hubProxy).length > 0) config['hubProxy'] = hubProxy
    if (form.mirror.trim() !== '') {
      config['python'] = {
        mirror: form.mirror.trim(),
        ...(form.trustedHost.trim() === '' ? {} : { trustedHost: form.trustedHost.trim() }),
      }
    }
    if (Object.keys(config).length === 0) {
      errors.push('hub-connector：代理和 pip 镜像至少填一项')
    } else {
      fragments.push({ id: 'hub-connector', mode: form.mode, config } as DesktopConfigFragmentInput)
    }
  }

  if (fragments.length === 0 && errors.length === 0) {
    errors.push('还没选要下发的条目')
  }

  return { fragments, errors }
}

/** Zod issue → 界面能读的中文（只有 strictObject 的未知键是英文原文） */
function issueText(issue: { code: string; path: (string | number | symbol)[]; message: string }): string {
  if (issue.message.startsWith('Unrecognized key')) {
    const key = /"([^"]+)"/u.exec(issue.message)?.[1] ?? ''
    return `这个键不在白名单里：${key}`
  }
  const path = issue.path.map((part) => String(part)).join('.')
  return path.length > 0 ? `${path}：${issue.message}` : issue.message
}

/** 提交前整体过一遍契约（未知条目 / 未知键 / 同 id 重复都在这里被挡住） */
export function validateConfigRequest(
  target: DesktopDeliveryTarget,
  fragments: DesktopConfigFragmentInput[],
): string | null {
  const parsed = DesktopConfigDeliverRequestSchema.safeParse({ target, fragments })
  if (parsed.success) return null
  const first = parsed.error.issues[0]
  return first ? issueText(first) : '配置片段不合法'
}

// ── 模型预设（GET /api/admin/desktop/config/model-preset）────────────────────

/** 预设里可选的一个模型（`key` = `提供方/模型 id`，前端做勾选与默认单选） */
export interface PresetModel {
  key: string
  provider: string
  id: string
  name: string
  raw: Record<string, unknown>
}

export interface PresetProvider {
  key: string
  displayName: string
  raw: Record<string, unknown>
  models: PresetModel[]
}

export interface PresetView {
  providers: PresetProvider[]
  defaultKey: string | null
  warnings: string[]
}

/** 把预设返回的两条片段读成可勾选的形状（认不出的部分忽略，不抛错） */
export function readPreset(
  fragments: { id: string; config: Record<string, unknown> }[],
  warnings: string[] = [],
): PresetView {
  const providers: PresetProvider[] = []
  let defaultKey: string | null = null
  for (const fragment of fragments) {
    if (fragment.id === 'llm-pi-ai') {
      const raw = asRecord(fragment.config['providers'])
      if (!raw) continue
      for (const [key, value] of Object.entries(raw)) {
        const provider = asRecord(value)
        if (!provider) continue
        const models = Array.isArray(provider['models']) ? provider['models'] : []
        providers.push({
          key,
          displayName: toStringOrEmpty(provider['displayName']) || key,
          raw: provider,
          models: models.flatMap((entry) => {
            const model = asRecord(entry)
            if (!model || typeof model['id'] !== 'string') return []
            return [
              {
                key: `${key}/${model['id']}`,
                provider: key,
                id: model['id'],
                name: toStringOrEmpty(model['name']) || model['id'],
                raw: model,
              },
            ]
          }),
        })
      }
      continue
    }
    if (fragment.id === 'agent-default-model') {
      const provider = toStringOrEmpty(fragment.config['provider'])
      const model = toStringOrEmpty(fragment.config['model'])
      if (provider !== '' && model !== '') defaultKey = `${provider}/${model}`
    }
  }
  return { providers, defaultKey, warnings }
}

/** 勾选 + 默认 → 两条片段的 config（没勾的模型从 providers 里摘掉） */
export function composePresetFragments(
  preset: PresetView,
  selected: readonly string[],
  defaultKey: string | null,
): {
  llmPiAi: Record<string, unknown> | null
  defaultModel: Record<string, unknown> | null
  errors: string[]
} {
  const errors: string[] = []
  const providers: Record<string, unknown> = {}
  for (const provider of preset.providers) {
    const models = provider.models.filter((model) => selected.includes(model.key))
    if (models.length === 0) continue
    providers[provider.key] = {
      ...provider.raw,
      models: models.map((model) => model.raw),
    }
  }
  if (Object.keys(providers).length === 0) {
    errors.push('至少勾一个模型')
    return { llmPiAi: null, defaultModel: null, errors }
  }

  const picked = preset.providers
    .flatMap((provider) => provider.models)
    .find((model) => model.key === defaultKey)
  if (!picked || !selected.includes(picked.key)) {
    errors.push('选一个默认模型')
    return { llmPiAi: null, defaultModel: null, errors }
  }
  return {
    llmPiAi: { providers },
    defaultModel: { provider: picked.provider, model: picked.id },
    errors,
  }
}

/** 草稿里已勾选的模型 key（编辑已有片段时回填勾选状态） */
export function selectedModelsOf(config: Record<string, unknown> | null): string[] {
  const providers = asRecord(config?.['providers'])
  if (!providers) return []
  const keys: string[] = []
  for (const [providerKey, value] of Object.entries(providers)) {
    const provider = asRecord(value)
    const models = Array.isArray(provider?.['models']) ? provider['models'] : []
    for (const entry of models) {
      const model = asRecord(entry)
      if (model && typeof model['id'] === 'string') keys.push(`${providerKey}/${model['id']}`)
    }
  }
  return keys
}

// ── 设备与 revision ────────────────────────────────────────────────────────

export interface RevisionDevice {
  deviceId: string
  name: string
  user: string
  appVersion: string | null
  applyState: string
  applyStateText: string
  errorCode: string | null
  errorText: string
  errorCount: number
  lastReportAt: string | null
}

export interface RevisionGroup {
  /** null = 还没上报过 appliedRevision（新设备 / 从未拉过清单） */
  revision: number | null
  total: number
  applied: number
  pending: number
  failed: number
  failures: RevisionDevice[]
}

/** 一台设备在列表里显示成什么（失败明细和总数都用它） */
export function revisionDeviceOf(item: DesktopDeviceAdminItem): RevisionDevice {
  const device = item.device
  return {
    deviceId: device.deviceId,
    name: device.name,
    user: item.user.displayName || item.user.username,
    appVersion: device.appVersion,
    applyState: device.applyState,
    applyStateText: applyStateText(device.applyState),
    errorCode: device.applyErrorCode,
    errorText: applyErrorText(device.applyErrorCode),
    errorCount: device.errorCount ?? 0,
    lastReportAt: device.lastReportAt,
  }
}

/**
 * 按「已应用的 revision」把设备分组：`applied` / `pending`（unknown、pending）/ `failed`（failed、partial）。
 * 新的 revision 在前，null 最后 —— 概览要回答的是「大家跟到哪一版了」。
 */
export function groupDevicesByRevision(items: DesktopDeviceAdminItem[]): RevisionGroup[] {
  const groups = new Map<number | null, RevisionGroup>()
  for (const item of items) {
    const revision = item.device.appliedRevision
    let group = groups.get(revision)
    if (!group) {
      group = { revision, total: 0, applied: 0, pending: 0, failed: 0, failures: [] }
      groups.set(revision, group)
    }
    group.total += 1
    const state = item.device.applyState
    if (state === 'applied') {
      group.applied += 1
    } else if (state === 'failed' || state === 'partial') {
      group.failed += 1
      group.failures.push(revisionDeviceOf(item))
    } else {
      group.pending += 1
    }
  }
  return [...groups.values()].sort((left, right) => {
    if (left.revision === null) return 1
    if (right.revision === null) return -1
    return right.revision - left.revision
  })
}

export interface DeviceSummary {
  total: number
  online: number
  pending: number
  failed: number
  byChannel: Record<string, number>
}

/** 概览第一行的几个数：设备总数 / 在线 / 待应用 / 失败（同一份设备列表算出来） */
export function summarizeDevices(items: DesktopDeviceAdminItem[]): DeviceSummary {
  const summary: DeviceSummary = { total: items.length, online: 0, pending: 0, failed: 0, byChannel: {} }
  for (const item of items) {
    const device = item.device
    if (device.presence === 'online') summary.online += 1
    if (device.applyState === 'failed' || device.applyState === 'partial') summary.failed += 1
    else if (device.applyState !== 'applied') summary.pending += 1
    const channel = device.appChannel ?? 'unknown'
    summary.byChannel[channel] = (summary.byChannel[channel] ?? 0) + 1
  }
  return summary
}

// ── 发布日志（审计 desktop.deliver）────────────────────────────────────────

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function percentOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 一条审计记录 → 「改了什么」（不含人名与时间，那两列单独渲染） */
export function describeDeliveryAudit(item: AuditItem): string {
  const detail = item.detail ?? {}
  const scope = typeof detail['scope'] === 'string' ? detail['scope'] : null
  const prefix =
    scope === 'role'
      ? `${detail['role'] === 'admin' ? '管理员' : '普通用户'} · `
      : scope === 'user'
        ? `用户 #${String(detail['userId'] ?? '')} · `
        : scope === 'all'
          ? '全部设备 · '
          : ''

  if (item.action === 'desktop.release.publish') {
    const channel = String(detail['channel'] ?? '')
    return `${prefix}发布安装包 ${String(detail['version'] ?? '')}（${channelLabel(channel as DesktopReleaseChannel)} · ${String(detail['target'] ?? '')}）`
  }
  if (item.action === 'desktop.release.rollback') {
    return `${prefix}回滚安装包 ${String(detail['target'] ?? '')} / ${channelLabel(String(detail['channel'] ?? '') as DesktopReleaseChannel)}`
  }
  if (item.action === 'desktop.update-floor.set') {
    return `设置强更地板 ${String(detail['minVersion'] ?? '（清空）')}`
  }
  if (item.action === 'desktop.plugin-package.upload') {
    return `上传插件整包 ${String(detail['packageName'] ?? '')} ${String(detail['version'] ?? '')}`
  }

  // 三类下发（desktop.deliver）
  if (detail['action'] === 'deliver' && typeof detail['packageName'] === 'string') {
    return `${prefix}下发插件 ${detail['packageName']} ${String(detail['version'] ?? '')}`
  }
  if (detail['action'] === 'withdraw') {
    return `${prefix}撤掉插件 #${String(detail['pluginId'] ?? '')}`
  }
  const entryIds = asStringArray(detail['entryIds'])
  if (entryIds.length > 0) {
    return `${prefix}配置片段：${entryIds.join('、')}`
  }
  if (typeof detail['channel'] === 'string') {
    const channel = channelLabel(detail['channel'] as DesktopReleaseChannel)
    const version = detail['targetVersion']
    const min = detail['minVersion']
    const percent = percentOf(detail['rolloutPercent'])
    const parts: string[] = []
    if (typeof version === 'string') parts.push(`目标 ${version}`)
    if (typeof min === 'string') parts.push(`最低 ${min}`)
    if (percent !== null) parts.push(`灰度 ${String(percent)}%`)
    if (detail['cleared'] === true) parts.push('删掉覆盖')
    return `${prefix}${channel}渠道 ${parts.length > 0 ? parts.join(' / ') : '更新策略'}`
  }
  const add = asStringArray(detail['add'])
  const remove = asStringArray(detail['remove'])
  if (add.length > 0 || remove.length > 0) {
    const parts: string[] = []
    if (add.length > 0) parts.push(`要求卸载 ${add.join('、')}`)
    if (remove.length > 0) parts.push(`取消卸载 ${remove.join('、')}`)
    return `${prefix}${parts.join('；')}`
  }
  return `${prefix}下发（revision ${String(item.targetId ?? '')}）`
}

/** sha512 太长，列表里只留前 12 位（完整值放 title） */
export function shortHash(value: string, keep = 12): string {
  return value.length <= keep ? value : `${value.slice(0, keep)}…`
}
