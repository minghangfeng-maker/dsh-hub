import type { DeliveryCreatedResponse, DeliveryRequest } from '@dsh-hub/shared'
import type { RequestMeta } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import {
  addUninstallTarget,
  appendDelivery,
  replaceConfigFragments,
  removeUninstallTarget,
  upsertPluginTarget,
  type ScopeKey,
} from '../desktop-delivery/repo.js'
import {
  buildPlan,
  existingDesktopFragments,
  resolveDesktopSide,
  resolveInstanceSide,
  rolloutRequestFor,
  type DeliveryPlan,
  type ResolvedItem,
} from './resolve.js'
import type { PreviewDeps } from './preview.js'

/**
 * `POST /api/admin/deliveries`（交付物 3）。两种执行面：
 *
 * - **实例侧**：每个内容项一个 job，交给现有 rollout 服务（金丝雀 / 并发 / 失败比例 / 重启策略不变）。
 *   job 之间互相独立：某一条建不起来（例如目标在执行侧被过滤成 0 人）只进 `skippedItems`，不影响其它项。
 * - **桌面侧**：整次提交一个事务、一个新 revision —— 只写「期望状态」（插件目标 / 卸载 / 配置片段），
 *   设备下次心跳拉清单才会应用。事务失败则整个桌面侧回滚、**不创建** revision。
 *
 * 「部分失败」：桌面侧事务失败时，实例侧已经建好的 job 保留（它们本来就是独立任务），
 * 错误信息里写明哪边失败、实例侧留了几个任务。
 */
