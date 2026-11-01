import type {
  RolloutPreviewItem,
  RolloutPreviewRequest,
  RolloutPreviewResponse,
  RolloutRequest,
  Strategy,
} from '@dsh-hub/shared'
import type { AppDeps, BaseDeps, RequestMeta } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import {
  effectiveRuntimeVersion,
  getDefaultPresetName,
  getLatestVersionId,
  getPluginRowForRollout,
  getPresetName,
  getRuntimeVersionLabel,
  getUserPluginStateRow,
  getVersionLabel,
  resolveTargetUserRows,
  writePluginDesired,
  writePresetDesired,
  writeRuntimeDesired,
  type TargetUserRow,
} from './repo.js'
import type { RolloutService } from './types.js'
import { MODELS_ROLLOUT_TYPE, type ModelsRolloutParams } from '../models/index.js'
import { PLUGIN_ROLLOUT_TYPE, type PluginRolloutParams } from '../plugins/index.js'
import { RUNTIME_ROLLOUT_TYPE, type RuntimeRolloutParams } from '../runtimes/index.js'

/**
 * 下发任务（rollout）服务（04 §4.8、06 §5.1）。
 * 流程固定为：解析 targets（金丝雀排前）→ 写期望状态 → 建 job 交给 WP4 引擎。
 * 这里**不执行**任何用户侧动作（那是各模块 JobHandler 的事）。
 */
