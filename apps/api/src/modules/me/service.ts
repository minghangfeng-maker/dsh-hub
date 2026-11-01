import {
  AVATAR_MAX_BYTES,
  USERNAME_CHANGE_COOLDOWN_DAYS,
  type RevokeOthersResponse,
  type SessionItem,
  type SessionListResponse,
  type UpdateMeResponse,
  type UserPublic,
} from '@dsh-hub/shared'
import type { AppDeps } from '../../context.js'
import { HubError } from '../../lib/errors.js'
import { checkPasswordStrength, hashPassword, verifyPassword } from '../../lib/password.js'
import { revokeSession, revokeUserSessions } from '../../lib/session.js'
import { parseUserAgent } from '../../lib/user-agent.js'
import { assertUsernameAvailable } from '../../lib/usernames.js'
import { findUserById, toUserPublic } from '../../lib/user-view.js'
import {
  AVATAR_FILE_REGEX,
  removeAvatar,
  resolveAvatarFile,
  sniffImage,
  writeAvatar,
  avatarFileName,
  type AvatarImage,
} from './avatar.js'
import {
  findSessionOwner,
  listUserSessions,
  updateAvatarFile,
  updatePassword,
  updateProfile,
} from './repo.js'
import type { MeService } from './types.js'

/** 30 天冷却（02 §5 / 04 §0.2 USERNAME_CHANGE_TOO_SOON） */
const USERNAME_COOLDOWN_MS = USERNAME_CHANGE_COOLDOWN_DAYS * 86_400_000

/**
 * 个人中心服务（04 §3）。头像的魔数校验/落盘在 avatar.ts，SQL 在 repo.ts。
 * 所有写操作都要审计（04 §7）——账号安全相关的动作在后台必须查得到。
 */
