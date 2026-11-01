import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, SETTINGS_KEYS } from '@dsh-hub/shared'
import { openDb } from '../src/db/index.js'
import { runMigrations } from '../src/db/migrate.js'
import { createTestClock } from '../src/lib/clock.js'
import { createSettingsStore } from '../src/lib/settings.js'

function makeStore(onWarn?: (message: string) => void) {
  const db = openDb(':memory:')
  runMigrations(db)
  const clock = createTestClock('2026-10-12T13:00:00.000Z')
  const store = createSettingsStore(db, clock, { onWarn: (message) => onWarn?.(message) })
  return { db, clock, store }
}

describe('settings 存储（03 §1.6）', () => {
  it('未落库时返回默认值，且与 DEFAULT_SETTINGS 一致', () => {
    const { store, db } = makeStore()
    for (const key of SETTINGS_KEYS) {
      expect(store.get(key)).toEqual(DEFAULT_SETTINGS[key])
    }
    expect(store.all()).toEqual(DEFAULT_SETTINGS)
    db.close()
  })

  it('set 校验并持久化（换一个 store 实例仍能读到）', () => {
    const { store, db, clock } = makeStore()
    const updated = store.set('site', {
      name: '小站',
      tagline: 't',
      announcement: '公告',
      announcementLevel: 'warning',
    })
    expect(updated.name).toBe('小站')
    const again = createSettingsStore(db, clock)
    expect(again.get('site').name).toBe('小站')
    const row = db.get<{ updated_at: string }>("SELECT updated_at FROM settings WHERE key = 'site'")
    expect(row?.updated_at).toBe('2026-10-12T13:00:00.000Z')
    db.close()
  })

  it('非法值抛 VALIDATION_FAILED 并带 details.fields，不落库', () => {
    const { store, db } = makeStore()
    // 0 是合法的「维护模式」（只停不起，WP40 集成联调要用它验证容量满）；负数才是非法值
    store.set('capacity', { maxRunning: 0, maxConcurrentExports: 2 })
    expect(store.get('capacity').maxRunning).toBe(0)
    expect(() => store.set('capacity', { maxRunning: -1, maxConcurrentExports: 2 })).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    )
    try {
      store.set('capacity', { maxRunning: 999, maxConcurrentExports: 2 })
      throw new Error('999 应该被拒')
    } catch (error) {
      const details = (error as { details?: { fields?: Record<string, string> } }).details
      expect(details?.fields?.maxRunning).toBeTruthy()
    }
    // 非法值不落库：还是上一步写进去的 0
    expect(store.get('capacity')).toEqual({ ...DEFAULT_SETTINGS.capacity, maxRunning: 0 })
    db.close()
  })

  it('setMany 按键整体替换且在一个事务里', () => {
    const { store, db } = makeStore()
    const all = store.setMany({
      registration: { mode: 'open', requireApproval: true, maxUsers: 10 },
      security: { adminSessionHours: 24, reauthMinutes: 5 },
    })
    expect(all.registration.mode).toBe('open')
    expect(all.security.adminSessionHours).toBe(24)
    expect(all.site).toEqual(DEFAULT_SETTINGS.site)
    db.close()
  })

  it('setMany 里有一项非法则整体不生效', () => {
    const { store, db } = makeStore()
    expect(() =>
      store.setMany({
        registration: { mode: 'open', requireApproval: false, maxUsers: 10 },
        security: { adminSessionHours: 0, reauthMinutes: 5 },
      }),
    ).toThrow()
    expect(store.get('registration')).toEqual(DEFAULT_SETTINGS.registration)
    db.close()
  })

  it('reset 回到默认值', () => {
    const { store, db } = makeStore()
    store.set('registration', { mode: 'closed', requireApproval: false, maxUsers: 1 })
    store.reset('registration')
    expect(store.get('registration')).toEqual(DEFAULT_SETTINGS.registration)
    db.close()
  })

  it('库里数据损坏时回退默认值并告警', () => {
    const warn = vi.fn()
    const { store, db } = makeStore(warn)
    db.run(
      "INSERT INTO settings (key, value_json, updated_at) VALUES ('site', ?, '2026-01-01T00:00:00.000Z')",
      '{oops',
    )
    expect(store.get('site')).toEqual(DEFAULT_SETTINGS.site)
    expect(warn).toHaveBeenCalled()
    db.run(
      "UPDATE settings SET value_json = ? WHERE key = 'site'",
      JSON.stringify({ name: 'x', tagline: 'y', announcement: '', announcementLevel: 'nope' }),
    )
    expect(store.get('site')).toEqual(DEFAULT_SETTINGS.site)
    db.close()
  })
})
