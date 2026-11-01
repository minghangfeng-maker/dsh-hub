import {
  AGENT_MODE_LABEL,
  AGENT_MODE_PLUGIN_PACKAGE,
  DEFAULT_AGENT_MODE_SETTINGS,
  type AgentMode,
  type AgentModeClientConfig,
  type AgentModeModelOption,
  type AgentModePlugin,
  type AgentModeSettings,
  type AgentModeStateResponse,
  type AgentModeTargets,
  type AgentModeUser,
  type AdminPluginRow,
  type DeliverAgentModeRequest,
  type MyAgentMode,
  type RelayScope,
  type UpdateAgentModeRequest,
} from '@dsh-hub/shared'
import type { AppDeps, BaseDeps, RequestMeta } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import type { JobSummary } from '@dsh-hub/shared'
import type { RelayScopeModel, RelayService } from '../relay/types.js'
import { shanghaiDay, shanghaiMonthStart } from '../relay/time.js'
import { containerEnvApplied } from './deliver.js'
import { isTargeted, modesEnv } from './env.js'
import { AGENT_MODE_ROLLOUT_TYPE } from './job.js'
import { listUserRows, userExists, type AgentModeUserRow } from './repo.js'
import { createAgentModeSettingsStore } from './settings-store.js'
import type { AgentModesService } from './types.js'

/** 两个模式（顺序 = 界面顺序与 `/api/me/relay` 的返回顺序） */
const MODES = ['claude-code', 'codex'] as const

/**
 * Claude Code / Codex 管理（18）：设置读写、状态汇总、下发任务、容器 env、插件与用户端视图。
 *
 * 为什么设置缓存放在这里而不是 relay：18 §3.2 要求 PUT 后立即失效，而 relay 的 `/v1`
 * 每个请求都要问「模式是否开通 / 用户在不在 targets」——两边各缓存一份就会有一边读到旧值。
 * relay 通过 `services.agentModes` 读这份缓存（单实例、PUT 同步刷新）。
 */
