/**
 * 发送队列（Outbox）的**持久化**：按 `accountKey + backendId` 一份，退出登录清空。
 *
 * 为什么要持久化：0.2.x 的发送队列只在 UI 的内存里（`chat.ts` 的 `queue`）。唤醒期间、
 * 断线期间打的字，App 一被杀就没了——用户以为发出去了，其实连队列都不存在了。
 * 现在队列条目落 IndexedDB，冷启动恢复后照常显示成「待发气泡」并在连上后按序发出。
 *
 * 分工（与 `file-store.ts` 同款）：
 * - 本文件只管字节怎么落盘（key 形状、版本升级、账号清理），不含任何发送逻辑；
 * - 编排在 `channel/outbox.ts`；两者的公共形状是 `OutboxRecord`（结构类型，不互相 import）。
 *
 * 隔离规则（§6.4）：key 首段是 `accountKey`（Hub origin + username）。退出登录 / 换账号时
 * 由 `sessionCache.clearAccount()` → `purgeAccountCaches()` 统一清理（见 `cache/db.ts`），
 * 不依赖 UI 记得调。
 */

import type { MobileOutgoingAttachment } from '../contracts/mobile-v2.js'
import {
  STORE_OUTBOX,
  indexedDbAvailable,
  openCacheDb,
  registerAccountCachePurger,
} from './db.js'

/** 队列里的一条（= 一条还没真正发出去的消息）。字段全部可 JSON 化。 */
export interface OutboxRecord {
  /**
   * 队列 id，同时**就是**这条消息将来的 `clientMessageId`。
   *
   * 同一个 id 从「待发气泡」用到「已发送」：气泡不会因为换了一个身份而重建，
   * Hub/Host 也能按稳定 id 去重（M4 §12.1 的幂等语义）。
   */
  id: string
  text: string
  /** 入队时间（毫秒）。 */
  at: number
  /** 排进哪个会话；null = 还没有会话（发送前要先建）。 */
  sessionId: string | null
  /** 已就绪的附件引用（Hub 签发的 uploadId）。 */
  attachments: MobileOutgoingAttachment[]
  /**
   * 还没就绪的附件（UI 侧上传任务的 localId）。
   *
   * 只存 id，不存字节：队列落盘时附件字节可能还在内存里上传，跨重启无法恢复。
   * 恢复时这些 id 在 UI 侧查不到（`missing`），按「附件已丢失」处理（见 `channel/outbox.ts`）。
   */
  attachmentIds: string[]
  /** 为它发起过几次 create（诊断/退避用）。 */
  attempts: number
  /**
   * 附件出了问题（上传失败 / 跨重启后字节丢失）：条目**停在队列里**等用户决定
   * （重试 / 去掉附件只发文字 / 删除），绝不自动丢附件发出。
   *
   * 落盘：重启后仍然显示成「附件丢失」，用户还能选「去掉附件发送」。
   */
  problem?: OutboxProblem
}

/** 一条待发消息的附件问题（决定气泡上给哪三个动作）。 */
export interface OutboxProblem {
  kind: 'upload-failed' | 'attachment-missing'
  /** 出问题的附件本地 id（重试按它找任务；去掉附件发送时整条摘掉）。 */
  attachmentIds: string[]
}

/** 存储接口：IndexedDB 与内存两种实现（语义一致，后者不跨重启）。 */
export interface OutboxStore {
  /** 读这个账号 + 后端排队中的条目（按入队顺序）。没有 / 读失败返回空数组。 */
  load(accountKey: string, backendId: string): Promise<OutboxRecord[]>
  /** 覆盖保存整个队列（空数组 = 删除这一行，不留下空记录）。失败静默忽略。 */
  save(accountKey: string, backendId: string, entries: readonly OutboxRecord[]): Promise<void>
  clearAccount(accountKey: string): Promise<void>
  clearAll(): Promise<void>
}

/** 进程内实现（Node 单测 / Web 隐私模式）。 */
export class MemoryOutboxStore implements OutboxStore {
  private readonly items = new Map<string, OutboxRecord[]>()

  private static keyOf(accountKey: string, backendId: string): string {
    return `${accountKey}\u0000${backendId}`
  }

  async load(accountKey: string, backendId: string): Promise<OutboxRecord[]> {
    const hit = this.items.get(MemoryOutboxStore.keyOf(accountKey, backendId))
    return hit ? hit.map((entry) => ({ ...entry })) : []
  }

  async save(
    accountKey: string,
    backendId: string,
    entries: readonly OutboxRecord[],
  ): Promise<void> {
    const key = MemoryOutboxStore.keyOf(accountKey, backendId)
    if (entries.length === 0) {
      this.items.delete(key)
      return
    }
    this.items.set(
      key,
      entries.map((entry) => ({ ...entry })),
    )
  }

  async clearAccount(accountKey: string): Promise<void> {
    const prefix = `${accountKey}\u0000`
    for (const key of [...this.items.keys()]) if (key.startsWith(prefix)) this.items.delete(key)
  }