export async function executeDelivery(
  deps: PreviewDeps,
  request: DeliveryRequest,
  actorId: number,
  meta: RequestMeta,
): Promise<DeliveryCreatedResponse> {
  const db = deps.db
  const now = (): string => deps.clock.nowIso()
  const plan = await buildPlan(deps, request)
  const skippedItems: DeliveryCreatedResponse['skippedItems'] = []
  const jobs: DeliveryCreatedResponse['jobs'] = []
  const instanceUserIds = new Set<number>()
  const desktopUserIds = new Set<number>()
  const desktopDeviceIds = new Set<string>()
  let desktopRevision: number | null = null
  let desktopFailure: string | null = null

  // ── 1) 实例侧：每个内容项一个 job ────────────────────────────────────────
  if (plan.platforms.instance) {
    const rollouts = deps.services.rollouts
    if (!rollouts) throw new HubError('INTERNAL', 'rollouts service 未装配')
    for (const entry of plan.items) {
      const side = await resolveInstanceSide(deps, plan, entry)
      if (side.blocked !== null) {
        skippedItems.push({ itemLabel: entry.label, platform: 'instance', reason: side.blocked })
        continue
      }
      if (side.userIds.length === 0) {
        skippedItems.push({
          itemLabel: entry.label,
          platform: 'instance',
          reason: side.rows.length === 0 ? '目标解析为 0 人（没有匹配的用户）' : '解析到的目标全部被跳过',
        })
        continue
      }
      try {
        const created = await rollouts.create(rolloutRequestFor(plan, entry, side.userIds), actorId, meta)
        jobs.push({ jobId: created.jobId, itemLabel: entry.label })
        for (const userId of side.userIds) instanceUserIds.add(userId)
      } catch (error) {
        if (HubError.is(error) && error.status >= 400 && error.status < 500) {
          // 建不起来（例如「没有匹配的目标用户」）只跳过这一项，不影响其它内容项
          skippedItems.push({ itemLabel: entry.label, platform: 'instance', reason: error.message })
          continue
        }
        throw error
      }
    }
  }

  // ── 2) 桌面侧：一个事务、一个新 revision ─────────────────────────────────
  if (plan.platforms.desktop) {
    const desktopItems = plan.items.map((entry) => ({ entry, side: resolveDesktopSide(db, plan, entry) }))
    const executable = desktopItems.filter(({ side }) => side.blocked === null && side.scopes.length > 0)
    for (const { entry, side } of desktopItems) {
      if (side.blocked !== null) {
        skippedItems.push({ itemLabel: entry.desktopLabel, platform: 'desktop', reason: side.blocked })
        continue
      }
      if (side.scopes.length === 0) {
        skippedItems.push({
          itemLabel: entry.desktopLabel,
          platform: 'desktop',
          reason: side.rows.length === 0 ? '目标解析为 0 台设备' : '解析到的目标全部被跳过',
        })
      }
    }

    if (executable.length > 0) {
      const scopes = mergeScopes(executable.flatMap(({ side }) => side.scopes))
      for (const { side } of executable) {
        for (const row of side.rows) {
          if (row.skipReason !== null) continue
          desktopUserIds.add(row.target.userId)
          desktopDeviceIds.add(row.target.deviceId)
        }
      }
      const deliveryScope = deliveryScopeFor(request, scopes)
      try {
        desktopRevision = db.tx(() => {
          for (const { entry, side } of executable) {
            writeDesktopItem(db, plan, entry, side.scopes, actorId, now())
          }
          return appendDelivery(db, {
            scope: deliveryScope,
            kind: deliveryKindOf(plan),
            actorId,
            detail: {
              platforms: request.platforms,
              action: request.action,
              targets: describeTargets(request),
              items: plan.items.map((entry) => describeItem(entry)),
              // 这次发布写没写模型配置片段（relay/dsh?platform=desktop 的 lastDelivery 靠它认）
              ...(plan.items.some((entry) => entry.item.kind === 'models') ? { modelsWritten: true } : {}),
              users: sampleOf([...desktopUserIds].sort((a, b) => a - b)),
              devices: desktopDeviceIds.size,
              scopes: scopes.map((scope) => describeScope(scope)),
              routedBy: scopes.length === 1 ? 'target' : 'all',
            },
            at: now(),
          })
        })
      } catch (error) {
        desktopFailure = error instanceof Error ? error.message : String(error)
      }
    }
  }

  const detail = {
    platforms: request.platforms,
    action: request.action,
    targets: describeTargets(request),
    items: plan.items.map((entry) => describeItem(entry)),
    instance: {
      jobs: jobs.map((job) => job.jobId),
      users: sampleOf([...instanceUserIds].sort((a, b) => a - b)),
    },
    desktop:
      desktopRevision === null
        ? null
        : {
            revision: desktopRevision,
            users: sampleOf([...desktopUserIds].sort((a, b) => a - b)),
            devices: desktopDeviceIds.size,
            ...(desktopFailure === null ? {} : { failed: desktopFailure }),
          },
    skippedItems,
  }

  if (desktopFailure !== null) {
    deps.audit.log({
      actorId,
      actorIp: meta.ip,
      action: 'delivery.create',
      targetType: 'delivery',
      targetId: null,
      detail: { ...detail, outcome: 'desktop-failed' },
    })
    throw new HubError(
      'INTERNAL',
      `桌面侧下发失败，整个桌面侧已回滚（未创建桌面 revision）；实例侧已创建的 ${String(jobs.length)} 个任务保留：${desktopFailure}`,
      {
        desktopFailed: true,
        instanceJobs: jobs.map((job) => job.jobId),
        skippedItems,
      },
    )
  }

  if (jobs.length === 0 && desktopRevision === null) {
    deps.audit.log({
      actorId,
      actorIp: meta.ip,
      action: 'delivery.create',
      targetType: 'delivery',
      targetId: null,
      detail: { ...detail, outcome: 'nothing-to-run' },
    })
    throw new HubError('VALIDATION_FAILED', '没有可执行的内容项：两个平台都没有解析到能下发的目标', {
      fields: { items: '目标解析为 0，或所有内容项在当前平台上都不适用' },
      skippedItems,
    })
  }

  deps.audit.log({
    actorId,
    actorIp: meta.ip,
    action: 'delivery.create',
    targetType: 'delivery',
    targetId: desktopRevision ?? jobs[0]?.jobId ?? null,
    detail: { ...detail, outcome: 'ok' },
  })

  return {
    jobs,
    desktop:
      desktopRevision === null
        ? null
        : {
            revision: desktopRevision,
            users: desktopUserIds.size,
            devices: desktopDeviceIds.size,
          },
    skippedItems,
  }
}

// ── 桌面侧写入 ──────────────────────────────────────────────────────────────

