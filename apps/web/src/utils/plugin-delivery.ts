import { DELIVERY_MAX_ITEMS } from '@dsh-hub/shared'

/**
 * 插件库（WP28c）跳到统一下发向导时带的查询串（docs/21 §1.2）。
 *
 * 唯一格式来源是契约 `packages/shared/src/api/delivery.ts` 里 `DELIVERY_PREFILL_QUERY_KEYS`
 * 的注释：`items` 逗号分隔，每项 `plugin:<pluginId>[:<versionId>]`；`targets` 取
 * `all | installed | installed-outdated`；缺省的字段由向导用自己的默认值。
 *
 * 这里只拼地址，**不在插件库页提交任何下发**：预览与二次密码永远在向导里。
 */

/** 统一下发向导的地址（文档与契约注释里的 `/admin/rollouts`；WP28b 的向导挂在这里）。 */
export const DELIVERY_WIZARD_PATH = '/admin/rollouts'

/** 一次最多几个内容项（契约 `DELIVERY_MAX_ITEMS` = 20）。 */
export const PLUGIN_DELIVERY_LIMIT = DELIVERY_MAX_ITEMS

/** 插件库能发起的三个动作；`apply-config` 与插件无关。 */
export type PluginDeliveryAction = 'install' | 'upgrade' | 'uninstall'

export interface DeliveryLocation {
  path: string
  query: Record<string, string>
}

/** 一个内容项：`plugin:<id>`；版本省略 = 取该插件的最新版本。 */
export function pluginItem(pluginId: number, versionId?: number): string {
  if (!Number.isInteger(pluginId) || pluginId <= 0) throw new Error(`插件 id 不合法：${pluginId}`)
  if (versionId === undefined) return `plugin:${pluginId}`
  if (!Number.isInteger(versionId) || versionId <= 0) throw new Error(`版本 id 不合法：${versionId}`)
  return `plugin:${pluginId}:${versionId}`
}

/**
 * 批量条 / 单行菜单要跳的向导地址。
 *
 * - `install`：只面向实例（`platforms=instance`），版本缺省最新；
 * - `upgrade`：实例 + 桌面端，目标是「已安装且版本较旧」的用户（`targets=installed-outdated`）；
 * - `uninstall`：只带动作与内容项，平台与目标交给向导的默认值并在那里再确认。
 *
 * 超过 20 个直接抛错 —— 按钮上已经禁用，这里只是不让它悄悄截断（截断会卸错东西）。
 */
export function pluginDeliveryLocation(
  action: PluginDeliveryAction,
  pluginIds: readonly number[],
): DeliveryLocation {
  if (pluginIds.length === 0) throw new Error('至少要选一个插件')
  if (pluginIds.length > PLUGIN_DELIVERY_LIMIT)
    throw new Error(`一次最多 ${PLUGIN_DELIVERY_LIMIT} 个插件，现在选了 ${pluginIds.length} 个`)

  // 顺序固定成 id 升序：同一组插件每次生成的地址都一样，便于对比与测试
  const items = [...pluginIds].sort((a, b) => a - b).map((id) => pluginItem(id)).join(',')

  if (action === 'install') {
    return { path: DELIVERY_WIZARD_PATH, query: { platforms: 'instance', action, items } }
  }
  if (action === 'upgrade') {
    return {
      path: DELIVERY_WIZARD_PATH,
      query: { platforms: 'instance,desktop', action, targets: 'installed-outdated', items },
    }
  }
  return { path: DELIVERY_WIZARD_PATH, query: { action, items } }
}

/** 是否超过一次上限（批量条的按钮据此禁用并提示）。 */
export function overDeliveryLimit(count: number): boolean {
  return count > PLUGIN_DELIVERY_LIMIT
}

/**
 * 桌面插件库的批量下发：**只预选桌面平台**（docs/22 §1.3「多选批量 → 统一下发并预选 desktop」）。
 *
 * 与云端那条的区别只有 `platforms=desktop`：桌面插件只能从桌面库出（云端插件没有整包时
 * 向导会把该平台放进 `skippedItems`），所以不能让向导默认带上实例。
 */
export function desktopPluginDeliveryLocation(
  action: PluginDeliveryAction,
  pluginIds: readonly number[],
): DeliveryLocation {
  if (pluginIds.length === 0) throw new Error('至少要选一个插件')
  if (pluginIds.length > PLUGIN_DELIVERY_LIMIT)
    throw new Error(`一次最多 ${PLUGIN_DELIVERY_LIMIT} 个插件，现在选了 ${pluginIds.length} 个`)
  const items = [...pluginIds].sort((a, b) => a - b).map((id) => pluginItem(id)).join(',')
  return {
    path: DELIVERY_WIZARD_PATH,
    query: { platforms: 'desktop', action, ...(action === 'upgrade' ? { targets: 'installed-outdated' } : {}), items },
  }
}
