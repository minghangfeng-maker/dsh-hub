import { DEFAULT_RELAY_SETTINGS, RelaySettingsSchema, type RelaySettings } from '@dsh-hub/shared'
import type { HubDb } from '../../db/index.js'
import { HubError, zodFieldErrors } from '../../lib/errors.js'

/**
 * 中转站设置存 `settings` 表的 `relay` 键（12 §8）。
 *
 * 为什么不用 `lib/settings.ts` 的 SettingsStore：那个 store 的键集合是 shared 的 `SETTINGS_KEYS`
 * （site/registration/…），加 `relay` 会动到全站设置的契约；这里自己读写这一行，schema 仍来自 shared。
 */
export const RELAY_SETTINGS_KEY = 'relay'

export interface RelaySettingsStore {
  get(): RelaySettings
  update(patch: Partial<RelaySettings>, at: string): RelaySettings
  reset(): void
  /** 默认值（测试与「恢复默认」用） */
  defaults(): RelaySettings
}

export interface RelaySettingsOptions {
  /** 读到损坏数据时的告警回调（默认静默回退默认值） */
  onWarn?: (message: string, detail?: unknown) => void
}

export function createRelaySettingsStore(db: HubDb, opts: RelaySettingsOptions = {}): RelaySettingsStore {
  function readRaw(): unknown {
    const row = db.get<{ value_json: string }>(
      'SELECT value_json FROM settings WHERE key = ?',
      RELAY_SETTINGS_KEY,
    )
    if (!row) return undefined
    try {
      return JSON.parse(row.value_json)
    } catch (error) {
      opts.onWarn?.('中转站设置不是合法 JSON，回退默认值', error)
      return undefined
    }
  }

  /** 逐字段校验：某个字段坏了只丢它自己，不把整份设置打回默认 */
  function get(): RelaySettings {
    const raw = readRaw()
    if (raw === undefined || raw === null || typeof raw !== 'object') return { ...DEFAULT_RELAY_SETTINGS }
    const merged = { ...DEFAULT_RELAY_SETTINGS, ...(raw as Record<string, unknown>) }
    const parsed = RelaySettingsSchema.safeParse(merged)
    if (parsed.success) return parsed.data
    opts.onWarn?.('中转站设置校验失败，回退默认值', zodFieldErrors(parsed.error))
    return { ...DEFAULT_RELAY_SETTINGS }
  }

  function write(value: RelaySettings, at: string): void {
    db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      RELAY_SETTINGS_KEY,
      JSON.stringify(value),
      at,
    )
  }

  return {
    get,
    update(patch, at) {
      const next = { ...get(), ...patch }
      const parsed = RelaySettingsSchema.safeParse(next)
      if (!parsed.success) {
        throw new HubError('VALIDATION_FAILED', '中转站设置不合法', { fields: zodFieldErrors(parsed.error) })
      }
      write(parsed.data, at)
      return parsed.data
    },
    reset() {
      db.run('DELETE FROM settings WHERE key = ?', RELAY_SETTINGS_KEY)
    },
    defaults() {
      return { ...DEFAULT_RELAY_SETTINGS }
    },
  }
}