export function createMeService(deps: AppDeps): MeService {
  const { db, clock, audit, paths } = deps

  function loadUser(userId: number) {
    const row = findUserById(db, userId)
    if (!row || row.deleted_at) throw new HubError('NOT_FOUND', '用户不存在')
    return row
  }

  function currentUser(userId: number): UserPublic {
    return toUserPublic(loadUser(userId))
  }

  return {
    async updateProfile(userId, input): Promise<UpdateMeResponse> {
      const row = loadUser(userId)
      const now = clock.nowIso()
      const patch: Parameters<typeof updateProfile>[2] = { at: now }
      const changed: string[] = []

      if (input.username !== undefined && input.username !== row.username) {
        if (row.username_changed_at) {
          const nextAllowedMs = Date.parse(row.username_changed_at) + USERNAME_COOLDOWN_MS
          if (nextAllowedMs > Date.parse(now)) {
            throw new HubError('USERNAME_CHANGE_TOO_SOON', undefined, {
              retryAfterSec: Math.ceil((nextAllowedMs - Date.parse(now)) / 1000),
              changedAt: row.username_changed_at,
            })
          }
        }
        assertUsernameAvailable(db, input.username, row.id)
        patch.username = input.username
        patch.usernameChangedAt = now
        changed.push('username')
      }
      if (input.displayName !== undefined && input.displayName !== row.display_name) {
        patch.displayName = input.displayName
        changed.push('displayName')
      }
      if (input.bio !== undefined && input.bio !== row.bio) {
        patch.bio = input.bio
        changed.push('bio')
      }

      if (changed.length > 0) {
        updateProfile(db, userId, patch)
        const detail = { fields: changed, username: patch.username, displayName: patch.displayName }
        if (changed.includes('username')) {
          audit.log({
            actorId: userId,
            action: 'user.username.change',
            targetType: 'user',
            targetId: userId,
            detail: { from: row.username, to: patch.username },
          })
        }
        if (changed.includes('displayName') || changed.includes('bio')) {
          audit.log({ actorId: userId, action: 'user.update', targetType: 'user', targetId: userId, detail })
        }
      }
      return { user: currentUser(userId) }
    },

    async setAvatar(userId, upload): Promise<UpdateMeResponse> {
      const row = loadUser(userId)
      if (upload.data.length === 0) throw new HubError('VALIDATION_FAILED', '上传文件为空')
      if (upload.data.length > AVATAR_MAX_BYTES) {
        throw new HubError('PAYLOAD_TOO_LARGE', `头像不能超过 ${Math.floor(AVATAR_MAX_BYTES / 1024)} KB`)
      }
      const image: AvatarImage | null = sniffImage(upload.data)
      if (!image) throw new HubError('UNSUPPORTED_MEDIA', '头像只支持 png / jpeg / webp')
      // 声明的 MIME 与魔数不一致说明是伪造扩展名，直接拒绝（02 §T12）
      if (upload.mimeType && upload.mimeType !== image.mime && upload.mimeType !== 'application/octet-stream') {
        throw new HubError('UNSUPPORTED_MEDIA', '文件内容与类型不一致')
      }

      const fileName = avatarFileName(userId, upload.data, image.format)
      const previous = row.avatar_file
      writeAvatar(paths.avatarsDir, fileName, upload.data)
      updateAvatarFile(db, userId, fileName, clock.nowIso())
      if (previous && previous !== fileName) removeAvatar(paths.avatarsDir, previous)
      audit.log({
        actorId: userId,
        action: 'user.avatar.change',
        targetType: 'user',
        targetId: userId,
        detail: { file: fileName, bytes: upload.data.length, replaced: previous },
      })
      return { user: currentUser(userId) }
    },

    async deleteAvatar(userId): Promise<UpdateMeResponse> {
      const row = loadUser(userId)
      if (row.avatar_file) {
        updateAvatarFile(db, userId, null, clock.nowIso())
        removeAvatar(paths.avatarsDir, row.avatar_file)
        audit.log({
          actorId: userId,
          action: 'user.avatar.change',
          targetType: 'user',
          targetId: userId,
          detail: { removed: row.avatar_file },
        })
      }
      return { user: currentUser(userId) }
    },

    async changePassword(userId, sessionId, input): Promise<void> {
      const row = loadUser(userId)
      if (!verifyPassword(input.currentPassword, row.password_hash)) throw new HubError('WRONG_PASSWORD')
      if (verifyPassword(input.newPassword, row.password_hash)) {
        throw new HubError('WEAK_PASSWORD', undefined, { reasons: ['新密码不能与当前密码相同'] })
      }
      const reasons = checkPasswordStrength(input.newPassword, row.username)
      if (reasons.length > 0) throw new HubError('WEAK_PASSWORD', undefined, { reasons })

      const now = clock.nowIso()
      updatePassword(db, userId, hashPassword(input.newPassword), now)
      // 改密后其它设备立即失效（02 §5 / 10 §B6）
      const revoked = revokeUserSessions(db, userId, now, sessionId)
      // 桌面端令牌与设备密钥同样立刻作废（WP25a 交付物 8）；设备行保留，
      // 用户重新登录会命中同一个 install_key，仍是「同一台设备」，不占新额度。
      const revokedDevices = deps.services.desktop?.revokeTokensForUser(userId, 'password-change') ?? 0
      audit.log({
        actorId: userId,
        action: 'auth.password.change',
        targetType: 'user',
        targetId: userId,
        detail: { revokedOtherSessions: revoked, revokedDesktopTokens: revokedDevices },
      })
    },

    async listSessions(userId, currentSessionId): Promise<SessionListResponse> {
      const items: SessionItem[] = listUserSessions(db, userId, clock.nowIso()).map((session) => ({
        id: session.id,
        current: session.id === currentSessionId,
        createdAt: session.created_at,
        lastSeenAt: session.last_seen_at,
        ip: session.ip,
        userAgent: session.user_agent,
        device: parseUserAgent(session.user_agent).device,
      }))
      return { items }
    },

    async revokeSession(userId, currentSessionId, targetSessionId): Promise<void> {
      const owner = findSessionOwner(db, targetSessionId)
      if (owner === null || owner !== userId) throw new HubError('NOT_FOUND', '会话不存在')
      const revoked = revokeSession(db, targetSessionId, clock.nowIso())
      audit.log({
        actorId: userId,
        action: 'user.sessions.revoke',
        targetType: 'user',
        targetId: userId,
        detail: { sessionId: targetSessionId, self: targetSessionId === currentSessionId, revoked },
      })
    },

    async revokeOthers(userId, currentSessionId): Promise<RevokeOthersResponse> {
      const revoked = revokeUserSessions(db, userId, clock.nowIso(), currentSessionId)
      audit.log({
        actorId: userId,
        action: 'user.sessions.revoke',
        targetType: 'user',
        targetId: userId,
        detail: { others: true, revoked },
      })
      return { revoked }
    },
  }
}

export { AVATAR_FILE_REGEX, resolveAvatarFile, sniffImage }
