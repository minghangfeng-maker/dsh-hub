import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, relative, sep } from 'node:path'
import {
  DELETED_USERNAME_SUFFIX,
  QuotaSchema,
  USER_TRASH_RETENTION_DAYS,
  type AdminOverviewResponse,
  type AdminUserResponse,
  type CreateUserRequest,
  type CreateUserResponse,
  type DeletedUserItem,
  type DeletedUserListQuery,
  type DeletedUserListResponse,
  type DeleteUserQuery,
  type ResetPasswordResponse,
  type RestoreUserRequest,
  type RevokeSessionsResponse,
  type RoleLabelListResponse,
  type UpdateUserRequest,
  type UserAdminView,
  type UserDetailResponse,
  type UserListQuery,
  type UserListResponse,
  type UserPluginRow,
  type UserProviderKey,
} from '@dsh-hub/shared'
import type { AppDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { newSlug, newTempPassword } from '../../lib/ids.js'
import { checkPasswordStrength, hashPassword } from '../../lib/password.js'
import { isInside, resolveInside } from '../../lib/paths.js'
import { normalizeRoleLabel } from '../../lib/role-label.js'
import { revokeUserSessions } from '../../lib/session.js'
import { resolveInstanceSummary } from '../../lib/instance-view.js'
import type { HostSnapshot } from '../instances/types.js'
import { assertUsernameAvailable, normalizeUsername } from '../../lib/usernames.js'
import { findUserById, resolveQuota, toUserPublic, type UserRecord } from '../../lib/user-view.js'
import { isoPlusMs } from '../../lib/clock.js'
import {
  auditForUser,
  countActiveAdmins,
  countUserSessions,
  hasTable,
  insertUserAsAdmin,
  listDeletedUsers,
  listExpiredDeletedUsers,
  listRoleLabels,
  listUsers,
  markUserDeleted,
  markUserPurged,
  recentAudit,
  recentRegistrations,
  restoreUserRecord,
  setPasswordAndRevokeFlag,
  setTrashDir,
  updateUserAsAdmin,
  userStats,
} from './repo.js'
import type { AdminActor, AdminUsersService } from './types.js'

/**
 * 管理端用户服务（04 §4.1 §4.2）。用户统计与最近注册/审计由本包实现；
 * 实例/宿主/任务/版本相关字段归 WP2/WP3/WP4，这里按 0/null 占位（任务书）。
 *
 * 「最后一个管理员」保护贯穿三处：降级、停用、删除——否则系统会锁死自己。
 */
export function createAdminUsersService(deps: AppDeps): AdminUsersService {
  const { db, clock, settings, audit, paths } = deps

  /**
   * 座舱令牌（WP56b / docs/24 §3.3）：账号被降级 / 停用 / 删除时立即作废，
   * 并通知手机通道给座舱通道发 `bye`。座舱令牌不跟 cookie 会话走，所以必须在这里显式吊销。
   */
  function revokeCockpitAccess(targetId: number, reason: 'demoted' | 'deleted'): void {
    const revoked = deps.services.cockpitAuth?.revokeForAdmin(targetId, reason) ?? 0
    if (revoked > 0) deps.events.emit('cockpit.admin-logout', { adminId: targetId })
  }

  function loadUser(userId: number): UserRecord {
    const row = findUserById(db, userId)
    if (!row || row.deleted_at) throw new HubError('NOT_FOUND', '用户不存在')
    return row
  }

  /** users 行 → `UserAdminView`（04 §0.1；实例摘要在 WP2 就绪前自动退化成 absent） */
  async function toAdminView(row: UserRecord): Promise<UserAdminView> {
    const { quota, isDefault } = resolveQuota(row.quota_json, settings.get('default_quota'), (message) =>
      deps.logger.warn({ userId: row.id }, message),
    )
    return {
      ...toUserPublic(row),
      roleLabel: row.role === 'admin' ? '' : row.role_label,
      quota,
      quotaIsDefault: isDefault,
      runtimeId: row.runtime_id,
      modelPresetId: row.model_preset_id,
      modelPolicy: row.model_policy,
      instance: await resolveInstanceSummary(deps, row.id, row.username),
      lastLoginIp: row.last_login_ip,
      deletedAt: row.deleted_at,
    }
  }

  /** 概览的 `instances` 字段（04 §4.1 §10.9）：WP2 的 `counts()` */
  async function instancesOverview(): Promise<{
    running: number
    max: number
    starting: number
    error: number
  }> {
    try {
      return deps.services.instances.counts()
    } catch (error) {
      deps.logger.debug({ err: error }, '实例计数不可用')
      return { running: 0, max: settings.get('capacity').maxRunning, starting: 0, error: 0 }
    }
  }

  /** 概览的 `host` 字段（04 §4.1 §10.9）：WP2 的 `hostSnapshot()` */
  async function hostOverview(): Promise<HostSnapshot> {
    try {
      return await deps.services.instances.hostSnapshot()
    } catch (error) {
      deps.logger.debug({ err: error }, '宿主快照不可用')
      return {
        cpuCount: 0,
        load1: 0,
        load5: 0,
        memTotal: 0,
        memAvailable: 0,
        diskTotal: 0,
        diskFree: 0,
        dockerOk: false,
        dockerVersion: null,
      }
    }
  }

  /** 概览的 `runtime` 字段（04 §4.1）：默认版本 + 版本总数 */
  async function runtimeOverview(): Promise<{ defaultVersion: string | null; versions: number }> {
    try {
      const [rows, fallback] = await Promise.all([
        deps.services.runtimes.list(),
        deps.services.runtimes.defaultRuntime(),
      ])
      return { defaultVersion: fallback?.dshVersion ?? null, versions: rows.length }
    } catch (error) {
      deps.logger.debug({ err: error }, '运行时版本列表不可用')
      return { defaultVersion: null, versions: 0 }
    }
  }

  function assertLastAdminSafe(row: UserRecord, action: 'demote' | 'disable' | 'delete'): void {
    if (row.role !== 'admin' || row.status !== 'active') return
    if (countActiveAdmins(db) > 1) return
    const label = action === 'demote' ? '降级' : action === 'disable' ? '停用' : '删除'
    throw new HubError('CONFLICT', `系统至少需要保留一个可用的管理员，不能${label}最后一个管理员`)
  }

  // ── 用户回收站（WP22 / 迁移 006） ──────────────────────────────────────────

  const DAY_MS = 86_400_000
  const RETENTION_MS = USER_TRASH_RETENTION_DAYS * DAY_MS

  /** 删除时的原名：优先 `deleted_username`（迁移 006 回填），缺失时从墓碑名还原 */
  function originalUsernameOf(row: UserRecord): string {
    if (row.deleted_username) return row.deleted_username
    const marker = row.username.indexOf(DELETED_USERNAME_SUFFIX)
    return marker > 0 ? row.username.slice(0, marker) : row.username
  }

  /** 可恢复截止时间 = 删除时间 + 保留期（03 §2 / 10 §G2） */
  function restorableUntilOf(row: UserRecord): string {
    return isoPlusMs(row.deleted_at!, RETENTION_MS)
  }

  /**
   * `trash_dir` → 绝对路径。缺失/非法/不在 `trash/` 下时返回 null（列表/恢复都不能被一条脏数据炸掉）。
   * 只允许访问回收站根目录内的路径，避免配置文件被篡改后删/搬走别的数据。
   */
  function trashPathOf(row: UserRecord): string | null {
    if (!row.trash_dir) return null
    try {
      const abs = resolveInside(paths.root, row.trash_dir)
      if (!isInside(paths.trashDir, abs)) {
        deps.logger.warn({ userId: row.id, trashDir: row.trash_dir }, '回收站路径不在 trash/ 下，已忽略')
        return null
      }
      return abs
    } catch (error) {
      deps.logger.warn({ err: error, userId: row.id, trashDir: row.trash_dir }, '回收站路径不合法，已忽略')
      return null
    }
  }

  /** 回收站数据目录是否还在（列表里的「数据」列） */
  function dataInTrash(row: UserRecord): boolean {
    const abs = trashPathOf(row)
    if (!abs) return false
    try {
      return existsSync(abs) && statSync(abs).isDirectory()
    } catch {
      return false
    }
  }

  function toDeletedItem(row: UserRecord): DeletedUserItem {
    const until = restorableUntilOf(row)
    const daysLeft = Math.ceil((Date.parse(until) - Date.parse(clock.nowIso())) / DAY_MS)
    return {
      id: row.id,
      slug: row.slug,
      username: originalUsernameOf(row),
      displayName: row.display_name,
      role: row.role,
      roleLabel: row.role === 'admin' ? '' : row.role_label,
      status: row.status,
      deletedAt: row.deleted_at!,
      deletedFromStatus: row.deleted_from_status,
      dataInTrash: dataInTrash(row),
      restorableUntil: until,
      daysLeft,
    }
  }

  /** 删除前的状态：恢复后回到它（存量数据/异常值按 active，与任务书口径一致） */
  function restoredStatusOf(value: string | null): 'pending' | 'active' | 'disabled' {
    return value === 'pending' || value === 'disabled' ? value : 'active'
  }

  /** 取回收站行；不存在 → 404，未删除 → CONFLICT（04 §4.2） */
  function recycleBinRow(userId: number): UserRecord {
    const row = findUserById(db, userId)
    if (!row) throw new HubError('NOT_FOUND', '用户不存在')
    if (!row.deleted_at) throw new HubError('CONFLICT', '该用户不在回收站')
    return row
  }

  /**
   * 彻底删除一条回收站记录：删 trash 数据目录 → `purged_at` 置位 → 审计（`user.purge`）。
   * 数据目录删除失败只记日志、不阻断（否则列表里会永远留一条删不掉的记录）。
   */
  function purgeTrashRow(row: UserRecord, actor: AdminActor | null, reason: 'manual' | 'expired'): void {
    const now = clock.nowIso()
    const abs = trashPathOf(row)
    let dataDeleted = false
    let dataError: string | null = null
    if (abs) {
      try {
        if (existsSync(abs)) rmSync(abs, { recursive: true, force: true })
        dataDeleted = true
      } catch (error) {
        dataError = error instanceof Error ? error.message : String(error)
        deps.logger.warn({ err: error, userId: row.id, trashDir: row.trash_dir }, '彻底删除用户数据目录失败')
      }
    }
    markUserPurged(db, row.id, now)
    // 彻底删除：设备行 + 令牌 + 插件清单物理删除（外键 CASCADE），与 D6 §7.2 一致
    deps.services.desktop?.purgeUser(row.id)
    audit.log({
      actorId: actor?.actorId ?? null,
      actorIp: actor?.ip ?? null,
      action: 'user.purge',
      targetType: 'user',
      targetId: row.id,
      detail: {
        username: originalUsernameOf(row),
        deletedAt: row.deleted_at,
        trashDir: row.trash_dir,
        reason,
        dataDeleted,
        dataError,
      },
    })
  }

  return {
    async overview(): Promise<AdminOverviewResponse> {
      const todayStart = `${clock.nowIso().slice(0, 10)}T00:00:00.000Z`
      const users = userStats(db, todayStart)
      const registrations = await Promise.all(recentRegistrations(db, 8).map((row) => toAdminView(row)))
      const [instances, host] = await Promise.all([instancesOverview(), hostOverview()])
      // 桌面设备计数（WP25e 交付物 4）：读不通不该让概览页 500，降级为「不带这个键」
      let desktop: AdminOverviewResponse['desktop']
      try {
        desktop = deps.services.desktop?.overview()
      } catch (error) {
        deps.logger.warn({ err: error }, '概览：桌面设备计数读取失败')
      }
      return {
        users,
        instances,
        host,
        ...(desktop === undefined ? {} : { desktop }),
        // WP4 已实现：口径见 04 §9 第 6 条（failedLast24h = 24h 内 finished_at 且 failed|partial）
        jobs: deps.services.jobs.overviewCounts(),
        // 版本目录归 WP3（runtimes）；服务异常时降级为「没有版本」，不让概览页 500
        runtime: await runtimeOverview(),
        recent: { registrations, audit: recentAudit(db, 8) },
      }
    },

    async listUsers(query: UserListQuery): Promise<UserListResponse> {
      const { rows, total } = listUsers(db, {
        q: query.q,
        status: query.status,
        role: query.role,
        roleLabel: query.roleLabel,
        instance: query.instance,
        sort: query.sort,
        page: query.page,
        pageSize: query.pageSize,
        withInstances: hasTable(db, 'instances'),
      })
      return {
        items: await Promise.all(rows.map((row) => toAdminView(row))),
        total,
        page: query.page,
        pageSize: query.pageSize,
      }
    },

    async roleLabels(): Promise<RoleLabelListResponse> {
      return { items: listRoleLabels(db) }
    },

    async createUser(input: CreateUserRequest, actor: AdminActor): Promise<CreateUserResponse> {
      assertUsernameAvailable(db, input.username)
      const role = input.role ?? 'user'
      // 管理员不带标签（界面上统一叫「管理员」）
      const roleLabel = role === 'admin' ? '' : normalizeRoleLabel(input.roleLabel ?? '')
      const now = clock.nowIso()
      let tempPassword: string | undefined
      if (input.password === undefined) {
        tempPassword = newTempPassword(14)
      } else {
        const reasons = checkPasswordStrength(input.password, input.username)
        if (reasons.length > 0) throw new HubError('WEAK_PASSWORD', undefined, { reasons })
      }
      const password = input.password ?? tempPassword!
      const userId = insertUserAsAdmin(db, {
        slug: newSlug(),
        username: input.username,
        displayName: input.displayName?.trim() || input.username,
        passwordHash: hashPassword(password),
        role,
        roleLabel,
        mustChangePassword: tempPassword !== undefined,
        at: now,
      })
      audit.log({
        actorId: actor.actorId,
        actorIp: actor.ip,
        // 04 §7 的 user.create（2026-10-12 编排者裁决新增，与 auth.register 区分开）
        action: 'user.create',
        targetType: 'user',
        targetId: userId,
        detail: { username: input.username, role, roleLabel, tempPassword: !!tempPassword },
      })
      const row = findUserById(db, userId)!
      return { user: await toAdminView(row), ...(tempPassword ? { tempPassword } : {}) }
    },

    async getUser(userId: number): Promise<UserDetailResponse> {
      const row = loadUser(userId)
      const now = clock.nowIso()
      // 单用户插件状态归 WP3（`plugins.listUserPluginRows`）；插件服务不可用时降级为空数组
      let plugins: UserPluginRow[] = []
      try {
        plugins = await deps.services.plugins.listUserPluginRows(userId)
      } catch (error) {
        deps.logger.debug({ err: error, userId }, '插件列表不可用')
      }
      // 04 §10.3：per-user 提供方的密钥状态（只给 {set,last4}，永不回显明文）
      let providerKeys: UserProviderKey[] = []
      try {
        providerKeys = await deps.services.models.providerKeysForUser(userId)
      } catch (error) {
        deps.logger.debug({ err: error, userId }, '提供方密钥状态不可用')
      }
      return {
        user: await toAdminView(row),
        plugins,
        providerKeys,
        sessions: countUserSessions(db, userId, now),
        recentAudit: auditForUser(db, userId, 20),
      }
    },

    async updateUser(
      userId: number,
      input: UpdateUserRequest,
      actor: AdminActor,
    ): Promise<AdminUserResponse> {
      const row = loadUser(userId)
      const now = clock.nowIso()
      const patch: Parameters<typeof updateUserAsAdmin>[2] = { at: now }
      let touched = false

      // 角色与标签一起算：升为管理员时清空标签；只改标签也记 user.role.change
      const nextRole = input.role ?? row.role
      const nextLabel =
        nextRole === 'admin'
          ? ''
          : input.roleLabel !== undefined
            ? normalizeRoleLabel(input.roleLabel)
            : row.role_label
      if (nextRole !== row.role || nextLabel !== row.role_label) {
        if (nextRole !== row.role) {
          if (nextRole === 'user') assertLastAdminSafe(row, 'demote')
          patch.role = nextRole
          // 降级 = 交还管理权限：座舱令牌立即作废
          if (nextRole === 'user') revokeCockpitAccess(userId, 'demoted')
        }
        if (nextLabel !== row.role_label) patch.roleLabel = nextLabel
        touched = true
        audit.log({
          actorId: actor.actorId,
          actorIp: actor.ip,
          action: 'user.role.change',
          targetType: 'user',
          targetId: userId,
          detail: { from: row.role, to: nextRole, fromLabel: row.role_label, toLabel: nextLabel },
        })
      }

      if (input.status !== undefined && input.status !== row.status) {
        if (input.status !== 'active') assertLastAdminSafe(row, 'disable')
        patch.status = input.status
        touched = true
        // 04 §7 的动作按语义挑：停用/启用/审批，其余（例如退回 pending）记 user.update
        const action =
          input.status === 'disabled'
            ? 'user.disable'
            : input.status === 'active'
              ? row.status === 'pending'
                ? 'user.approve'
                : 'user.enable'
              : 'user.update'
        audit.log({
          actorId: actor.actorId,
          actorIp: actor.ip,
          action,
          targetType: 'user',
          targetId: userId,
          detail: { from: row.status, to: input.status },
        })
        // 停用 / 退回待审批：桌面端令牌与设备密钥立刻作废，设备行也标吊销（WP25a 交付物 8）。
        // 重新启用后设备仍是吊销状态，用户重新登录即建新设备（D6 §7.2 的口径）。
        if (input.status !== 'active') {
          deps.services.desktop?.revokeAllForUser(userId, 'user-disabled')
          revokeCockpitAccess(userId, 'demoted')
        }
      }

      if (input.displayName !== undefined && input.displayName !== row.display_name) {
        patch.displayName = input.displayName
        touched = true
      }

      if (input.quota !== undefined) {
        if (input.quota === null) {
          patch.quotaJson = null
        } else {
          // 与当前生效配额合并后整体校验（PATCH 语义：只改给出的字段）
          const current = resolveQuota(row.quota_json, settings.get('default_quota')).quota
          patch.quotaJson = JSON.stringify(QuotaSchema.parse({ ...current, ...input.quota }))
        }
        touched = true
        audit.log({
          actorId: actor.actorId,
          actorIp: actor.ip,
          action: 'user.quota.change',
          targetType: 'user',
          targetId: userId,
          detail: { quota: patch.quotaJson ? (JSON.parse(patch.quotaJson) as unknown) : null },
        })
      }

      if (input.runtimeId !== undefined && input.runtimeId !== row.runtime_id) {
        patch.runtimeId = input.runtimeId
        touched = true
      }
      if (input.modelPresetId !== undefined && input.modelPresetId !== row.model_preset_id) {
        patch.modelPresetId = input.modelPresetId
        touched = true
      }
      if (input.modelPolicy !== undefined && input.modelPolicy !== row.model_policy) {
        patch.modelPolicy = input.modelPolicy
        touched = true
      }

      if (touched) {
        updateUserAsAdmin(db, userId, patch)
        audit.log({
          actorId: actor.actorId,
          actorIp: actor.ip,
          action: 'user.update',
          targetType: 'user',
          targetId: userId,
          detail: {
            displayName: patch.displayName,
            runtimeId: patch.runtimeId,
            modelPresetId: patch.modelPresetId,
            modelPolicy: patch.modelPolicy,
          },
        })
      }
      return { user: await toAdminView(loadUser(userId)) }
    },

    async approve(userId: number, actor: AdminActor): Promise<AdminUserResponse> {
      const row = loadUser(userId)
      if (row.status !== 'pending') throw new HubError('CONFLICT', '该用户不处于待审批状态')
      updateUserAsAdmin(db, userId, { status: 'active', at: clock.nowIso() })
      audit.log({
        actorId: actor.actorId,
        actorIp: actor.ip,
        action: 'user.approve',
        targetType: 'user',
        targetId: userId,
        detail: { username: row.username },
      })
      return { user: await toAdminView(loadUser(userId)) }
    },

    async resetPassword(userId: number, actor: AdminActor): Promise<ResetPasswordResponse> {
      const row = loadUser(userId)
      const tempPassword = newTempPassword(14)
      const now = clock.nowIso()
      setPasswordAndRevokeFlag(db, userId, hashPassword(tempPassword), now)
      const revoked = revokeUserSessions(db, userId, now)
      audit.log({
        actorId: actor.actorId,
        actorIp: actor.ip,
        action: 'user.password.reset',
        targetType: 'user',
        targetId: userId,
        detail: { username: row.username, revokedSessions: revoked },
      })
      return { tempPassword }
    },

    async revokeSessions(userId: number, actor: AdminActor): Promise<RevokeSessionsResponse> {
      const row = loadUser(userId)
      const revoked = revokeUserSessions(db, userId, clock.nowIso())
      audit.log({
        actorId: actor.actorId,
        actorIp: actor.ip,
        action: 'user.sessions.revoke',
        targetType: 'user',
        targetId: userId,
        detail: { username: row.username, revoked },
      })
      return { revoked }
    },

    async deleteUser(userId: number, query: DeleteUserQuery, actor: AdminActor): Promise<void> {
      const row = loadUser(userId)
      // 先判「最后一个管理员」再判「不能删自己」：两者同时成立时，前者给的信息更有用
      assertLastAdminSafe(row, 'delete')
      if (userId === actor.actorId) throw new HubError('FORBIDDEN', '不能删除自己的账号')

      const now = clock.nowIso()
      // 软删除的同时立即释放用户名（墓碑名不满足 USERNAME_REGEX）：删完马上能建同名新用户
      const tombstoneUsername = markUserDeleted(db, userId, {
        username: row.username,
        fromStatus: row.status,
        at: now,
      })
      const revoked = revokeUserSessions(db, userId, now)
      // 桌面设备一并吊销（D6 §7.2 与 instances.removeUserData 并列）；恢复后设备仍是吊销态
      deps.services.desktop?.revokeAllForUser(userId, 'user-deleted')
      revokeCockpitAccess(userId, 'deleted')

      // 容器与数据目录归 WP2（removeUserData）；清理失败不能挡住软删除与用户名释放
      let cleanupError: string | null = null
      let trashDir: string | null = null
      try {
        const cleanup = await deps.services.instances.removeUserData(userId, { purge: query.purge })
        if (cleanup.trashPath) {
          // 只存相对 HUB_DATA_DIR 的路径，且必须落在 trash/ 下（恢复时按同样规则解析）
          if (isInside(paths.root, cleanup.trashPath) && isInside(paths.trashDir, cleanup.trashPath)) {
            trashDir = relative(paths.root, cleanup.trashPath).split(sep).join('/')
            setTrashDir(db, userId, trashDir, now)
          } else {
            deps.logger.warn({ userId, trashPath: cleanup.trashPath }, '回收站数据目录越界，未记录')
          }
        }
      } catch (error) {
        cleanupError = error instanceof Error ? error.message : String(error)
        deps.logger.warn({ err: error, userId, purge: query.purge }, '删除用户时清理实例数据失败')
      }
      // purge=true：数据已直接删掉，不进回收站（04 §8.9）
      if (query.purge) markUserPurged(db, userId, now)

      audit.log({
        actorId: actor.actorId,
        actorIp: actor.ip,
        action: 'user.delete',
        targetType: 'user',
        targetId: userId,
        detail: {
          username: row.username,
          /** 删除时原名（写入 deleted_username，回收站展示/恢复默认名） */
          deletedUsername: row.username,
          /** 原名已即时释放，可立即用于注册/建号（墓碑名留在 users.username） */
          releasedUsername: true,
          tombstoneUsername,
          purge: query.purge,
          trashDir,
          purged: query.purge,
          revokedSessions: revoked,
          cleanupError,
        },
      })
    },

    async listDeletedUsers(query: DeletedUserListQuery): Promise<DeletedUserListResponse> {
      const { rows, total } = listDeletedUsers(db, {
        q: query.q,
        page: query.page,
        pageSize: query.pageSize,
      })
      return {
        items: rows.map(toDeletedItem),
        total,
        page: query.page,
        pageSize: query.pageSize,
      }
    },

    async restoreUser(
      userId: number,
      input: RestoreUserRequest,
      actor: AdminActor,
    ): Promise<AdminUserResponse> {
      const row = recycleBinRow(userId)
      if (row.purged_at) throw new HubError('CONFLICT', '该用户已彻底删除，无法恢复')
      const now = clock.nowIso()
      const deletedAtMs = row.deleted_at ? Date.parse(row.deleted_at) : Number.NaN
      if (Number.isNaN(deletedAtMs) || Date.parse(now) - deletedAtMs >= RETENTION_MS) {
        throw new HubError('CONFLICT', `已超过 ${USER_TRASH_RETENTION_DAYS} 天保留期，无法恢复`)
      }

      // 不给用户名就用删除时原名；原名可能已被新用户占用，此时管理员必须指定新用户名
      const previousUsername = originalUsernameOf(row)
      const username = normalizeUsername(input.username ?? previousUsername)
      try {
        assertUsernameAvailable(db, username, userId)
      } catch (error) {
        if (HubError.is(error) && error.code === 'USERNAME_TAKEN') {
          throw new HubError('USERNAME_TAKEN', `用户名 ${username} 已被占用，请为这个用户指定新用户名`)
        }
        throw error
      }

      // 数据目录：trash/ → users/<slug>。目标已存在或文件操作失败都不阻断恢复
      // （恢复后首次打开实例会重新建目录），只记日志与审计 detail。
      let dataRestored = false
      const trashPath = trashPathOf(row)
      if (trashPath && existsSync(trashPath)) {
        const target = paths.userDir(row.slug)
        try {
          if (existsSync(target)) {
            deps.logger.warn({ userId, slug: row.slug }, '恢复用户时目标数据目录已存在，跳过数据搬回')
          } else {
            mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
            renameSync(trashPath, target)
            dataRestored = true
          }
        } catch (error) {
          deps.logger.warn({ err: error, userId, slug: row.slug }, '恢复用户数据目录失败，跳过（不影响恢复）')
        }
      }

      const status = restoredStatusOf(row.deleted_from_status)
      restoreUserRecord(db, userId, { username, status, at: now })
      audit.log({
        actorId: actor.actorId,
        actorIp: actor.ip,
        action: 'user.restore',
        targetType: 'user',
        targetId: userId,
        detail: { username, previousUsername, renamed: username !== previousUsername, dataRestored },
      })
      return { user: await toAdminView(findUserById(db, userId)!) }
    },

    async purgeUser(userId: number, actor: AdminActor): Promise<void> {
      const row = recycleBinRow(userId)
      if (row.purged_at) throw new HubError('CONFLICT', '该用户已彻底删除')
      purgeTrashRow(row, actor, 'manual')
    },

    /** 超过保留期的回收站条目：自动彻底删除（actor 为 null，detail.reason='expired'） */
    async sweepExpiredDeletions(): Promise<{ purged: number; failed: number }> {
      const cutoff = isoPlusMs(clock.nowIso(), -RETENTION_MS)
      const rows = listExpiredDeletedUsers(db, cutoff)
      let purged = 0
      let failed = 0
      for (const row of rows) {
        try {
          purgeTrashRow(row, null, 'expired')
          purged += 1
        } catch (error) {
          failed += 1
          deps.logger.warn({ err: error, userId: row.id }, '自动清理过期回收站用户失败')
        }
      }
      if (purged > 0 || failed > 0) deps.logger.info({ purged, failed }, '回收站过期清理完成')
      return { purged, failed }
    },
  }
}
