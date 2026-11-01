import { PluginInstallStatsResponseSchema, type PluginInstallStatsResponse } from '@dsh-hub/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { adminPluginCatalog } from '@/mocks/admin'
import { installMockFetch } from '@/mocks/fetch'
import { mockDesktopStatsOf } from '@/mocks/plugin-desktop-stats'
import { handlePluginInstallStats, mockPluginInstallStats } from '@/mocks/plugin-install-stats'
import { setMockScenario } from '@/mocks/state'

/**
 * 插件安装统计的假数据（WP28c 交付物 2 / 5）。
 *
 * 假数据必须过契约 schema —— 形状漂了页面上只会变成「接口返回的数据不符合契约」，
 * 不如在测试里先炸。另外四种「已安装」列的形态（有较旧版本 / 全最新 / 无人安装 / 桌面 0 台）
 * 是走查与组件测试的依据，这里逐条钉住。
 */

const restores: (() => void)[] = []

function useMock(scenario: 'plugins-bulk' | 'admin' | 'admin-empty'): void {
  setMockScenario(scenario)
  restores.push(installMockFetch(scenario))
}

afterEach(() => {
  while (restores.length > 0) restores.pop()?.()
  setMockScenario('running')
})

function itemIn(response: PluginInstallStatsResponse, pluginId: number) {
  const item = response.items.find((row) => row.pluginId === pluginId)
  expect(item, `应有插件 ${pluginId} 的统计`).toBeTruthy()
  return item!
}

describe('install-stats 假数据', () => {
  it('plugins-bulk：11 个插件，形状合契约', () => {
    const stats = PluginInstallStatsResponseSchema.parse(mockPluginInstallStats('plugins-bulk'))
    expect(stats.items).toHaveLength(11)
    expect(stats.items.map((row) => row.pluginId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(stats.items.every((row) => row.instance.outdated <= row.instance.users)).toBe(true)
    expect(stats.items.every((row) => row.desktop.users <= row.desktop.devices)).toBe(true)
    expect(stats.items.find((row) => row.pluginId === 1)?.latestVersion).toBe('0.16.0')
  })

  it('四种形态各就位：有较旧版本 / 全最新 / 无人安装 / 桌面 0 台', () => {
    const stats = mockPluginInstallStats('plugins-bulk')

    // 邮件助手：两边都有人装，且都有较旧版本（出现「N 待升级」）
    const email = itemIn(stats, 1)
    expect(email.instance).toEqual({ users: 4, outdated: 2 })
    expect(email.desktop).toEqual({ devices: 3, users: 2, outdated: 1, bundledDevices: 0 })

    // IM 机器人：桌面 0 台，而且两边都全最新（不出现徽标）
    const im = itemIn(stats, 2)
    expect(im.instance).toEqual({ users: 2, outdated: 0 })
    expect(im.desktop).toEqual({ devices: 0, users: 0, outdated: 0, bundledDevices: 0 })

    // 文件下载器：两边都有人装，且都最新
    const files = itemIn(stats, 3)
    expect(files.instance).toEqual({ users: 6, outdated: 0 })
    // 文件下载器是桌面客户端**自带**的一个（docs/22 §4.2）：其中 2 台是内置装的
    expect(files.desktop).toEqual({ devices: 5, users: 4, outdated: 0, bundledDevices: 2 })

    // 视频渲染：无人安装
    expect(itemIn(stats, 4)).toMatchObject({
      instance: { users: 0, outdated: 0 },
      desktop: { devices: 0, users: 0, outdated: 0, bundledDevices: 0 },
    })

    // 旧版便签（plugins-bulk 追加的那批，policy=hidden）：只有桌面端装着，且桌面有较旧版本
    expect(itemIn(stats, 6)).toMatchObject({
      instance: { users: 0, outdated: 0 },
      desktop: { devices: 4, users: 3, outdated: 2, bundledDevices: 0 },
    })
  })

  it('桌面「较旧」按桌面最新版本算（desktopLatestVersion），不是云上最新', () => {
    const stats = mockPluginInstallStats('admin')

    // 邮件助手：桌面库最新 0.16.0，3 台里 1 台还是 0.15.0
    const email = itemIn(stats, 1)
    expect(email.latestVersion).toBe('0.16.0')
    expect(email.desktopLatestVersion).toBe('0.16.0')
    expect(email.desktop.outdated).toBe(1)

    // 视频渲染不在桌面插件库：没有桌面版本 → null，「较旧」恒 0
    const video = itemIn(stats, 4)
    expect(video.desktopLatestVersion).toBeNull()
    expect(video.desktop.outdated).toBe(0)

    // 插件库列表每行自带的 desktopStats 与 install-stats 的 desktop 同源（同一份假数据）
    const desktopRow = adminPluginCatalog('admin', 'desktop').find((plugin) => plugin.id === 1)
    expect(desktopRow?.desktopStats).toEqual(email.desktop)
  })

  it('mockDesktopStatsOf：传入的桌面最新版本变，「较旧」跟着变（不是写死的数字）', () => {
    expect(mockDesktopStatsOf(1, '0.16.0')).toEqual({ devices: 3, users: 2, outdated: 1, bundledDevices: 0 })
    // 最新版本降到 0.15.0 → 3 台都不算旧
    expect(mockDesktopStatsOf(1, '0.15.0').outdated).toBe(0)
    // 升到 0.17.0 → 3 台全旧
    expect(mockDesktopStatsOf(1, '0.17.0').outdated).toBe(3)
    // 没有桌面版本（不在桌面插件库）→ 0
    expect(mockDesktopStatsOf(1, null).outdated).toBe(0)
  })

  it('实例人数与插件目录的 stats.installed 是同一个数（同一页上不打架）', () => {
    const stats = mockPluginInstallStats('plugins-bulk')
    expect(itemIn(stats, 1).instance.users).toBe(4)
    expect(itemIn(stats, 2).instance.users).toBe(2)
    expect(itemIn(stats, 3).instance.users).toBe(6)
    expect(itemIn(stats, 10).instance.users).toBe(5)
  })

  it('admin 场景只有 4 个基础插件；插件库为空时没有任何统计', () => {
    expect(mockPluginInstallStats('admin').items).toHaveLength(4)
    expect(mockPluginInstallStats('admin-empty')).toEqual({ items: [] })
  })

  it('接口：GET /api/admin/plugins/install-stats 返回契约数据；别的路径不接管', async () => {
    useMock('plugins-bulk')
    const response = await fetch('/api/admin/plugins/install-stats')
    expect(response.status).toBe(200)
    const stats = PluginInstallStatsResponseSchema.parse(await response.json())
    expect(stats.items).toHaveLength(11)

    expect(handlePluginInstallStats('/api/admin/plugins', 'GET')).toBeNull()
    expect(handlePluginInstallStats('/api/admin/plugins/install-stats', 'POST')).toBeNull()
  })
})
