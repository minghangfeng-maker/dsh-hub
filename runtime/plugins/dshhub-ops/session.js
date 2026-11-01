/**
 * `sessionId` 的唯一来源：工具执行上下文里的 agent 会话。
 *
 * 结论（DSH 源码，2026-10-29 核对）：
 * - 工具 `execute(args, exec)` 的 `exec` 是 `ToolRunContext`，它继承 `ToolExecutionInput`，
 *   其中 `readonly agent?: Agent` 就是「这次调用替谁跑」（由 agent loop 填）——
 *   `packages/core/tools/src/index.ts:340`。
 * - `Agent` 的实时半边补上了 `readonly session: Session`（`runtime-types.ts` 的 module 增强），
 *   `packages/core/agent/src/runtime-types.ts:168`。
 * - `Session.id` 就是持久会话 id（`get id(): SessionId { return this.header.id }`），
 *   `packages/core/session/src/index.ts:546`（header 在 `:540`、`SessionHeader.id` 在
 *   `packages/core/session/src/types.ts:102`，接口在 `:95`）。
 *
 * 所以 `exec.agent.session.id` 是**权威来源**，`header.id` 只是防御性兜底；
 * 模型参数里的任何 `sessionId` 一律不看（docs/24 §5：「不让模型填」）。
 *
 * @module @dshhub/ops/session
 */

/**
 * 取这次工具调用所属的 DSH 会话 id。
 * @param {{agent?: {session?: {id?: unknown, header?: {id?: unknown}}}}} [exec]
 * @returns {string | null} 取不到时 null（调用方必须拒绝执行，不能编一个）
 */
export function sessionIdOf(exec) {
  const session = exec?.agent?.session
  const direct = session?.id
  if (typeof direct === 'string' && direct.length > 0) return direct
  const headerId = session?.header?.id
  if (typeof headerId === 'string' && headerId.length > 0) return headerId
  return null
}

/**
 * 会话的工作目录（只用于日志与守则措辞；取不到就是空串）。
 * @param {object} [exec]
 */
export function cwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' ? cwd : ''
}

/**
 * 抹掉模型可能塞进来的 `sessionId`：契约里没有这个参数，出现即视为脏数据。
 * 保留其余字段原样（`args` 里可能有 secretRef，不能改写）。
 * @param {Record<string, unknown> | undefined} args
 */
export function withoutSessionId(args) {
  if (args === undefined || args === null || typeof args !== 'object') return {}
  const copy = { ...args }
  for (const key of Object.keys(copy)) {
    if (key.toLowerCase() === 'sessionid') delete copy[key]
  }
  return copy
}
