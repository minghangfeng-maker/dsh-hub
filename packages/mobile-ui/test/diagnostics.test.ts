/**
 * 本地诊断事件（0.2.10）：跨重启保留的启动/登录/链路事件。
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  DIAGNOSTICS_KEY,
  clearDiagEvents,
  readDiagEvents,
  recordDiag,
} from '@/lib/diagnostics'

class FakeStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
}

function installStorage(): FakeStorage {
  const storage = new FakeStorage()
  ;(globalThis as { localStorage?: unknown }).localStorage = storage
  return storage
}

afterEach(() => {
  clearDiagEvents()
  delete (globalThis as { localStorage?: unknown }).localStorage
})

describe('诊断事件', () => {
  it('记录后能读出来，并持久化到 localStorage（跨重启）', () => {
    const storage = installStorage()
    recordDiag('boot', '0.2.10')
    recordDiag('link:connected')
    const raw = storage.getItem(DIAGNOSTICS_KEY)
    expect(raw).toBeTruthy()
    expect(readDiagEvents().map((event) => event.name)).toEqual(['boot', 'link:connected'])
    expect(readDiagEvents()[0]?.detail).toBe('0.2.10')
  })

  it('只保留最近 40 条；detail 截断到 80 字', () => {
    installStorage()
    for (let i = 0; i < 45; i += 1) recordDiag(`e${i}`)
    expect(readDiagEvents()).toHaveLength(40)
    expect(readDiagEvents()[0]?.name).toBe('e5')
    recordDiag('long', 'x'.repeat(200))
    expect(readDiagEvents().at(-1)?.detail).toHaveLength(80)
  })

  it('存储里的垃圾数据当没有；clear 后为空', () => {
    const storage = installStorage()
    storage.setItem(DIAGNOSTICS_KEY, 'not json')
    expect(readDiagEvents()).toEqual([])
    recordDiag('boot')
    clearDiagEvents()
    expect(readDiagEvents()).toEqual([])
    expect(storage.getItem(DIAGNOSTICS_KEY)).toBeNull()
  })
})
