import { HubError } from './errors.js'

/**
 * 骨架期的统一占位：模块 service 的方法在对应任务包实现前都抛这个错。
 * 用 INTERNAL(500) 而不是 404/501 —— 这些是**内部**调用，出现即代表接线错误。
 */
export function notImplemented(what: string): never {
  throw new HubError('INTERNAL', `${what} 尚未实现（WP0a 只提供骨架）`)
}
