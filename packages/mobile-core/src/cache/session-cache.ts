/**
 * 会话缓存（按账号 + 后端隔离）。
 *
 * 开发文档 §6.4：会话列表和最近 20 个会话缓存在 IndexedDB，离线时可以查看；
 * 退出登录、切换 Hub 或账号时清空缓存。M2 的隔离规则是 `HubAccountKey(origin, username)`，
 * 这里把它落成 `accountKey` 参数，key 里再带 `backendId`（§1.4 第 3 条：每个后端分别缓存）。
 *
 * 缓存里只有**服务端返回的会话行与历史文本**，不写令牌、不写密码。
 */

import type { MobileSessionRow } from '@dsh-hub/shared'
import type { ChatEntry } from '../channel/workspace.js'
import {
  STORE_MESSAGES,
  STORE_SESSIONS,
  openCacheDb,
  purgeAccountCaches,
} from './db.js'

export interface CachedSessionList {
  backendId: string
  sessions: MobileSessionRow[]
  /** 本地写入时间（毫秒），UI 用它显示「缓存于 …」 */
  cachedAt: number
}

export interface CachedConversation {
  backendId: string
  sessionId: string
  messages: ChatEntry[]
  cachedAt: number
}

export interface SessionCache {
  getSessions(accountKey: string, backendId: string): Promise<CachedSessionList | null>
  putSessions(accountKey: string, backendId: string, sessions: MobileSessionRow[]): Promise<void>
  getConversation(
    accountKey: string,
    backendId: string,
    sessionId: string,
  ): Promise<CachedConversation | null>
  putConversation(
    accountKey: string,
    backendId: string,
    sessionId: string,
    messages: ChatEntry[],
  ): Promise<void>
  /** 账号或 Hub 变化时调用：清掉这个账号下的全部后端缓存。 */
  clearAccount(accountKey: string): Promise<void>
  clearAll(): Promise<void>
}

/** 单测 / mock / 隐私模式用：进程内存，不落盘。 */
export class MemorySessionCache implements SessionCache {
  private sessions = new Map<string, CachedSessionList>()
  private messages = new Map<string, CachedConversation>()

  private skey(accountKey: string, backendId: string): string {
    return `${accountKey}\u0000${backendId}`
  }
  private mkey(accountKey: string, backendId: string, sessionId: string): string {
    return `${this.skey(accountKey, backendId)}\u0000${sessionId}`
  }

  async getSessions(accountKey: string, backendId: string): Promise<CachedSessionList | null> {
    return this.sessions.get(this.skey(accountKey, backendId)) ?? null
  }
  async putSessions(accountKey: string, backendId: string, sessions: MobileSessionRow[]): Promise<void> {
    this.sessions.set(this.skey(accountKey, backendId), {
      backendId,
      sessions,
      cachedAt: Date.now(),
    })
  }
  async getConversation(
    accountKey: string,
    backendId: string,
    sessionId: string,
  ): Promise<CachedConversation | null> {
    return this.messages.get(this.mkey(accountKey, backendId, sessionId)) ?? null
  }
  async putConversation(
    accountKey: string,
    backendId: string,
    sessionId: string,
    messages: ChatEntry[],
  ): Promise<void> {
    this.messages.set(this.mkey(accountKey, backendId, sessionId), {
      backendId,
      sessionId,
      messages,
      cachedAt: Date.now(),
    })
  }
  async clearAccount(accountKey: string): Promise<void> {
    const prefix = `${accountKey}\u0000`
    for (const key of [...this.sessions.keys()]) if (key.startsWith(prefix)) this.sessions.delete(key)
    for (const key of [...this.messages.keys()]) if (key.startsWith(prefix)) this.messages.delete(key)
    // 同一账号下的产出文件缓存（registerAccountCachePurger 注册）一起清。
    await purgeAccountCaches(accountKey)
  }
  async clearAll(): Promise<void> {
    this.sessions.clear()
    this.messages.clear()
    await purgeAccountCaches(null)
  }
}

interface StoredSessions {
  accountKey: string
  backendId: string
  sessions: MobileSessionRow[]
  cachedAt: number
}
interface StoredConversation {
  accountKey: string
  backendId: string
  sessionId: string
  messages: ChatEntry[]
  cachedAt: number
}

