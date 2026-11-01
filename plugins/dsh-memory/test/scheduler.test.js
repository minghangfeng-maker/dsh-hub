/**
 * 调度：每日/每周计划时间、是否该跑、忙/闲/禁用与续跑。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createScheduler, isDue, lastScheduledAt } from '../runtime/scheduler.js'
import { patchSettings, readSettings } from '../runtime/store.js'
import { testService } from './helpers.js'

/** 计划时间按本机时区解释，所以测试里的时刻也用本机时区构造（CI 跑在 UTC，写死 +08:00 会错位） */
function local(text) {
  const [date, time] = text.split('T')
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  return new Date(y, m - 1, d, hh, mm)
}

test('lastScheduledAt：每日取最近一次，每周回退到周一', () => {
  const now = local('2026-10-20T12:00') // 周二
  const daily = lastScheduledAt({ deepFrequency: 'daily', deepTime: '03:30' }, now)
  assert.equal(daily.getDate(), 20)
  assert.equal(daily.getHours(), 3)
  assert.equal(daily.getMinutes(), 30)

  const early = lastScheduledAt({ deepFrequency: 'daily', deepTime: '03:30' }, local('2026-10-20T01:00'))
  assert.equal(early.getDate(), 19)

  const weekly = lastScheduledAt({ deepFrequency: 'weekly', deepTime: '03:30' }, now)
  assert.equal(weekly.getDay(), 1, '每周应回退到周一')
  assert.equal(weekly.getDate(), 19)

  assert.equal(lastScheduledAt({ deepFrequency: 'off', deepTime: '03:30' }, now), null)
})

test('isDue：上次深整理早于最近计划时间才算过期', () => {
  const now = local('2026-10-20T12:00')
  const settings = { deepFrequency: 'daily', deepTime: '03:30', lastDeep: null }
  assert.equal(isDue(settings, now), true)
  assert.equal(isDue({ ...settings, lastDeep: local('2026-10-20T03:31').toISOString() }, now), false)
  assert.equal(isDue({ ...settings, lastDeep: local('2026-10-19T03:31').toISOString() }, now), true)
  assert.equal(isDue({ ...settings, deepFrequency: 'off' }, now), false)
})

function fakeConsolidator(results = {}) {
  const calls = { resume: 0, deep: 0 }
  return {
    calls,
    async resumeIfPaused() {
      calls.resume += 1
      return results.resumed ?? null
    },
    async runDeep(options) {
      calls.deep += 1
      return results.deep ?? { id: 'run-scheduled', status: 'done', reason: options?.reason }
    },
  }
}

test('tick：忙 → 不动；空闲够了且到期 → 跑深整理', async () => {
  const { home, service, cleanup } = await testService()
  try {
    await patchSettings(home, { idleMinutes: 1, deepTime: '03:30' })
    const clock = { now: local('2026-10-20T12:00') }
    let busy = true
    const consolidator = fakeConsolidator()
    const scheduler = createScheduler({ service, consolidator, ctx: null, isBusy: () => busy, now: () => clock.now })

    let result = await scheduler.tick()
    assert.equal(result.action, 'busy')
    assert.equal(consolidator.calls.deep, 0)

    busy = false
    clock.now = new Date(clock.now.getTime() + 30_000)
    result = await scheduler.tick()
    assert.equal(result.action, 'waiting-idle')

    clock.now = new Date(clock.now.getTime() + 60_000)
    result = await scheduler.tick()
    assert.equal(result.action, 'ran')
    assert.equal(consolidator.calls.deep, 1)
  } finally {
    await cleanup()
  }
})

test('tick：禁用时不跑；暂停中的运行在空闲后续跑', async () => {
  const { service, cleanup } = await testService()
  try {
    await patchSettings(service.home, { enabled: false, idleMinutes: 1 })
    const clock = { now: local('2026-10-20T12:00') }
    const consolidator = fakeConsolidator({ resumed: { id: 'run-paused', status: 'done' } })
    const scheduler = createScheduler({ service, consolidator, ctx: null, isBusy: () => false, now: () => clock.now })

    let result = await scheduler.tick()
    assert.equal(result.action, 'disabled')

    await patchSettings(service.home, { enabled: true })
    clock.now = new Date(clock.now.getTime() + 2 * 60_000)
    result = await scheduler.tick()
    assert.equal(result.action, 'resumed')
    assert.equal(result.run.id, 'run-paused')
    assert.equal(consolidator.calls.resume, 1)
    // 续跑优先于新开一次
    assert.equal(consolidator.calls.deep, 0)
  } finally {
    await cleanup()
  }
})

test('tick：还没到计划时间就不跑', async () => {
  const { service, cleanup } = await testService()
  try {
    const now = local('2026-10-20T12:00')
    const settings = await readSettings(service.home)
    await patchSettings(service.home, { idleMinutes: 1, lastDeep: local('2026-10-20T03:31').toISOString() })
    const consolidator = fakeConsolidator()
    const scheduler = createScheduler({ service, consolidator, ctx: null, isBusy: () => false, now: () => now })
    scheduler.resetIdle()
    const result = await scheduler.tick()
    assert.equal(result.action, 'not-due')
    assert.equal(settings.enabled, true)
    assert.equal(consolidator.calls.deep, 0)
  } finally {
    await cleanup()
  }
})
