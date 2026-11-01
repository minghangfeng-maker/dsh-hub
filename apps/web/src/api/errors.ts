import { ERROR_CODES, defaultErrorMessage, type ErrorCode } from '@dsh-hub/shared'

import { formatPoints } from '@/utils/points'
import { HubApiError, NETWORK_ERROR, isHubApiError, type FrontendErrorCode } from './http'

/**
 * 错误码 → 中文文案（07 §9：映射集中在这里）。
 *
 * 覆盖 04 §0.2 的**全部**错误码（WP25a 起 32 个）；表格是前端语气（亲切、简短、给出下一步），
 * 服务端如果给了更具体的 `message`，优先用服务端的（04 §0）。
 */
export const ERROR_TEXT: Record<ErrorCode, string> = {
  UNAUTHENTICATED: '登录状态已过期，请重新登录',
  FORBIDDEN: '这个操作需要更高的权限',
  REAUTH_REQUIRED: '为了安全，请再输入一次密码',
  MUST_CHANGE_PASSWORD: '请先设置新密码，再继续使用',
  NOT_FOUND: '没有找到这个内容，可能已被删除',
  VALIDATION_FAILED: '有几项填写还需要调整',
  RATE_LIMITED: '操作有点频繁，歇一会儿再试',
  INVALID_CREDENTIALS: '用户名或密码不对，再试一次？',
  ACCOUNT_LOCKED: '连续输错太多次，账号被临时锁定了',
  ACCOUNT_DISABLED: '这个账号已被停用，请联系管理员',
  ACCOUNT_PENDING: '账号还在等待管理员审批，通过后就能用了',
  REGISTRATION_CLOSED: '当前没有开放注册',
  INVITE_INVALID: '邀请码无效、已过期或者用完了',
  USERNAME_TAKEN: '这个用户名已经被占用了',
  USERNAME_RESERVED: '这个用户名是系统保留字，换一个吧',
  USERNAME_CHANGE_TOO_SOON: '用户名 30 天内只能改一次',
  WEAK_PASSWORD: '密码强度不够',
  WRONG_PASSWORD: '当前密码不正确',
  USER_LIMIT_REACHED: '用户数量已经到上限了',
  CAPACITY_FULL: '同时在用的人有点多，稍后再试试',
  DISK_QUOTA_EXCEEDED: '磁盘用量超过配额了，先清理一下工作区文件',
  GONE: '已经过期了，重新来一次吧',
  INSUFFICIENT_POINTS: '积分不足，充值后再启动吧',
  INSTANCE_BUSY: '你的 DSH 正在忙别的任务，稍等一会儿',
  INSTANCE_START_FAILED: 'DSH 启动失败了',
  RUNTIME_NOT_READY: '这个 DSH 版本还没准备好，请稍后再试',
  EXPORT_LIMIT: '今天的导出次数用完了，明天再来',
  EXPORT_TOO_LARGE: '导出内容太大了，少勾几项试试',
  PAYLOAD_TOO_LARGE: '文件太大了，换个小一点的吧',
  UNSUPPORTED_MEDIA: '不支持这种文件类型',
  CONFLICT: '当前状态下不能这么做，刷新看看？',
  UPSTREAM_ERROR: '外部服务暂时不可用，稍后再试',
  // 桌面端（WP25a）：设备令牌失效 / 设备数超限
  DEVICE_TOKEN_INVALID: '这台设备需要重新登录桌面端',
  DEVICE_LIMIT_REACHED: '登录的桌面设备数量到上限了，先在网页端吊销一台',
  // 手机 App（WP40a）：App 契约用自己的名字，语义同上面两条 + 停用/待审批
  USER_DISABLED: '这个账号已被停用，请联系管理员',
  USER_PENDING: '账号还在等待管理员审批，通过后就能用了',
  DEVICE_REVOKED: '这台设备已被吊销，请重新登录',
  INSTANCE_ABSENT: '还没有开通云实例，请联系管理员',
  INSTANCE_PROVISION_FAILED: '开通云实例失败，请稍后重试或联系管理员',
  INTERNAL: '出了点小问题，请稍后再试',
}

/** 前端专用错误码的文案（04 §0.2 之外的补充，只有网络层失败一条）。 */
export const FRONTEND_ERROR_TEXT: Record<typeof NETWORK_ERROR, string> = {
  NETWORK_ERROR: '网络好像断开了，请稍后再试',
}