  async clearAll(): Promise<void> {
    this.items.clear()
  }
}

interface StoredOutboxRow {
  accountKey: string
  backendId: string
  entries: OutboxRecord[]
  savedAt: number
}

/** IndexedDB 实现（手机真机用的就是它）。所有公开方法吞掉异常：缓存坏了只是「队列丢了」。 */
export class IndexedDbOutboxStore implements OutboxStore {
  async load(accountKey: string, backendId: string): Promise<OutboxRecord[]> {
    try {
      const db = await openCacheDb()
      const row = await new Promise<StoredOutboxRow | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE_OUTBOX, 'readonly')
        const request = tx
          .objectStore(STORE_OUTBOX)
          .get([accountKey, backendId]) as IDBRequest<StoredOutboxRow | undefined>
        tx.oncomplete = () => resolve(request.result)
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'))
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'))
      })
      if (!row || !Array.isArray(row.entries)) return []
      return row.entries.filter(isOutboxRecord).map((entry) => ({ ...entry }))
    } catch {
      return []
    }
  }

  async save(
    accountKey: string,
    backendId: string,
    entries: readonly OutboxRecord[],
  ): Promise<void> {
    try {
      const db = await openCacheDb()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_OUTBOX, 'readwrite')
        const store = tx.objectStore(STORE_OUTBOX)
        if (entries.length === 0) store.delete([accountKey, backendId])
        else {
          const row: StoredOutboxRow = {
            accountKey,
            backendId,
            entries: entries.map((entry) => ({ ...entry })),
            savedAt: Date.now(),
          }
          store.put(row)
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'))
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'))
      })
    } catch {
      /* 队列落盘失败不影响在线发送（只是一次重启会丢） */
    }
  }

  async clearAccount(accountKey: string): Promise<void> {
    await this.deleteWhere((row) => row.accountKey === accountKey)
  }

  async clearAll(): Promise<void> {
    try {
      const db = await openCacheDb()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_OUTBOX, 'readwrite')
        tx.objectStore(STORE_OUTBOX).clear()
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'))
      })
    } catch {
      /* ignore */
    }
  }

  private async deleteWhere(match: (row: { accountKey?: string }) => boolean): Promise<void> {
    try {
      const db = await openCacheDb()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_OUTBOX, 'readwrite')
        const request = tx.objectStore(STORE_OUTBOX).openCursor()
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) return
          if (match(cursor.value as { accountKey?: string })) cursor.delete()
          cursor.continue()
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 删除失败'))
      })
    } catch {
      /* ignore */
    }
  }
}

function isOutboxProblem(value: unknown): value is OutboxProblem {
  if (typeof value !== 'object' || value === null) return false
  const problem = value as Partial<OutboxProblem>
  if (problem.kind !== 'upload-failed' && problem.kind !== 'attachment-missing') return false
  return Array.isArray(problem.attachmentIds) && problem.attachmentIds.every((id) => typeof id === 'string')
}

/** 落盘条目的**形状校验**：老版本/坏数据（字段缺失、类型不对）一律丢弃，别让它把队列卡死。 */
function isOutboxRecord(value: unknown): value is OutboxRecord {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Partial<OutboxRecord>
  if (typeof row.id !== 'string' || row.id === '') return false
  if (typeof row.text !== 'string') return false
  if (typeof row.at !== 'number' || !Number.isFinite(row.at)) return false
  if (row.sessionId !== null && typeof row.sessionId !== 'string') return false
  if (!Array.isArray(row.attachments)) return false
  if (!Array.isArray(row.attachmentIds)) return false
  if (typeof row.attempts !== 'number' || !Number.isFinite(row.attempts)) return false
  // problem 是可选加法字段：形状不对就丢掉它（条目本身仍然可用）。
  if (row.problem !== undefined && !isOutboxProblem(row.problem)) delete (row as { problem?: unknown }).problem
  return true
}

export interface CreateOutboxStoreOptions {
  /**
   * 是否挂到「账号级清理」注册表（默认挂）。测试里想自己控制清理时机时传 false。
   */
  registerAccountPurger?: boolean
}

/**
 * 真机入口：有 IndexedDB 就用持久实现，没有（Node 单测 / 隐私模式）退回内存。
 *
 * 注册了账号级清理：`sessionCache.clearAccount()/clearAll()`（退出登录、换账号、换 Hub 时
 * auth 层唯一会调的地方）会把本账号的发送队列一起清掉。
 */
export function createOutboxStore(options: CreateOutboxStoreOptions = {}): OutboxStore {
  const store: OutboxStore = indexedDbAvailable()
    ? new IndexedDbOutboxStore()
    : new MemoryOutboxStore()
  if (options.registerAccountPurger !== false) {
    registerAccountCachePurger((accountKey) =>
      accountKey === null ? store.clearAll() : store.clearAccount(accountKey),
    )
  }
  return store
}
