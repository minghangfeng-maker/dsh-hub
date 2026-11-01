import { describe, expect, it } from 'vitest'
import {
  CONTRACT_MAP,
  PublicDesktopDownloadItemSchema,
  PublicDesktopDownloadResponseSchema,
} from '../src/index.js'

/**
 * 公开主页的安装包契约（WP36）：`GET /api/public/desktop/download`。
 * 这份数据直接决定主页左卡显示什么，形状漂了要么按钮消失、要么渲染出 undefined。
 */
describe('公开主页安装包信息（WP36）', () => {
  const item = {
    version: '0.2.1',
    channel: 'latest' as const,
    prerelease: false,
    fileName: 'DSH-Hub-Setup-0.2.1.exe',
    bytes: 376_438_784,
    url: '/desktop/bin/win-x64/DSH-Hub-Setup-0.2.1.exe',
    publishedAt: '2026-10-23T01:02:03.000Z',
  }

  it('解析一条正式版安装包；旧服务端没给 portable 时补 null（WP38）', () => {
    expect(PublicDesktopDownloadItemSchema.parse(item)).toEqual({ ...item, portable: null })
  })

  it('免安装 ZIP（WP38）：文件名 / 大小 / 直链', () => {
    const portable = {
      fileName: 'DSH-Hub-0.2.1-win-x64-portable.zip',
      bytes: 497_040_528,
      url: '/desktop/bin/win-x64/DSH-Hub-0.2.1-win-x64-portable.zip',
    }
    expect(PublicDesktopDownloadItemSchema.parse({ ...item, portable }).portable).toEqual(portable)
    expect(
      PublicDesktopDownloadItemSchema.safeParse({ ...item, portable: { fileName: 'x.zip' } }).success,
    ).toBe(false)
  })

  it('预发布版本带 prerelease 标记（`0.2.1-rc.2`）', () => {
    const parsed = PublicDesktopDownloadItemSchema.parse({
      ...item,
      version: '0.2.1-rc.2',
      channel: 'nightly',
      prerelease: true,
      fileName: 'DSH-Hub-Setup-0.2.1-rc.2.exe',
      url: '/desktop/bin/win-x64/DSH-Hub-Setup-0.2.1-rc.2.exe',
    })
    expect(parsed.version).toBe('0.2.1-rc.2')
    expect(parsed.prerelease).toBe(true)
  })

  it('没有安装包：windows 为 null，android 恒为 null', () => {
    expect(PublicDesktopDownloadResponseSchema.parse({ windows: null, android: null })).toEqual({
      windows: null,
      android: null,
    })
    expect(PublicDesktopDownloadResponseSchema.safeParse({ windows: null, android: {} }).success).toBe(false)
  })

  it('拒绝漂移的形状（缺 url / bytes 非整数 / 未知通道）', () => {
    const { url: _url, ...withoutUrl } = item
    expect(PublicDesktopDownloadItemSchema.safeParse(withoutUrl).success).toBe(false)
    expect(PublicDesktopDownloadItemSchema.safeParse({ ...item, bytes: 1.5 }).success).toBe(false)
    expect(PublicDesktopDownloadItemSchema.safeParse({ ...item, channel: 'stable' }).success).toBe(false)
    expect(PublicDesktopDownloadItemSchema.safeParse({ ...item, version: 'v0.2.1' }).success).toBe(false)
  })

  it('契约表里登记了这个匿名接口', () => {
    const entry = CONTRACT_MAP.find((row) => row.path === '/api/public/desktop/download')
    expect(entry).toEqual(
      expect.objectContaining({
        method: 'GET',
        response: 'PublicDesktopDownloadResponseSchema',
      }),
    )
  })
})
