import { z } from 'zod'

/**
 * 全部业务错误码（04 §0.2）。新增错误码必须同时更新 04 文档。
 */
export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'REAUTH_REQUIRED',
  'MUST_CHANGE_PASSWORD',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'INVALID_CREDENTIALS',
  'ACCOUNT_LOCKED',
  'ACCOUNT_DISABLED',
  'ACCOUNT_PENDING',
  'REGISTRATION_CLOSED',
  'INVITE_INVALID',
  'USERNAME_TAKEN',
  'USERNAME_RESERVED',
  'USERNAME_CHANGE_TOO_SOON',
  'WEAK_PASSWORD',
  'WRONG_PASSWORD',
  'USER_LIMIT_REACHED',
  'CAPACITY_FULL',
  'DISK_QUOTA_EXCEEDED',
  'INSUFFICIENT_POINTS',
  'INSTANCE_BUSY',
  'INSTANCE_START_FAILED',
  'RUNTIME_NOT_READY',
  'EXPORT_LIMIT',
  'EXPORT_TOO_LARGE',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA',
  'CONFLICT',
  'GONE',
  'UPSTREAM_ERROR',
  'DEVICE_TOKEN_INVALID',
  'DEVICE_LIMIT_REACHED',
  /**
   * WP40a：手机 App 契约（`v2/契约草案-认证与bootstrap.md` §1–§3）点名的错误码。
   * 语义与网页端已有的 `ACCOUNT_DISABLED` / `ACCOUNT_PENDING` / `DEVICE_TOKEN_INVALID` 相同，
   * 只是 App 端按契约用这几个名字（见 `MOBILE_AUTH_ERROR_CODES`）；实现上由既有错误码**映射**得到，
   * 不新增判定逻辑。`INSTANCE_ABSENT` 是手机唤醒特有的「这个用户还没有云实例」。
   */
  'USER_DISABLED',
  'USER_PENDING',
  'DEVICE_REVOKED',
  'INSTANCE_ABSENT',
  /**
   * 上线决定 ①（2026-10-25）：首次唤醒自动开通失败。
   * 只在手机 `POST /api/mobile/instance/wake` 的自动开通路径上出现（建目录 / 落实例行 /
   * 渲染 managed 失败）；App 端提示「开通失败，可重试」。启动失败的既有码是 `INSTANCE_START_FAILED`。
   */
  'INSTANCE_PROVISION_FAILED',
  'INTERNAL',
] as const

export const ErrorCodeSchema = z.enum(ERROR_CODES)

export type ErrorCode = z.infer<typeof ErrorCodeSchema>

/** 错误码 → HTTP 状态码（04 §0.2） */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  REAUTH_REQUIRED: 403,
  MUST_CHANGE_PASSWORD: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  RATE_LIMITED: 429,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_LOCKED: 423,
  ACCOUNT_DISABLED: 403,
  ACCOUNT_PENDING: 403,
  REGISTRATION_CLOSED: 403,
  INVITE_INVALID: 400,
  USERNAME_TAKEN: 409,
  USERNAME_RESERVED: 400,
  USERNAME_CHANGE_TOO_SOON: 429,
  WEAK_PASSWORD: 400,
  WRONG_PASSWORD: 400,
  USER_LIMIT_REACHED: 403,
  CAPACITY_FULL: 503,
  DISK_QUOTA_EXCEEDED: 403,
  INSUFFICIENT_POINTS: 402,
  INSTANCE_BUSY: 409,
  INSTANCE_START_FAILED: 500,
  RUNTIME_NOT_READY: 409,
  EXPORT_LIMIT: 429,
  EXPORT_TOO_LARGE: 413,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA: 415,
  CONFLICT: 409,
  GONE: 410,
  UPSTREAM_ERROR: 502,
  /** 桌面设备令牌无效：不存在 / 已吊销 / 已过期 / 设备被吊销 / 用户不可用（WP25a） */
  DEVICE_TOKEN_INVALID: 401,
  /** 桌面设备数达到 `settings.desktop.maxDevicesPerUser`（WP25a） */
  DEVICE_LIMIT_REACHED: 409,
  /** 手机 App：账号被停用（= `ACCOUNT_DISABLED`，App 契约用这个名字） */
  USER_DISABLED: 403,
  /** 手机 App：账号待审批（= `ACCOUNT_PENDING`） */
  USER_PENDING: 403,
  /** 手机 App：设备已被吊销 / refresh token 被重放（App 回到登录页） */
  DEVICE_REVOKED: 401,
  /** 手机 App：用户还没有云实例（还没开通 / 管理员没给建容器） */
  INSTANCE_ABSENT: 404,
  /** 手机 App：首次唤醒自动开通失败（目录/实例行/managed 渲染）；可重试 */
  INSTANCE_PROVISION_FAILED: 500,
  INTERNAL: 500,
}