/**
 * IndexedDB 实现。key = [accountKey, backendId]（会话列表）/ [accountKey, backendId, sessionId]
 * （对话），所以「账号或 Hub 变化」时按 accountKey 前缀删不掉 —— 用游标扫一遍并匹配首段。
 */
export class IndexedDbSessionCache implements SessionCache {
  private db(): Promise<IDBDatabase> {
    // 连接与版本号统一由 cache/db.ts 管理（文件缓存用同一个库，必须同版本打开）。
    return openCacheDb()
  }

  private async withStore<T>(
    store: string,
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T> | void,
  ): Promise<T | null> {
    const db = await this.db()
    return new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(store, mode)
      const os = tx.objectStore(store)
      let request: IDBRequest<T> | void
      try {
        request = fn(os)
      } catch (error) {
        reject(error)
        return
      }
      tx.oncomplete = () => resolve(request ? (request.result as T) : null)
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'))
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'))
    })
  }

  async getSessions(accountKey: string, backendId: string): Promise<CachedSessionList | null> {
    try {
      const row = await this.withStore<StoredSessions | undefined>(STORE_SESSIONS, 'readonly', (os) =>
        os.get([accountKey, backendId]) as IDBRequest<StoredSessions | undefined>,
      )
      if (!row) return null
      return { backendId: row.backendId, sessions: row.sessions, cachedAt: row.cachedAt }
    } catch {
      return null
    }
  }

  async putSessions(
    accountKey: string,
    backendId: string,
    sessions: MobileSessionRow[],
  ): Promise<void> {
    try {
      const value: StoredSessions = { accountKey, backendId, sessions, cachedAt: Date.now() }
      await this.withStore(STORE_SESSIONS, 'readwrite', (os) => {
        os.put(value)
      })
    } catch {
      /* 缓存失败不影响在线功能 */
    }
  }

  async getConversation(
    accountKey: string,
    backendId: string,
    sessionId: string,
  ): Promise<CachedConversation | null> {
    try {
      const row = await this.withStore<StoredConversation | undefined>(STORE_MESSAGES, 'readonly', (os) =>
        os.get([accountKey, backendId, sessionId]) as IDBRequest<StoredConversation | undefined>,
      )
      if (!row) return null
      return {
        backendId: row.backendId,
        sessionId: row.sessionId,
        messages: row.messages,
        cachedAt: row.cachedAt,
      }
    } catch {
      return null
    }
  }

  async putConversation(
    accountKey: string,
    backendId: string,
    sessionId: string,
    messages: ChatEntry[],
  ): Promise<void> {
    try {
      // 只留最近一段，避免长会话把手机存储吃满（文档 §6.4「最近 20 个会话」）。
      const trimmed = messages.slice(-400)
      const value: StoredConversation = {
        accountKey,
        backendId,
        sessionId,
        messages: trimmed,
        cachedAt: Date.now(),
      }
      await this.withStore(STORE_MESSAGES, 'readwrite', (os) => {
        os.put(value)
      })
    } catch {
      /* ignore */
    }
  }

  async clearAccount(accountKey: string): Promise<void> {
    await this.deleteByPrefix(STORE_SESSIONS, accountKey)
    await this.deleteByPrefix(STORE_MESSAGES, accountKey)
    // 产出文件缓存（files / fileBlobs）注册在同一个清理动作上：退出登录/换账号一起清。
    await purgeAccountCaches(accountKey)
  }

  async clearAll(): Promise<void> {
    for (const store of [STORE_SESSIONS, STORE_MESSAGES]) {
      try {
        await this.withStore(store, 'readwrite', (os) => {
          os.clear()
        })
      } catch {
        /* ignore */
      }
    }
    await purgeAccountCaches(null)
  }

  private async deleteByPrefix(store: string, accountKey: string): Promise<void> {
    try {
      const db = await this.db()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite')
        const os = tx.objectStore(store)
        const request = os.openCursor()
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) return
          const value = cursor.value as { accountKey?: string }
          if (value?.accountKey === accountKey) cursor.delete()
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
