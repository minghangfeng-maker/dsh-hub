import { describe, expect, it } from 'vitest'

import {
  DELIVERY_WIZARD_PATH,
  PLUGIN_DELIVERY_LIMIT,
  overDeliveryLimit,
  pluginDeliveryLocation,
  pluginItem,
} from '@/utils/plugin-delivery'

/**
 * 插件库 → 统一下发向导的预填地址（WP28c 交付物 1 / 4）。
 *
 * 期望值逐字对照契约 `packages/shared/src/api/delivery.ts` 里 `DELIVERY_PREFILL_QUERY_KEYS` 的注释：
 * `/admin/rollouts?platforms=instance,desktop&action=upgrade&targets=installed&items=plugin:12,plugin:15:345`
 * —— 键的顺序、`items` 的分隔符、版本缺省（只有 `plugin:<id>`）、`targets=installed-outdated` 都在这里钉住。
 */

function url(action: Parameters<typeof pluginDeliveryLocation>[0], ids: number[]): string {
  const { path, query } = pluginDeliveryLocation(action, ids)
  return `${path}?${new URLSearchParams(query).toString().replaceAll('%2C', ',').replaceAll('%3A', ':')}`
}

describe('插件 → 统一下发向导的预填地址', () => {
  it('向导挂在 /admin/rollouts（契约注释里的地址）', () => {
    expect(DELIVERY_WIZARD_PATH).toBe('/admin/rollouts')
  })

  it('下发 / 安装：只面向实例，版本缺省 = 最新', () => {
    expect(pluginDeliveryLocation('install', [12])).toEqual({
      path: '/admin/rollouts',
      query: { platforms: 'instance', action: 'install', items: 'plugin:12' },
    })
    expect(url('install', [12])).toBe('/admin/rollouts?platforms=instance&action=install&items=plugin:12')
  })

  it('升级已安装用户：实例 + 桌面端，目标是「已安装且版本较旧」', () => {
    expect(pluginDeliveryLocation('upgrade', [12])).toEqual({
      path: '/admin/rollouts',
      query: {
        platforms: 'instance,desktop',
        action: 'upgrade',
        targets: 'installed-outdated',
        items: 'plugin:12',
      },
    })
    expect(url('upgrade', [12, 15])).toBe(
      '/admin/rollouts?platforms=instance,desktop&action=upgrade&targets=installed-outdated&items=plugin:12,plugin:15',
    )
  })

  it('卸载：只带动作与内容项，平台与目标交给向导的默认值', () => {
    expect(pluginDeliveryLocation('uninstall', [12])).toEqual({
      path: '/admin/rollouts',
      query: { action: 'uninstall', items: 'plugin:12' },
    })
  })

  it('多个插件按 id 升序、逗号分隔；要钉某个版本时才带第三段', () => {
    expect(pluginDeliveryLocation('install', [15, 12, 9]).query['items']).toBe(
      'plugin:9,plugin:12,plugin:15',
    )
    expect(pluginItem(12)).toBe('plugin:12')
    expect(pluginItem(15, 345)).toBe('plugin:15:345')
    expect(url('upgrade', [12, 15])).toContain('items=plugin:12,plugin:15')
  })

  it(`一次最多 ${PLUGIN_DELIVERY_LIMIT} 个：正好 20 个可以，第 21 个抛错（不悄悄截断）`, () => {
    const ids = Array.from({ length: PLUGIN_DELIVERY_LIMIT }, (_, index) => index + 1)
    expect(PLUGIN_DELIVERY_LIMIT).toBe(20)
    expect(pluginDeliveryLocation('install', ids).query['items']?.split(',')).toHaveLength(20)
    expect(overDeliveryLimit(20)).toBe(false)
    expect(overDeliveryLimit(21)).toBe(true)
    expect(() => pluginDeliveryLocation('install', [...ids, 21])).toThrow(/最多 20 个/)
    expect(() => pluginDeliveryLocation('upgrade', Array.from({ length: 21 }, (_, i) => i + 1))).toThrow()
  })

  it('一个都没选 / id 不合法：抛错而不是生成空地址', () => {
    expect(() => pluginDeliveryLocation('install', [])).toThrow(/至少要选一个/)
    expect(() => pluginItem(0)).toThrow()
    expect(() => pluginItem(-3)).toThrow()
    expect(() => pluginItem(1, 0)).toThrow()
  })
})
