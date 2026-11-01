import { describe, expect, it } from 'vitest'
import { loadConfig, type HubConfig } from '../src/config.js'
import { isAllowedOriginForEntry } from '../src/app.js'
import {
  markEdgeSocket,
  markPublicSocket,
  parseEdgeRealIp,
  requestOrigin,
} from '../src/server/public-request.js'

/**
 * WP52（08 §3）：「这个请求的对外 origin」与边缘入口的 `X-Real-IP` 解析。
 *
 * 纯单元测试：不打监听器、不碰数据库，只钉住三条规则
 * 1. 三种入口（本机 7700 / 7443 TLS 网关 / 边缘入口）各自的 origin、链接基址、下载基址与镜像顺序；
 * 2. CSRF 只认**本请求入口**的对外 origin（两个入口互不认）；
 * 3. `X-Real-IP` 必须恰好是一个裸 IPv4/IPv6，其余一律拒绝。
 */

const PUBLIC_ORIGIN = 'https://hub.example.com:8123'
const PUBLIC_ASSETS = 'https://hub.example.com:8124/downloads'
const EDGE_ORIGIN = 'https://edge.example.com'
const EDGE_ASSETS = 'https://edge.example.com/downloads'

function configOf(env: Record<string, string> = {}): HubConfig {
  return loadConfig({
    HUB_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    HUB_PUBLIC_ASSETS_ORIGIN: PUBLIC_ASSETS,
    HUB_EDGE_PORT: '7710',
    HUB_EDGE_ORIGIN: EDGE_ORIGIN,
    HUB_EDGE_ASSETS_ORIGIN: EDGE_ASSETS,
    ...env,
  })
}

/** 造一个带标记的 socket（不需要真的是 net.Socket：requestOrigin 只读两个 symbol） */
function socketOf(marks: { public?: boolean; edge?: boolean } = {}): object {
  const socket: Record<symbol, unknown> = {}
  if (marks.public === true) markPublicSocket(socket)
  if (marks.edge === true) markEdgeSocket(socket)
  return socket
}

const local = { socket: socketOf() }
const publicReq = { socket: socketOf({ public: true }) }
/** 边缘入口一定同时带公网标记（08 §3） */
const edgeReq = { socket: socketOf({ public: true, edge: true }) }

describe('requestOrigin：三种入口（08 §3）', () => {
  it('7700 本机：对外 origin 是回环地址，下载基址仍指公网入口', () => {
    const config = configOf()
    const origin = requestOrigin(local, config)
    expect(origin.kind).toBe('local')
    expect(origin.edge).toBe(false)
    expect(origin.origin).toBe('http://127.0.0.1:7700')
    // 下发给用户看的链接仍按公网入口的公开基址（本机地址对别的机器没有意义）
    expect(origin.linkOrigin).toBe(PUBLIC_ORIGIN)
    expect(origin.download).toEqual({ origin: PUBLIC_ORIGIN, assetsOrigin: PUBLIC_ASSETS })
    expect(origin.downloadMirrors).toEqual([
      { origin: PUBLIC_ORIGIN, assetsOrigin: PUBLIC_ASSETS },
      { origin: EDGE_ORIGIN, assetsOrigin: EDGE_ASSETS },
    ])
  })

  it('7443 TLS 网关：对外 origin 与下载基址都是公网入口，镜像第二是边缘入口', () => {
    const origin = requestOrigin(publicReq, configOf())
    expect(origin.kind).toBe('public')
    expect(origin.origin).toBe(PUBLIC_ORIGIN)
    expect(origin.linkOrigin).toBe(PUBLIC_ORIGIN)
    expect(origin.download).toEqual({ origin: PUBLIC_ORIGIN, assetsOrigin: PUBLIC_ASSETS })
    expect(origin.downloadMirrors.map((base) => base.origin)).toEqual([PUBLIC_ORIGIN, EDGE_ORIGIN])
  })

  it('边缘入口：对外 origin 与下载基址都是边缘入口，镜像第一是边缘入口', () => {
    const origin = requestOrigin(edgeReq, configOf())
    expect(origin.kind).toBe('edge')
    expect(origin.edge).toBe(true)
    expect(origin.origin).toBe(EDGE_ORIGIN)
    expect(origin.linkOrigin).toBe(EDGE_ORIGIN)
    expect(origin.download).toEqual({ origin: EDGE_ORIGIN, assetsOrigin: EDGE_ASSETS })
    expect(origin.downloadMirrors).toEqual([
      { origin: EDGE_ORIGIN, assetsOrigin: EDGE_ASSETS },
      { origin: PUBLIC_ORIGIN, assetsOrigin: PUBLIC_ASSETS },
    ])
  })

  it('HUB_EDGE_PORT=0（未配置边缘入口）时只有公网入口一个下载基址', () => {
    const config = configOf({ HUB_EDGE_PORT: '0', HUB_EDGE_ORIGIN: '', HUB_EDGE_ASSETS_ORIGIN: '' })
    expect(config.edgeOrigin).toBeNull()
    expect(config.edgeAssetsOrigin).toBeNull()
    for (const req of [local, publicReq]) {
      const origin = requestOrigin(req, config)
      expect(origin.downloadMirrors).toEqual([{ origin: PUBLIC_ORIGIN, assetsOrigin: PUBLIC_ASSETS }])
    }
    // 未配置边缘入口时，即使 socket 被误标成 edge，也不能凭空造出边缘入口地址
    const weird = requestOrigin({ socket: socketOf({ public: true, edge: true }) }, config)
    expect(weird.origin).toBe(PUBLIC_ORIGIN)
    expect(weird.downloadMirrors).toHaveLength(1)
  })

  it('两个入口的地址完全相同时去重（配置写重了也不重复下发）', () => {
    const config = configOf({ HUB_EDGE_ORIGIN: PUBLIC_ORIGIN, HUB_EDGE_ASSETS_ORIGIN: PUBLIC_ASSETS })
    const origin = requestOrigin(publicReq, config)
    expect(origin.downloadMirrors).toHaveLength(1)
    expect(requestOrigin(edgeReq, config).downloadMirrors).toHaveLength(1)
  })
})

