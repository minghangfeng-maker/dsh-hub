import { describe, expect, it } from 'vitest'
import { MemorySessionCache } from '../src/cache/session-cache.js'
import { MemoryKeyValueStore, SelectionStore } from '../src/prefs/selection-store.js'
import type { MobileSessionRow } from '@dsh-hub/shared'

const row = (sessionId: string, title: string | null = null): MobileSessionRow => ({
  sessionId,
  title,
  updatedAt: 1,
  running: false,
  blank: false,
  agentAvailable: true,
})

describe('会话缓存按账号 + 后端隔离', () => {
  it('不同后端互不覆盖，切回来先读缓存', async () => {
    const cache = new MemorySessionCache()
    await cache.putSessions('https://hub#demo', 'cloud:self', [row('s1', '云')])
    await cache.putSessions('https://hub#demo', 'dv_desktop', [row('s2', '电脑')])

    expect((await cache.getSessions('https://hub#demo', 'cloud:self'))?.sessions[0]!.title).toBe('云')
    expect((await cache.getSessions('https://hub#demo', 'dv_desktop'))?.sessions[0]!.title).toBe('电脑')
    expect(await cache.getSessions('https://hub#other', 'cloud:self')).toBeNull()
  })

  it('账号或 Hub 变化时 clearAccount 只清这个账号', async () => {
    const cache = new MemorySessionCache()
    await cache.putSessions('hub-a#demo', 'cloud:self', [row('s1')])
    await cache.putSessions('hub-b#demo', 'cloud:self', [row('s2')])
    await cache.putConversation('hub-a#demo', 'cloud:self', 's1', [
      { seq: 1, localId: null, role: 'user', text: 'hi', tools: [], at: 1, pending: false, failed: false, unknown: false },
    ])
    await cache.clearAccount('hub-a#demo')
    expect(await cache.getSessions('hub-a#demo', 'cloud:self')).toBeNull()
    expect(await cache.getConversation('hub-a#demo', 'cloud:self', 's1')).toBeNull()
    expect((await cache.getSessions('hub-b#demo', 'cloud:self'))?.sessions[0]!.sessionId).toBe('s2')
  })
})

describe('按账号 + 后端记住模型与思考程度', () => {
  it('读写互不影响；lastBackend 独立保存', async () => {
    const store = new SelectionStore(new MemoryKeyValueStore())
    const key = 'https://hub#demo'
    await store.setSelection(key, 'cloud:self', { modelId: 'deepseek-v4-pro', effortId: 'xhigh' })
    await store.setSelection(key, 'dv_desktop', { modelId: 'deepseek-v4-flash', effortId: 'low' })
    await store.setLastBackend(key, 'dv_desktop')

    expect(await store.getSelection(key, 'cloud:self')).toEqual({
      modelId: 'deepseek-v4-pro',
      effortId: 'xhigh',
    })
    expect(await store.getSelection(key, 'dv_desktop')).toEqual({
      modelId: 'deepseek-v4-flash',
      effortId: 'low',
    })
    expect(await store.getLastBackend(key)).toBe('dv_desktop')
    expect(await store.getLastBackend('https://hub#other')).toBeNull()
  })

  it('forgetAccount 清掉该账号的全部选择，不动别的账号', async () => {
    const store = new SelectionStore(new MemoryKeyValueStore())
    await store.setSelection('hub#a', 'cloud:self', { modelId: 'm1', effortId: 'high' })
    await store.setSelection('hub#b', 'cloud:self', { modelId: 'm2', effortId: 'low' })
    await store.forgetAccount('hub#a')
    expect(await store.getSelection('hub#a', 'cloud:self')).toBeNull()
    expect(await store.getSelection('hub#b', 'cloud:self')).toEqual({ modelId: 'm2', effortId: 'low' })
  })

  it('损坏的 JSON 不会抛错（选择只是偏好，不能挡住启动）', async () => {
    const kv = new MemoryKeyValueStore()
    await kv.set('dsh-hub:selection:v1', '{oops')
    const store = new SelectionStore(kv)
    expect(await store.getSelection('hub#a', 'cloud:self')).toBeNull()
  })
})
