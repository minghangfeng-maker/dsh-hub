import {
  AGENT_MODE_LABEL,
  AGENT_MODE_PLUGIN_PACKAGE,
  type AgentMode,
  type PluginVersion,
} from '@dsh-hub/shared'
import type { AppDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import type { JobHandler } from '../jobs/types.js'
import { applyAgentModeEnv } from './deliver.js'
import { isTargeted } from './env.js'

/**
 * `rollout.agent-mode`（18 §4.2）：每个用户一条 task。
 * 第 1 步按需装插件（复用 `plugins.installForUser`，与 `rollout.plugin` 同一个执行函数）；
 * 第 2 步应用 env（和 `models.applyForUser` 同样的判断，见 `deliver.ts`）。
 * 失败只影响该用户（jobs 引擎按用户串行、按策略暂停）。
 */
export interface AgentModeRolloutParams {
  mode: AgentMode
  /** 目标用户（targets ∪ 运行中容器 env 里还有这个模式的用户） */
  userIds: number[]
  restart: 'now' | 'next-start'
  /** targets 里没装插件的用户，自动安装插件库里的最新版本 */
  installPlugin: boolean
}

export const AGENT_MODE_ROLLOUT_TYPE = 'rollout.agent-mode'

export function createAgentModeRolloutHandler(deps: AppDeps): JobHandler<AgentModeRolloutParams> {
  return {
    type: AGENT_MODE_ROLLOUT_TYPE,

    async plan(params) {
      const label = AGENT_MODE_LABEL[params.mode]
      return {
        title: `下发 ${label} 配置 · ${String(params.userIds.length)} 个用户`,
        tasks: params.userIds.map((userId) => ({ userId, payload: { userId } })),
      }
    },

    async runTask(ctx, task, params) {
      const userId = task.userId ?? readPayloadUserId(task.payload)
      if (userId === null) throw new HubError('INTERNAL', '模式下发任务缺少 userId')
      const label = AGENT_MODE_LABEL[params.mode]
      const settings = deps.services.agentModes.settings(params.mode)

      let installedPlugin = false
      let installHandledRestart = false
      if (params.installPlugin && isTargeted(settings.targets, userId)) {
        const installed = await ensurePlugin(deps, params, userId, ctx)
        installedPlugin = installed.installed
        installHandledRestart = installed.restarted
      } else if (!isTargeted(settings.targets, userId)) {
        ctx.log(`用户已不在 ${label} 的开放范围里：只去掉环境变量，不装插件`)
      }

      const applied = await applyAgentModeEnv(deps, userId, {
        onLog: ctx.log,
        restart: params.restart,
        // 插件安装已经重启过一次时不再为了「装了插件」重复重启（env 若仍不一致会重建）
        forceRestart: installedPlugin && !installHandledRestart,
      })
      return {
        userId,
        mode: params.mode,
        installedPlugin,
        envApplied: applied.applied,
        recreated: applied.recreated,
        restarted: applied.restarted,
      }
    },
  }
}

interface EnsurePluginResult {
  installed: boolean
  /** 安装过程本身已经重启过 DSH（restart=now 且插件要求重启） */
  restarted: boolean
}

/** 按包名在插件库里找插件并按需装最新版（18 §4.2 第 1 步） */
async function ensurePlugin(
  deps: AppDeps,
  params: AgentModeRolloutParams,
  userId: number,
  ctx: { log: (line: string) => void; signal: AbortSignal },
): Promise<EnsurePluginResult> {
  const packageName = AGENT_MODE_PLUGIN_PACKAGE[params.mode]
  const plugins = deps.services.plugins
  if (!plugins) {
    ctx.log('插件服务未装配，跳过安装插件')
    return { installed: false, restarted: false }
  }
  const catalog = await plugins.listCatalog()
  const row = catalog.find((item) => item.packageName === packageName)
  if (!row) {
    ctx.log(`插件库里还没有 ${packageName}，跳过安装（去「插件」页上传后再下发）`)
    return { installed: false, restarted: false }
  }

  const current = await plugins.listUserPluginRows(userId)
  const state = current.find((item) => item.packageName === packageName)
  if (state?.actualVersionId != null) {
    ctx.log(`已安装 ${packageName}@${state.actualVersion ?? '—'}，跳过插件安装`)
    return { installed: false, restarted: false }
  }

  const version: PluginVersion | null =
    row.versions.find((item) => item.version === row.latestVersion) ?? row.versions[0] ?? null
  if (!version) {
    ctx.log(`${packageName} 还没有可用版本，跳过安装`)
    return { installed: false, restarted: false }
  }
  ctx.log(`安装 ${packageName}@${version.version}`)
  await plugins.installForUser(
    userId,
    { add: [version], remove: [] },
    { restart: params.restart, onLog: ctx.log, signal: ctx.signal, source: 'admin' },
  )
  // installForUser 在 restart=now 且插件要求重启时自己会重启；approximate 地按插件元信息判断，
  // 避免第 2 步为了「装了插件」再重启一次（env 真的变了仍然会重建）。
  return { installed: true, restarted: params.restart === 'now' && row.needsRestart }
}

function readPayloadUserId(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null) return null
  const value = (payload as { userId?: unknown }).userId
  return typeof value === 'number' ? value : null
}
