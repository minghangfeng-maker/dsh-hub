/**
 * 交接码 → 座舱令牌的**接缝**（WP56b ↔ WP56a）。
 *
 * 交接码的签发与存表归 WP56a 的 `modules/cockpit`（`POST /api/admin/cockpit/handoff`、
 * 表 `cockpit_handoff_codes`）；「拿码换令牌」这条路由归本包（`modules/mobile`）。
 * 两个包并行开发，所以这里只约定**一个方法**，运行时按鸭子类型从 `deps.services.cockpit` 上取，
 * 取不到就明确报错（而不是编一个码就发令牌）。
 *
 * WP56a 侧实现（`modules/cockpit/service.ts` 的 `consumeHandoff`）：
 * - 方法名 `consumeHandoff(code)`，返回**管理员 id**（`number | null`），同步/异步都接受；
 * - **一次性**：成功兑换后立即把码标记为已用（并发兑换只有一个成功）；
 * - 过期（60 秒）、已用、不存在 → `null`。
 *
 * @module @dsh-hub/api/modules/mobile/cockpit-port
 */

export interface CockpitHandoffExchange {
  /** 用一次性交接码换管理员 id；无效 / 已用 / 过期 → null */
  consumeHandoff(code: string): number | null | Promise<number | null>
}

/** 从 services 里找 cockpit 模块的兑换实现（没有就 null）。 */
export function findCockpitHandoffExchange(services: unknown): CockpitHandoffExchange | null {
  if (services === null || typeof services !== 'object') return null
  const cockpit = (services as { cockpit?: unknown }).cockpit
  if (cockpit === null || typeof cockpit !== 'object') return null
  const exchange = (cockpit as { consumeHandoff?: unknown }).consumeHandoff
  if (typeof exchange !== 'function') return null
  return cockpit as CockpitHandoffExchange
}