/** 界面展示需要的错误信息（已解析 details）。 */
export interface ErrorDescription {
  code: FrontendErrorCode | 'UNKNOWN'
  message: string
  /** `VALIDATION_FAILED` 的 `details.fields`：字段 → 中文说明 */
  fieldErrors: Record<string, string>
  /** `RATE_LIMITED` / `ACCOUNT_LOCKED` 的 `details.retryAfterSec` */
  retryAfterSec: number | null
  /** 网络层失败（没连上服务器），界面可提示「检查网络」 */
  network: boolean
  /** 重试有意义（网络、限流、上游、内部错误） */
  retryable: boolean
}

export { defaultErrorMessage }

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function readFields(details: Record<string, unknown>): Record<string, string> {
  const fields = details['fields']
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return {}

  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    if (typeof value === 'string') result[key] = value
  }
  return result
}

/** 单个错误码的默认文案（后端 04 §0.2 + 前端 NETWORK_ERROR）。 */
export function textForCode(code: FrontendErrorCode): string {
  if (code === NETWORK_ERROR) return FRONTEND_ERROR_TEXT.NETWORK_ERROR
  return ERROR_TEXT[code] ?? defaultErrorMessage(code)
}

/**
 * 把任意异常整理成界面可直接展示的信息。
 * 业务错误（HubApiError）优先用服务端 message，再按错误码补充细节。
 */
export function describeError(error: unknown): ErrorDescription {
  if (isHubApiError(error)) {
    const fieldErrors = readFields(error.details)
    const retryAfterSec = asNumber(error.details['retryAfterSec'])
    const base = error.message || textForCode(error.code)

    let message = base
    switch (error.code) {
      case 'VALIDATION_FAILED': {
        const first = Object.values(fieldErrors)[0]
        message = first ?? base
        break
      }
      case 'WEAK_PASSWORD': {
        const reasons = asStringArray(error.details['reasons'])
        if (reasons.length > 0) message = `${base}：${reasons.join('、')}`
        break
      }
      case 'CAPACITY_FULL': {
        const running = asNumber(error.details['running'])
        const max = asNumber(error.details['max'])
        if (running !== null && max !== null) message = `${base}（正在运行 ${running}/${max}）`
        break
      }
      case 'INSUFFICIENT_POINTS': {
        // 13 §3：`details { balanceMicro, blockPriceMicro }`；余额与所需金额都按「积分」显示
        const balance = asNumber(error.details['balanceMicro'])
        const blockPrice = asNumber(error.details['blockPriceMicro'])
        if (balance !== null && blockPrice !== null) {
          message = `积分不足：余额 ${formatPoints(balance)}，至少需要 ${formatPoints(blockPrice)}`
        }
        break
      }
      case 'DISK_QUOTA_EXCEEDED': {
        // 04 §0.2：details {usedBytes, limitBytes}
        const used = asNumber(error.details['usedBytes'])
        const limit = asNumber(error.details['limitBytes'])
        if (used !== null && limit !== null) {
          message = `${base}（已用 ${(used / 1024 ** 3).toFixed(1)}GB / 上限 ${(limit / 1024 ** 3).toFixed(1)}GB）`
        }
        break
      }
      case 'RATE_LIMITED': {
        if (retryAfterSec !== null) message = `${base}（${retryAfterSec} 秒后可重试）`
        break
      }
      default:
        break
    }

    return {
      code: error.code,
      message,
      fieldErrors,
      retryAfterSec,
      network: error.isNetworkError,
      retryable:
        error.isNetworkError ||
        ['RATE_LIMITED', 'UPSTREAM_ERROR', 'INTERNAL', 'CONFLICT'].includes(error.code),
    }
  }

  if (error instanceof Error && error.message) {
    return {
      code: 'UNKNOWN',
      message: error.message,
      fieldErrors: {},
      retryAfterSec: null,
      network: false,
      retryable: false,
    }
  }

  return {
    code: 'UNKNOWN',
    message: ERROR_TEXT.INTERNAL,
    fieldErrors: {},
    retryAfterSec: null,
    network: false,
    retryable: false,
  }
}

/** 界面文案（模板里 `{{ errorText(err) }}`）。 */
export function errorText(error: unknown): string {
  return describeError(error).message
}

/** 表单字段错误（配合 Naive 的 `feedback`）。 */
export function fieldErrorsOf(error: unknown): Record<string, string> {
  return describeError(error).fieldErrors
}

/** 文案覆盖自检用：返回缺文案的错误码。 */
export function missingErrorTexts(): ErrorCode[] {
  return ERROR_CODES.filter((code) => !ERROR_TEXT[code])
}

export { HubApiError, isHubApiError, NETWORK_ERROR }
