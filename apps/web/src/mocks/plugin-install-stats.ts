import type { PluginInstallStat, PluginInstallStatsResponse } from '@dsh-hub/shared'

import { adminPluginCatalog, desktopPluginCatalog } from './admin'
import { mockDesktopStatsOf } from './plugin-desktop-stats'
import { getMockState, type MockScenario } from './state'

/**
 * 插件安装统计的假数据（WP28c）：`GET /api/admin/plugins/install-stats`。
 *
 * 四个基础插件分别摆出插件库「已安装」列要覆盖的几种样子（任务书交付物 2、5）：
 * - `dsh-email`：实例与桌面都有人装，且**有较旧版本**（列表里出现「N 待升级」徽标）；
 * - `dsh-im`：实例有人装、**桌面 0 台**，两个平台都**全是最新**（没有徽标）；
 * - `dsh-file-download`：两边都有人装且都最新；
 * - `dsh-remotion-video-plugin`：**无人安装**（实例 0 人 · 桌面 0 台）。
 * `?mock=plugins-bulk` 追加的那几个插件再补「只有桌面、没有实例」与「桌面有较旧版本」两种。
 *
 * 实例人数与 `ADMIN_PLUGINS[].stats.installed` 取同一个数——同一页上「已装 4」与「实例 3 人」打架
 * 会让走查看不出真假；「待升级」的人数不会超过「人数」。
 */

/**
 * 一个插件在两侧的安装情况（`PluginInstallStat` 去掉 `pluginId` / `latestVersion`）。
 * 桌面侧那半（含内置设备数）统一从 `plugin-desktop-stats.ts` 取，与插件库列表的 `desktopStats` 同源。
 */
type StatShape = { instance: PluginInstallStat['instance'] }

/** 手工定制的四个基础插件（桌面侧在 `plugin-desktop-stats.ts` 里）。 */
const CUSTOM: Record<number, StatShape> = {
  1: { instance: { users: 4, outdated: 2 } },
  2: { instance: { users: 2, outdated: 0 } },
  3: { instance: { users: 6, outdated: 0 } },
  4: { instance: { users: 0, outdated: 0 } },
}

/** `plugins-bulk` 追加的插件：按 id 写死，刷新多少次都一样（截图与单测可复现）。 */
const BULK: Record<number, StatShape> = {
  5: { instance: { users: 3, outdated: 1 } },
  6: { instance: { users: 0, outdated: 0 } },
  7: { instance: { users: 1, outdated: 0 } },
  8: { instance: { users: 0, outdated: 0 } },
  9: { instance: { users: 2, outdated: 1 } },
  10: { instance: { users: 5, outdated: 0 } },
  11: { instance: { users: 0, outdated: 0 } },
}

const EMPTY: StatShape = { instance: { users: 0, outdated: 0 } }

/**
 * 某个场景下的安装统计（与 `GET /api/admin/plugins` 返回的插件目录一一对应）。
 *
 * 桌面两列都取**桌面**口径：`desktopLatestVersion` = 桌面库里的最新版本（没有桌面版本 = null），
 * `desktop.outdated` 按它算（契约 `7bb61db`，不是跟云上最新版本比）。
 */
export function mockPluginInstallStats(scenario: MockScenario): PluginInstallStatsResponse {
  const desktopLatest = new Map(
    desktopPluginCatalog(scenario).map((plugin) => [plugin.id, plugin.latestVersion]),
  )
  return {
    items: adminPluginCatalog(scenario).map((plugin) => {
      const shape = CUSTOM[plugin.id] ?? BULK[plugin.id] ?? EMPTY
      const users = plugin.stats.installed
      const desktopVersion = desktopLatest.get(plugin.id) ?? null
      return {
        pluginId: plugin.id,
        instance: { users, outdated: Math.min(shape.instance.outdated, users) },
        desktop: mockDesktopStatsOf(plugin.id, desktopVersion),
        latestVersion: plugin.latestVersion,
        desktopLatestVersion: desktopVersion,
      }
    }),
  }
}

/**
 * 走查用开关：地址栏带 `stats=fail` 时这个接口返回 500 —— 页面上「已安装」列整列变「—」，
 * 列表本身照常（交付物 2 的失败态截图靠它，真实接口失败时就是这个样子）。
 */
function wantsFailure(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('stats') === 'fail'
}

/** `GET /api/admin/plugins/install-stats`；未命中返回 `null`（调用方透传真后端）。 */
export function handlePluginInstallStats(pathname: string, method: string): Response | null {
  if (pathname !== '/api/admin/plugins/install-stats' || method !== 'GET') return null
  if (wantsFailure()) {
    return new Response(
      JSON.stringify({ error: { code: 'INTERNAL', message: '安装统计读取失败', details: {} } }),
      { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } },
    )
  }
  return new Response(JSON.stringify(mockPluginInstallStats(getMockState().scenario)), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
