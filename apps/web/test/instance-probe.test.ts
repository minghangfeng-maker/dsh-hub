import { describe, expect, it } from 'vitest'
import type { InstanceProbe } from '@dsh-hub/shared'

import { probeTextOf } from '@/components/admin/instance-probe'

/**
 * WP33「会话」列文案（docs/22 §6.3）：
 * `进行中 N` / `有人在看` / `空闲 X 分钟（Y 分钟后休眠）` / `未知`。
 * 判定与阈值在服务端，前端只负责把时间点翻译成人话。
 */
const NOW = Date.parse('2026-10-22T12:00:00.000Z')

function probe(part: Partial<InstanceProbe>): InstanceProbe {
  return {
    state: 'unattended',
    probeAt: '2026-10-22T11:59:00.000Z',
    runningSessions: 0,
    openClients: 0,
    lastPromptAt: null,
    lastBusyAt: null,
    lastClientAt: null,
    idleSince: null,
    stopAt: null,
    ...part,
  }
}

describe('probeTextOf（WP33）', () => {
  it('没有探针结果（实例没在跑）→ 破折号', () => {
    expect(probeTextOf(null, NOW).label).toBe('—')
  })

  it('busy → 进行中 N，并说明有没有人在看', () => {
    const text = probeTextOf(probe({ state: 'busy', runningSessions: 3, openClients: 2 }), NOW)
    expect(text.label).toBe('进行中 3')
    expect(text.hint).toContain('2 条连接')
    expect(text.tone).toBe('success')
  })

  it('watching → 有人在看，依据里带空闲分钟', () => {
    const text = probeTextOf(
      probe({
        state: 'watching',
        openClients: 1,
        idleSince: '2026-10-22T10:30:00.000Z',
        stopAt: '2026-10-22T12:30:00.000Z',
      }),
      NOW,
    )
    expect(text.label).toBe('有人在看')
    expect(text.hint).toContain('1 条连接')
    expect(text.tone).toBe('sky')
  })

  it('unattended → 空闲 X 分钟（Y 分钟后休眠）', () => {
    const text = probeTextOf(
      probe({
        state: 'unattended',
        idleSince: '2026-10-22T11:30:00.000Z',
        stopAt: '2026-10-22T12:30:00.000Z',
        lastClientAt: '2026-10-22T11:30:00.000Z',
      }),
      NOW,
    )
    expect(text.label).toBe('空闲 30 分钟（30 分钟后休眠）')
    expect(text.hint).toContain('最后断开')
  })

  it('unattended 但没有休眠时刻（不回收）→ 只说空闲多久', () => {
    const text = probeTextOf(
      probe({ state: 'unattended', idleSince: '2026-10-22T11:00:00.000Z', stopAt: null }),
      NOW,
    )
    expect(text.label).toBe('空闲 60 分钟')
  })

  it('unknown → 未知，提示按 CPU 规则回收', () => {
    const text = probeTextOf(probe({ state: 'unknown' }), NOW)
    expect(text.label).toBe('未知')
    expect(text.hint).toContain('CPU')
  })
})
