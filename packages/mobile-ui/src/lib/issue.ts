/**
 * 「界面上的一条问题」（限流倒计时、后端不可连接、唤醒失败……）。
 *
 * 单独放在 lib 里：auth（登录/令牌）与 backend（选择/唤醒）都要产出它，但两个 store
 * 之间只能有**一个**方向（backend → auth），所以形状与「错误 → 问题」的转换放在这里。
 */

import { HubApiError, errorMessage, isRetryableCode } from '@dsh-hub/mobile-core'

export interface UiIssue {
  code: string
  message: string
  retryable: boolean
  /** 限流倒计时（秒）：来自 Hub 的 `details.retryAfterSec`。 */
  retryAfterSec?: number
}

/** `HubApiError` → 界面问题；其它（网络/未知）按 `network` 处理。 */
export function issueFromError(error: unknown): UiIssue {
  if (error instanceof HubApiError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.retryAfterSec === undefined ? {} : { retryAfterSec: error.retryAfterSec }),
    }
  }
  const code = 'network'
  return { code, message: errorMessage(code), retryable: isRetryableCode(code) }
}
