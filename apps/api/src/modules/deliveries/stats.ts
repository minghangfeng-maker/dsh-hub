import type { PluginInstallStat, PluginInstallStatsResponse } from '@dsh-hub/shared'
import type { BaseDeps } from '../../context.js'
import { compareSemver } from '../desktop-delivery/service.js'
import { listInstallFacts } from './repo.js'
import { isParsableVersion } from './resolve.js'

/**
 * `GET /api/admin/plugins/install-stats`（交付物 4）：每个插件在实例与桌面端的安装人数。
 *
 * **一条 SQL**（`listInstallFacts` 把两侧 UNION ALL 成事实行），聚合与 semver 比较在内存里做
 * ——`outdated` 要按 semver 语义比较，SQLite 没有这个函数；但绝不按插件循环查库（N+1）。
 *
 * 口径：
 * - `instance.users` = `user_plugins.desired='installed'` 的用户数（排除已软删）；
 * - `instance.outdated` = 这些用户的生效版本（实际优先，否则期望）低于**云上**最新版本的人数；
 * - `desktop.devices` = 有效设备里上报了该包（`state <> 'absent'`）的设备数；
 * - `desktop.users` = 这些设备的用户数；`desktop.outdated` = 上报版本低于**桌面**最新版本的设备数
 *   （docs/22 §2.1 起两平台版本独立，用云上版本判桌面设备「旧」是错的）；
 * - `desktop.bundledDevices` = 上报 `source='bundled'`（客户端自带）的设备数。
 *
 * 「最新版本」与插件库同一口径：该平台里 `MAX(plugin_versions.id)`（插入顺序）。
 */
export function buildInstallStats(deps: BaseDeps): PluginInstallStatsResponse {
  const facts = listInstallFacts(deps.db)
  interface Bucket {
    pluginId: number
    latestVersion: string | null
    desktopLatestVersion: string | null
    instanceUsers: Set<number>
    instanceOutdated: Set<number>
    desktopDevices: Set<string>
    desktopUsers: Set<number>
    desktopOutdatedDevices: Set<string>
    bundledDevices: Set<string>
  }
  const buckets = new Map<number, Bucket>()
  for (const fact of facts) {
    let bucket = buckets.get(fact.plugin_id)
    if (!bucket) {
      bucket = {
        pluginId: fact.plugin_id,
        latestVersion: fact.latest_version,
        desktopLatestVersion: fact.desktop_latest_version,
        instanceUsers: new Set(),
        instanceOutdated: new Set(),
        desktopDevices: new Set(),
        desktopUsers: new Set(),
        desktopOutdatedDevices: new Set(),
        bundledDevices: new Set(),
      }
      buckets.set(fact.plugin_id, bucket)
    }
    if (fact.side === 'instance' && fact.user_id !== null) {
      bucket.instanceUsers.add(fact.user_id)
      if (isOlderThanLatest(fact.version, bucket.latestVersion)) bucket.instanceOutdated.add(fact.user_id)
      continue
    }
    if (fact.side === 'desktop' && fact.device_id !== null) {
      bucket.desktopDevices.add(fact.device_id)
      if (fact.user_id !== null) bucket.desktopUsers.add(fact.user_id)
      // docs/22 §4.2：客户端自带（source=bundled）的设备数，用于插件库的「内置」徽标
      if (fact.source === 'bundled') bucket.bundledDevices.add(fact.device_id)
      // 桌面设备只跟桌面版本比：没有桌面版本的插件（只在云上库）不算「旧」
      if (isOlderThanLatest(fact.version, bucket.desktopLatestVersion)) {
        bucket.desktopOutdatedDevices.add(fact.device_id)
      }
    }
  }

  const items: PluginInstallStat[] = [...buckets.values()]
    .sort((left, right) => left.pluginId - right.pluginId)
    .map((bucket) => ({
      pluginId: bucket.pluginId,
      instance: { users: bucket.instanceUsers.size, outdated: bucket.instanceOutdated.size },
      desktop: {
        devices: bucket.desktopDevices.size,
        users: bucket.desktopUsers.size,
        outdated: bucket.desktopOutdatedDevices.size,
        bundledDevices: bucket.bundledDevices.size,
      },
      latestVersion: bucket.latestVersion,
      desktopLatestVersion: bucket.desktopLatestVersion,
    }))
  // 插件库为空 → items=[]（不是 404 / 不是报错）
  return { items }
}

/**
 * 上报/期望的版本是否「低于最新版本」：
 * - 没有最新版本（插件还没有版本）→ 不算旧；
 * - 版本号缺失或解析不出来 → 算旧（无法确认是最新）；
 * - 否则按 semver 比较（`0.9.0 < 0.10.0`，预发布 < 正式）。
 */
function isOlderThanLatest(version: string | null, latest: string | null): boolean {
  if (latest === null) return false
  if (!isParsableVersion(version)) return true
  if (!isParsableVersion(latest)) return false
  return compareSemver(version, latest) < 0
}
