import type { RolloutAction } from '@dsh-hub/shared'
import type { AppDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import type { JobHandler } from '../jobs/types.js'
import {
  latestVersionRow as latestPluginVersion,
  toPluginCard,
  getUserPluginRow,
  getVersionRow,
  requirePluginRow,
} from './repo.js'
import { toPluginVersion } from './repo.js'

/**
 * `rollout.plugin` 任务处理器（06 §5.1 §5.2）：每个用户一个 task，逐台执行
 * `plugins.installForUser`。期望状态由 rollouts 服务在创建 job **之前**写好，
 * 这里只负责按期望状态算出这次要 add/remove 什么。
 */
export interface PluginRolloutParams {
  pluginId: number
  action: RolloutAction
  versionId?: number
  /** 目标用户（已经过金丝雀排序；job_tasks 的 seq 就是它的顺序） */
  userIds: number[]
  restart: 'now' | 'next-start'
  source?: 'admin' | 'user' | 'policy'
}

export const PLUGIN_ROLLOUT_TYPE = 'rollout.plugin'

export function createPluginRolloutHandler(deps: AppDeps): JobHandler<PluginRolloutParams> {
  return {
    type: PLUGIN_ROLLOUT_TYPE,

    async plan(params) {
      const plugin = requirePluginRow(deps.db, params.pluginId)
      const version = resolveVersionLabel(deps, params)
      const actionLabel = ACTION_LABELS[params.action]
      const title = `${actionLabel}插件 ${plugin.package_name}${version ? `@${version}` : ''} · ${String(
        params.userIds.length,
      )} 个用户`
      return {
        title,
        tasks: params.userIds.map((userId) => ({ userId, payload: { userId } })),
      }
    },

    async runTask(ctx, task, params) {
      const userId = task.userId ?? readPayloadUserId(task.payload)
      if (userId === null) throw new HubError('INTERNAL', '插件下发任务缺少 userId')
      const plugin = requirePluginRow(deps.db, params.pluginId)
      const latest = latestPluginVersion(deps.db, plugin.id)

      if (params.action === 'uninstall') {
        const card = toPluginCard(plugin, latest?.version ?? null)
        ctx.log(`卸载 ${plugin.package_name}`)
        await deps.services.plugins.installForUser(
          userId,
          { add: [], remove: [card] },
          { restart: params.restart, onLog: ctx.log, signal: ctx.signal, source: params.source ?? 'admin' },
        )
        return { userId, action: 'uninstall', packageName: plugin.package_name }
      }

      const versionId =
        params.versionId ?? getUserPluginRow(deps.db, userId, plugin.id)?.desired_version_id ?? latest?.id
      if (!versionId) throw new HubError('CONFLICT', `插件 ${plugin.package_name} 没有可用版本`)
      const versionRow = getVersionRow(deps.db, versionId)
      if (!versionRow || versionRow.plugin_id !== plugin.id) {
        throw new HubError('NOT_FOUND', '插件版本不存在')
      }
      ctx.log(
        `${params.action === 'apply-config' ? '重新应用配置' : '安装'} ${plugin.package_name}@${versionRow.version}`,
      )
      await deps.services.plugins.installForUser(
        userId,
        { add: [toPluginVersion(versionRow)], remove: [] },
        { restart: params.restart, onLog: ctx.log, signal: ctx.signal, source: params.source ?? 'admin' },
      )
      return { userId, action: params.action, packageName: plugin.package_name, version: versionRow.version }
    },
  }
}

const ACTION_LABELS: Record<RolloutAction, string> = {
  install: '安装',
  upgrade: '升级',
  uninstall: '卸载',
  'apply-config': '应用配置 ',
}

function resolveVersionLabel(deps: AppDeps, params: PluginRolloutParams): string | null {
  if (params.action === 'uninstall') return null
  const versionId = params.versionId ?? latestPluginVersion(deps.db, params.pluginId)?.id
  return versionId ? (getVersionRow(deps.db, versionId)?.version ?? null) : null
}

function readPayloadUserId(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null) return null
  const value = (payload as { userId?: unknown }).userId
  return typeof value === 'number' ? value : null
}
