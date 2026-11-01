/**
 * 定时整理：每分钟 tick 一次，空闲时跑深整理。
 *
 * DESIGN.md §8.5：
 *   - 定时器用 `ctx.effect` 创建，插件卸载时清除；
 *   - 抢占看 agents 注册表（有会话在跑 turn 就不开始/暂停）；
 *   - 同刻只允许一个整理任务（文件锁在 consolidate 里拿）。
 *
 * 「无活跃会话持续 X 分钟后补跑当天没跑的深整理」用 `lastBusyAt` 近似：
 * 每个 tick 只要发现有会话在跑就刷新它，空闲满 idleMinutes 才触发。
 *
 * @module @local/dsh-memory/scheduler
 */

import { readSettings } from './store.js'

/** tick 间隔（毫秒）。 */
const TICK_MS = 60_000

/**
 * 算「最近一次应该跑」的时间点。
 * @param {{deepTime: string, deepFrequency: string}} settings - 设置。
 * @param {Date} now - 当前时间。
 * @returns {Date|null} 最近一次计划时间；off 返回 null。
 */
export function lastScheduledAt(settings, now = new Date()) {
  if (settings.deepFrequency === 'off') return null
  const [hour, minute] = String(settings.deepTime || '03:30').split(':').map(Number)
  const occurrence = new Date(now)
  occurrence.setSeconds(0, 0)
  occurrence.setHours(hour, minute, 0, 0)
  if (occurrence.getTime() > now.getTime()) occurrence.setDate(occurrence.getDate() - 1)
  if (settings.deepFrequency === 'weekly') {
    // 回退到最近的周一。
    const day = occurrence.getDay() // 0=周日
    const back = (day + 6) % 7
    occurrence.setDate(occurrence.getDate() - back)
    if (occurrence.getTime() > now.getTime()) occurrence.setDate(occurrence.getDate() - 7)
  }
  return occurrence
}

/** 这次计划是否已经跑过。 */
export function isDue(settings, now = new Date()) {
  const scheduled = lastScheduledAt(settings, now)
  if (!scheduled) return false
  const last = settings.lastDeep ? Date.parse(settings.lastDeep) : 0
  return !Number.isFinite(last) || last < scheduled.getTime()
}

/**
 * 创建调度器。
 * @param {{service: object, consolidator: object, ctx?: object, isBusy?: () => boolean, now?: () => Date}} input - 依赖。
 * @returns {object} 调度器。
 */
export function createScheduler(input) {
  const { service, consolidator } = input
  const ctx = input.ctx
  const now = input.now ?? (() => new Date())
  let timer = null
  let startedAt = now().getTime()
  let lastBusyAt = startedAt
  let running = false
  let ticks = 0

  /** 是否有会话在跑 turn。 */
  function isBusy() {
    if (typeof input.isBusy === 'function') return Boolean(input.isBusy())
    try {
      const agents = ctx?.get?.('agents')?.list?.() ?? []
      return agents.some((agent) => agent?.status === 'running')
    } catch {
      return false
    }
  }

  /**
   * 跑一次检查（测试可直接调用）。
   * @returns {Promise<object>} 本 tick 的动作摘要。
   */
  async function tick() {
    ticks += 1
    const at = now()
    const busy = isBusy()
    if (busy) {
      lastBusyAt = at.getTime()
      return { action: 'busy' }
    }
    const settings = await readSettings(service.home)
    if (!settings.enabled) return { action: 'disabled' }
    const idleMs = at.getTime() - Math.max(lastBusyAt, startedAt)
    const idleEnough = idleMs >= settings.idleMinutes * 60_000

    // 暂停中的深整理：空闲够了就续跑。
    if (idleEnough) {
      const resumed = await consolidator.resumeIfPaused().catch(() => null)
      if (resumed) return { action: 'resumed', run: { id: resumed.id, status: resumed.status } }
    }
    if (running) return { action: 'already-running' }
    if (!isDue(settings, at)) return { action: 'not-due' }
    if (!idleEnough) return { action: 'waiting-idle', idleMs, idleMinutes: settings.idleMinutes }

    running = true
    try {
      const run = await consolidator.runDeep({ reason: 'scheduled' })
      return { action: 'ran', run: { id: run.id, status: run.status } }
    } finally {
      running = false
    }
  }

  /** 启动定时器（ctx.effect 管理生命周期）。 */
  function start() {
    if (!ctx?.effect) return () => {}
    return ctx.effect(() => {
      timer = setInterval(() => {
        void tick().catch((error) => service.recordError?.(error))
      }, TICK_MS)
      timer.unref?.()
      // 启动 5 秒后先看一眼（别在进程刚起来、会话还没恢复时抢跑）。
      const first = setTimeout(() => {
        void tick().catch((error) => service.recordError?.(error))
      }, 5_000)
      first.unref?.()
      return () => {
        clearTimeout(first)
        if (timer) clearInterval(timer)
        timer = null
      }
    }, 'memory: scheduler tick')
  }

  return {
    start,
    tick,
    isBusy,
    isDue: (settings, at) => isDue(settings, at ?? now()),
    lastScheduledAt: (settings, at) => lastScheduledAt(settings, at ?? now()),
    stats: () => ({ ticks, startedAt, lastBusyAt, running }),
    resetIdle: () => {
      startedAt = now().getTime()
      lastBusyAt = startedAt
    },
  }
}
