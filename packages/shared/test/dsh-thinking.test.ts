import { describe, expect, it } from 'vitest'
import {
  CreateRelayModelRequestSchema,
  effectiveDshThinking,
  UpdateRelayModelRequestSchema,
} from '../src/index.js'

describe('effectiveDshThinking（WP13，12 §7.0）', () => {
  it('没设 → null', () => {
    expect(effectiveDshThinking({ reasoningEfforts: ['off', 'high'] }, null)).toBeNull()
  })

  it('声明过的档位生效（含 off）', () => {
    expect(effectiveDshThinking({ reasoningEfforts: ['off', 'low', 'high', 'max'] }, 'max')).toBe('max')
    expect(effectiveDshThinking({ reasoningEfforts: ['off', 'high'] }, 'off')).toBe('off')
  })

  it('没声明的档位、没声明思考、只声明了 off → null', () => {
    expect(effectiveDshThinking({ reasoningEfforts: ['off', 'high'] }, 'medium')).toBeNull()
    expect(effectiveDshThinking({}, 'high')).toBeNull()
    expect(effectiveDshThinking({ reasoningEfforts: ['off'] }, 'off')).toBeNull()
    expect(effectiveDshThinking({ reasoningEfforts: ['bogus', 'high'] }, 'high')).toBe('high')
  })
})

describe('defaultThinking 字段', () => {
  it('新建默认 null；修改省略 = 不改、null = 清除', () => {
    const created = CreateRelayModelRequestSchema.parse({ name: 'm', price: { inputMicro: 0, outputMicro: 0 } })
    expect(created.defaultThinking).toBeNull()
    expect(UpdateRelayModelRequestSchema.parse({ sort: 1 })).toEqual({ sort: 1 })
    expect(UpdateRelayModelRequestSchema.parse({ defaultThinking: null })).toEqual({ defaultThinking: null })
    expect(UpdateRelayModelRequestSchema.safeParse({ defaultThinking: 'huge' }).success).toBe(false)
  })
})
