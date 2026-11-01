import type { HubDb } from '../../db/index.js'
import type { Clock } from '../../lib/clock.js'
import { deleteUsageBefore } from './repo.js'
import { deleteToolUsageBefore } from './tools/repo.js'
import { shanghaiDay } from './time.js'

/**
 * 逐条用量记录的保留期清理（12 §8；搜索池见 14 §4）：每小时删 `relay_usage` 与
 * `relay_tool_usage` 里早于 `logRetentionDays` 的行，日汇总（`relay_usage_daily`）永久保留。
 *
 * 搜索池的用量**不删当月**：免费额度按 `month` 统计 `free=1` 的行，删了会把额度还回去。
 *
 * 渠道/密钥的冷却到期不需要定时器：读的时候比较时间即可（12 §8 明确）。
 */

export const RELAY_CLEANUP_INTERVAL_MS = 3_600_000

export interface RelayCleanupOptions {
  db: HubDb
  clock: Clock
  log?: (message: string, detail?: Record<string, unknown>) => void
  /** 读取保留天数（每次清理时取，改设置后立刻生效） */
  retentionDays: () => number
  intervalMs?: number
}

export interface RelayCleanupHandle {
  /** 立刻跑一次，返回删除的行数 */
  runNow(): number
  stop(): void
}

export function startRelayCleanup(opts: RelayCleanupOptions): RelayCleanupHandle {
  const run = (): number => {
    const days = Math.max(1, Math.trunc(opts.retentionDays()))
    const cutoff = new Date(opts.clock.now().getTime() - days * 86_400_000).toISOString()
    try {
      const removed = deleteUsageBefore(opts.db, cutoff)
      const removedTools = deleteToolUsageBefore(
        opts.db,
        cutoff,
        shanghaiDay(opts.clock.nowIso()).slice(0, 7),
      )
      if (removed > 0 || removedTools > 0) {
        opts.log?.(`中转站清理了 ${String(removed)} 条过期用量记录与 ${String(removedTools)} 条搜索池记录`, {
          cutoff,
        })
      }
      return removed + removedTools
    } catch (error) {
      // 清理失败不该影响进程（下一轮再试）
      opts.log?.('中转站用量清理失败', { error: error instanceof Error ? error.message : String(error) })
      return 0
    }
  }

  const timer = setInterval(run, opts.intervalMs ?? RELAY_CLEANUP_INTERVAL_MS)
  // 不能让清理定时器拖住进程退出
  timer.unref?.()

  return {
    runNow: run,
    stop: () => clearInterval(timer),
  }
}
