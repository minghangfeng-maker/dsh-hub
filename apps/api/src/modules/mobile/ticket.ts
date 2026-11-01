import { MOBILE_TICKET_TTL_MS } from '@dsh-hub/shared'
import { isoPlusMs } from '../../lib/clock.js'
import { randomToken } from '../../lib/crypto.js'

/**
 * 手机通道的一次性 ticket（WP40a / v2 §4.1）。
 *
 * 为什么需要它：手机通道原来是 cookie 鉴权（M4 裁决 1「不新增 connect token」），前提是
 * 原生 OkHttp 能带 cookie。v2 的 App 是 Capacitor WebView + `Authorization: Bearer`，
 * 浏览器 WebSocket API 不能带自定义头，所以升级请求只能把凭据放进查询串 —— 那就必须是
 * 一个**短命、一次性、绑定用户/设备/节点**的东西，而不是 access token 本身。
 *
 * 存内存、不落库：30 秒的东西写库只会多一张要清理的表。Hub 重启后 ticket 全失效，
 * App 重新申请即可（申请走 Bearer，不受影响）。
 */
export interface MobileTicket {
  ticket: string
  userId: number
  /** Bearer 申请的票绑定到具体设备；cookie（0.2.0 老客户端）申请的票为 null */
  deviceId: string | null
  nodeId: string
  expiresAt: string
}

export interface MobileTicketStore {
  /** 签发（同一用户/节点可以有多个并存，每个都是一次性的） */
  issue(input: { userId: number; deviceId: string | null; nodeId: string }, nowIso: string): MobileTicket
  /**
   * 取出并作废（**一次性**：无论后续校验是否通过，票都不再可用）。
   * 不存在/已用过/已过期 → null。
   */
  consume(ticket: string, nowIso: string): MobileTicket | null
  /** 当前未过期的票数（测试断言用） */
  size(nowIso: string): number
}

/** 内存上限：超出时丢最旧的（正常情况下同时在途的票只有个位数） */
const MAX_TICKETS = 512

export function createMobileTicketStore(): MobileTicketStore {
  const tickets = new Map<string, MobileTicket>()

  function sweep(nowIso: string): void {
    for (const [key, value] of tickets) {
      if (value.expiresAt <= nowIso) tickets.delete(key)
    }
  }

  return {
    issue(input, nowIso): MobileTicket {
      sweep(nowIso)
      if (tickets.size >= MAX_TICKETS) {
        const oldest = tickets.keys().next()
        if (!oldest.done) tickets.delete(oldest.value)
      }
      const ticket: MobileTicket = {
        ticket: randomToken(24),
        userId: input.userId,
        deviceId: input.deviceId,
        nodeId: input.nodeId,
        expiresAt: isoPlusMs(nowIso, MOBILE_TICKET_TTL_MS),
      }
      tickets.set(ticket.ticket, ticket)
      return ticket
    },
    consume(ticket, nowIso): MobileTicket | null {
      const found = tickets.get(ticket)
      if (found === undefined) return null
      tickets.delete(ticket)
      if (found.expiresAt <= nowIso) return null
      return found
    },
    size(nowIso): number {
      sweep(nowIso)
      return tickets.size
    },
  }
}
