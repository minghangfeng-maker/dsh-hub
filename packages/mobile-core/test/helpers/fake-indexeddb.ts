/**
 * 极简 IndexedDB 假实现（**不引外部依赖**，只覆盖 App 缓存层用到的子集）。
 *
 * 为什么需要：持久文件缓存跑在 IndexedDB 上，真机最容易出问题的地方恰恰是
 * 「建表/升级/复合 key/游标删」这些代码路径；只用 Memory 实现测不到它们。
 * `fake-indexeddb` 会引新依赖（任务书明确不允许），所以这里自己写一个
 * 内存版：够用、可断言、行为（异步回调、事务完成、游标 continue）与真实实现一致。
 *
 * 支持：
 * - `open(name, version)` + `onupgradeneeded`（版本变大时触发）；
 * - `createObjectStore(name, { keyPath })`（keyPath 支持字符串或字段数组）；
 * - 事务（单/多 store）、`put/get/delete/clear`、`openCursor` + `cursor.delete/continue`；
 * - 请求回调与事务 oncomplete 都在异步任务里触发（与浏览器一致）。
 */

type KeyPath = string | string[]

interface StoreMeta {
  keyPath: KeyPath
  data: Map<string, unknown>
}

function clone<T>(value: T): T {
  // Node 18+ 有 structuredClone；没有时退化为原对象（测试里都是普通对象/Uint8Array）。
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value)
    } catch {
      return value
    }
  }
  return value
}

function keyOf(keyPath: KeyPath, value: unknown): string {
  if (Array.isArray(keyPath)) {
    const record = value as Record<string, unknown>
    return JSON.stringify(keyPath.map((field) => record[field]))
  }
  const record = value as Record<string, unknown>
  return JSON.stringify(record[keyPath])
}

function normalizeKey(key: unknown): string {
  return Array.isArray(key) ? JSON.stringify(key) : JSON.stringify(key)
}

/**
 * 假请求。
 *
 * 刻意不 `implements IDBRequest`：DOM lib 里 `source` 是非空联合类型，而真实请求
 * 在成功前 `result` 也还不存在，严格实现反而要写一堆假分支。生产代码只通过
 * `IDBFactory`/`IDBOpenDBRequest` 的**类型**看它（open() 返回值处一次性 cast），
 * 所以这里保持最简形状即可。
 */
class FakeRequest<T> {
  onsuccess: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  result!: T
  error: DOMException | null = null
  readyState: IDBRequestReadyState = 'pending'
}

class FakeCursor {
  constructor(
    private readonly items: Array<{ key: string; value: unknown }>,
    public index: number,
    private readonly onContinue: () => void,
    private readonly onDelete: (key: string) => void,
  ) {}
  get key(): unknown {
    return this.items[this.index]?.key
  }
  get value(): unknown {
    return this.items[this.index]?.value
  }
  get primaryKey(): unknown {
    return this.key
  }
  continue(): void {
    this.index += 1
    this.onContinue()
  }
  advance(): void {
    this.continue()
  }
  delete(): void {
    const item = this.items[this.index]
    if (item) this.onDelete(item.key)
  }
}

class FakeObjectStore {
  constructor(
    private readonly meta: StoreMeta,
    private readonly tx: FakeTransaction,
  ) {}

  put(value: unknown): FakeRequest<IDBValidKey> {
    const key = keyOf(this.meta.keyPath, value)
    this.meta.data.set(key, clone(value))
    return this.tx.request(key as IDBValidKey)
  }

  get(key: unknown): FakeRequest<unknown> {
    return this.tx.request(this.meta.data.get(normalizeKey(key)))
  }

  delete(key: unknown): FakeRequest<undefined> {
    this.meta.data.delete(normalizeKey(key))
    return this.tx.request(undefined)
  }

  clear(): FakeRequest<undefined> {
    this.meta.data.clear()
    return this.tx.request(undefined)
  }

  openCursor(): FakeRequest<unknown> {
    const request = new FakeRequest<unknown>()
    const items = [...this.meta.data.entries()].map(([key, value]) => ({ key, value }))
    const onDelete = (key: string): void => {
      this.meta.data.delete(key)
    }
    let cursor: FakeCursor | null = null
    const site = (): void => {
      this.tx.enter()
      cursor = new FakeCursor(items, cursor === null ? 0 : cursor.index, site, onDelete)
      request.result = cursor.index < items.length ? cursor : null
      queueMicrotask(() => {
        request.onsuccess?.(new Event('success'))
        this.tx.leave()
      })
    }
    site()
    return request
  }
}

class FakeTransaction {
  oncomplete: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onabort: ((event: Event) => void) | null = null
  error: DOMException | null = null
  mode: IDBTransactionMode
  objectStoreNames: DOMStringList
  private readonly stores: Map<string, StoreMeta>
  private active = 0
  private finishScheduled = false
  private finished = false

