import type { Platform } from '@dsh-hub/shared'
import type { HubDb } from '../../db/index.js'

/**
 * 「下发到 DSH」的配置存 `settings` 表的 `relay_dsh` 键（12 §8）：
 * `{ presetId, defaultModelId, defaultRouteId, updatedAt }`。
 *
 * 为什么自己读写这一行：键集合不进 shared 的 `SETTINGS_KEYS`（同 `relay`），免得动全站设置的契约。
 * `updatedAt` 是 12 §7.0「还没下发」判定要用的（`pending` 比它与最近一次 rollout.models 的创建时间）；
 * 只在选中集合 / 默认模型 / 渲染内容真的有变化时才更新。
 */
export const RELAY_DSH_SETTINGS_KEY = 'relay_dsh'

/**
 * 桌面平台的「下发到 DSH」配置存在另一个键（docs/22 §3）：两个平台的勾选集合 / 默认模型 / 渲染指纹各一份，
 * 用一个键存两份会互相覆盖。键不进 shared 的 `SETTINGS_KEYS`（同 relay）。
 */
export const RELAY_DSH_DESKTOP_SETTINGS_KEY = 'relay_dsh_desktop'

export function relayDshSettingsKeyOf(platform: Platform): string {
  return platform === 'desktop' ? RELAY_DSH_DESKTOP_SETTINGS_KEY : RELAY_DSH_SETTINGS_KEY
}

export interface RelayDshSettings {
  /** Hub 自动维护的系统预设 id（还没建过 / 被删掉后为 null） */
  presetId: number | null
  /**
   * 选中的路由 id 列表（docs/22 §3）。云上的选中集合仍然落在 `relay_routes.dsh_enabled`（旧代码读它）；
   * 桌面平台没有那列可用，就把选中集合存在这里，两个平台互不影响。
   */
  routeIds: number[]
  defaultModelId: number | null
  /** 16 §6.1：默认（模型 + 渠道）对应的路由；老配置在启动时回填，失效时自动改选 */
  defaultRouteId: number | null
  /** 下发配置最近一次变化的时间；从没配置过 = null */
  updatedAt: string | null
  /**
   * 上次同步时「会被渲染的模型内容」的指纹（`dsh.ts` 的 `dshRenderFingerprint`）。
   * 模型改名/改上下文/compat 这类不改变预设行、却改变 managed.patch.yml 的变更靠它识别。
   */
  renderHash: string | null
}

export interface RelayDshStore {
  get(): RelayDshSettings
  /** 写配置：`updatedAt` 必填，它就是「配置最近一次变化的时间」（同时写进 settings 行的 updated_at） */
  write(value: RelayDshSettings & { updatedAt: string }): void
}

const EMPTY: RelayDshSettings = {
  presetId: null,
  routeIds: [],
  defaultModelId: null,
  defaultRouteId: null,
  updatedAt: null,
  renderHash: null,
}

function asId(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/** 坏数据只丢坏字段（不让一行脏 JSON 把「下发到 DSH」整页打挂） */
function parse(raw: unknown): RelayDshSettings {
  if (typeof raw !== 'object' || raw === null) return { ...EMPTY }
  const value = raw as Record<string, unknown>
  const routeIds = Array.isArray(value.routeIds)
    ? value.routeIds.filter((id): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0)
    : []
  return {
    presetId: asId(value.presetId),
    routeIds,
    defaultModelId: asId(value.defaultModelId),
    defaultRouteId: asId(value.defaultRouteId),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    renderHash: typeof value.renderHash === 'string' ? value.renderHash : null,
  }
}

export function createRelayDshStore(
  db: HubDb,
  opts: { onWarn?: (message: string) => void; platform?: Platform } = {},
): RelayDshStore {
  const key = relayDshSettingsKeyOf(opts.platform ?? 'cloud')
  function read(): RelayDshSettings {
    const row = db.get<{ value_json: string }>(
      'SELECT value_json FROM settings WHERE key = ?',
      key,
    )
    if (!row) return { ...EMPTY }
    try {
      return parse(JSON.parse(row.value_json))
    } catch {
      opts.onWarn?.('下发到 DSH 的配置不是合法 JSON，已按未配置处理')
      return { ...EMPTY }
    }
  }

  return {
    get: read,
    write(value) {
      db.run(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        key,
        JSON.stringify(value),
        value.updatedAt,
      )
    },
  }
}