export function createAgentModesService(deps: BaseDeps): AgentModesService {
  const db = deps.db
  const clock = deps.clock
  const log = deps.logger
  const store = createAgentModeSettingsStore(db, {
    onWarn: (message, detail) => log.warn({ detail }, message),
  })

  function services(): Partial<AppDeps['services']> {
    return (deps as Partial<AppDeps>).services ?? {}
  }

  function requireRelay(): RelayService {
    const relay = services().relay
    if (!relay) throw new HubError('INTERNAL', 'relay service 未装配')
    return relay
  }

  function audit(entry: {
    actorId?: number | null
    meta?: RequestMeta
    action: string
    detail?: Record<string, unknown>
  }): void {
    deps.audit.log({
      actorId: entry.actorId ?? null,
      actorIp: entry.meta?.ip ?? null,
      action: entry.action,
      targetType: 'agent-mode',
      targetId: entry.detail?.mode === undefined ? null : String(entry.detail.mode),
      detail: entry.detail ?? null,
    })
  }

  // ── 设置 ──────────────────────────────────────────────────────────────────

  function settings(mode: AgentMode): AgentModeSettings {
    return store.get(mode)
  }

  function allSettings(): Record<AgentMode, AgentModeSettings> {
    return store.all()
  }

  function ratePermille(mode: AgentMode): number {
    return store.get(mode).ratePermille
  }

  function isOpenFor(scope: RelayScope, userId: number): boolean {
    if (scope === 'dsh') return false
    const mode: AgentMode = scope
    const current = store.get(mode)
    return current.enabled && isTargeted(current.targets, userId)
  }

  // ── 模型 ──────────────────────────────────────────────────────────────────

  /** 默认模型：设置里指定的可用模型，否则 `sort DESC, name ASC` 第一个（18 §2） */
  function electDefault(models: RelayScopeModel[], storedId: number | null): RelayScopeModel | null {
    const sorted = [...models].sort(
      (left, right) =>
        right.sort - left.sort ||
        (left.name < right.name ? -1 : left.name > right.name ? 1 : 0) ||
        left.id - right.id,
    )
    if (storedId !== null) {
      const hit = sorted.find((model) => model.id === storedId)
      if (hit) return hit
    }
    return sorted[0] ?? null
  }

  function effectiveModels(mode: AgentMode): {
    all: RelayScopeModel[]
    usable: RelayScopeModel[]
    defaultModel: RelayScopeModel | null
    smallModel: RelayScopeModel | null
  } {
    const all = requireRelay().scopeModels(mode, { userId: 0, role: 'admin' })
    const usable = all.filter((model) => model.visible && model.enabled && model.routable)
    const current = store.get(mode)
    const defaultModel = electDefault(usable, current.defaultModelId)
    const smallModel = mode === 'codex' ? null : (electDefault(usable, current.smallModelId) ?? defaultModel)
    return { all, usable, defaultModel, smallModel }
  }

  function modelOption(model: RelayScopeModel): AgentModeModelOption {
    return {
      id: model.id,
      name: model.name,
      displayName: model.displayName,
      enabled: model.enabled,
      routable: model.routable,
    }
  }

  /** 给插件的模型条目（18 §3.4） */
  function clientModels(mode: AgentMode, userId: number, role: 'user' | 'admin'): RelayScopeModel[] {
    return requireRelay()
      .scopeModels(mode, { userId, role })
      .filter((model) => model.visible && model.enabled && model.routable)
  }

  function warnings(mode: AgentMode): string[] {
    const current = store.get(mode)
    const out: string[] = []
    if (requireRelay().internalBaseUrl() === null) {
      out.push('中转站内部监听器没开，用户容器连不上中转站')
    }
    const { all, usable, defaultModel, smallModel } = effectiveModels(mode)
    if (all.length === 0) {
      out.push('这个模式还没有模型，插件里会没有模型可选')
    } else if (usable.length === 0) {
      out.push('这个模式还没有可用模型（模型要启用且有可用渠道），插件里会没有模型可选')
    }
    if (current.defaultModelId !== null && defaultModel?.id !== current.defaultModelId) {
      const stored = all.find((model) => model.id === current.defaultModelId)
      const name = stored?.name ?? '（已删除）'
      out.push(`默认模型 ${name} 已不可用，实际使用 ${defaultModel?.name ?? '（没有可用模型）'}`)
    }
    if (mode === 'claude-code' && current.smallModelId !== null && smallModel?.id !== current.smallModelId) {
      const stored = all.find((model) => model.id === current.smallModelId)
      out.push(
        `小模型 ${stored?.name ?? '（已删除）'} 已不可用，实际使用 ${smallModel?.name ?? '（没有可用模型）'}`,
      )
    }
    return out
  }

  // ── 插件 ──────────────────────────────────────────────────────────────────

  async function pluginCatalogRow(mode: AgentMode): Promise<AdminPluginRow | null> {
    const plugins = services().plugins
    if (!plugins) return null
    try {
      const rows = await plugins.listCatalog()
      return rows.find((row) => row.packageName === AGENT_MODE_PLUGIN_PACKAGE[mode]) ?? null
    } catch (error) {
      log.warn({ err: error, mode }, '读取插件库失败')
      return null
    }
  }

  function pluginDto(row: AdminPluginRow): AgentModePlugin {
    return {
      pluginId: row.id,
      packageName: row.packageName,
      latestVersion: row.latestVersion,
      policy: row.policy,
      installedUsers: row.stats.installed,
    }
  }

  /** 某插件每个用户的已安装版本（`actualVersion`；没装 / 没对账成功 = null） */
  async function installedVersionMap(pluginId: number): Promise<Map<number, string>> {
    const out = new Map<number, string>()
    const plugins = services().plugins
    if (!plugins) return out
    try {
      const items = await plugins.listUsersOfPlugin(pluginId)
      for (const item of items) {
        const version = item.row?.actualVersion ?? null
        if (version !== null) out.set(item.user.id, version)
      }
    } catch (error) {
      log.warn({ err: error, pluginId }, '读取插件安装情况失败')
    }
    return out
  }

  // ── 状态（18 §4.3）────────────────────────────────────────────────────────

  interface LastDeliver {
    jobId: number
    status: JobSummary['status']
    createdAt: string
  }

  async function lastDeliverFor(mode: AgentMode): Promise<LastDeliver | null> {
    const jobs = services().jobs
    if (!jobs) return null
    try {
      const recent = await jobs.listWithParams(AGENT_MODE_ROLLOUT_TYPE, 100)
      for (const item of recent) {
        const params = item.params as { mode?: unknown } | null
        if (params?.mode === mode) {
          return { jobId: item.job.id, status: item.job.status, createdAt: item.job.createdAt }
        }
      }
      return null
    } catch (error) {
      log.warn({ err: error, mode }, '读取最近一次模式下发任务失败')
      return null
    }
  }

  function targetIds(current: AgentModeSettings, users: AgentModeUserRow[]): Set<number> {
    if ('all' in current.targets) return new Set(users.map((row) => row.id))
    const alive = new Set(users.map((row) => row.id))
    return new Set(current.targets.userIds.filter((id) => alive.has(id)))
  }

  async function state(mode: AgentMode): Promise<AgentModeStateResponse> {
    const current = store.get(mode)
    const { all, defaultModel, smallModel } = effectiveModels(mode)
    const catalog = await pluginCatalogRow(mode)
    const outWarnings = warnings(mode)
    if (!catalog) {
      outWarnings.push(
        `插件库里还没有 ${AGENT_MODE_PLUGIN_PACKAGE[mode]}，去「插件」页上传后用户才能用这个模式`,
      )
    }

    const users = listUserRows(db)
    const byId = new Map(users.map((row) => [row.id, row]))
    const targeted = targetIds(current, users)
    const versions = catalog ? await installedVersionMap(catalog.id) : new Map<number, string>()
    const instances = services().instances
    const rows: AgentModeUser[] = []
    const runningEntries = instances ? await instances.listForAdmin({ status: 'running' }) : []
    const runningIds = new Set(runningEntries.map((entry) => entry.user.id))

    const candidateIds = new Set<number>(targeted)
    // 被移出 targets、但运行中的容器 env 里还有这个模式的用户：也要列出来，下发后去掉 env
    for (const entry of runningEntries) {
      if (candidateIds.has(entry.user.id)) continue
      const row = byId.get(entry.user.id)
      if (!row) continue
      const applied = await containerEnvApplied(deps as AppDeps, row)
      if (applied === false) candidateIds.add(row.id)
    }

    const today = shanghaiDay(clock.nowIso())
    const monthStart = shanghaiMonthStart(today)
    for (const userId of [...candidateIds].sort((left, right) => left - right)) {
      const row = byId.get(userId)
      if (!row) continue
      const running = runningIds.has(userId)
      const envApplied = running ? await containerEnvApplied(deps as AppDeps, row) : null
      const month = requireRelay().usageStats(
        { from: monthStart, to: today, userId, scope: mode },
        { scope: 'admin' },
      )
      rows.push({
        userId,
        username: row.username,
        displayName: row.display_name,
        targeted: targeted.has(userId),
        pluginVersion: versions.get(userId) ?? null,
        instanceStatus: instances?.currentStatus(userId) ?? 'absent',
        envApplied,
        monthCostMicro: month.total.costMicro,
      })
    }

    const last = await lastDeliverFor(mode)
    // 18 §4.2「待下发」：enabled / targets 改过且晚于最近一次任务，或有运行中容器的 env 未生效
    const rangeChanged =
      current.targetsUpdatedAt !== null && (last === null || current.targetsUpdatedAt > last.createdAt)
    const needs = new Set<number>()
    if (rangeChanged) {
      for (const userId of targeted) needs.add(userId)
    } else if (current.enabled) {
      // 从没改过 targets 但模式开着（手改库 / 默认值）也当作要下发一次
      if (last === null) for (const userId of targeted) needs.add(userId)
    }
    for (const row of rows) {
      if (row.envApplied === false) needs.add(row.userId)
    }

    return {
      mode,
      settings: current,
      effectiveDefaultModel: defaultModel?.name ?? null,
      effectiveSmallModel: mode === 'codex' ? null : (smallModel?.name ?? null),
      plugin: catalog ? pluginDto(catalog) : null,
      models: all.map(modelOption),
      users: rows,
      pending: needs.size > 0,
      pendingUsers: needs.size,
      lastDeliver: last,
      warnings: [...new Set(outWarnings)],
    }
  }

  // ── 修改设置 ──────────────────────────────────────────────────────────────

  function sameTargets(left: AgentModeTargets, right: AgentModeTargets): boolean {
    if ('all' in left || 'all' in right) return 'all' in left && 'all' in right
    if (left.userIds.length !== right.userIds.length) return false
    const a = [...left.userIds].sort((x, y) => x - y)
    const b = [...right.userIds].sort((x, y) => x - y)
    return a.every((value, index) => value === b[index])
  }

  function validateTargets(targets: AgentModeTargets): void {
    if ('all' in targets) return
    const missing = targets.userIds.filter((id) => !userExists(db, id))
    if (missing.length > 0) {
      const reason = `用户 ${missing.join('、')} 不存在或已删除`
      throw new HubError('VALIDATION_FAILED', reason, { fields: { targets: reason } })
    }
  }

  function validateModelId(mode: AgentMode, modelId: number | null, field: string): void {
    if (modelId === null) return
    const scopeModels = requireRelay().scopeModels(mode, { userId: 0, role: 'admin' })
    if (!scopeModels.some((model) => model.id === modelId)) {
      const reason = `模型 ${String(modelId)} 不在 ${AGENT_MODE_LABEL[mode]} 的作用域里`
      throw new HubError('VALIDATION_FAILED', reason, { fields: { [field]: reason } })
    }
  }

  function resolvedTargetIds(targets: AgentModeTargets): Set<number> {
    if ('all' in targets) return new Set(listUserRows(db).map((row) => row.id))
    return new Set(targets.userIds)
  }

  async function update(
    mode: AgentMode,
    input: UpdateAgentModeRequest,
    actorId: number,
    meta: RequestMeta,
  ): Promise<AgentModeStateResponse> {
    const current = store.get(mode)
    const next: AgentModeSettings = { ...current, targets: { ...current.targets } }
    const changed: string[] = []

    if (input.enabled !== undefined && input.enabled !== current.enabled) {
      next.enabled = input.enabled
      changed.push('enabled')
    }
    if (input.ratePermille !== undefined && input.ratePermille !== current.ratePermille) {
      next.ratePermille = input.ratePermille
      changed.push('ratePermille')
    }
    if (input.label !== undefined && input.label !== current.label) {
      next.label = input.label
      changed.push('label')
    }
    if (input.defaultModelId !== undefined && input.defaultModelId !== current.defaultModelId) {
      validateModelId(mode, input.defaultModelId, 'defaultModelId')
      next.defaultModelId = input.defaultModelId
      changed.push('defaultModelId')
    }
    if (input.smallModelId !== undefined && input.smallModelId !== current.smallModelId) {
      if (mode === 'codex') {
        const reason = 'Codex 没有小模型设置'
        throw new HubError('VALIDATION_FAILED', reason, { fields: { smallModelId: reason } })
      }
      validateModelId(mode, input.smallModelId, 'smallModelId')
      next.smallModelId = input.smallModelId
      changed.push('smallModelId')
    }
    let targetsChanged = false
    if (input.targets !== undefined && !sameTargets(input.targets, current.targets)) {
      validateTargets(input.targets)
      next.targets = input.targets
      targetsChanged = true
      changed.push('targets')
    }

    const now = clock.nowIso()
    if (changed.length > 0) {
      next.updatedAt = now
      if (targetsChanged || changed.includes('enabled')) next.targetsUpdatedAt = now
      store.write(mode, next)
    }

    if (changed.length > 0) {
      const detail: Record<string, unknown> = { mode, fields: changed }
      if (targetsChanged) {
        const before = resolvedTargetIds(current.targets)
        const after = resolvedTargetIds(next.targets)
        detail.targets = {
          added: [...after].filter((id) => !before.has(id)).sort((a, b) => a - b),
          removed: [...before].filter((id) => !after.has(id)).sort((a, b) => a - b),
        }
      }
      if (changed.includes('ratePermille')) {
        detail.ratePermille = { from: current.ratePermille, to: next.ratePermille }
      }
      if (changed.includes('enabled')) detail.enabled = { from: current.enabled, to: next.enabled }
      audit({ actorId, meta, action: 'agent-mode.update', detail })
    }
    return await state(mode)
  }

  // ── 下发 ──────────────────────────────────────────────────────────────────

  async function deliverTargetUsers(mode: AgentMode): Promise<number[]> {
    const current = store.get(mode)
    const users = listUserRows(db)
    const targeted = targetIds(current, users)
    const byId = new Map(users.map((row) => [row.id, row]))
    const result = new Set<number>(targeted)
    const instances = services().instances
    if (instances) {
      const running = await instances.listForAdmin({ status: 'running' })
      for (const entry of running) {
        if (result.has(entry.user.id)) continue
        const row = byId.get(entry.user.id)
        if (!row) continue
        if ((await containerEnvApplied(deps as AppDeps, row)) === false) result.add(row.id)
      }
    }
    return [...result].sort((left, right) => left - right)
  }

  async function deliver(
    mode: AgentMode,
    input: DeliverAgentModeRequest,
    actorId: number,
    meta: RequestMeta,
  ): Promise<{ jobId: number }> {
    const userIds = await deliverTargetUsers(mode)
    if (userIds.length === 0) {
      throw new HubError('CONFLICT', '没有需要下发的用户（先开通并选择开放给谁）')
    }
    const jobs = services().jobs
    if (!jobs) throw new HubError('INTERNAL', '任务引擎未装配')
    const job = await jobs.create({
      type: AGENT_MODE_ROLLOUT_TYPE,
      params: {
        mode,
        userIds,
        restart: input.restart,
        installPlugin: input.installPlugin,
      },
      createdBy: actorId,
    })
    audit({
      actorId,
      meta,
      action: 'agent-mode.deliver',
      detail: {
        mode,
        jobId: job.id,
        users: userIds.length,
        restart: input.restart,
        installPlugin: input.installPlugin,
      },
    })
    return { jobId: job.id }
  }

  // ── 容器 env（18 §4.1）────────────────────────────────────────────────────

  function envForUser(userId: number): Record<string, string> {
    try {
      const relay = services().relay
      if (!relay) return {}
      const internalBaseUrl = relay.internalBaseUrl()
      if (internalBaseUrl === null) return {}
      return modesEnv({
        settings: store.all(),
        userId,
        internalBaseUrl,
        keyFor: (mode) => relay.systemKeyPlain(userId, mode),
      }).env
    } catch (error) {
      log.warn({ err: error, userId }, '读取对话模式 env 失败，本次不注入')
      return {}
    }
  }

  // ── 插件 / 用户端视图 ─────────────────────────────────────────────────────

  function clientConfig(mode: AgentMode, userId: number, role: 'user' | 'admin'): AgentModeClientConfig {
    const current = store.get(mode)
    const models = clientModels(mode, userId, role)
    const defaultModel = electDefault(models, current.defaultModelId)
    const smallModel = mode === 'codex' ? null : (electDefault(models, current.smallModelId) ?? defaultModel)
    return {
      mode,
      label: current.label,
      defaultModel: defaultModel?.name ?? null,
      smallModel: smallModel?.name ?? null,
      models: models.map((model) => ({
        id: model.name,
        displayName: model.displayName,
        contextWindow: model.info.contextWindow ?? null,
        maxTokens: model.info.maxTokens ?? null,
        reasoningEfforts: model.info.reasoningEfforts ?? [],
        defaultThinking: model.defaultThinking,
      })),
      updatedAt: current.updatedAt,
    }
  }

  function myModes(userId: number, role: 'user' | 'admin'): MyAgentMode[] {
    const out: MyAgentMode[] = []
    for (const mode of MODES) {
      const current = store.get(mode)
      if (!current.enabled || !isTargeted(current.targets, userId)) continue
      const models = clientModels(mode, userId, role)
      const defaultModel = electDefault(models, current.defaultModelId)
      out.push({
        mode,
        label: current.label,
        ratePermille: current.ratePermille,
        defaultModel: defaultModel?.name ?? null,
        models: models.map((model) => ({
          name: model.name,
          displayName: model.displayName,
          apis: model.apis,
          price: model.price,
          channelRate: model.channelRate,
          info: model.info,
        })),
      })
    }
    return out
  }

  // 18 §4.1：把 env 桥注册进 models（containerEnv 叠加；容器 config_hash 因此覆盖模式 env）
  services().models?.attachAgentModeEnv((userId) => envForUser(userId))

  return {
    settings,
    allSettings,
    isOpenFor,
    ratePermille,
    envForUser,
    warnings,
    state,
    update,
    deliver,
    clientConfig,
    myModes,
    deliverTargetUsers,
  }
}

/** 18 §2 的默认设置（测试与「恢复默认」用） */
export function defaultAgentModeSettings(mode: AgentMode): AgentModeSettings {
  void mode
  return {
    ...DEFAULT_AGENT_MODE_SETTINGS,
    targets: { userIds: [] },
  }
}
