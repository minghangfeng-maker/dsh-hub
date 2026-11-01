import {
  type AdminRuntimeRow,
  type AvailableRuntimesResponse,
  type CreateRuntimeRequest,
  type CreateRuntimeResponse,
} from '@dsh-hub/shared'
import type { AppDeps, BaseDeps, RequestMeta } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { imageForVersion } from '../instances/index.js'
import { fetchAvailableVersions, type AvailableVersions } from './available.js'
import { createRuntimeBuildHandler, RUNTIME_BUILD_TYPE } from './build.js'
import {
  clearDefaultRuntimes,
  countUnpinnedUsers,
  countUsersOnRuntime,
  deleteRuntimeRow,
  getDefaultRuntimeRow,
  getRuntimeRow,
  getRuntimeRowByVersion,
  insertRuntimeRow,
  listRuntimeRows,
  toAdminRuntimeRow,
  updateRuntimeRow,
  type RuntimeRow,
} from './repo.js'
import { upgradeUser } from './upgrade.js'
import type { RuntimeService, UpgradeUserResult } from './types.js'

/**
 * DSH 版本（运行时镜像）服务（04 §4.6、06 §3；WP3 实现）。
 * 版本 = 镜像 tag `dshhub/runtime:<dsh_version>`；构建走 `runtime.build` 任务。
 */