function writeDesktopItem(
  db: PreviewDeps['db'],
  plan: DeliveryPlan,
  entry: ResolvedItem,
  scopes: ScopeKey[],
  actorId: number,
  at: string,
): void {
  const item = entry.item
  if (item.kind === 'plugin') {
    if (entry.plugin === null) return
    if (plan.request.action === 'uninstall') {
      for (const scope of scopes) {
        addUninstallTarget(db, { scope, packageName: entry.plugin.packageName, actorId, at })
      }
      return
    }
    // docs/22 §2.2：桌面目标永远写**桌面版本**（`desktopVersionId` 或桌面最新）
    if (entry.desktopVersion === null) return
    for (const scope of scopes) {
      upsertPluginTarget(db, {
        scope,
        pluginId: entry.plugin.id,
        versionId: entry.desktopVersion.id,
        enabled: true,
        actorId,
        at,
      })
      removeUninstallTarget(db, scope, entry.plugin.packageName)
    }
    return
  }

  if (item.kind === 'models') {
    const rendered = plan.modelFragments?.fragments ?? []
    if (rendered.length === 0) return
    for (const scope of scopes) {
      const existing = existingDesktopFragments(db, scope)
      const merged = existing.map((row) => ({ ...row }))
      for (const fragment of rendered) {
        const index = merged.findIndex((row) => row.entryId === fragment.id)
        const configJson = JSON.stringify(fragment.config)
        if (index >= 0) {
          // 只替换内容：模式（enforce/default）与备注保持管理员原来的选择
          merged[index] = { ...merged[index]!, configJson }
        } else {
          merged.push({ entryId: fragment.id, mode: 'enforce', configJson, note: '' })
        }
      }
      replaceConfigFragments(db, { scope, fragments: merged, actorId, at })
    }
  }
}

/** 多个内容项的作用域取并集（同一个用户多个内容项只写一次 revision 行） */
function mergeScopes(scopes: ScopeKey[]): ScopeKey[] {
  const seen = new Map<string, ScopeKey>()
  for (const scope of scopes) seen.set(scopeKeyOf(scope), scope)
  return [...seen.values()]
}

function scopeKeyOf(scope: ScopeKey): string {
  return `${scope.scope}|${scope.role}|${scope.userId ?? ''}`
}

/**
 * 发布日志的 scope：`all`/`role` 目标就是它自己；`users`/`installed` 解析成用户时——
 * 只解析出一个人就精确到 `scope=user`，多个人则用 `scope=all`（`desktop_deliveries.revision` 是主键，
 * 一次提交只能有一行；用 all 才能让所有被点到的设备跳到这个 revision）。
 */
function deliveryScopeFor(request: DeliveryRequest, scopes: ScopeKey[]): ScopeKey {
  if (request.targets.mode === 'all') return { scope: 'all', role: '', userId: null }
  if (request.targets.mode === 'role') {
    return (
      scopes.find((scope) => scope.scope === 'role') ?? { scope: 'role', role: request.targets.role, userId: null }
    )
  }
  if (scopes.length === 1) return scopes[0]!
  return { scope: 'all', role: '', userId: null }
}

function deliveryKindOf(plan: DeliveryPlan): 'plugin' | 'config' | 'uninstall' | 'mixed' {
  const kinds = new Set(plan.items.map((entry) => entry.item.kind))
  if (kinds.size > 1) return 'mixed'
  if (plan.request.action === 'uninstall') return 'uninstall'
  if (kinds.has('models')) return 'config'
  return 'plugin'
}

// ── 审计 detail 的小工具 ────────────────────────────────────────────────────

function describeTargets(request: DeliveryRequest): Record<string, unknown> {
  if (request.targets.mode === 'users') {
    return { mode: 'users', ...sampleOf(request.targets.userIds) }
  }
  if (request.targets.mode === 'role') return { mode: 'role', role: request.targets.role }
  if (request.targets.mode === 'installed') {
    return { mode: 'installed', outdatedOnly: request.targets.outdatedOnly }
  }
  return { mode: 'all' }
}

function describeItem(entry: ResolvedItem): Record<string, unknown> {
  if (entry.item.kind === 'plugin') {
    return {
      kind: 'plugin',
      pluginId: entry.plugin?.id ?? null,
      packageName: entry.plugin?.packageName ?? null,
      versionId: entry.version?.id ?? entry.item.versionId ?? null,
      version: entry.version?.version ?? null,
      // 桌面侧可能用另一个版本（同版本号允许两平台各有一条）
      desktopVersionId: entry.desktopVersion?.id ?? entry.item.desktopVersionId ?? null,
      desktopVersion: entry.desktopVersion?.version ?? null,
    }
  }
  if (entry.item.kind === 'models') {
    return { kind: 'models', presetId: entry.item.presetId ?? null, presetName: entry.preset?.name ?? null }
  }
  return { kind: 'runtime', runtimeId: entry.runtime?.id ?? null, version: entry.runtime?.version ?? null }
}

function describeScope(scope: ScopeKey): string {
  if (scope.scope === 'all') return 'all'
  if (scope.scope === 'role') return `role:${scope.role}`
  return `user:${String(scope.userId)}`
}

/** 「解析人数」：超过 50 只记前 50 + 总数（交付物 3 的审计要求） */
function sampleOf(ids: number[], limit = 50): { count: number; sample: number[]; truncated: boolean } {
  return { count: ids.length, sample: ids.slice(0, limit), truncated: ids.length > limit }
}
