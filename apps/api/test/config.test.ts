import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DATA_DIR,
  DEFAULT_MOBILE_WEB_DIST_DIR,
  defaultMobileWebDir,
  dockerHostOptions,
  loadConfig,
} from '../src/config.js'

describe('loadConfig（01 §6）', () => {
  it('默认值：阶段一不开 TLS/跳转，公网源是回环明文', () => {
    const config = loadConfig({})
    expect(config.dataDir).toBe(DEFAULT_DATA_DIR)
    expect(config.httpPort).toBe(7700)
    expect(config.tlsPort).toBe(0)
    expect(config.redirectPort).toBe(0)
    expect(config.proxyProtocol).toBe(true)
    expect(config.publicOrigin).toBe('http://127.0.0.1:7700')
    expect(config.cookieSecure).toBe(false)
    expect(config.containerDriver).toBe('docker')
    expect(config.usersNetwork).toBe('dshhub-users')
    expect(config.usersSubnet).toBe('10.213.0.0/20')
    expect(config.npmRegistry).toBe('https://registry.npmmirror.com')
    expect(config.logLevel).toBe('info')
  })

  it('明文监听地址默认回环；HUB_HTTP_HOST 只接受 127.0.0.1 / 0.0.0.0（局域网联调）', () => {
    expect(loadConfig({}).httpHost).toBe('127.0.0.1')
    expect(loadConfig({ HUB_HTTP_HOST: '0.0.0.0' }).httpHost).toBe('0.0.0.0')
    // 不给出「绑到某个具体网卡」的口子：容器 IP / 主机名一律拒绝启动
    expect(() => loadConfig({ HUB_HTTP_HOST: '10.219.65.1' })).toThrow()
    expect(() => loadConfig({ HUB_HTTP_HOST: 'localhost' })).toThrow()
  })

  it('按环境变量覆盖，端口是数字', () => {
    const config = loadConfig({
      HUB_DATA_DIR: '/tmp/x',
      HUB_HTTP_PORT: '7701',
      HUB_CONTAINER_DRIVER: 'fake',
      HUB_LOG_LEVEL: 'debug',
      HUB_PUBLIC_ORIGIN: 'https://203.0.113.10/',
    })
    expect(config.dataDir).toBe('/tmp/x')
    expect(config.httpPort).toBe(7701)
    expect(config.containerDriver).toBe('fake')
    expect(config.logLevel).toBe('debug')
    // 末尾斜杠会被去掉，便于直接与 Origin 头比较
    expect(config.publicOrigin).toBe('https://203.0.113.10')
    // 未显式设置 HUB_COOKIE_SECURE 时按协议推断
    expect(config.cookieSecure).toBe(true)
  })

  it('阶段二：HSTS 默认 86400（0 = 不发）；HUB_PUBLIC_ORIGIN 可带端口（WP7b）', () => {
    expect(loadConfig({}).hstsMaxAge).toBe(86_400)
    expect(loadConfig({ HUB_HSTS_MAX_AGE: '0' }).hstsMaxAge).toBe(0)
    expect(loadConfig({ HUB_HSTS_MAX_AGE: '300' }).hstsMaxAge).toBe(300)
    const prod = loadConfig({ HUB_PUBLIC_ORIGIN: 'https://hub.example.com:8443' })
    expect(prod.publicOrigin).toBe('https://hub.example.com:8443')
    // 未显式设置 HUB_COOKIE_SECURE 时：cookieSecure 只是「按协议推断」的参考值，
    // 真正的 Secure 由监听器决定（cookieSecureExplicit=false）
    expect(prod.cookieSecure).toBe(true)
    expect(prod.cookieSecureExplicit).toBe(false)
  })

  it('显式 HUB_COOKIE_SECURE 覆盖推断', () => {
    expect(
      loadConfig({ HUB_PUBLIC_ORIGIN: 'https://a.example', HUB_COOKIE_SECURE: 'false' }).cookieSecure,
    ).toBe(false)
    expect(
      loadConfig({ HUB_PUBLIC_ORIGIN: 'http://127.0.0.1:7700', HUB_COOKIE_SECURE: '1' }).cookieSecure,
    ).toBe(true)
    expect(
      loadConfig({ HUB_PUBLIC_ORIGIN: 'https://a.example', HUB_COOKIE_SECURE: 'false' }).cookieSecureExplicit,
    ).toBe(true)
    expect(loadConfig({ HUB_PUBLIC_ORIGIN: 'https://a.example' }).cookieSecureExplicit).toBe(false)
  })

  it('非法值直接抛错（不带坏配置启动）', () => {
    expect(() => loadConfig({ HUB_HTTP_PORT: 'abc' })).toThrow()
    expect(() => loadConfig({ HUB_HTTP_PORT: '99999' })).toThrow()
    expect(() => loadConfig({ HUB_PUBLIC_ORIGIN: 'ftp://x' })).toThrow()
    expect(() => loadConfig({ HUB_USERS_SUBNET: '10.213.0.0' })).toThrow()
    expect(() => loadConfig({ HUB_CONTAINER_DRIVER: 'podman' })).toThrow()
  })

  it('手机网页版目录：默认是单仓构建产物 packages/mobile-ui/dist-web，可被 HUB_MOBILE_WEB_DIR 覆盖', () => {
    // 默认 = 仓库里的构建产物（和 apps/web/dist 同一套思路：pnpm build 完就能托管 /m/）
    expect(defaultMobileWebDir()).toBe(DEFAULT_MOBILE_WEB_DIST_DIR)
    expect(DEFAULT_MOBILE_WEB_DIST_DIR.endsWith(join('packages', 'mobile-ui', 'dist-web'))).toBe(true)
    expect(loadConfig({}).mobileWebDir).toBe(DEFAULT_MOBILE_WEB_DIST_DIR)
    // 数据目录不再影响默认值（发布流程要用自己的目录就显式设 HUB_MOBILE_WEB_DIR）
    expect(loadConfig({ HUB_DATA_DIR: '/tmp/hub-data' }).mobileWebDir).toBe(
      DEFAULT_MOBILE_WEB_DIST_DIR,
    )
    // 显式覆盖
    expect(loadConfig({ HUB_MOBILE_WEB_DIR: '/srv/mobile-web/current' }).mobileWebDir).toBe(
      '/srv/mobile-web/current',
    )
    // 空白 = 没设置（systemd 的 EnvironmentFile 里留空很常见）
    expect(loadConfig({ HUB_MOBILE_WEB_DIR: '   ' }).mobileWebDir).toBe(
      DEFAULT_MOBILE_WEB_DIST_DIR,
    )
    // 相对路径按进程 cwd 解析成绝对路径：后面的 realpath 不能跟着 cwd 变
    expect(loadConfig({ HUB_MOBILE_WEB_DIR: 'rel/current' }).mobileWebDir).toBe(resolve('rel/current'))
  })

  it('dockerHostOptions 支持 unix 与 tcp', () => {
    expect(dockerHostOptions('unix:///var/run/docker.sock')).toEqual({ socketPath: '/var/run/docker.sock' })
    expect(dockerHostOptions('tcp://127.0.0.1:2375')).toEqual({ host: '127.0.0.1', port: '2375' })
  })
})
