/**
 * 进程内单例：网关、令牌存储、偏好、会话缓存、产出文件持久缓存。
 *
 * 放在模块里而不是 Pinia 里，是为了让「聊天」与「账号」两个 store 共享同一份实例，
 * 又不会互相 import 造成循环依赖。
 */

import {
  MockHub,
  SelectionStore,
  createFileStore,
  createHubGateway,
  createOutboxStore,
  type HubGateway,
  type KeyValueStore,
} from '@dsh-hub/mobile-core'
import { APP_VERSION, HUB_ORIGIN, HUB_ORIGINS } from './app-info'
import { recordDiag } from './diagnostics'
import { RememberedLoginStore } from './remembered-login'
import {
  createLoginSecureStore,
  createPreferenceStore,
  createSessionCache,
  createTokenStore,
} from './storage'

/**
 * 构建期常量（`vite.config.ts` 的 `define`）：只有 `VITE_HUB_ORIGIN=mock` 的构建是 true。
 *
 * 为什么必须是**构建期**常量：0.2.17 之前是 `core/src/factory.ts` 里的运行期判断
 * `isMockOrigin(origin)`，Vite 折不掉，900 行的 `MockHub` 就整份打进了正式 APK。
 * 现在正式构建里这个标识被替换成字面量 `false`，下面的 mock 分支（连同 MockHub 模块）
 * 会被完整 tree-shake 掉；mock 构建（`bash scripts/build-apk.sh mock`）仍然是 true。
 */
declare const __DSH_MOCK_HUB__: boolean

export const tokenStore = createTokenStore()
export const prefs = createPreferenceStore()
export const sessionCache = createSessionCache()
/**
 * 产出文件 / 对话内图片的**持久**缓存（IndexedDB，上限 128MiB）。
 *
 * 与 `sessionCache` 同一个库（cache/db.ts）；退出登录/换账号时
 * `sessionCache.clearAccount()` 会通过注册表把本账号的文件缓存一起清掉。
 * 没有 IndexedDB 的环境（Web 隐私模式）自动退回内存实现。
 */
export const fileStore = createFileStore()
/**
 * 发送队列的**持久**存储（IndexedDB，按 accountKey + backendId 一份）。
 *
 * 队列编排在 core 的 `Outbox`（`channel/outbox.ts`），这里只提供落盘出口：
 * 唤醒/断线期间打的字先入队落盘，冷启动恢复后照常显示成待发气泡。
 * 与 `fileStore` 共用同一个库与账号级清理器（退出登录一起清）。
 */
export const outboxStore = createOutboxStore()
export const selectionStore = new SelectionStore(prefs)
/** 记住的账号密码（登录页与「冷启动自动登录」共用同一份实例）。 */
export const loginSecureStore = createLoginSecureStore()
export const rememberedLogin = new RememberedLoginStore({ prefs, secure: loginSecureStore })

/**
 * 「上次可用的 Hub 入口」（0.4.11 / WP52）：写普通偏好（正式包 = Capacitor Preferences）。
 *
 * 只在多入口时才有内容；单入口（`VITE_HUB_ORIGIN` 覆盖 / mock）读到的值不在候选里，
 * core 会自动忽略。
 */
export const originStore: KeyValueStore = {
  get: (key) => prefs.get(key),
  set: (key, value) => prefs.set(key, value),
  remove: (key) => prefs.remove(key),
}

export const gateway: HubGateway = __DSH_MOCK_HUB__
  ? new MockHub({ tokenStore })
  : createHubGateway({
      origin: HUB_ORIGIN,
      // 0.4.11：有序入口（首选广州、备用新加坡）。令牌两个入口通用，切换不重新登录。
      origins: HUB_ORIGINS,
      originStore,
      onOriginEvent: (name, detail) => recordDiag(name, detail),
      tokenStore,
      clientName: 'dsh-hub-app',
      clientVersion: APP_VERSION,
    })
