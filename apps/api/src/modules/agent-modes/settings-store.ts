import {
  AgentModeSettingsSchema,
  DEFAULT_AGENT_MODE_SETTINGS,
  type AgentMode,
  type AgentModeSettings,
} from '@dsh-hub/shared'
import type { HubDb } from '../../db/index.js'
import { zodFieldErrors } from '../../lib/errors.js'

/** settings 表键（18 §2：两个模式各一份） */
export const AGENT_MODES_SETTINGS_KEY = 'agent_modes'

export type AgentModeSettingsMap = Record<AgentMode, AgentModeSettings>

/**
 * 模式设置存 `settings.agent_modes`（18 §2）。
 *
 * 18 §3.2 要求「设置在内存里缓存，PUT 后立即失效」：`/v1` 每个请求都要判断
 * 「模式是否开通、用户是否在 targets」，读库太浪费；这里缓存整份设置，写入时同步刷新。
 * schema 来自 shared（`AgentModeSettingsSchema`），读坏数据只丢那个模式、不让整份回默认。
 */
export interface AgentModeSettingsStore {
  get(mode: AgentMode): AgentModeSettings
  all(): AgentModeSettingsMap
  /** 写入一个模式（调用方负责合并与时间戳）并刷新缓存 */
  write(mode: AgentMode, settings: AgentModeSettings): void
  /** 丢掉缓存，下次读库（手动修库 / 测试用） */
  invalidate(): void
}

export interface AgentModeSettingsStoreOptions {
  onWarn?: (message: string, detail?: unknown) => void
}

export function createAgentModeSettingsStore(
  db: HubDb,
  opts: AgentModeSettingsStoreOptions = {},
): AgentModeSettingsStore {
  let cache: AgentModeSettingsMap | null = null

  function defaults(): AgentModeSettingsMap {
    return {
      'claude-code': { ...DEFAULT_AGENT_MODE_SETTINGS, targets: { userIds: [] } },
      codex: { ...DEFAULT_AGENT_MODE_SETTINGS, targets: { userIds: [] } },
    }
  }

  function readAll(): AgentModeSettingsMap {
    if (cache) return cache
    const result = defaults()
    const row = db.get<{ value_json: string }>(
      'SELECT value_json FROM settings WHERE key = ?',
      AGENT_MODES_SETTINGS_KEY,
    )
    if (!row) {
      cache = result
      return result
    }
    let raw: unknown
    try {
      raw = JSON.parse(row.value_json)
    } catch (error) {
      opts.onWarn?.('Claude Code / Codex 设置不是合法 JSON，回退默认值', error)
      cache = result
      return result
    }
    if (typeof raw !== 'object' || raw === null) {
      cache = result
      return result
    }
    const record = raw as Record<string, unknown>
    for (const mode of ['claude-code', 'codex'] as const) {
      if (record[mode] === undefined) continue
      const parsed = AgentModeSettingsSchema.safeParse(record[mode])
      if (parsed.success) result[mode] = parsed.data
      else opts.onWarn?.(`${mode} 设置校验失败，回退默认值`, zodFieldErrors(parsed.error))
    }
    cache = result
    return result
  }

  return {
    get(mode) {
      return readAll()[mode]
    },
    all() {
      return { ...readAll() }
    },
    write(mode, settings) {
      const next = { ...readAll(), [mode]: settings }
      const parsed = AgentModeSettingsSchema.safeParse(settings)
      if (!parsed.success) {
        throw new Error(`模式设置不合法：${JSON.stringify(zodFieldErrors(parsed.error))}`)
      }
      db.run(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        AGENT_MODES_SETTINGS_KEY,
        JSON.stringify(next),
        settings.updatedAt ?? new Date().toISOString(),
      )
      cache = next
    },
    invalidate() {
      cache = null
    },
  }
}
