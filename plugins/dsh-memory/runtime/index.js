/**
 * `@local/dsh-memory` —— Host 半边入口。
 *
 * 组装顺序（每个模块都只依赖上一个）：
 *   service（条目/索引/stats/收件箱） → consolidator（整理） → scheduler（定时）
 *   工具（tools）· 注入（inject）· HTTP（api）
 *
 * 可选依赖都用 `ctx.inject` 动态注入：webServer / tools / sessionProjections
 * 在加载器里可能比本插件晚 ACTIVE（注释踩过这个坑），直接
 * `ctx.get()` 会拿到 undefined 并**静默**跳过注册。
 *
 * @module @local/dsh-memory
 */

import { registerMemoryRoutes } from './api.js'
import { resolveConfig } from './config.js'
import { createConsolidator } from './consolidate.js'
import { installInjection, registerMemoryProjection } from './inject.js'
import { createScheduler } from './scheduler.js'
import { createMemoryService } from './service.js'
import { registerTools } from './tools.js'
import { createMemoryPilot } from './pilot.js'

/** 插件在 Loader 里的诊断名。 */
export const name = 'memory'

/** 不强制依赖任何服务：缺 webServer 时依然能注入和用工具。 */
export const inject = []

/** 与 DESIGN.md §12 一致的默认配置（Loader 没有 schema 时也能看出默认值）。 */
export const DEFAULT_CONFIG = resolveConfig({})

/**
 * 挂载插件。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [rawConfig] - cordis 行 config。
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const service = createMemoryService(ctx, config)
  // Optional bridge service: pilots do not depend on this plugin being installed.
  ctx.provide?.('memoryPilot', createMemoryPilot(service))

  // 卸载时清掉防抖定时器（不影响已经在跑的整理任务；它的锁会自然过期）。
  ctx.effect(() => () => service.dispose(), 'memory: dispose')

  const consolidator = createConsolidator({ service, ctx })
  const scheduler = createScheduler({ service, consolidator, ctx })

  // 工具：可选依赖 tools。
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => registerTools(toolCtx, service), 'memory: tools')
  })

  // 注入 + session projection：可选依赖 sessionProjections / agents。
  ctx.inject(['sessionProjections', 'agents'], (subCtx) => {
    registerMemoryProjection(subCtx)
    subCtx.effect(() => installInjection(subCtx, service), 'memory: injection')
  })

  // HTTP：可选依赖 webServer（headless profile 没有它）。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => registerMemoryRoutes(webCtx, { service, consolidator, scheduler }), 'memory: http api')
  })

  // 定时整理：每分钟 tick（ctx.effect 负责卸载）。
  ctx.effect(() => scheduler.start(), 'memory: scheduler')

  // 启动后安静地重建一次索引（不写"最近运行"，避免刚装好就显示跑过整理）。
  const startup = setTimeout(() => {
    void service.runLight({ reason: 'startup', silent: true })
      .then(() => service.generateIndex('global'))
      .catch((error) => service.recordError(error))
  }, 3_000)
  startup.unref?.()
  ctx.effect(() => () => clearTimeout(startup), 'memory: startup light')
}

/** 便于测试/嵌入：导出工厂。 */
export { createMemoryService } from './service.js'
export { createConsolidator } from './consolidate.js'
export { createScheduler } from './scheduler.js'
export { createApi, registerMemoryRoutes, API_PREFIX } from './api.js'
export { registerTools } from './tools.js'
export { installInjection, registerMemoryProjection, buildInjection } from './inject.js'