  constructor(
    stores: Map<string, StoreMeta>,
    names: string[],
    mode: IDBTransactionMode,
  ) {
    this.stores = stores
    this.mode = mode
    this.objectStoreNames = {
      contains: (name: string) => names.includes(name),
      length: names.length,
      item: (index: number) => names[index] ?? null,
      [Symbol.iterator]: () => names[Symbol.iterator](),
    } as DOMStringList
    for (const name of names) {
      if (!stores.has(name)) {
        throw new DOMException(`没有 object store：${name}`, 'NotFoundError')
      }
    }
    this.scheduleFinish()
  }

  objectStore(name: string): FakeObjectStore {
    const meta = this.stores.get(name)
    if (!meta) throw new DOMException(`没有 object store：${name}`, 'NotFoundError')
    return new FakeObjectStore(meta, this)
  }

  abort(): void {
    if (this.finished) return
    this.finished = true
    this.onabort?.(new Event('abort'))
  }

  /** 事务里开始一个请求（内部 API）。 */
  enter(): void {
    this.active += 1
    this.finishScheduled = false
  }

  /** 请求结束（内部 API）。 */
  leave(): void {
    this.active -= 1
    if (this.active === 0) this.scheduleFinish()
  }

  /** 发一个同步生效的请求，保存 result 后异步回调 onsuccess。 */
  request<T>(result: T): FakeRequest<T> {
    const request = new FakeRequest<T>()
    this.enter()
    queueMicrotask(() => {
      request.result = result
      request.readyState = 'done'
      request.onsuccess?.(new Event('success'))
      this.leave()
    })
    return request
  }

  private scheduleFinish(): void {
    if (this.finished || this.finishScheduled) return
    this.finishScheduled = true
    // 用宏任务：让同一轮里继续追加的请求（游标 continue / 后续 put）先登记上。
    setTimeout(() => {
      if (this.finished) return
      if (this.active > 0) {
        this.finishScheduled = false
        return
      }
      this.finished = true
      this.oncomplete?.(new Event('complete'))
    }, 0)
  }
}

class FakeDatabase {
  private readonly stores = new Map<string, StoreMeta>()
  readonly objectStoreNames: DOMStringList
  version: number

  constructor(
    version: number,
    private readonly onVersionChange?: () => void,
  ) {
    this.version = version
    this.objectStoreNames = {
      contains: (name: string) => this.stores.has(name),
      length: 0,
      item: () => null,
      [Symbol.iterator]: () => this.stores.keys(),
    } as DOMStringList
  }

  createObjectStore(name: string, options: { keyPath?: KeyPath | null } = {}): unknown {
    this.stores.set(name, { keyPath: options.keyPath ?? 'id', data: new Map() })
    return {}
  }

  transaction(names: string | string[], mode: IDBTransactionMode = 'readonly'): FakeTransaction {
    const list = Array.isArray(names) ? names : [names]
    return new FakeTransaction(this.stores, list, mode)
  }

  close(): void {
    this.onVersionChange?.()
  }

  /** 测试辅助：清空全部 store（同一个 fake 库复用给多个用例时用）。 */
  reset(): void {
    for (const store of this.stores.values()) store.data.clear()
  }

  /** 测试辅助：某 store 的当前条目数。 */
  sizeOf(name: string): number {
    return this.stores.get(name)?.data.size ?? 0
  }
}

class FakeOpenRequest extends FakeRequest<FakeDatabase> {
  onupgradeneeded: ((event: Event) => void) | null = null
  onblocked: ((event: Event) => void) | null = null
}

export class FakeIndexedDB {
  private readonly databases = new Map<string, { db: FakeDatabase; version: number }>()

  open(name: string, version?: number): IDBOpenDBRequest {
    const request = new FakeOpenRequest()
    queueMicrotask(() => {
      const existing = this.databases.get(name)
      const nextVersion = version ?? existing?.version ?? 1
      const db = existing?.db ?? new FakeDatabase(nextVersion, () => undefined)
      db.version = nextVersion
      this.databases.set(name, { db, version: nextVersion })
      request.result = db
      if (!existing || nextVersion > existing.version) {
        request.onupgradeneeded?.(new Event('upgradeneeded'))
      }
      request.onsuccess?.(new Event('success'))
    })
    return request as unknown as IDBOpenDBRequest
  }

  /** 测试辅助：直接拿到已打开的库（第一次 open 之后才可用）。 */
  peek(name: string): FakeDatabase | undefined {
    return this.databases.get(name)?.db
  }

  deleteDatabase(name: string): IDBOpenDBRequest {
    this.databases.delete(name)
    const request = new FakeOpenRequest()
    queueMicrotask(() => request.onsuccess?.(new Event('success')))
    return request as unknown as IDBOpenDBRequest
  }
}
