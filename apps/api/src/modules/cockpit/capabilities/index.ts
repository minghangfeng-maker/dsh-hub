import type { CapabilityDefinition, CapabilityRegistry } from './types.js'
import { createCapabilityRegistry } from './registry.js'
import { READ_ONLY_CAPABILITIES } from './read.js'
import { READ_ONLY_EXTRA_CAPABILITIES } from './read-extra.js'
import { WRITE_CAPABILITIES } from './write.js'
import { WRITE_EXTRA_CAPABILITIES } from './write-extra.js'
import { SENSITIVE_CAPABILITIES } from './write-sensitive.js'
import { PEOPLE_CAPABILITIES } from './admin-people.js'
import { PLATFORM_CAPABILITIES } from './admin-platform.js'
import { RELAY_CAPABILITIES } from './admin-relay.js'
import { OPS_CAPABILITIES } from './admin-ops.js'

export * from './types.js'
export { defineCapability } from './define.js'
export { createCapabilityRegistry } from './registry.js'
export {
  COCKPIT_TRUNCATE_HINT,
  byteSize,
  isSensitiveKey,
  redact,
  redactValueText,
  truncateResult,
  type TruncateResult,
} from './redact.js'
export { READ_ONLY_CAPABILITIES } from './read.js'
export { READ_ONLY_EXTRA_CAPABILITIES, deliveryPreview, parseDeliveryRequest } from './read-extra.js'
export { WRITE_CAPABILITIES, rolloutPreview } from './write.js'
export { WRITE_EXTRA_CAPABILITIES } from './write-extra.js'
export { SENSITIVE_CAPABILITIES } from './write-sensitive.js'
export { PEOPLE_CAPABILITIES } from './admin-people.js'
export { PLATFORM_CAPABILITIES } from './admin-platform.js'
export { RELAY_CAPABILITIES } from './admin-relay.js'
export { OPS_CAPABILITIES } from './admin-ops.js'

/**
 * 全部能力（docs/24 §4 的全集）：
 * - `read.ts` / `write.ts`：WP56a 的 ★ 核心能力；
 * - `read-extra.ts` / `write-extra.ts` / `write-sensitive.ts`：WP56e1 补齐的未标 ★ 能力
 *   （R0 / R1+R2 / R3 分开，敏感的那几条一眼能看见）；
 * - `admin-people.ts` / `admin-platform.ts` / `admin-relay.ts` / `admin-ops.ts`：WP56f 把经典页面
 *   剩下的操作补成能力（覆盖率从 46% 提到 ≥90%）。
 */
export function defaultCapabilities(): CapabilityDefinition[] {
  return [
    ...READ_ONLY_CAPABILITIES,
    ...READ_ONLY_EXTRA_CAPABILITIES,
    ...WRITE_CAPABILITIES,
    ...WRITE_EXTRA_CAPABILITIES,
    ...SENSITIVE_CAPABILITIES,
    ...PEOPLE_CAPABILITIES,
    ...PLATFORM_CAPABILITIES,
    ...RELAY_CAPABILITIES,
    ...OPS_CAPABILITIES,
  ]
}

export function createDefaultCapabilityRegistry(): CapabilityRegistry {
  return createCapabilityRegistry(defaultCapabilities())
}
