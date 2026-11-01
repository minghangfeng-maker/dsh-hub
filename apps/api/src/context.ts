import type { FastifyBaseLogger } from 'fastify'
import type { HubConfig } from './config.js'
import type { HubDb } from './db/index.js'
import type { AuditLogger } from './lib/audit.js'
import type { Clock } from './lib/clock.js'
import type { EventBus } from './lib/events.js'
import type { HubPaths } from './lib/paths.js'
import type { SettingsStore } from './lib/settings.js'
import type { ContainerDriver } from './modules/instances/types.js'
import type { Services } from './modules/index.js'
import type { OpsInstanceProbe } from './modules/cockpit/ops-probe.js'

/** 请求侧元信息（审计、限流、会话记录都用它，避免 service 依赖 Fastify 类型） */
export interface RequestMeta {
  ip: string | null
  userAgent: string | null
  /** 是否经 7443 TLS 网关进来的公网请求（决定按 IP 的限流能否享受回环豁免，02 §5） */
  publicRequest?: boolean
}

/**
 * 依赖容器：模块的 service 工厂只拿得到这些（`services` 由 modules/index.ts 组装后放进来）。
 * 模块之间**只能**通过 `deps.services.<other>` 调用，不直接读别人的表（01 §4 模块边界规则）。
 */
export interface BaseDeps {
  config: HubConfig
  db: HubDb
  clock: Clock
  events: EventBus
  settings: SettingsStore
  audit: AuditLogger
  paths: HubPaths
  driver: ContainerDriver
  logger: FastifyBaseLogger
  /** 测试模式（`buildApp({ testing: true })`）：放宽日志、允许注入时钟/驱动 */
  testing: boolean
  /**
   * 座舱容器探针（WP56a：座舱模块用它；WP56b 注入真实现，测试注入 `FakeOpsInstanceProbe`）。
   * 缺省时用「容器尚未装配」的安全默认（`/ops/*` 一律 401）。
   */
  opsProbe?: OpsInstanceProbe
}

export interface AppDeps extends BaseDeps {
  services: Services
}
