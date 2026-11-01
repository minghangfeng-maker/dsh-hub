import { z } from 'zod'
import { CapabilityDescriptorSchema, type CapabilityDescriptor, type CockpitArea } from '@dsh-hub/shared'
import { HubError } from '../../../lib/errors.js'
import type { CapabilityDefinition, CapabilityRegistry } from './types.js'

/**
 * 能力注册表：id 唯一、目录项（JSON Schema）在**定义期**算好。
 *
 * 目录项在构造时过一遍 `CapabilityDescriptorSchema`：description 写超 300 字、id 不符合
 * `域.动词` 这类「只有人看得见」的错误，启动时就炸，而不是等座舱 DSH 拿到一份坏目录。
 */
export function createCapabilityRegistry(definitions: CapabilityDefinition[]): CapabilityRegistry {
  const byId = new Map<string, CapabilityDefinition>()
  for (const definition of definitions) {
    if (byId.has(definition.id)) throw new HubError('INTERNAL', `能力 id 重复：${definition.id}`)
    byId.set(definition.id, definition)
  }
  const descriptors = definitions
    .map(toDescriptor)
    .sort((a, b) => (a.area === b.area ? a.id.localeCompare(b.id) : a.area.localeCompare(b.area)))

  return {
    get: (id) => byId.get(id),
    list: () => [...byId.values()],
    descriptors: () => descriptors,
    catalog(query) {
      const q = query?.q?.trim().toLowerCase() ?? ''
      const area = query?.area
      const tokens = q.split(/[\s,，;；]+/u).filter((token) => token.length > 0)
      const items = descriptors.filter((descriptor) => {
        if (area && descriptor.area !== area) return false
        if (tokens.length === 0) return true
        const haystack = `${descriptor.id}\n${descriptor.title}\n${descriptor.description}`.toLowerCase()
        return tokens.every((token) => haystack.includes(token))
      })
      return { items, total: items.length }
    },
  }
}

function toDescriptor(definition: CapabilityDefinition): CapabilityDescriptor {
  const candidate = {
    id: definition.id,
    area: definition.area as CockpitArea,
    title: definition.title,
    description: definition.description,
    risk: definition.risk,
    input: jsonSchemaOf(definition.input),
    ...(definition.secretFields ? { secretFields: definition.secretFields } : {}),
    ...(definition.dataSource === undefined ? {} : { dataSource: definition.dataSource }),
    ...(definition.classicPath === undefined ? {} : { classicPath: definition.classicPath }),
  }
  const parsed = CapabilityDescriptorSchema.safeParse(candidate)
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；')
    throw new HubError('INTERNAL', `能力 ${definition.id} 的目录项不合法：${fields}`)
  }
  return parsed.data
}

/** zod → JSON Schema（给模型看）。生成失败时给空 schema：宁可参数说明缺失，也不要启动失败 */
function jsonSchemaOf(input: z.ZodType): Record<string, unknown> {
  try {
    return z.toJSONSchema(input, { io: 'input' }) as Record<string, unknown>
  } catch {
    return {}
  }
}