export function createRolloutService(deps: BaseDeps): RolloutService {
  const db = deps.db
  const at = (): string => deps.clock.nowIso()

  /** 该版本是不是当前默认版本（04 §10.5 的钉版本语义） */
  function isDefaultRuntime(runtimeId: number): boolean {
    const row = db.get<{ is_default: number }>('SELECT is_default FROM runtimes WHERE id = ?', runtimeId)
    return row?.is_default === 1
  }

  function services(): Partial<AppDeps['services']> {
    return (deps as Partial<AppDeps>).services ?? {}
  }

  /** 该用户是否正在运行（决定「会不会重启」与目标过滤） */
  function isRunning(userId: number): boolean {
    const instances = services().instances
    return instances ? instances.currentStatus(userId) === 'running' : false
  }

  async function targetsFor(
    input: RolloutRequest | RolloutPreviewRequest,
    actorId: number | null,
  ): Promise<TargetUserRow[]> {
    const rows = resolveTargetUserRows(db, input.targets, actorId)
    if (input.kind === 'runtime') {
      // 钉在其它版本的用户不受「统一更新」影响（06 §3 钉版本、10 D7）
      return rows.filter((row) => row.runtime_id === null || row.runtime_id === input.runtimeId)
    }
    if (input.kind === 'plugin' && input.action === 'uninstall') {
      return rows.filter((row) => {
        const state = getUserPluginStateRow(db, row.id, input.pluginId)
        return state?.desired === 'installed' || state?.actual_version_id != null
      })
    }
    return rows
  }

  async function resolveTargets(input: RolloutRequest): Promise<number[]> {
    return (await targetsFor(input, null)).map((row) => row.id)
  }

  async function preview(
    input: RolloutPreviewRequest,
    actorId: number | null = null,
  ): Promise<RolloutPreviewResponse> {
    assertReferences(input)
    const targets = await targetsFor(input, actorId)
    const items: RolloutPreviewItem[] = targets.map((user) => previewItem(user, input))
    return { targets: items, total: items.length }
  }

  function previewItem(user: TargetUserRow, input: RolloutPreviewRequest): RolloutPreviewItem {
    const running = isRunning(user.id)
    if (input.kind === 'plugin') {
      const plugin = getPluginRowForRollout(db, input.pluginId)
      if (!plugin) throw new HubError('NOT_FOUND', '插件不存在')
      const state = getUserPluginStateRow(db, user.id, input.pluginId)
      const installedVersion =
        state?.actual_version_id != null ? (getVersionLabel(db, state.actual_version_id) ?? '已安装') : null
      const targetVersionId = input.versionId ?? getLatestVersionId(db, plugin.id)
      const targetVersion = targetVersionId ? (getVersionLabel(db, targetVersionId) ?? '未知版本') : null
      if (input.action === 'uninstall') {
        return {
          userId: user.id,
          username: user.username,
          current: installedVersion ?? '未安装',
          after: '未安装',
          willRestart: running && plugin.needs_restart === 1,
        }
      }
      const label =
        input.action === 'apply-config'
          ? `重应用配置（${targetVersion ?? '当前版本'}）`
          : `${targetVersion ?? '未知版本'}`
      return {
        userId: user.id,
        username: user.username,
        current: installedVersion ? `${plugin.package_name}@${installedVersion}` : '未安装',
        after: `${plugin.package_name}@${label}`,
        willRestart: running && plugin.needs_restart === 1,
      }
    }
    if (input.kind === 'runtime') {
      return {
        userId: user.id,
        username: user.username,
        current: effectiveRuntimeVersion(db, user) ?? '未就绪',
        after: `${getRuntimeVersionLabel(db, input.runtimeId) ?? '未知版本'}${
          isDefaultRuntime(input.runtimeId) ? '（默认版本，不钉住）' : ''
        }`,
        // disabled / 没在跑的用户只写期望状态，下次启动才生效（06 §5.1）
        willRestart: running && user.status !== 'disabled',
      }
    }
    const currentPreset =
      user.model_preset_id !== null
        ? (getPresetName(db, user.model_preset_id) ?? '未知预设')
        : `默认预设${getDefaultPresetName(db) ? `（${getDefaultPresetName(db) ?? ''}）` : ''}`
    const targetPreset =
      input.presetId === undefined
        ? `${currentPreset}（保持预设，重渲染最新配置）`
        : (getPresetName(db, input.presetId) ?? '未知预设')
    const changed =
      input.presetId === undefined
        ? true // 重渲染也算一次配置变更（可能触发重启）
        : (user.model_preset_id ?? null) !== (input.presetId ?? null)
    return {
      userId: user.id,
      username: user.username,
      current: user.model_policy === 'free' ? '自由配置（不下发）' : currentPreset,
      after: user.model_policy === 'free' ? '自由配置（不下发）' : targetPreset,
      willRestart: running && changed,
    }
  }

  /**
   * 请求里的外键必须真实存在（D9：不校验会 500）。全部抛 404 / 409，绝不落到 INTERNAL。
   * - `versionId` 必须存在且属于该插件；
   * - `runtimeId` 必须存在且镜像 ready；
   * - `presetId` 必须存在。
   */
  function assertReferences(input: RolloutRequest): void {
    if (input.kind === 'plugin') {
      const plugin = getPluginRowForRollout(db, input.pluginId)
      if (!plugin) throw new HubError('NOT_FOUND', '插件不存在')
      if (input.versionId !== undefined) {
        const version = db.get<{ plugin_id: number }>(
          'SELECT plugin_id FROM plugin_versions WHERE id = ?',
          input.versionId,
        )
        if (!version || version.plugin_id !== input.pluginId) {
          throw new HubError('NOT_FOUND', '插件版本不存在或不属于该插件')
        }
      }
      return
    }
    if (input.kind === 'runtime') {
      const row = db.get<{ status: string }>('SELECT status FROM runtimes WHERE id = ?', input.runtimeId)
      if (!row) throw new HubError('NOT_FOUND', 'DSH 版本不存在')
      if (row.status !== 'ready') {
        throw new HubError('RUNTIME_NOT_READY', '该版本的镜像还没就绪，不能下发')
      }
      return
    }
    if (input.presetId !== undefined && getPresetName(db, input.presetId) === null) {
      throw new HubError('NOT_FOUND', '模型预设不存在')
    }
  }

  async function create(
    input: RolloutRequest,
    actorId: number,
    meta: RequestMeta,
    opts: { source?: 'admin' | 'user' } = {},
  ): Promise<{ jobId: number }> {
    const source = opts.source ?? 'admin'
    assertReferences(input)
    const targets = await targetsFor(input, actorId)
    if (targets.length === 0) {
      throw new HubError('CONFLICT', '没有匹配的目标用户')
    }
    const jobs = services().jobs
    if (!jobs) throw new HubError('INTERNAL', '任务引擎未装配')
    const userIds = targets.map((row) => row.id)
    const now = at()

    // 1) 写期望状态（在一个事务里，job 建起来之前就落库）
    db.tx(() => {
      if (input.kind === 'plugin') {
        const versionId =
          input.action === 'uninstall' ? null : (input.versionId ?? getLatestVersionId(db, input.pluginId))
        if (input.action !== 'uninstall' && versionId === null) {
          throw new HubError('CONFLICT', '该插件还没有可安装的版本')
        }
        for (const userId of userIds) {
          writePluginDesired(
            db,
            userId,
            input.pluginId,
            input.action === 'uninstall' ? 'absent' : 'installed',
            versionId,
            source,
            now,
          )
        }
      } else if (input.kind === 'runtime') {
        // 04 §10.5：目标就是默认版本 → 期望状态写「跟随默认」（置空），以后换默认版本也能跟上；
        // 非默认版本才钉住
        const targetIsDefault = isDefaultRuntime(input.runtimeId)
        for (const userId of userIds) {
          writeRuntimeDesired(db, userId, targetIsDefault ? null : input.runtimeId, now)
        }
      } else if (input.presetId !== undefined) {
        // 04 §10.6：省略 presetId = 不改用户预设，只按最新配置重渲染
        for (const userId of userIds) writePresetDesired(db, userId, input.presetId, now)
      }
    })

    // 2) 建 job（title / tasks 由各模块的 JobHandler.plan 产出；金丝雀顺序 = userIds 顺序）
    const strategy: Strategy = { ...input.strategy }
    let jobId: number
    if (input.kind === 'plugin') {
      const params: PluginRolloutParams = {
        pluginId: input.pluginId,
        action: input.action,
        ...(input.versionId === undefined ? {} : { versionId: input.versionId }),
        userIds,
        restart: strategy.restart,
        source,
      }
      jobId = (await jobs.create({ type: PLUGIN_ROLLOUT_TYPE, params, strategy, createdBy: actorId })).id
    } else if (input.kind === 'runtime') {
      const params: RuntimeRolloutParams = { runtimeId: input.runtimeId, userIds }
      jobId = (await jobs.create({ type: RUNTIME_ROLLOUT_TYPE, params, strategy, createdBy: actorId })).id
    } else {
      const params: ModelsRolloutParams = { presetId: input.presetId ?? null, userIds }
      jobId = (await jobs.create({ type: MODELS_ROLLOUT_TYPE, params, strategy, createdBy: actorId })).id
    }

    deps.audit.log({
      actorId,
      actorIp: meta.ip,
      action: 'rollout.create',
      targetType: 'rollout',
      targetId: jobId,
      detail: { ...describe(input), targets: userIds.length, strategy },
    })
    return { jobId }
  }

  return { preview, create, resolveTargets }
}

function describe(input: RolloutRequest): Record<string, unknown> {
  if (input.kind === 'plugin') {
    return {
      kind: 'plugin',
      action: input.action,
      pluginId: input.pluginId,
      versionId: input.versionId ?? null,
    }
  }
  if (input.kind === 'runtime') return { kind: 'runtime', runtimeId: input.runtimeId }
  return { kind: 'models', presetId: input.presetId ?? null }
}
