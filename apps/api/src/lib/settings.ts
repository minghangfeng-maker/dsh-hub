import { z } from 'zod'
import {
  CapacitySettingsSchema,
  CockpitSettingsSchema,
  ContainerSettingsSchema,
  DEFAULT_SETTINGS,
  DesktopSettingsSchema,
  ExportsSettingsSchema,
  MobileSettingsSchema,
  QuotaSchema,
  RegistrationSettingsSchema,
  SecuritySettingsSchema,
  SETTINGS_KEYS,
  SiteSettingsSchema,
  type Settings,
  type SettingsKey,
} from '@dsh-hub/shared'
import type { HubDb } from '../db/index.js'
import type { Clock } from './clock.js'
import { HubError, zodFieldErrors } from './errors.js'

/** 每个 settings 键一个 schema（03 §1.6）：写入必须校验，读出也校验（防手改库） */
const KEY_SCHEMAS = {
  site: SiteSettingsSchema,
  registration: RegistrationSettingsSchema,
  default_quota: QuotaSchema,
  capacity: CapacitySettingsSchema,
  exports: ExportsSettingsSchema,
  security: SecuritySettingsSchema,
  desktop: DesktopSettingsSchema,
  mobile: MobileSettingsSchema,
  container: ContainerSettingsSchema,
  cockpit: CockpitSettingsSchema,
} satisfies Record<SettingsKey, z.ZodType>

interface SettingsRow {
  key: string
  value_json: string
  updated_at: string
}

export interface SettingsStore {
  /** 取一个键（缺省/损坏时回退到默认值） */
  get<K extends SettingsKey>(key: K): Settings[K]
  /** 取全部（合并默认值） */
  all(): Settings
  /** 校验并写入一个键，返回落库后的值 */
  set<K extends SettingsKey>(key: K, value: unknown): Settings[K]
  /** 批量按键替换（PATCH /api/admin/settings），整体在一个事务里 */
  setMany(patch: Partial<Record<SettingsKey, unknown>>): Settings
  /** 删除某键，回到默认值 */
  reset(key: SettingsKey): void
}

export interface SettingsStoreOptions {
  /** 读到损坏数据时的告警回调（默认静默回退） */
  onWarn?: (message: string, detail?: unknown) => void
}

/**
 * settings 表的读写（03 §1.6）。默认值来自 shared 的 `DEFAULT_SETTINGS`，
 * 保证「文档、shared、数据库」三处默认值只有一份真相。
 */
export function createSettingsStore(db: HubDb, clock: Clock, opts: SettingsStoreOptions = {}): SettingsStore {
  const defaults = SettingsSchemaAll()

  function readRow(key: SettingsKey): SettingsRow | undefined {
    return db.get<SettingsRow>('SELECT key, value_json, updated_at FROM settings WHERE key = ?', key)
  }

  function parse<K extends SettingsKey>(key: K, raw: string): Settings[K] | null {
    try {
      const parsed = KEY_SCHEMAS[key].safeParse(JSON.parse(raw))
      if (!parsed.success) {
        opts.onWarn?.(`设置项 ${key} 校验失败，回退默认值`, zodFieldErrors(parsed.error))
        return null
      }
      return parsed.data as Settings[K]
    } catch (error) {
      opts.onWarn?.(`设置项 ${key} 不是合法 JSON，回退默认值`, error)
      return null
    }
  }

  function write(key: SettingsKey, value: unknown): void {
    const parsed = KEY_SCHEMAS[key].safeParse(value)
    if (!parsed.success) {
      throw new HubError('VALIDATION_FAILED', `设置项 ${key} 不合法`, {
        fields: zodFieldErrors(parsed.error),
      })
    }
    db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(parsed.data),
      clock.nowIso(),
    )
  }

  return {
    get(key) {
      const row = readRow(key)
      if (!row) return defaults[key]
      return parse(key, row.value_json) ?? defaults[key]
    },
    all() {
      const result = { ...defaults }
      for (const key of SETTINGS_KEYS) {
        const row = readRow(key)
        if (!row) continue
        const value = parse(key, row.value_json)
        if (value !== null) (result as Record<string, unknown>)[key] = value
      }
      return result
    },
    set(key, value) {
      write(key, value)
      return this.get(key)
    },
    setMany(patch) {
      db.tx(() => {
        for (const key of SETTINGS_KEYS) {
          if (patch[key] === undefined) continue
          write(key, patch[key])
        }
      })
      return this.all()
    },
    reset(key) {
      db.run('DELETE FROM settings WHERE key = ?', key)
    },
  }
}

/** 默认值先自检一遍：文档、schema、常量三者不一致时立刻炸掉（而不是运行时才发现） */
function SettingsSchemaAll(): Settings {
  const parsed = z
    .object({
      site: SiteSettingsSchema,
      registration: RegistrationSettingsSchema,
      default_quota: QuotaSchema,
      capacity: CapacitySettingsSchema,
      exports: ExportsSettingsSchema,
      security: SecuritySettingsSchema,
      desktop: DesktopSettingsSchema,
      mobile: MobileSettingsSchema,
      container: ContainerSettingsSchema,
      cockpit: CockpitSettingsSchema,
    })
    .safeParse(DEFAULT_SETTINGS)
  if (!parsed.success) {
    throw new HubError('INTERNAL', 'DEFAULT_SETTINGS 与 settings schema 不一致', {
      fields: zodFieldErrors(parsed.error),
    })
  }
  return parsed.data
}
