import { DEFAULT_TOOL_SETTINGS, ToolSettingsSchema, type ToolSettings } from '@dsh-hub/shared'
import type { HubDb } from '../../../db/index.js'
import { HubError, zodFieldErrors } from '../../../lib/errors.js'

/**
 * 搜索池设置存 `settings` 表的 `relay_tools` 键（14 §3.2），写法照 `relay/settings-store.ts`：
 * 逐字段校验，某个字段坏了只丢它自己。
 *
 * 另外维护一个内部键 `relay_tools_meta`（不在契约里）：记录设置最后一次影响**下发渲染**的变更时间，
 * 用来判断「待下发」（照 12 §7.0 的 pending 思路，最小改动）。
 */
export const TOOL_SETTINGS_KEY = 'relay_tools'
export const TOOL_META_KEY = 'relay_tools_meta'

export interface ToolMeta {
  /** 最后一次影响 managed 渲染的设置变更时间（ISO）；从没改过 = null */
  updatedAt: string | null
}

export interface ToolSettingsStore {
  get(): ToolSettings
  update(patch: Partial<ToolSettings>, at: string): ToolSettings
  reset(): void
  defaults(): ToolSettings
  meta(): ToolMeta
  /** 记一次「影响渲染的设置变更」（用于待下发提示） */
  touchUpdatedAt(at: string): void
}

export interface ToolSettingsOptions {
  onWarn?: (message: string, detail?: unknown) => void
}

export function createToolSettingsStore(db: HubDb, opts: ToolSettingsOptions = {}): ToolSettingsStore {
  function readRaw(key: string): unknown {
    const row = db.get<{ value_json: string }>('SELECT value_json FROM settings WHERE key = ?', key)
    if (!row) return undefined
    try {
      return JSON.parse(row.value_json)
    } catch (error) {
      opts.onWarn?.(`设置 ${key} 不是合法 JSON，回退默认值`, error)
      return undefined
    }
  }

  function write(key: string, value: unknown, at: string): void {
    db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value),
      at,
    )
  }

  function get(): ToolSettings {
    const raw = readRaw(TOOL_SETTINGS_KEY)
    if (raw === undefined || raw === null || typeof raw !== 'object') {
      return { ...DEFAULT_TOOL_SETTINGS }
    }
    const merged = { ...DEFAULT_TOOL_SETTINGS, ...(raw as Record<string, unknown>) }
    const parsed = ToolSettingsSchema.safeParse(merged)
    if (parsed.success) return parsed.data
    opts.onWarn?.('搜索池设置校验失败，回退默认值', zodFieldErrors(parsed.error))
    return { ...DEFAULT_TOOL_SETTINGS }
  }

  function meta(): ToolMeta {
    const raw = readRaw(TOOL_META_KEY)
    if (raw === undefined || raw === null || typeof raw !== 'object') return { updatedAt: null }
    const value = (raw as Record<string, unknown>).updatedAt
    return { updatedAt: typeof value === 'string' ? value : null }
  }

  return {
    get,
    update(patch, at) {
      const next = { ...get(), ...patch }
      const parsed = ToolSettingsSchema.safeParse(next)
      if (!parsed.success) {
        throw new HubError('VALIDATION_FAILED', '搜索池设置不合法', {
          fields: zodFieldErrors(parsed.error),
        })
      }
      write(TOOL_SETTINGS_KEY, parsed.data, at)
      return parsed.data
    },
    reset() {
      db.run('DELETE FROM settings WHERE key = ?', TOOL_SETTINGS_KEY)
    },
    defaults() {
      return { ...DEFAULT_TOOL_SETTINGS }
    },
    meta,
    touchUpdatedAt(at) {
      write(TOOL_META_KEY, { updatedAt: at } satisfies ToolMeta, at)
    },
  }
}
