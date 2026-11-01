/**
 * `@dsh-hub/shared` —— 前后端唯一契约（04）。
 *
 * 约定：每个接口一个 `<Name>Request` / `<Name>Response` schema，类型由 `z.infer` 推导；
 * 04 文档新增接口时必须在此补 schema（`test/contract.test.ts` 会核对覆盖表）。
 */
export * from './constants.js'
export * from './contract-map.js'
export * from './errors.js'
export * from './common.js'
export * from './api/admin-users.js'
export * from './api/agent-modes.js'
export * from './api/auth.js'
export * from './api/cockpit.js'
export * from './api/compute.js'
export * from './api/desktop.js'
export * from './api/desktop-delivery.js'
export * from './api/delivery.js'
export * from './api/exports.js'
export * from './api/instances.js'
export * from './api/jobs.js'
export * from './api/me.js'
export * from './api/mobile.js'
export * from './api/mobile-app.js'
export * from './api/mobile-v2.js'
export * from './api/models.js'
export * from './api/plugins.js'
export * from './api/relay.js'
export * from './api/rollouts.js'
export * from './api/runtimes.js'
export * from './api/site.js'
export * from './api/tools.js'
