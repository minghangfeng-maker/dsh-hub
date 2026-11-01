/**
 * 产出文件 / 对话内图片的**持久**缓存（M5 §8 / §17 D4；0.2.14 真机反馈 ① ②）。
 *
 * 与 `channel/files.ts` 里的 `FileCache` 的分工：
 * - `FileCache`：进程内内存缓存（32MiB，随会话关闭/退出登录清空）——同一轮对话里
 *   同 fileRef 的重复读取不再走通道，但它**跨重启不存在**；真机上「重新打开会话，
 *   交付物又要重新下载一次，云容器刚唤醒时大概率 30s 超时」就是它。
 * - 本文件：IndexedDB 持久缓存（默认上限 128MiB，按 LRU 淘汰），下载一次后
 *   **重开会话 / 杀掉 App 再开都能立刻渲染**，同时也让正文里的云端路径图片有地方落。
 *
 * 隔离规则（§6.4）：key 首段是 `accountKey`（Hub origin + username）。
 * 退出登录 / 换账号时由 `sessionCache.clearAccount()` → `purgeAccountCaches()`
 * 统一清理（见 cache/db.ts），不依赖 UI 记得调。
 *
 * 存储布局（同一个库 `dsh-hub-app` v2）：
 * - `files`：元信息（name/mime/size/sha256/时间戳），LRU 只看这张表，扫起来很便宜；
 * - `fileBlobs`：字节。两张表同一个复合 key [accountKey, sessionId, key]，
 *   一次事务里同写同删，不会出现「有元信息没字节」的脏条目（读到脏条目按未命中处理）。
 */

import {
  STORE_FILE_BLOBS,
  STORE_FILE_ENTRIES,
  indexedDbAvailable,
  openCacheDb,
  registerAccountCachePurger,
} from './db.js'

/** 持久缓存默认上限：128MiB（一张 4K 图 ~5MB，够缓存几十张图/文档）。 */
export const DEFAULT_FILE_CACHE_MAX_BYTES = 128 * 1024 * 1024

export type StoredFileMediaType = 'image' | 'file'

/** 一条文件缓存元信息（不含字节）。 */
export interface StoredFileEntry {
  /** HubAccountKey(origin, username)：账号/Hub 隔离的第一段。 */
  accountKey: string
  sessionId: string
  /**
   * 缓存键：有 `fileRef` 用 `fileRef`；只有云端路径用 `path:<路径>`。
   * 与 `WorkspaceController.readFile` 的请求键严格一致（见 `fileCacheKeyOf`）。
   */
  key: string
  name: string
  mimeType: string
  mediaType: StoredFileMediaType
  /** 字节数（= data.byteLength；LRU 按它算总容量）。 */
  bytes: number
  sha256?: string
  cachedAt: number
  /** 最近一次命中/写入时间：LRU 淘汰按它排序。 */
  touchedAt: number
}

export interface StoredFile extends StoredFileEntry {
  data: Uint8Array
}

/** 会话/账号清理与容量统计都按异步接口（IndexedDB 实现），内存实现同样满足。 */
export interface FileStore {
  /** 命中返回字节（并更新 LRU 时间）；未命中/条目损坏返回 null，绝不抛错。 */
  get(accountKey: string, sessionId: string, key: string): Promise<StoredFile | null>
  /** 只查元信息是否存在（不加载字节）。 */
  has(accountKey: string, sessionId: string, key: string): Promise<boolean>
  /** 写入并触发 LRU 淘汰。失败（配额满/隐私模式）静默忽略：缓存不能拖垮在线功能。 */
  put(file: StoredFile): Promise<void>
  clearSession(accountKey: string, sessionId: string): Promise<void>
  clearAccount(accountKey: string): Promise<void>
  clearAll(): Promise<void>
  stats(): Promise<{ count: number; bytes: number }>
}

/**
 * 读文件请求的缓存键。
 *
 * - `fileRef` 优先（Hub 签发的不透明引用，同一张图在工具卡/交付物/预览里都一样）；
 * - 只有 `path` 时用 `path:` 前缀，避免和 fileRef 撞键。
 */
export function fileCacheKeyOf(target: { fileRef?: string; path?: string }): string | null {
  if (target.fileRef !== undefined && target.fileRef !== '') return target.fileRef
  if (target.path !== undefined && target.path !== '') return `path:${target.path}`
  return null
}

