import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  ERROR_MESSAGES,
  ErrorBodySchema,
  ErrorCodeSchema,
  defaultErrorMessage,
} from '../src/index.js'

describe('错误码表（04 §0.2）', () => {
  it('每个错误码都有 HTTP 状态与中文文案', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_HTTP_STATUS[code], `${code} 缺少 HTTP 状态`).toBeGreaterThanOrEqual(400)
      expect(ERROR_HTTP_STATUS[code]).toBeLessThan(600)
      expect(ERROR_MESSAGES[code]?.length ?? 0, `${code} 缺少默认文案`).toBeGreaterThan(0)
    }
  })

  it('ErrorCodeSchema 只接受表内的码', () => {
    expect(ErrorCodeSchema.safeParse('INTERNAL').success).toBe(true)
    expect(ErrorCodeSchema.safeParse('NOT_A_CODE').success).toBe(false)
  })

  it('defaultErrorMessage 回退到 INTERNAL', () => {
    expect(defaultErrorMessage('NOT_FOUND')).toBe(ERROR_MESSAGES.NOT_FOUND)
  })

  it('ErrorBodySchema 接受 details', () => {
    const parsed = ErrorBodySchema.parse({
      error: {
        code: 'VALIDATION_FAILED',
        message: '参数不合法',
        details: { fields: { username: '格式不对' } },
      },
    })
    expect(parsed.error.details?.fields).toEqual({ username: '格式不对' })
  })

  it('ErrorBodySchema 拒绝未知错误码', () => {
    expect(ErrorBodySchema.safeParse({ error: { code: 'OOPS', message: 'x' } }).success).toBe(false)
  })
})

describe('默认设置（03 §1.6）与 SettingsSchema 保持一致', () => {
  it('DEFAULT_SETTINGS 可以被解析', async () => {
    const { SettingsSchema } = await import('../src/index.js')
    const parsed = SettingsSchema.parse(DEFAULT_SETTINGS)
    expect(parsed.registration.mode).toBe('invite')
    expect(parsed.default_quota.memoryMb).toBe(4096)
    expect(parsed.capacity.maxRunning).toBe(12)
    expect(parsed.exports.ttlHours).toBe(24)
    expect(parsed.security.adminSessionHours).toBe(12)
  })
})
