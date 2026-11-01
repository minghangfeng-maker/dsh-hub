/**
 * App 本地缓存共用的 IndexedDB 连接 + 「按账号清理」注册表。
 *
 * 为什么单独一层：
 * - 会话缓存（sessions/messages）与产出文件缓存（files/fileBlobs）在**同一个库**里，
 *   必须用同一个版本号打开；两个类各自 `open(name, version)` 会互相触发 versionchange
 *   甚至 blocked（真机上会话缓存先打开 v1，文件缓存要 v2 → 升级卡住，界面永远等）。
 * - 退出登录 / 换账号时，`auth` 只调用 `sessionCache.clearAccount(accountKey)`
 *   （那是稳定的清理入口）。文件缓存通过下面的注册表挂到同一个动作上，
 *   不需要改 auth 层，也不会漏清（账号隔离是 §6.4 的硬要求）。
 */

/** 库名沿用 0.2.x 的 `dsh-hub-app`（升级只加 store，不换库名）。 */
export const CACHE_DB_NAME = 'dsh-hub-app'

/**
 * 1 = 会话列表 + 对话；2 = 追加产出文件（files / fileBlobs）；3 = 追加发送队列（outbox）。
 *
 * **只增不减**：老用户升级 App 后打开新版本，onupgradeneeded 里补建缺的 store
 * （已有的 sessions/messages/files 数据原样保留）。
 */
export const CACHE_DB_VERSION = 3

export const STORE_SESSIONS = 'sessions'
export const STORE_MESSAGES = 'messages'
/** 文件元信息（小，可整表扫；LRU 淘汰只看它）。 */
export const STORE_FILE_ENTRIES = 'files'
/** 文件字节（大；与会话/账号按同一个复合 key 对齐）。 */
export const STORE_FILE_BLOBS = 'fileBlobs'
/** 发送队列（按 accountKey + backendId 一份；退出登录清空）。 */
export const STORE_OUTBOX = 'outbox'

/** 当前环境有没有 IndexedDB（Web 开发/Node 单测/隐私模式可能没有）。 */
export function indexedDbAvailable(): boolean {
  return typeof (globalThis as { indexedDB?: unknown }).indexedDB !== 'undefined'
}

let dbPromise: Promise<IDBDatabase> | null = null

/**
 * 打开（必要时升级）缓存库。进程内只开一次。
 *
 * 打开失败（隐私模式/存储被禁用）不缓存 rejected promise：下一次调用还能重试，
 * 而且调用方（两个缓存类）都按「缓存不可用 → 退回内存」处理，不影响在线功能。
 */
export function openCacheDb(): Promise<IDBDatabase> {
  if (dbPromise !== null) return dbPromise
  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB
    if (!factory) {
      reject(new Error('当前环境没有 IndexedDB'))
      return
    }
    let request: IDBOpenDBRequest
    try {
      request = factory.open(CACHE_DB_NAME, CACHE_DB_VERSION)
    } catch (error) {
      reject(error instanceof Error ? error : new Error('IndexedDB 打开失败'))
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: ['accountKey', 'backendId'] })
      }
      if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
        db.createObjectStore(STORE_MESSAGES, { keyPath: ['accountKey', 'backendId', 'sessionId'] })
      }
      if (!db.objectStoreNames.contains(STORE_FILE_ENTRIES)) {
        db.createObjectStore(STORE_FILE_ENTRIES, { keyPath: ['accountKey', 'sessionId', 'key'] })
      }
      if (!db.objectStoreNames.contains(STORE_FILE_BLOBS)) {
        db.createObjectStore(STORE_FILE_BLOBS, { keyPath: ['accountKey', 'sessionId', 'key'] })
      }
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        db.createObjectStore(STORE_OUTBOX, { keyPath: ['accountKey', 'backendId'] })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'))
    request.onblocked = () => reject(new Error('IndexedDB 升级被其它窗口占用'))
  })
  dbPromise = promise
  void promise.catch(() => {
    if (dbPromise === promise) dbPromise = null
  })
  return promise
}

// ── 按账号清理的注册表 ──────────────────────────────────────────────────────

/**
 * 账号级缓存清理器：`accountKey` 为 null 表示「清全部」（无账号上下文时的兜底）。
 *
 * 约定由 `sessionCache.clearAccount` / `clearAll` 触发 —— 也就是退出登录、换账号、
 * 换 Hub 时 auth 层唯一会调用的那个清理入口。
 */
export type AccountCachePurger = (accountKey: string | null) => Promise<void> | void

const purgers = new Set<AccountCachePurger>()

/** 注册一个账号级清理器；返回注销函数（测试用）。 */
export function registerAccountCachePurger(purger: AccountCachePurger): () => void {
  purgers.add(purger)
  return () => purgers.delete(purger)
}

/**
 * 执行全部已注册清理器。
 *
 * 单个清理器失败不能阻断其它清理（例如文件缓存事务失败，也不能让会话缓存保留），
 * 所以逐个 try/catch；调用方仍然 await，保证「清理完再回登录页」。
 */
export async function purgeAccountCaches(accountKey: string | null): Promise<void> {
  for (const purger of [...purgers]) {
    try {
      await purger(accountKey)
    } catch {
      /* ignore：缓存清理失败不阻断退出 */
    }
  }
}
