/**
 * 按「账号 + 后端」记住模型与思考程度（开发文档 §1.4 第 4 条）。
 *
 * 存在普通键值存储里（Capacitor Preferences / Web localStorage / 单测内存）：
 * 这不是敏感信息，但必须按账号隔离，否则 A 账号的模型选择会跑到 B 账号上。
 * 键的写法：一个 JSON blob，`{ [accountKey]: { lastBackend, backends: { [backendId]: {...} } } }`。
 */

export interface KeyValueStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

export class MemoryKeyValueStore implements KeyValueStore {
  private map = new Map<string, string>()
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key)
  }
}

export interface BackendSelection {
  modelId: string
  effortId: string
}

interface AccountPrefs {
  lastBackend?: string
  backends: Record<string, BackendSelection>
}

type PrefsBlob = Record<string, AccountPrefs>

const PREF_KEY = 'dsh-hub:selection:v1'

export class SelectionStore {
  constructor(private readonly kv: KeyValueStore) {}

  private async read(): Promise<PrefsBlob> {
    try {
      const raw = await this.kv.get(PREF_KEY)
      if (!raw) return {}
      const parsed = JSON.parse(raw) as PrefsBlob
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  private async write(blob: PrefsBlob): Promise<void> {
    try {
      await this.kv.set(PREF_KEY, JSON.stringify(blob))
    } catch {
      /* 配额/权限错误不影响主流程 */
    }
  }

  async getSelection(accountKey: string, backendId: string): Promise<BackendSelection | null> {
    const blob = await this.read()
    const sel = blob[accountKey]?.backends?.[backendId]
    if (!sel || typeof sel.modelId !== 'string' || typeof sel.effortId !== 'string') return null
    return sel
  }

  async setSelection(accountKey: string, backendId: string, selection: BackendSelection): Promise<void> {
    const blob = await this.read()
    const account = blob[accountKey] ?? { backends: {} }
    account.backends = { ...account.backends, [backendId]: selection }
    blob[accountKey] = account
    await this.write(blob)
  }

  async getLastBackend(accountKey: string): Promise<string | null> {
    const blob = await this.read()
    return blob[accountKey]?.lastBackend ?? null
  }

  async setLastBackend(accountKey: string, backendId: string): Promise<void> {
    const blob = await this.read()
    const account = blob[accountKey] ?? { backends: {} }
    account.lastBackend = backendId
    blob[accountKey] = account
    await this.write(blob)
  }

  /** 账号或 Hub 变化时清掉这个账号的全部选择。 */
  async forgetAccount(accountKey: string): Promise<void> {
    const blob = await this.read()
    if (!(accountKey in blob)) return
    delete blob[accountKey]
    await this.write(blob)
  }

  async clearAll(): Promise<void> {
    await this.kv.remove(PREF_KEY)
  }
}
