import { describe, expect, it } from 'vitest'
import { MobileAppInfoSchema, PublicAndroidDownloadResponseSchema } from '../src/index.js'

/**
 * WP52（08 §3）：下载镜像地址是**可选字段**，老 Hub / 老 App 都必须照旧工作。
 *
 * - `bootstrap.app.downloadMirrors`：同一个 APK 的全部可用地址，本入口排第一；
 * - `GET /api/public/android/download` 的 `app.mirrors`：同一份数据。
 */

const APK = {
  version: '0.4.11',
  versionCode: 51,
  prerelease: false,
  fileName: 'dsh-hub-app-0.4.11-0123abcd.apk',
  bytes: 1024,
  sha256: 'a'.repeat(64),
  url: 'https://edge.example.com/downloads/mobile-app/dsh-hub-app-0.4.11-0123abcd.apk',
  publishedAt: '2026-10-28T00:00:00.000Z',
}

describe('MobileAppInfoSchema：downloadMirrors（WP52）', () => {
  const base = { minVersionCode: 1, latestVersionCode: 51, downloadUrl: 'https://edge.example.com/x.apk' }

  it('老 Hub 不发这个字段也合法（可选）', () => {
    expect(MobileAppInfoSchema.parse(base)).toEqual(base)
  })

  it('接受有序地址列表（本入口第一、另一个入口第二）', () => {
    const mirrors = [
      'https://edge.example.com/downloads/mobile-app/a.apk',
      'https://hub.example.com:8124/downloads/mobile-app/a.apk',
    ]
    expect(MobileAppInfoSchema.parse({ ...base, downloadMirrors: mirrors }).downloadMirrors).toEqual(mirrors)
    // 没有发布记录时是空数组
    expect(MobileAppInfoSchema.parse({ ...base, downloadUrl: null, downloadMirrors: [] }).downloadMirrors).toEqual([])
  })

  it('非字符串 / 空串被拒（地址必须是可直接请求的 URL 文本）', () => {
    expect(() => MobileAppInfoSchema.parse({ ...base, downloadMirrors: 'not-a-list' })).toThrow()
    expect(() => MobileAppInfoSchema.parse({ ...base, downloadMirrors: [''] })).toThrow()
    expect(() => MobileAppInfoSchema.parse({ ...base, downloadMirrors: [1] })).toThrow()
  })
})

describe('PublicAndroidDownloadResponseSchema：app.mirrors（WP52）', () => {
  it('没有 mirrors 也合法（老 Hub）', () => {
    const parsed = PublicAndroidDownloadResponseSchema.parse({ app: APK, qrUrl: '/api/public/android/qr.svg' })
    expect(parsed.app?.mirrors).toBeUndefined()
  })

  it('带 mirrors 时原样保留顺序', () => {
    const mirrors = [`${APK.url}`, 'https://hub.example.com:8124/downloads/mobile-app/a.apk']
    const parsed = PublicAndroidDownloadResponseSchema.parse({
      app: { ...APK, mirrors },
      qrUrl: '/api/public/android/qr.svg',
    })
    expect(parsed.app?.mirrors).toEqual(mirrors)
  })

  it('没有发布记录时 app=null（mirrors 自然不存在）', () => {
    expect(
      PublicAndroidDownloadResponseSchema.parse({ app: null, qrUrl: '/api/public/android/qr.svg' }).app,
    ).toBeNull()
  })
})