export function createRuntimeService(deps: BaseDeps): RuntimeService {
  const db = deps.db

  function services(): Partial<AppDeps['services']> {
    return (deps as Partial<AppDeps>).services ?? {}
  }

  function audit(entry: {
    actorId?: number | null
    meta?: RequestMeta
    action: string
    targetId: number
    detail?: Record<string, unknown>
  }): void {
    deps.audit.log({
      actorId: entry.actorId ?? null,
      actorIp: entry.meta?.ip ?? null,
      action: entry.action,
      targetType: 'runtime',
      targetId: entry.targetId,
      detail: entry.detail ?? null,
    })
  }

  function requireRuntime(runtimeId: number): RuntimeRow {
    const row = getRuntimeRow(db, runtimeId)
    if (!row) throw new HubError('NOT_FOUND', 'DSH 版本不存在')
    return row
  }

  /** `usersOnIt`：钉在该版本上的用户 + （默认版本时）跟随默认的用户 */
  function usersOnIt(row: RuntimeRow): number {
    const pinned = countUsersOnRuntime(db, row.id)
    return row.is_default === 1 ? pinned + countUnpinnedUsers(db) : pinned
  }

  function dto(row: RuntimeRow): AdminRuntimeRow {
    return toAdminRuntimeRow(row, usersOnIt(row))
  }

  async function list(): Promise<AdminRuntimeRow[]> {
    return listRuntimeRows(db).map(dto)
  }

  async function get(runtimeId: number): Promise<AdminRuntimeRow> {
    return dto(requireRuntime(runtimeId))
  }

  async function updateNotes(
    runtimeId: number,
    notes: string,
    actorId: number,
    meta: RequestMeta,
  ): Promise<AdminRuntimeRow> {
    requireRuntime(runtimeId)
    updateRuntimeRow(db, runtimeId, { notes })
    audit({ actorId, meta, action: 'runtime.build', targetId: runtimeId, detail: { notesUpdated: true } })
    return dto(requireRuntime(runtimeId))
  }

  async function available(): Promise<AvailableRuntimesResponse> {
    const result: AvailableVersions = await fetchAvailableVersions(deps.config.npmRegistry)
    return result
  }

  async function create(
    input: CreateRuntimeRequest,
    actorId: number,
    meta: RequestMeta,
  ): Promise<CreateRuntimeResponse> {
    const dshVersion = input.dshVersion.trim()
    if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/u.test(dshVersion)) {
      throw new HubError('VALIDATION_FAILED', '版本号格式不合法', { fields: { dshVersion: '格式不合法' } })
    }
    const existing = getRuntimeRowByVersion(db, dshVersion)
    if (existing && existing.status !== 'failed' && existing.status !== 'retired') {
      throw new HubError(
        'CONFLICT',
        existing.status === 'ready' ? `版本 ${dshVersion} 的镜像已就绪` : `版本 ${dshVersion} 正在构建`,
      )
    }
    const at = deps.clock.nowIso()
    const runtimeId =
      existing?.id ??
      insertRuntimeRow(db, {
        dshVersion,
        image: imageForVersion(dshVersion),
        status: 'building',
        notes: input.notes ?? '',
        at,
      })
    if (existing) {
      updateRuntimeRow(db, runtimeId, { status: 'building', notes: input.notes ?? existing.notes })
    }

    const jobs = services()?.jobs
    if (!jobs) {
      updateRuntimeRow(db, runtimeId, { status: 'failed', notes: '任务引擎未装配' })
      throw new HubError('INTERNAL', '任务引擎未装配，无法创建构建任务')
    }
    let job: { id: number }
    try {
      job = await jobs.create({
        type: RUNTIME_BUILD_TYPE,
        params: { runtimeId, dshVersion },
        // 构建只有一个 task，不需要金丝雀；失败直接结束（failed）而不是暂停等管理员
        strategy: { canary: 0, concurrency: 1 },
        createdBy: actorId,
      })
    } catch (error) {
      // 建任务失败时别把行留在 building（否则同版本永远不会再被创建）
      updateRuntimeRow(db, runtimeId, {
        status: 'failed',
        notes: `创建构建任务失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
      })
      throw error
    }
    updateRuntimeRow(db, runtimeId, { buildJobId: job.id })
    audit({
      actorId,
      meta,
      action: 'runtime.build',
      targetId: runtimeId,
      detail: { dshVersion, jobId: job.id },
    })
    return { runtime: dto(requireRuntime(runtimeId)), jobId: job.id }
  }

  async function setDefault(runtimeId: number, actorId: number, meta: RequestMeta): Promise<AdminRuntimeRow> {
    const row = requireRuntime(runtimeId)
    if (row.status !== 'ready') {
      throw new HubError('RUNTIME_NOT_READY', `版本 ${row.dsh_version} 的镜像还没就绪，不能设为默认`)
    }
    db.tx(() => {
      clearDefaultRuntimes(db)
      updateRuntimeRow(db, runtimeId, { isDefault: true, status: 'ready' })
    })
    audit({
      actorId,
      meta,
      action: 'runtime.default',
      targetId: runtimeId,
      detail: { dshVersion: row.dsh_version },
    })
    return dto(requireRuntime(runtimeId))
  }

  async function retire(runtimeId: number, actorId: number, meta: RequestMeta): Promise<AdminRuntimeRow> {
    const row = requireRuntime(runtimeId)
    if (row.is_default === 1) {
      throw new HubError('CONFLICT', '默认版本不能下线，请先把别的版本设为默认')
    }
    updateRuntimeRow(db, runtimeId, { status: 'retired' })
    audit({
      actorId,
      meta,
      action: 'runtime.retire',
      targetId: runtimeId,
      detail: { dshVersion: row.dsh_version },
    })
    return dto(requireRuntime(runtimeId))
  }

  async function remove(runtimeId: number, actorId: number, meta: RequestMeta): Promise<void> {
    const row = requireRuntime(runtimeId)
    if (row.is_default === 1) throw new HubError('CONFLICT', '默认版本不能删除')
    if (row.status === 'building') throw new HubError('CONFLICT', '版本正在构建，不能删除')
    if (countUsersOnRuntime(db, runtimeId) > 0) {
      throw new HubError('CONFLICT', `还有 ${String(countUsersOnRuntime(db, runtimeId))} 个用户钉在该版本上`)
    }
    const instances = services()?.instances
    if (instances) {
      const entries = await instances.listForAdmin()
      const inUse = entries.find((entry) => entry.runtimeVersion === row.dsh_version)
      if (inUse) {
        throw new HubError('CONFLICT', `用户 ${inUse.user.username} 的容器正在使用该版本，不能删除`)
      }
    }
    try {
      await deps.driver.removeImage(row.image)
    } catch (error) {
      deps.logger.warn({ err: error, image: row.image }, '删除运行时镜像失败（继续删记录）')
    }
    deleteRuntimeRow(db, runtimeId)
    audit({
      actorId,
      meta,
      action: 'runtime.delete',
      targetId: runtimeId,
      detail: { dshVersion: row.dsh_version },
    })
  }

  async function defaultRuntime(): Promise<AdminRuntimeRow | null> {
    const row = getDefaultRuntimeRow(db)
    return row ? dto(row) : null
  }

  /** 遗留构建的说明文案（B2）：管理端在 notes 里能直接看懂 */
  const STALE_BUILD_NOTE = '构建未完成（Hub 重启对账：构建任务已不在运行）'

  /** 构建任务是否还在跑：`queued`/`running` 之外（含 paused/终态/任务不存在）都算不在跑 */
  async function buildStillRunning(jobId: number | null): Promise<boolean> {
    const jobs = services()?.jobs
    if (jobId === null || !jobs) return false
    try {
      const { job } = await jobs.get(jobId)
      return job.status === 'queued' || job.status === 'running'
    } catch {
      return false
    }
  }

  /**
   * 启动对账（WP8b B2）：`building` 是内存里的构建任务负责收尾的中间态，
   * Hub 重启后没人能再回写它（`jobs.recoverAfterRestart` 会把 running task 标失败）。
   * 这里把「构建任务已不在跑」的遗留行置为 `failed`，否则它永远卡在 building：
   * 删除 409、重新构建也会被当作「正在构建」拒绝。
   * 返回被修正的 runtime id（调用方写日志）。
   */
  async function reconcileStaleBuilds(): Promise<number[]> {
    const fixed: number[] = []
    for (const row of listRuntimeRows(db)) {
      if (row.status !== 'building') continue
      if (await buildStillRunning(row.build_job_id)) continue
      updateRuntimeRow(db, row.id, { status: 'failed', notes: STALE_BUILD_NOTE })
      fixed.push(row.id)
    }
    return fixed
  }

  async function upgrade(
    userId: number,
    runtimeId: number,
    opts?: { onLog?: (line: string) => void },
  ): Promise<UpgradeUserResult> {
    return upgradeUser(deps, userId, runtimeId, opts)
  }

  return {
    list,
    get,
    updateNotes,
    available,
    create,
    setDefault,
    retire,
    remove,
    defaultRuntime,
    upgradeUser: upgrade,
    reconcileStaleBuilds,
  }
}

export { createRuntimeBuildHandler, RUNTIME_BUILD_TYPE }
