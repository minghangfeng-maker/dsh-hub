/**
 * `createHubGateway` 与 mock 的分工（0.2.17）。
 *
 * 背景：以前 `createHubGateway` 用**运行期**判断 `isMockOrigin(origin)` 选实现，Vite 折不掉，
 * 900 行的 MockHub 就被打进了正式 APK。现在「走 mock」是构建期常量
 * （`__DSH_MOCK_HUB__`，见 packages/mobile-ui/vite.config.ts 与 src/lib/instance.ts），
 * 正式构建里 mock 分支整块消失。所以：
 *  - `createHubGateway` 只负责真实 Hub，传 mock 地址是编程错误（直接报错）；
 *  - MockHub 仍是普通导出的类，单测/开发可以 `new MockHub()`（见 mock-flow.test.ts）。
 */

import { describe, expect, it } from 'vitest'
import { createHubGateway } from '../src/factory.js'
import { HubClient } from '../src/http/hub-client.js'
import { MemoryTokenStore } from '../src/auth/token-store.js'
import { MockHub } from '../src/mock/mock-hub.js'
import { MOCK_HUB_ORIGIN } from '../src/config.js'

describe('createHubGateway：只建真实 Hub', () => {
  it('mock 地址 → 明确报错（mock 由构建期分支 new MockHub）', () => {
    expect(() =>
      createHubGateway({ origin: MOCK_HUB_ORIGIN, tokenStore: new MemoryTokenStore() }),
    ).toThrow(/MockHub/)
  })

  it('真实地址 → HubClient（不是 MockHub）', () => {
    const gateway = createHubGateway({
      origin: 'https://hub.test:8123',
      tokenStore: new MemoryTokenStore(),
      clientName: 'dsh-hub-app',
      clientVersion: '0.0.0-test',
    })
    expect(gateway).toBeInstanceOf(HubClient)
    expect(gateway).not.toBeInstanceOf(MockHub)
  })

  it('MockHub 仍然可以直接实例化（单测 / mock 构建）', () => {
    const hub = new MockHub({ tokenStore: new MemoryTokenStore(), wakeMs: 1 })
    expect(hub).toBeInstanceOf(MockHub)
    expect(hub).not.toBeInstanceOf(HubClient)
  })
})
