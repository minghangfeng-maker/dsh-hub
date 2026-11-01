import { THINKING_LEVELS } from '@dsh-hub/shared'
import { describe, expect, it } from 'vitest'

import {
  DEEPSEEK_THINKING_LEVELS,
  normalizeThinkingLevels,
  THINKING_LEVEL_OPTIONS,
  thinkingLevelsProblem,
} from '@/components/admin/thinking-levels'

describe('思考档位', () => {
  it('选项覆盖 pi-ai 的全部档位，按强度递增', () => {
    expect(THINKING_LEVEL_OPTIONS.map((option) => option.value)).toEqual([...THINKING_LEVELS])
    expect(THINKING_LEVEL_OPTIONS[0]!.label).toContain('关闭思考')
  })

  it('DeepSeek 档位 = off + low / high / max', () => {
    expect(DEEPSEEK_THINKING_LEVELS).toEqual(['off', 'low', 'high', 'max'])
  })

  it('归一化：按强度排序、去重、丢掉不认识的；空 → undefined', () => {
    expect(normalizeThinkingLevels(['max', 'off', 'low', 'max', 'bogus'])).toEqual(['off', 'low', 'max'])
    expect(normalizeThinkingLevels([])).toBeUndefined()
    expect(normalizeThinkingLevels(['bogus'])).toBeUndefined()
  })

  it('只勾 off 的模型会被拦下，其余情况放行', () => {
    expect(thinkingLevelsProblem([{ id: 'flash', name: 'Flash', reasoningEfforts: ['off'] }])).toContain(
      'flash',
    )
    expect(
      thinkingLevelsProblem([{ id: 'flash', name: 'Flash', reasoningEfforts: ['off', 'high'] }]),
    ).toBeNull()
    expect(thinkingLevelsProblem([{ id: 'plain', name: 'Plain' }])).toBeNull()
  })
})
