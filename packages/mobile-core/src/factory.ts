/**
 * 真实 Hub 网关的唯一入口。
 *
 * **mock 不在这里选**（0.2.17 改动）：以前这里用 `isMockOrigin(origin)` 做**运行期**判断，
 * Vite 折不掉，于是 900 行的 `MockHub` 连同它引用的正文/技能目录被整份打进正式 APK。
 * 现在「走 mock」是**构建期常量**（`__DSH_MOCK_HUB__`，由 `packages/mobile-ui/vite.config.ts` 的
 * `define` 注入，只在 `VITE_HUB_ORIGIN=mock` 时为 true），分支写在调用方
 * （`packages/mobile-ui/src/lib/instance.ts`）里：正式构建里那个分支是字面量 `false`，
 * MockHub 模块整体被 tree-shake 掉。
 *
 * 所以这里只建 `HubClient`。传 mock 地址属于把两条路走混了，直接报错比静默连一个
 * 不存在的地址更好。
 */

import { isMockOrigin } from './config.js'
import { HubClient, type HubClientOptions } from './http/hub-client.js'
import type { HubGateway } from './gateway.js'
import type { TokenStore } from './auth/token-store.js'
import type { KeyValueStore } from './prefs/selection-store.js'

export interface CreateGatewayOptions {
  origin: string
  /** 多入口（0.4.11）：有序候选，首选在前；不给就只连 `origin`。 */
  origins?: readonly string[]
  /** 持久化「上次可用入口」。 */
  originStore?: KeyValueStore
  originProbeTimeoutMs?: number
  onOriginEvent?: (event: string, detail: string) => void
  tokenStore: TokenStore
  clientName?: string
  clientVersion?: string
  fetchImpl?: HubClientOptions['fetchImpl']
  createSocket?: HubClientOptions['createSocket']
  now?: () => number
}

export function createHubGateway(options: CreateGatewayOptions): HubGateway {
  if (isMockOrigin(options.origin)) {
    throw new Error(
      'mock 构建请直接用 MockHub（见 packages/mobile-ui/src/lib/instance.ts 的构建期分支），' +
        'createHubGateway 只负责真实 Hub',
    )
  }
  return new HubClient({
    origin: options.origin,
    ...(options.origins === undefined ? {} : { origins: options.origins }),
    ...(options.originStore === undefined ? {} : { originStore: options.originStore }),
    ...(options.originProbeTimeoutMs === undefined
      ? {}
      : { originProbeTimeoutMs: options.originProbeTimeoutMs }),
    ...(options.onOriginEvent === undefined ? {} : { onOriginEvent: options.onOriginEvent }),
    tokenStore: options.tokenStore,
    clientName: options.clientName,
    clientVersion: options.clientVersion,
    fetchImpl: options.fetchImpl,
    createSocket: options.createSocket,
    now: options.now,
  })
}
