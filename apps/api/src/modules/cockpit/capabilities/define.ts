import { z } from 'zod'
import type { CapabilityDefinition, CapabilitySpec } from './types.js'

/**
 * 定义能力的唯一入口（docs/24 §4）。
 *
 * 做两件事：把 zod `input` 与 `run` 绑在一起（运行前先 parse，**未经校验的参数绝不进 service**），
 * 并把泛型收窄成注册表能统一持有的 `CapabilityDefinition`（参数在内部 parse，外部只看 unknown）。
 */
export function defineCapability<I>(spec: CapabilitySpec<I>): CapabilityDefinition {
  const input = spec.input as unknown as z.ZodType
  return {
    id: spec.id,
    area: spec.area,
    title: spec.title,
    description: spec.description,
    risk: spec.risk,
    input,
    ...(spec.secretFields ? { secretFields: [...spec.secretFields] } : {}),
    ...(spec.dataSource === undefined ? {} : { dataSource: spec.dataSource }),
    ...(spec.classicPath === undefined ? {} : { classicPath: spec.classicPath }),
    ...(spec.preview
      ? {
          preview: async (ctx: Parameters<NonNullable<CapabilityDefinition['preview']>>[0], raw: unknown) =>
            spec.preview!(ctx, spec.input.parse(raw)),
        }
      : {}),
    run: async (ctx, raw) => spec.run(ctx, spec.input.parse(raw)),
  }
}
