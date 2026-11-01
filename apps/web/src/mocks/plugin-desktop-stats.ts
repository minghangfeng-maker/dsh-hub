import type { PluginDesktopStats } from '@dsh-hub/shared'

/**
 * 桌面侧安装统计的假数据（WP32b；桌面「较旧」的口径在 WP32d 改成按桌面最新版本算）。
 *
 * 同一份数既给插件库列表的 `desktopStats`（`GET /api/admin/plugins?platform=desktop` 每行带一份），
 * 也给 `GET /api/admin/plugins/install-stats` 的 `desktop` 字段 —— 两处口径一致，页面上不会打架。
 *
 * 「较旧」**按桌面最新版本算**（契约 `7bb61db`：桌面版本的「旧」跟桌面库的最新版本比，不是云上最新）：
 * 这里记的是每台设备上报的版本，`mockDesktopStatsOf(id, latestVersion)` 现算；
 * 插件没有桌面版本（不在桌面插件库）= `latestVersion: null` → 「较旧」恒 0。
 *
 * - 1 邮件助手：3 台装着（0.16.0 / 0.16.0 / 0.15.0），1 台版本较旧；
 * - 3 文件下载器：5 台都是 1.0.0，其中 2 台是客户端**自带（bundled）**装的；
 * - 4 视频渲染：没有桌面版本（不在桌面插件库），0 台；
 * - 5 记忆库（plugins-bulk 场景）：2 台，1 台较旧、2 台内置。
 */

/** 某插件在桌面设备上的上报情况（假数据） */
interface DesktopFacts {
  /** 装了它的用户数（一台设备一个用户，用户数 ≤ 设备数） */
  users: number
  /** 其中客户端自带装好的设备数（`source=bundled`） */
  bundledDevices: number
  /** 每台设备上报的版本（数组长度 = 设备数） */
  versions: string[]
}

export const MOCK_DESKTOP_FACTS: Record<number, DesktopFacts> = {
  1: { users: 2, bundledDevices: 0, versions: ['0.16.0', '0.16.0', '0.15.0'] },
  3: { users: 4, bundledDevices: 2, versions: ['1.0.0', '1.0.0', '1.0.0', '1.0.0', '1.0.0'] },
  // 4 视频渲染：没有桌面版本，两个平台都没人装（install-stats 的「无人安装」形态）
  4: { users: 0, bundledDevices: 0, versions: [] },
  5: { users: 1, bundledDevices: 2, versions: ['0.3.1', '0.3.0'] },
  6: { users: 3, bundledDevices: 0, versions: ['1.2.0', '1.2.0', '1.1.0', '1.0.0'] },
  8: { users: 3, bundledDevices: 0, versions: ['0.9.4', '0.9.4', '0.9.4', '0.9.4'] },
  9: { users: 1, bundledDevices: 0, versions: ['0.4.2'] },
  10: { users: 3, bundledDevices: 0, versions: ['1.1.0', '1.1.0', '1.0.0'] },
}

const EMPTY: PluginDesktopStats = { devices: 0, users: 0, outdated: 0, bundledDevices: 0 }

/** 版本号比较（只比数字段，`0.2.0-rc.2` 与 `0.2.0` 视为同段；与 `mocks/deliveries.ts` 的 isOlder 同一口径） */
function versionParts(version: string): number[] {
  return version
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0))
}

function isOlderVersion(version: string, target: string): boolean {
  const left = versionParts(version)
  const right = versionParts(target)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a < b
  }
  return false
}

/**
 * 某插件在桌面侧的统计（没有就全 0）。
 *
 * @param latestVersion 桌面库里的最新版本；`null` = 这个插件没有桌面版本（不在桌面插件库）
 */
export function mockDesktopStatsOf(pluginId: number, latestVersion: string | null): PluginDesktopStats {
  const facts = MOCK_DESKTOP_FACTS[pluginId]
  if (!facts || facts.versions.length === 0) return { ...EMPTY }
  return {
    devices: facts.versions.length,
    users: facts.users,
    outdated:
      latestVersion === null
        ? 0
        : facts.versions.filter((version) => isOlderVersion(version, latestVersion)).length,
    bundledDevices: facts.bundledDevices,
  }
}
