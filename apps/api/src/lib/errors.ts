import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ERROR_HTTP_STATUS, type ErrorBody, type ErrorCode, defaultErrorMessage } from '@dsh-hub/shared'

/**
 * 业务错误：全项目统一用它（11 §5）。`code` 决定 HTTP 状态与默认中文文案，
 * `details` 会原样进响应体（例如限流的 `retryAfterSec`、校验失败的 `fields`）。
 *
 * `httpStatus` 只在「同一个错误码在不同端点必须用不同状态」时用。目前唯一的地方是
 * 手机 App 契约（`v2/契约草案-认证与bootstrap.md` §2）：wake 的容量满要 **409**，
 * 而网页端的 `CAPACITY_FULL` 是 503（04 §0.2）。App 按 `code` 分支，状态码只是给
 * 通用 HTTP 客户端看的，所以不改全局映射表。
 */
export class HubError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly details: Record<string, unknown> | undefined

  constructor(
    code: ErrorCode,
    message?: string,
    details?: Record<string, unknown>,
    options?: { httpStatus?: number },
  ) {
    super(message ?? defaultErrorMessage(code))
    this.name = 'HubError'
    this.code = code
    this.status = options?.httpStatus ?? ERROR_HTTP_STATUS[code] ?? 500
    this.details = details
  }

  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    }
  }

  static is(error: unknown): error is HubError {
    return error instanceof HubError
  }
}

/** zod 校验失败 → `details.fields`（每个字段只保留第一条错误，04 §0） */
export function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.map((p) => String(p)).join('.') : '_'
    if (!(path in fields)) fields[path] = issue.message
  }
  return fields
}

/** 把任意抛出的东西翻译成 HTTP 状态 + 错误体；**绝不**把堆栈/内部信息放进 body */
export function toHttpError(error: unknown): { status: number; body: ErrorBody } {
  if (HubError.is(error)) return { status: error.status, body: error.toBody() }
  if (error instanceof z.ZodError) {
    const fields = zodFieldErrors(error)
    return {
      status: 400,
      body: {
        error: {
          code: 'VALIDATION_FAILED',
          message: defaultErrorMessage('VALIDATION_FAILED'),
          details: { fields },
        },
      },
    }
  }
  const status = statusOf(error)
  if (status !== undefined) {
    const code = codeOfStatus(status)
    return { status, body: { error: { code, message: defaultErrorMessage(code) } } }
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: defaultErrorMessage('INTERNAL') } } }
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const candidate = error as { statusCode?: unknown; status?: unknown }
  const value = typeof candidate.statusCode === 'number' ? candidate.statusCode : candidate.status
  return typeof value === 'number' && value >= 400 && value < 600 ? value : undefined
}

function codeOfStatus(status: number): ErrorCode {
  if (status === 400) return 'VALIDATION_FAILED'
  if (status === 401) return 'UNAUTHENTICATED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 409) return 'CONFLICT'
  if (status === 413) return 'PAYLOAD_TOO_LARGE'
  if (status === 415) return 'UNSUPPORTED_MEDIA'
  if (status === 429) return 'RATE_LIMITED'
  return 'INTERNAL'
}

/**
 * 统一错误处理：业务错误按 `code` 映射状态；zod → VALIDATION_FAILED；
 * Fastify 自带错误（415/413/…）按状态映射；其余一律 INTERNAL，5xx 只写日志不外泄。
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const { status, body } = toHttpError(error)
    if (status >= 500) request.log.error({ err: error }, '请求处理失败')
    else request.log.debug({ code: body.error.code, url: request.url }, '请求被拒绝')
    void reply.code(status).send(body)
  })

  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send(new HubError('NOT_FOUND').toBody())
  })
}
