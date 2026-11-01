/**
 * 更新提示里「版本号文案」的解析（0.2.16）。
 *
 * `bootstrap.app` 只下发 `latestVersionCode` 与 `downloadUrl`，没有版本名；
 * 提示里要写「新版本 0.2.16」就只能从发布文件名里认。认不出来必须返回 null
 * （宁可不写版本号，也不要显示错的）。
 */

import { describe, expect, it } from 'vitest'
import { versionFromApkUrl } from '@/lib/app-info'

describe('versionFromApkUrl', () => {
  it('正式发布文件名：认出三段式版本号', () => {
    expect(
      versionFromApkUrl(
        'https://cdn.example.com/downloads/mobile-app/dsh-hub-app-0.2.16-73d2dbcf.apk',
      ),
    ).toBe('0.2.16')
  })

  it('带查询串/锚点也能认', () => {
    expect(versionFromApkUrl('https://x.test/a/dsh-hub-app-1.0.0-abcdef.apk?download=1')).toBe('1.0.0')
  })

  it('不是这个命名规则：返回 null（不猜）', () => {
    expect(versionFromApkUrl('https://x.test/downloads/latest.apk')).toBeNull()
    expect(versionFromApkUrl('https://x.test/dsh-hub-app-debug.apk')).toBeNull()
    expect(versionFromApkUrl('')).toBeNull()
    expect(versionFromApkUrl(null)).toBeNull()
    expect(versionFromApkUrl(undefined)).toBeNull()
  })
})
