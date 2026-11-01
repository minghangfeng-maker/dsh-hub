import { DEFAULT_COMPUTE_SETTINGS, ComputeSettingsSchema, type ComputeSettings } from '@dsh-hub/shared'
import type { HubDb } from '../../db/index.js'
import { HubError, zodFieldErrors } from '../../lib/errors.js'

/**
 * 算力租赁设置存 `settings` 表的 `compute` 键（13 §5）。
 * 与 relay 一样由模块自己读写、不进 `SettingsSchema`（免得动全站设置的契约）。
 */
export const COMPUTE_SETTINGS_KEY = 'compute'

export interface ComputeSettingsStore {
  get(): ComputeSettings
  update(patch: Partial<ComputeSettings>, at: string): ComputeSettings
  reset(): void
  defaults(): ComputeSettings
}

export interface ComputeSettingsOptions {
  /** 读到损坏数据时的告警回调（默认静默回退默认值） */
  onWarn?: (message: string, detail?: unknown) => void
}

export function createComputeSettingsStore(
  db: HubDb,
  opts: ComputeSettingsOptions = {},
): ComputeSettingsStore {
  function readRaw(): unknown {
    const row = db.get<{ value_json: string }>(
      'SELECT value_json FROM settings WHERE key = ?',
      COMPUTE_SETTINGS_KEY,
    )
    if (!row) return undefined
    try {
      return JSON.parse(row.value_json)
    } catch (error) {
      opts.onWarn?.('算力租赁设置不是合法 JSON，回退默认值', error)
      return undefined
    }
  }

  /** 逐字段校验：某个字段坏了只丢它自己，不把整份设置打回默认 */
  function get(): ComputeSettings {
    const raw = readRaw()
    if (raw === undefined || raw === null || typeof raw !== 'object') return { ...DEFAULT_COMPUTE_SETTINGS }
    const merged = { ...DEFAULT_COMPUTE_SETTINGS, ...(raw as Record<string, unknown>) }
    const parsed = ComputeSettingsSchema.safeParse(merged)
    if (parsed.success) return parsed.data
    opts.onWarn?.('算力租赁设置校验失败，回退默认值', zodFieldErrors(parsed.error))
    return { ...DEFAULT_COMPUTE_SETTINGS }
  }

  function write(value: ComputeSettings, at: string): void {
    db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      COMPUTE_SETTINGS_KEY,
      JSON.stringify(value),
      at,
    )
  }

  return {
    get,
    update(patch, at) {
      // PATCH 只改给出的字段；`plans` 给出时整体替换（13 §6）
      const next = { ...get(), ...patch }
      const parsed = ComputeSettingsSchema.safeParse(next)
      if (!parsed.success) {
        throw new HubError('VALIDATION_FAILED', '算力租赁设置不合法', {
          fields: zodFieldErrors(parsed.error),
        })
      }
      write(parsed.data, at)
      return parsed.data
    },
    reset() {
      db.run('DELETE FROM settings WHERE key = ?', COMPUTE_SETTINGS_KEY)
    },
    defaults() {
      return { ...DEFAULT_COMPUTE_SETTINGS }
    },
  }
}
