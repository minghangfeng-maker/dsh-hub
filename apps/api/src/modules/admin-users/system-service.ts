import {
  type AuditListQuery,
  type AuditListResponse,
  type CreateInvitesRequest,
  type CreateInvitesResponse,
  type InviteResponse,
  type InviteRow,
  type InviteListQuery,
  type InviteListResponse,
  type SettingsResponse,
  type UpdateInviteRequest,
  type UpdateSettingsRequest,
} from '@dsh-hub/shared'
import type { AppDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { newInviteCode } from '../../lib/ids.js'
import { normalizeRoleLabel } from '../../lib/role-label.js'
import {
  deleteInvite,
  findInviteById,
  findInviteByCode,
  insertInvite,
  listAudit,
  listInviteUses,
  listInvites,
  updateInvite,
  type InviteRecord,
} from './repo.js'
import type { AdminActor, SystemService } from './types.js'

/** 邀请码 / 系统设置 / 审计查询（04 §4.4）+ 公共站点信息（04 §1） */
export function createSystemService(deps: AppDeps): SystemService {
  const { db, clock, settings, audit } = deps

  /** 生成不重复的邀请码（12 位、去掉易混字符；碰撞概率极低，仍兜 10 次） */
  function generateCode(): string {
    for (let i = 0; i < 10; i += 1) {
      const code = newInviteCode()
      if (!findInviteByCode(db, code)) return code
    }
    throw new HubError('INTERNAL', '邀请码生成冲突，请重试')
  }

  function toInviteRow(record: InviteRecord, uses: InviteRow['uses']): InviteRow {
    return {
      id: record.id,
      code: record.code,
      note: record.note,
      maxUses: record.max_uses,
      usedCount: record.used_count,
      expiresAt: record.expires_at,
      disabled: record.disabled === 1,
      createdBy: record.created_by,
      createdAt: record.created_at,
      roleLabel: record.role_label,
      uses,
    }
  }

  function loadInvite(inviteId: number): InviteRecord {
    const row = findInviteById(db, inviteId)
    if (!row) throw new HubError('NOT_FOUND', '邀请码不存在')
    return row
  }

  function usesOf(records: InviteRecord[]): Map<number, InviteRow['uses']> {
    const grouped = new Map<number, InviteRow['uses']>()
    for (const use of listInviteUses(
      db,
      records.map((r) => r.id),
    )) {
      const list = grouped.get(use.invite_id) ?? []
      list.push({ userId: use.user_id, username: use.username ?? `#${use.user_id}`, usedAt: use.used_at })
      grouped.set(use.invite_id, list)
    }
    return grouped
  }

  return {
    async listInvites(query: InviteListQuery): Promise<InviteListResponse> {
      const { rows, total } = listInvites(db, query.page, query.pageSize)
      const grouped = usesOf(rows)
      return {
        items: rows.map((row) => toInviteRow(row, grouped.get(row.id) ?? [])),
        total,
        page: query.page,
        pageSize: query.pageSize,
      }
    },

    async createInvites(input: CreateInvitesRequest, actor: AdminActor): Promise<CreateInvitesResponse> {
      const now = clock.nowIso()
      // 注册时按码上的 role_label 给角色；「管理员」在这里就被拒掉（邀请码永远只发普通用户）
      const roleLabel = normalizeRoleLabel(input.roleLabel)
      const ids: number[] = []
      db.tx(() => {
        for (let i = 0; i < input.count; i += 1) {
          ids.push(
            insertInvite(db, {
              code: generateCode(),
              note: input.note,
              maxUses: input.maxUses,
              expiresAt: input.expiresAt ?? null,
              createdBy: actor.actorId,
              roleLabel,
              at: now,
            }),
          )
        }
      })
      const records = ids.map((id) => loadInvite(id))
      audit.log({
        actorId: actor.actorId,
        actorIp: actor.ip,
        action: 'invite.create',
        targetType: 'invite',
        targetId: ids[0] ?? null,
        detail: {
          count: ids.length,
          codes: records.map((r) => r.code),
          maxUses: input.maxUses,
          roleLabel,
        },
      })
      return { items: records.map((record) => toInviteRow(record, [])) }
    },

    async updateInvite(inviteId: number, input: UpdateInviteRequest, actor: AdminActor): Promise<InviteResponse> {
      const row = loadInvite(inviteId)
      if (input.maxUses !== undefined && input.maxUses < row.used_count) {
        throw new HubError('CONFLICT', `可用次数不能小于已使用次数（${row.used_count}）`)
      }
      // 只把真正变化的字段写库并记进审计：前端「保存」会把整个表单发过来，
      // 逐字段比对才能让「什么都没改」不产生一条 empty 的 invite.update
      const patch: Parameters<typeof updateInvite>[2] = {}
      const detail: Record<string, unknown> = {}
      if (input.disabled !== undefined && input.disabled !== (row.disabled === 1)) {
        patch.disabled = input.disabled
        detail.disabled = input.disabled
      }
      if (input.note !== undefined && input.note !== row.note) {
        patch.note = input.note
        detail.note = input.note
      }
      if (input.maxUses !== undefined && input.maxUses !== row.max_uses) {
        patch.maxUses = input.maxUses
        detail.maxUses = input.maxUses
      }
      if (input.expiresAt !== undefined && input.expiresAt !== row.expires_at) {
        patch.expiresAt = input.expiresAt
        detail.expiresAt = input.expiresAt
      }
      if (input.roleLabel !== undefined) {
        const roleLabel = normalizeRoleLabel(input.roleLabel)
        if (roleLabel !== row.role_label) {
          patch.roleLabel = roleLabel
          detail.fromLabel = row.role_label
          detail.toLabel = roleLabel
        }
      }
      if (Object.keys(patch).length > 0) {
        updateInvite(db, inviteId, patch)
        audit.log({
          actorId: actor.actorId,
          actorIp: actor.ip,
          action: 'invite.update',
          targetType: 'invite',
          targetId: inviteId,
          detail,
        })
      }
      const updated = loadInvite(inviteId)
      return { invite: toInviteRow(updated, usesOf([updated]).get(updated.id) ?? []) }
    },

    async deleteInvite(inviteId: number, actor: AdminActor): Promise<void> {
      const row = loadInvite(inviteId)
      if (row.used_count > 0) throw new HubError('CONFLICT', '该邀请码已被使用，不能删除（可改为停用）')
      deleteInvite(db, inviteId)
      audit.log({
        actorId: actor.actorId,
        actorIp: actor.ip,
        action: 'invite.delete',
        targetType: 'invite',
        targetId: inviteId,
        detail: { code: row.code, note: row.note },
      })
    },

    async getInvite(inviteId: number): Promise<InviteRow | null> {
      const row = findInviteById(db, inviteId)
      if (!row) return null
      return toInviteRow(row, usesOf([row]).get(row.id) ?? [])
    },

    async getSettings(): Promise<SettingsResponse> {
      return settings.all()
    },

    async updateSettings(input: UpdateSettingsRequest, actor: AdminActor): Promise<SettingsResponse> {
      const keys = Object.keys(input)
      const next = settings.setMany(input)
      audit.log({
        actorId: actor.actorId,
        actorIp: actor.ip,
        action: 'settings.update',
        targetType: 'settings',
        targetId: null,
        detail: { keys },
      })
      return next
    },

    async listAudit(query: AuditListQuery): Promise<AuditListResponse> {
      const { rows, total } = listAudit(db, {
        actorId: query.actorId,
        action: query.action,
        actionPrefix: query.actionPrefix,
        targetType: query.targetType,
        targetId: query.targetId,
        from: query.from,
        to: query.to,
        page: query.page,
        pageSize: query.pageSize,
      })
      return { items: rows, total, page: query.page, pageSize: query.pageSize }
    },

    async publicSite() {
      const site = settings.get('site')
      const registration = settings.get('registration')
      return {
        name: site.name,
        tagline: site.tagline,
        announcement: site.announcement,
        announcementLevel: site.announcementLevel,
        registrationMode: registration.mode,
        requireApproval: registration.requireApproval,
        // 2026-10-15 起用 Let's Encrypt 证书（00 D20）：没有自签根证书要装，恒为 null（WP7b、08 §3）
        caCertUrl: null,
      }
    },
  }
}