/** `path:` 键 → 原路径（诊断/保存文件名用）。 */
export function pathOfCacheKey(key: string): string | null {
  return key.startsWith('path:') ? key.slice('path:'.length) : null
}

/** 元信息里的大小/名字可能缺失：用于 UI 的兜底名。 */
export function fileNameOfKey(key: string, fallback = 'file'): string {
  const path = pathOfCacheKey(key) ?? key
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const name = cut >= 0 ? path.slice(cut + 1) : path
  return name !== '' ? name : fallback
}

function byteLengthOf(data: Uint8Array | ArrayBuffer): number {
  return data instanceof Uint8Array ? data.byteLength : data.byteLength
}

function asBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}

interface MemoryOptions {
  maxBytes?: number
}

/**
 * 进程内实现（Node 单测 / Web 开发 / 隐私模式）。
 *
 * 与 IndexedDB 版语义一致：LRU 按 touchedAt，账号隔离靠 key 前缀，
 * 但**不跨重启**（没有 IndexedDB 时的降级，行为比没有缓存好）。
 */
export class MemoryFileStore implements FileStore {
  private readonly maxBytes: number
  private readonly items = new Map<string, StoredFile>()

  constructor(options: MemoryOptions = {}) {
    this.maxBytes = Math.max(0, options.maxBytes ?? DEFAULT_FILE_CACHE_MAX_BYTES)
  }

  private static keyOf(accountKey: string, sessionId: string, key: string): string {
    return `${accountKey}\u0000${sessionId}\u0000${key}`
  }

  async get(accountKey: string, sessionId: string, key: string): Promise<StoredFile | null> {
    const mapKey = MemoryFileStore.keyOf(accountKey, sessionId, key)
    const hit = this.items.get(mapKey)
    if (!hit) return null
    // Map 的插入顺序当 LRU：命中就挪到队尾。
    this.items.delete(mapKey)
    const touched = { ...hit, touchedAt: Date.now() }
    this.items.set(mapKey, touched)
    return touched
  }

  async has(accountKey: string, sessionId: string, key: string): Promise<boolean> {
    return this.items.has(MemoryFileStore.keyOf(accountKey, sessionId, key))
  }

  async put(file: StoredFile): Promise<void> {
    const size = byteLengthOf(file.data)
    // 单个文件就超过总预算：缓存了也会立刻被自己淘汰，不如不写。
    if (size > this.maxBytes) return
    this.items.set(MemoryFileStore.keyOf(file.accountKey, file.sessionId, file.key), {
      ...file,
      bytes: size,
      touchedAt: file.touchedAt || Date.now(),
    })
    this.evict()
  }

  private evict(): void {
    let total = 0
    for (const item of this.items.values()) total += byteLengthOf(item.data)
    while (total > this.maxBytes && this.items.size > 1) {
      const eldest = this.items.keys().next()
      if (eldest.done) break
      const entry = this.items.get(eldest.value)
      if (entry) total -= byteLengthOf(entry.data)
      this.items.delete(eldest.value)
    }
  }

  async clearSession(accountKey: string, sessionId: string): Promise<void> {
    const prefix = `${accountKey}\u0000${sessionId}\u0000`
    for (const key of [...this.items.keys()]) if (key.startsWith(prefix)) this.items.delete(key)
  }

  async clearAccount(accountKey: string): Promise<void> {
    const prefix = `${accountKey}\u0000`
    for (const key of [...this.items.keys()]) if (key.startsWith(prefix)) this.items.delete(key)
  }

  async clearAll(): Promise<void> {
    this.items.clear()
  }

  /** 供单测断言容量（同步）。 */
  async stats(): Promise<{ count: number; bytes: number }> {
    let bytes = 0
    for (const item of this.items.values()) bytes += byteLengthOf(item.data)
    return { count: this.items.size, bytes }
  }
}

interface IndexedDbOptions {
  maxBytes?: number
}

type StoredBlobRow = { accountKey: string; sessionId: string; key: string; data: Uint8Array | ArrayBuffer }

/**
 * IndexedDB 实现：手机真机用的就是它。
 *
 * 所有公开方法都吞掉异常（返回 null / 直接返回）——缓存坏了只能是「慢一点」，
 * 不能让交付物加载直接失败。
 */
export class IndexedDbFileStore implements FileStore {
  private readonly maxBytes: number