/** 错误码 → 默认中文文案（给人看；接口可在抛出时覆盖） */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  UNAUTHENTICATED: '请先登录',
  FORBIDDEN: '没有权限执行该操作',
  REAUTH_REQUIRED: '该操作需要重新输入密码',
  MUST_CHANGE_PASSWORD: '请先修改初始密码',
  NOT_FOUND: '资源不存在',
  VALIDATION_FAILED: '参数不合法',
  RATE_LIMITED: '操作太频繁，请稍后再试',
  INVALID_CREDENTIALS: '用户名或密码错误',
  ACCOUNT_LOCKED: '账号被临时锁定，请稍后再试',
  ACCOUNT_DISABLED: '账号已被停用',
  ACCOUNT_PENDING: '账号正在等待管理员审批',
  REGISTRATION_CLOSED: '当前未开放注册',
  INVITE_INVALID: '邀请码无效、已过期或用完',
  USERNAME_TAKEN: '用户名已被占用',
  USERNAME_RESERVED: '该用户名为系统保留字',
  USERNAME_CHANGE_TOO_SOON: '30 天内只能修改一次用户名',
  WEAK_PASSWORD: '密码强度不足',
  WRONG_PASSWORD: '当前密码不正确',
  USER_LIMIT_REACHED: '用户数量已达上限',
  CAPACITY_FULL: '当前使用人数较多，请稍后重试',
  DISK_QUOTA_EXCEEDED: '磁盘用量已超过配额，暂时无法启动；请先清理工作区文件',
  INSUFFICIENT_POINTS: '积分不足，请充值后再启动',
  INSTANCE_BUSY: '实例正有任务在进行，请稍后重试',
  INSTANCE_START_FAILED: '实例启动失败',
  RUNTIME_NOT_READY: '指定的 DSH 版本镜像尚未就绪',
  EXPORT_LIMIT: '导出次数已用完，请明天再试',
  EXPORT_TOO_LARGE: '导出内容过大，请只勾选部分内容',
  PAYLOAD_TOO_LARGE: '上传内容过大',
  UNSUPPORTED_MEDIA: '不支持的内容类型',
  CONFLICT: '与当前状态冲突',
  GONE: '已过期，请重新开始',
  UPSTREAM_ERROR: '外部服务调用失败',
  DEVICE_TOKEN_INVALID: '这台设备未登录或登录已失效，请重新登录',
  DEVICE_LIMIT_REACHED: '已登录的设备数量已达上限，请先在网页端吊销不用的设备',
  USER_DISABLED: '账号已被停用',
  USER_PENDING: '账号正在等待管理员审批',
  DEVICE_REVOKED: '这台设备已被吊销，请重新登录',
  INSTANCE_ABSENT: '还没有开通云实例，请联系管理员',
  INSTANCE_PROVISION_FAILED: '开通云实例失败，请稍后重试或联系管理员',
  INTERNAL: '服务器内部错误',
}

/** 取错误码的默认文案 */
export function defaultErrorMessage(code: ErrorCode): string {
  return ERROR_MESSAGES[code] ?? ERROR_MESSAGES.INTERNAL
}

/** 错误响应体：`{"error":{"code","message","details"}}`（04 §0） */
export const ErrorBodySchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
})

export type ErrorBody = z.infer<typeof ErrorBodySchema>

/** 校验失败时的 `details.fields`：字段路径 → 中文说明 */
export const ErrorFieldsSchema = z.record(z.string(), z.string())

export type ErrorFields = z.infer<typeof ErrorFieldsSchema>
