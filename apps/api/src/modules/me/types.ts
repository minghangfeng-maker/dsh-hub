import type {
  ChangePasswordRequest,
  RevokeOthersResponse,
  SessionListResponse,
  UpdateMeRequest,
  UpdateMeResponse,
} from '@dsh-hub/shared'

/** 上传的头像（路由层用 @fastify/multipart 收完再交给 service） */
export interface AvatarUpload {
  data: Buffer
  mimeType: string
  filename?: string
}

/**
 * 个人中心服务（04 §3；WP1 实现）。
 * 头像只收 png/jpeg/webp（校验魔数）、≤1MB、固定 512×512；文件名 `<userId>-<sha256前12>.webp`。
 */
export interface MeService {
  /** 改昵称/简介/用户名（用户名 30 天冷却，见 USERNAME_CHANGE_TOO_SOON） */
  updateProfile(userId: number, input: UpdateMeRequest): Promise<UpdateMeResponse>
  setAvatar(userId: number, upload: AvatarUpload): Promise<UpdateMeResponse>
  deleteAvatar(userId: number): Promise<UpdateMeResponse>
  /** 改密：校验当前密码、写新哈希、吊销其它会话、清 must_change_password */
  changePassword(userId: number, sessionId: string, input: ChangePasswordRequest): Promise<void>
  listSessions(userId: number, currentSessionId: string): Promise<SessionListResponse>
  revokeSession(userId: number, sessionId: string, targetSessionId: string): Promise<void>
  revokeOthers(userId: number, currentSessionId: string): Promise<RevokeOthersResponse>
}
