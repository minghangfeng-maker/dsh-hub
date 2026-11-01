import { describe, expect, it } from 'vitest'

import {
  formatBytes,
  formatCount,
  formatCountdown,
  formatDateTime,
  formatDuration,
  formatPercent,
  fromNow,
} from '@/composables/useFormat'
import { instanceStatusMeta, JOB_STATUS_TEXT, USER_PLUGIN_STATE_TEXT } from '@/composables/useInstanceStatus'

describe('格式化工具（07 §6：资源条 / 运行时长 / 相对时间）', () => {
  it('formatBytes：B/KB/MB/GB/TB，整数不带小数', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(2 * 1024 ** 3)).toBe('2 GB')
    expect(formatBytes(1.25 * 1024 ** 3)).toBe('1.3 GB')
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(Number.NaN)).toBe('—')
  })

  it('formatPercent / formatCount 带千分位', () => {
    expect(formatPercent(0.6234)).toBe('62%')
    expect(formatPercent(null)).toBe('—')
    expect(formatCount(1234567)).toBe('1,234,567')
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe('—')
  })

  it('formatDuration：两级以内（2 小时 13 分 / 3 天 4 小时 / 13 分 5 秒）', () => {
    expect(formatDuration(0)).toBe('0 秒')
    expect(formatDuration(45_000)).toBe('45 秒')
    expect(formatDuration(45, 's')).toBe('45 秒')
    expect(formatDuration(65, 's')).toBe('1 分 5 秒')
    expect(formatDuration(2 * 3600 + 13 * 60, 's')).toBe('2 小时 13 分')
    expect(formatDuration(3 * 86400 + 4 * 3600, 's')).toBe('3 天 4 小时')
    expect(formatDuration(-5, 's')).toBe('0 秒')
  })

  it('formatCountdown：mm:ss（ACCOUNT_LOCKED 倒计时）', () => {
    expect(formatCountdown(900)).toBe('15:00')
    expect(formatCountdown(65)).toBe('01:05')
    expect(formatCountdown(-3)).toBe('00:00')
  })

  it('formatDateTime / fromNow 用中文', () => {
    expect(formatDateTime('2026-10-12T13:30:00.000Z')).toMatch(/^2026-10-1[23] \d{2}:30$/)
    expect(formatDateTime(null)).toBe('—')
    expect(fromNow(new Date(Date.now() - 3 * 60_000).toISOString())).toContain('分钟前')
  })
})

describe('状态文案表', () => {
  it('插件状态与任务状态都有中文', () => {
    expect(USER_PLUGIN_STATE_TEXT.synced).toBe('已同步')
    expect(JOB_STATUS_TEXT.succeeded).toBe('已完成')
    expect(JOB_STATUS_TEXT.partial).toBe('部分成功')
  })

  it('实例状态元数据齐全（用于表格里的兜底渲染）', () => {
    for (const status of ['running', 'starting', 'stopping', 'stopped', 'absent', 'error']) {
      expect(instanceStatusMeta(status).text.length).toBeGreaterThan(0)
    }
  })
})