describe('CSRF：只认本请求入口的对外 origin（08 §3）', () => {
  const config = configOf()

  it('边缘入口只认 HUB_EDGE_ORIGIN', () => {
    const entry = requestOrigin(edgeReq, config)
    expect(isAllowedOriginForEntry(EDGE_ORIGIN, config, entry)).toBe(true)
    // 公网入口 origin 在边缘入口一律不认（跨入口没有合法场景）
    expect(isAllowedOriginForEntry(PUBLIC_ORIGIN, config, entry)).toBe(false)
    // 公网上来的请求也不能借用本机调试源
    expect(isAllowedOriginForEntry('http://localhost:5173', config, entry)).toBe(false)
  })

  it('7443 只认 HUB_PUBLIC_ORIGIN', () => {
    const entry = requestOrigin(publicReq, config)
    expect(isAllowedOriginForEntry(PUBLIC_ORIGIN, config, entry)).toBe(true)
    expect(isAllowedOriginForEntry(EDGE_ORIGIN, config, entry)).toBe(false)
    expect(isAllowedOriginForEntry('http://localhost:5173', config, entry)).toBe(false)
  })

  it('7700 本机：公网入口 origin 与本机调试源都认，边缘入口 origin 不认', () => {
    const entry = requestOrigin(local, config)
    expect(isAllowedOriginForEntry(PUBLIC_ORIGIN, config, entry)).toBe(true)
    expect(isAllowedOriginForEntry('http://localhost:5173', config, entry)).toBe(true)
    expect(isAllowedOriginForEntry(EDGE_ORIGIN, config, entry)).toBe(false)
  })
})

describe('parseEdgeRealIp：只接受单个裸 IP（08 §3）', () => {
  it('合法的 IPv4 / IPv6 放行', () => {
    expect(parseEdgeRealIp('203.0.113.7')).toBe('203.0.113.7')
    expect(parseEdgeRealIp(' 203.0.113.7 ')).toBe('203.0.113.7')
    expect(parseEdgeRealIp('2001:db8::1')).toBe('2001:db8::1')
    expect(parseEdgeRealIp('::1')).toBe('::1')
    expect(parseEdgeRealIp('::ffff:203.0.113.7')).toBe('::ffff:203.0.113.7')
  })

  it('缺失 / 多个头 / 地址链 / 带端口 / 带方括号 / 非 IP 一律拒绝', () => {
    expect(parseEdgeRealIp(undefined)).toBeNull()
    expect(parseEdgeRealIp(null)).toBeNull()
    expect(parseEdgeRealIp('')).toBeNull()
    expect(parseEdgeRealIp('   ')).toBeNull()
    // Node 对同名头会解析成数组：多值就是有人在中途追加，不能猜
    expect(parseEdgeRealIp(['203.0.113.7', '198.51.100.1'])).toBeNull()
    expect(parseEdgeRealIp('203.0.113.7, 198.51.100.1')).toBeNull()
    expect(parseEdgeRealIp('203.0.113.7:443')).toBeNull()
    expect(parseEdgeRealIp('[2001:db8::1]')).toBeNull()
    expect(parseEdgeRealIp('localhost')).toBeNull()
    expect(parseEdgeRealIp('203.0.113.999')).toBeNull()
    expect(parseEdgeRealIp('x'.repeat(200))).toBeNull()
  })
})
