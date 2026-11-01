/**
 * Hub 入口解析（APK + 手机网页版）—— 开源版的核心约束：仓库里不写死任何地址。
 *
 * 这里锁住三种形态（与 `apps/mobile/README.md` 的「配置入口」一节对应）：
 *  1. **无构建变量 + 网页版**：入口就是页面自己的 origin（Hub 同源托管在 `/m/`）；
 *  2. **无构建变量 + APK**：入口为空 → 登录页要求用户手填服务器地址（填完持久化，重载后
 *     就是 `saved` 那一路）；
 *  3. **有构建变量**：`VITE_HUB_ORIGINS`（有序列表）说了算，`VITE_HUB_ORIGIN` 单入口覆盖最高。
 *
 * 另外锁住两条不许回退的行为：
 *  - 网页版不读运行期注入的 `window.__dshHubOrigins`（那是 APK 多入口 e2e 的开关）；
 *  - 拿不到页面 origin 时先看构建期列表，都没有就返回空数组（**不发明默认域名**）。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { MOCK_HUB_ORIGIN, resolveHubOrigins, resolveWebHubOrigins } from '../src/config.js'

const scope = globalThis as { __dshHubOrigins?: unknown }

afterEach(() => {
  delete scope.__dshHubOrigins
})

describe('无构建变量 + 网页版：入口就是页面 origin', () => {
  it('同源托管在 /m/：页面 origin 就是唯一入口', () => {
    expect(resolveWebHubOrigins(null, 'https://hub.example.com')).toEqual([
      'https://hub.example.com',
    ])
    expect(resolveWebHubOrigins(undefined, 'https://backup.example.com')).toEqual([
      'https://backup.example.com',
    ])
    // 末尾斜杠/路径都要归一成 origin
    expect(resolveWebHubOrigins('', 'https://hub.example.com/m/')).toEqual([
      'https://hub.example.com',
    ])
  })

  it('不传构建期列表时，拿不到页面 origin 就是空（不会变出一个默认域名）', () => {
    expect(resolveWebHubOrigins(null, null)).toEqual([])
    expect(resolveWebHubOrigins(null, 'file:///index.html')).toEqual([])
    expect(resolveWebHubOrigins(null, 'not-a-url')).toEqual([])
  })

  it('有 VITE_HUB_ORIGIN 覆盖时用它（开发 / e2e）', () => {
    expect(resolveWebHubOrigins('http://127.0.0.1:5401', 'http://127.0.0.1:9999')).toEqual([
      'http://127.0.0.1:5401',
    ])
    // 覆盖值非法：继续用页面 origin（网页版没有备用入口）
    expect(resolveWebHubOrigins('ftp://evil.test', 'https://hub.example.com')).toEqual([
      'https://hub.example.com',
    ])
  })

  it('mock 构建仍是进程内假 Hub', () => {
    expect(resolveWebHubOrigins(MOCK_HUB_ORIGIN, 'https://hub.example.com')).toEqual([
      MOCK_HUB_ORIGIN,
    ])
  })

  it('不读运行期注入的多入口列表（网页版只有单入口）', () => {
    scope.__dshHubOrigins = ['http://127.0.0.1:5400', 'http://127.0.0.1:5402']
    // APK 的解析会吃注入值（对照）
    expect(resolveHubOrigins()).toEqual(['http://127.0.0.1:5400', 'http://127.0.0.1:5402'])
    // 网页版忽略它
    expect(resolveWebHubOrigins(null, 'https://hub.example.com')).toEqual([
      'https://hub.example.com',
    ])
  })
})

describe('无构建变量 + APK：等用户手填服务器地址', () => {
  it('三层都空 → 空列表（登录页据此显示「服务器地址」输入框）', () => {
    expect(resolveHubOrigins()).toEqual([])
    expect(resolveHubOrigins({ builtIn: [], saved: [], override: null })).toEqual([])
  })

  it('用户填好并持久化之后（saved）：入口就是它', () => {
    expect(resolveHubOrigins({ saved: ['https://hub.example.com'] })).toEqual([
      'https://hub.example.com',
    ])
    // 手填地址里的非法值被丢掉（localStorage 被手改过也不至于让 App 起不来）
    expect(resolveHubOrigins({ saved: ['nonsense', 'http://192.168.1.10:7700'] })).toEqual([
      'http://192.168.1.10:7700',
    ])
  })
})

describe('有构建变量：VITE_HUB_ORIGINS / VITE_HUB_ORIGIN', () => {
  it('VITE_HUB_ORIGINS 决定有序入口列表', () => {
    const builtIn = ['https://hub.example.com', 'https://backup.example.com']
    expect(resolveHubOrigins({ builtIn })).toEqual(builtIn)
  })

  it('用户手填过的地址优先于构建期列表（换服务器不用重新装包）', () => {
    expect(
      resolveHubOrigins({
        builtIn: ['https://hub.example.com', 'https://backup.example.com'],
        saved: ['https://mine.example.com'],
      }),
    ).toEqual(['https://mine.example.com'])
  })

  it('VITE_HUB_ORIGIN 单入口覆盖最高（开发 / e2e）', () => {
    expect(
      resolveHubOrigins({
        override: 'http://127.0.0.1:5401',
        builtIn: ['https://hub.example.com'],
      }),
    ).toEqual(['http://127.0.0.1:5401'])
  })

  it('网页版：构建期列表只在拿不到页面 origin 时兜底', () => {
    const builtIn = ['https://hub.example.com']
    expect(resolveWebHubOrigins(null, 'https://other.example.com', builtIn)).toEqual([
      'https://other.example.com',
    ])
    expect(resolveWebHubOrigins(null, null, builtIn)).toEqual(builtIn)
  })
})
