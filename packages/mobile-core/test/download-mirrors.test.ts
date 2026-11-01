/**
 * 更新包镜像（0.4.11 / WP52）：顺序、去重、老 Hub 回退。
 */

import { describe, expect, it } from 'vitest'
import { resolveDownloadMirrors } from '../src/http/download-mirrors.js'

describe('resolveDownloadMirrors', () => {
  it('Hub 下发的 downloadMirrors 保持顺序，downloadUrl 兜底追加', () => {
    expect(
      resolveDownloadMirrors({
        downloadUrl: 'https://cn.test/downloads/app.apk',
        downloadMirrors: [
          'https://sg.test/downloads/app.apk',
          'https://cn.test/downloads/app.apk',
        ],
      }),
    ).toEqual(['https://sg.test/downloads/app.apk', 'https://cn.test/downloads/app.apk'])
  })

  it('老 Hub 没有 downloadMirrors：退回 downloadUrl 一个地址', () => {
    expect(resolveDownloadMirrors({ downloadUrl: 'https://cn.test/app.apk' })).toEqual([
      'https://cn.test/app.apk',
    ])
    expect(resolveDownloadMirrors({ downloadUrl: null })).toEqual([])
    expect(resolveDownloadMirrors(null)).toEqual([])
  })

  it('去重 + 丢掉非法地址 + 去掉空白', () => {
    expect(
      resolveDownloadMirrors({
        downloadUrl: '  https://cn.test/app.apk  ',
        downloadMirrors: [
          'https://sg.test/app.apk',
          'https://sg.test/app.apk',
          'ftp://bad.test/app.apk',
          'not-a-url',
          'https://cn.test/app.apk',
        ],
      }),
    ).toEqual(['https://sg.test/app.apk', 'https://cn.test/app.apk'])
  })

  it('只有 mirrors、downloadUrl 为 null 时也能用', () => {
    expect(
      resolveDownloadMirrors({
        downloadUrl: null,
        downloadMirrors: ['https://sg.test/app.apk'],
      }),
    ).toEqual(['https://sg.test/app.apk'])
  })
})