  constructor(options: IndexedDbOptions = {}) {
    this.maxBytes = Math.max(0, options.maxBytes ?? DEFAULT_FILE_CACHE_MAX_BYTES)
  }

  async get(accountKey: string, sessionId: string, key: string): Promise<StoredFile | null> {
    try {
      const db = await openCacheDb()
      const [entry, blob] = await new Promise<[StoredFileEntry | undefined, StoredBlobRow | undefined]>(
        (resolve, reject) => {
          const tx = db.transaction([STORE_FILE_ENTRIES, STORE_FILE_BLOBS], 'readonly')
          const entryRequest = tx
            .objectStore(STORE_FILE_ENTRIES)
            .get([accountKey, sessionId, key]) as IDBRequest<StoredFileEntry | undefined>
          const blobRequest = tx
            .objectStore(STORE_FILE_BLOBS)
            .get([accountKey, sessionId, key]) as IDBRequest<StoredBlobRow | undefined>
          tx.oncomplete = () => resolve([entryRequest.result, blobRequest.result])
          tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'))
          tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'))
        },
      )
      // 元信息与字节必须都在：只有一边存在说明上次写事务被中断，按未命中处理。
      if (!entry || !blob) return null
      void this.touch(accountKey, sessionId, key)
      return { ...entry, data: asBytes(blob.data) }
    } catch {
      return null
    }
  }

