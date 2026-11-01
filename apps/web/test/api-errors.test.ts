import { ERROR_CODES } from '@dsh-hub/shared'
import { describe, expect, it } from 'vitest'

import {
  ERROR_TEXT,
  FRONTEND_ERROR_TEXT,
  describeError,
  errorText,
  fieldErrorsOf,
  missingErrorTexts,
  textForCode,
} from '@/api/errors'
import { HubApiError, NETWORK_ERROR } from '@/api/http'

describe('错误文案表（04 §0.2 全覆盖）', () => {
  it('每个错误码都有中文文案，且没有多余键', () => {
    expect(missingErrorTexts()).toEqual([])
    expect(Object.keys(ERROR_TEXT).sort()).toEqual([...ERROR_CODES].sort())
  })

  it('文案是人话（不是错误码本身），且都不为空', () => {
    for (const code of ERROR_CODES) {
      const text = ERROR_TEXT[code]
      expect(text.length, `${code} 文案太短`).toBeGreaterThan(2)
      expect(text).not.toBe(code)
    }
  })
})

describe('describeError：把接口错误整理成界面能直接用的信息', () => {
  it('优先用服务端的中文 message', () => {
    const error = new HubApiError('USERNAME_TAKEN', '这个名字刚刚被抢走了', 409)
    expect(describeError(error).message).toBe('这个名字刚刚被抢走了')
  })

  it('message 为空时退回错误码文案', () => {
    const error = new HubApiError('FORBIDDEN', '', 403)
    expect(describeError(error).message).toBe(ERROR_TEXT.FORBIDDEN)
  })

  it('VALIDATION_FAILED 取出 details.fields，并把第一条当主文案', () => {
    const error = new HubApiError('VALIDATION_FAILED', '参数不合法', 400, {
      fields: { username: '只能包含小写字母、数字、- 和 _', bio: '个人简介最多 200 字' },
    })
    const description = describeError(error)

    expect(description.message).toBe('只能包含小写字母、数字、- 和 _')
    expect(description.fieldErrors).toEqual({
      username: '只能包含小写字母、数字、- 和 _',
      bio: '个人简介最多 200 字',
    })
    expect(fieldErrorsOf(error)).toEqual(description.fieldErrors)
  })

  it('WEAK_PASSWORD 拼接 details.reasons', () => {
    const error = new HubApiError('WEAK_PASSWORD', '密码强度不足', 400, {
      reasons: ['至少 10 位', '至少包含字母、数字、符号中的两类'],
    })
    expect(describeError(error).message).toBe('密码强度不足：至少 10 位、至少包含字母、数字、符号中的两类')
  })

  it('INSUFFICIENT_POINTS 用 details 拼出余额与所需金额（13 §7）', () => {
    const error = new HubApiError('INSUFFICIENT_POINTS', '积分不足，请充值后再启动', 402, {
      balanceMicro: 20_000,
      blockPriceMicro: 50_000,
    })
    expect(describeError(error).message).toBe('积分不足：余额 0.02，至少需要 0.05')
  })

  it('CAPACITY_FULL 附上 running/max', () => {
    const error = new HubApiError('CAPACITY_FULL', '同时在用的人有点多，稍后再试试', 503, {
      running: 12,
      max: 12,
    })
    expect(describeError(error).message).toContain('12/12')
  })

  it('RATE_LIMITED / ACCOUNT_LOCKED 给出 retryAfterSec（登录页据此倒计时）', () => {
    const rateLimited = new HubApiError('RATE_LIMITED', '操作太频繁', 429, { retryAfterSec: 30 })
    expect(describeError(rateLimited).retryAfterSec).toBe(30)
    expect(describeError(rateLimited).message).toContain('30 秒')

    const locked = new HubApiError('ACCOUNT_LOCKED', '账号被临时锁定，请稍后再试', 423, {
      retryAfterSec: 900,
    })
    expect(describeError(locked).retryAfterSec).toBe(900)
    expect(describeError(locked).retryable).toBe(false)
  })

  it('网络错误用前端专用 NETWORK_ERROR：文案固定、network=true、可重试', () => {
    const error = new HubApiError(NETWORK_ERROR, FRONTEND_ERROR_TEXT.NETWORK_ERROR, 0, { network: true })
    const description = describeError(error)

    expect(description.code).toBe(NETWORK_ERROR)
    expect(description.message).toBe('网络好像断开了，请稍后再试')
    expect(description.network).toBe(true)
    expect(description.retryable).toBe(true)
    expect(textForCode(NETWORK_ERROR)).toBe(FRONTEND_ERROR_TEXT.NETWORK_ERROR)
  })

  it('NETWORK_ERROR 只在 web 侧：后端错误码表（04 §0.2）里没有它', () => {
    expect(ERROR_CODES).not.toContain(NETWORK_ERROR)
    expect(Object.keys(ERROR_TEXT)).not.toContain(NETWORK_ERROR)
  })

  it('普通 Error 与未知值也能得到安全文案', () => {
    expect(errorText(new Error('boom'))).toBe('boom')
    expect(describeError(undefined).code).toBe('UNKNOWN')
    expect(describeError(undefined).message).toBe(ERROR_TEXT.INTERNAL)
    expect(describeError({ weird: true }).message).toBe(ERROR_TEXT.INTERNAL)
  })
})