  async has(accountKey: string, sessionId: string, key: string): Promise<boolean> {
    try {
      const db = await openCacheDb()
      return await new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(STORE_FILE_ENTRIES, 'readonly')
        const request = tx
          .objectStore(STORE_FILE_ENTRIES)
          .get([accountKey, sessionId, key]) as IDBRequest<StoredFileEntry | undefined>
        tx.oncomplete = () => resolve(request.result !== undefined)
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'))
      })
    } catch {
      return false
    }
  }

  async put(file: StoredFile): Promise<void> {
    const size = byteLengthOf(file.data)
    // 单个文件超过总预算：不写（否则刚写进去就被自己挤掉，还白占一次事务）。
    if (size > this.maxBytes) return
    try {
      const db = await openCacheDb()
      const now = Date.now()
      const entry: StoredFileEntry = {
        accountKey: file.accountKey,
        sessionId: file.sessionId,
        key: file.key,
        name: file.name,
        mimeType: file.mimeType,
        mediaType: file.mediaType,
        bytes: size,
        ...(file.sha256 === undefined ? {} : { sha256: file.sha256 }),
        cachedAt: file.cachedAt || now,
        touchedAt: file.touchedAt || now,
      }
      const blob: StoredBlobRow = {
        accountKey: file.accountKey,
        sessionId: file.sessionId,
        key: file.key,
        data: asBytes(file.data),
      }
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORE_FILE_ENTRIES, STORE_FILE_BLOBS], 'readwrite')
        tx.objectStore(STORE_FILE_ENTRIES).put(entry)
        tx.objectStore(STORE_FILE_BLOBS).put(blob)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'))
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'))
      })
      // 写完之后再淘汰（同一个方法内 await：保证 put 返回时容量已经收敛，
      // 测试与真机都能断言「最多 128MiB」；元信息表很小，扫一遍是毫秒级）。
      await this.trim()
    } catch {
      /* 缓存写入失败不影响在线功能 */
    }
  }

  /** 命中时更新 touchedAt（LRU 时间）；失败不打扰调用方。 */
  private async touch(accountKey: string, sessionId: string, key: string): Promise<void> {
    try {
      const db = await openCacheDb()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_FILE_ENTRIES, 'readwrite')
        const store = tx.objectStore(STORE_FILE_ENTRIES)
        const request = store.get([accountKey, sessionId, key]) as IDBRequest<StoredFileEntry | undefined>
        request.onsuccess = () => {
          const row = request.result
          if (!row) return
          store.put({ ...row, touchedAt: Date.now() })
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'))
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'))
      })
    } catch {
      /* ignore */
    }
  }

  /** 超预算时按 touchedAt 从旧到新删（元信息表很小，整表扫一遍足够）。 */
  private async trim(): Promise<void> {
    try {
      const rows = await this.collectEntries()
      let total = rows.reduce((sum, row) => sum + (row.bytes || 0), 0)
      if (total <= this.maxBytes) return
      rows.sort((a, b) => a.touchedAt - b.touchedAt)
      const victims = new Set<string>()
      for (const row of rows) {
        if (total <= this.maxBytes) break
        victims.add(JSON.stringify([row.accountKey, row.sessionId, row.key]))
        total -= row.bytes || 0
      }
      if (victims.size === 0) return
      const db = await openCacheDb()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORE_FILE_ENTRIES, STORE_FILE_BLOBS], 'readwrite')
        const entries = tx.objectStore(STORE_FILE_ENTRIES)
        const blobs = tx.objectStore(STORE_FILE_BLOBS)
        for (const row of rows) {
          if (!victims.has(JSON.stringify([row.accountKey, row.sessionId, row.key]))) continue
          entries.delete([row.accountKey, row.sessionId, row.key])
          blobs.delete([row.accountKey, row.sessionId, row.key])
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'))
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'))
      })
    } catch {
      /* ignore */
    }
  }

  private async collectEntries(): Promise<StoredFileEntry[]> {
    const db = await openCacheDb()
    return await new Promise<StoredFileEntry[]>((resolve, reject) => {
      const tx = db.transaction(STORE_FILE_ENTRIES, 'readonly')
      const store = tx.objectStore(STORE_FILE_ENTRIES)
      const request = store.openCursor()
      const rows: StoredFileEntry[] = []
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return
        rows.push(cursor.value as StoredFileEntry)
        cursor.continue()
      }
      tx.oncomplete = () => resolve(rows)
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 游标失败'))
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'))
    })
  }

  async clearSession(accountKey: string, sessionId: string): Promise<void> {
    await this.deleteWhere((row) => row.accountKey === accountKey && row.sessionId === sessionId)
  }

  async clearAccount(accountKey: string): Promise<void> {
    await this.deleteWhere((row) => row.accountKey === accountKey)
  }

  async clearAll(): Promise<void> {
    try {
      const db = await openCacheDb()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORE_FILE_ENTRIES, STORE_FILE_BLOBS], 'readwrite')
        tx.objectStore(STORE_FILE_ENTRIES).clear()
        tx.objectStore(STORE_FILE_BLOBS).clear()
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'))
      })
    } catch {
      /* ignore */
    }
  }

  /** 两个 store 按同一个判据用游标删（都是复合 key，前缀范围查询写起来更容易出错）。 */
  private async deleteWhere(match: (row: { accountKey?: string; sessionId?: string }) => boolean): Promise<void> {
    try {
      const db = await openCacheDb()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORE_FILE_ENTRIES, STORE_FILE_BLOBS], 'readwrite')
        const sweep = (storeName: string): void => {
          const request = tx.objectStore(storeName).openCursor()
          request.onsuccess = () => {
            const cursor = request.result
            if (!cursor) return
            const row = cursor.value as { accountKey?: string; sessionId?: string }
            if (match(row)) cursor.delete()
            cursor.continue()
          }
        }
        sweep(STORE_FILE_ENTRIES)
        sweep(STORE_FILE_BLOBS)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'))
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'))
      })
    } catch {
      /* ignore */
    }
  }

  async stats(): Promise<{ count: number; bytes: number }> {
    try {
      const rows = await this.collectEntries()
      return { count: rows.length, bytes: rows.reduce((sum, row) => sum + (row.bytes || 0), 0) }
    } catch {
      return { count: 0, bytes: 0 }
    }
  }
}

export interface CreateFileStoreOptions {
  maxBytes?: number
  /**
   * 是否挂到「账号级清理」注册表（默认挂）。测试里想自己控制清理时机时传 false。
   */
  registerAccountPurger?: boolean
}

/**
 * 手机真机入口：有 IndexedDB 就用持久实现，没有（Node 单测 / 隐私模式）退回内存。
 *
 * 注册了账号级清理：`sessionCache.clearAccount()/clearAll()`（退出登录、换账号、
 * 换 Hub 时 auth 层唯一会调的地方）会把本账号的文件缓存一起清掉。
 */
export function createFileStore(options: CreateFileStoreOptions = {}): FileStore {
  const maxBytes = options.maxBytes ?? DEFAULT_FILE_CACHE_MAX_BYTES
  const store: FileStore = indexedDbAvailable()
    ? new IndexedDbFileStore({ maxBytes })
    : new MemoryFileStore({ maxBytes })
  if (options.registerAccountPurger !== false) {
    registerAccountCachePurger((accountKey) =>
      accountKey === null ? store.clearAll() : store.clearAccount(accountKey),
    )
  }
  return store
}
