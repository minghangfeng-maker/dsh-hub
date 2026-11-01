import { describe, expect, it } from 'vitest'
import * as shared from '../src/index.js'
import { CONTRACT_MAP, renderContractTable } from '../src/index.js'

/** 表里出现的 schema 名必须真实存在于本包导出，且是 zod schema */
describe('接口 → schema 对照表（04 全覆盖）', () => {
  it('每个接口的 request/response 都有对应 schema', () => {
    const missing: string[] = []
    for (const entry of CONTRACT_MAP) {
      for (const name of [entry.request, entry.response]) {
        if (!name) continue
        const value = (shared as Record<string, unknown>)[name]
        if (value === undefined) missing.push(`${entry.method} ${entry.path} → ${name}`)
        else if (typeof (value as { safeParse?: unknown }).safeParse !== 'function') {
          missing.push(`${entry.method} ${entry.path} → ${name} 不是 zod schema`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('没有重复的「方法 + 路径」', () => {
    const keys = CONTRACT_MAP.map((e) => `${e.method} ${e.path}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('覆盖 04 的四个域（公共/认证/个人/管理）', () => {
    const paths = CONTRACT_MAP.map((e) => e.path)
    expect(paths).toContain('/api/public/site')
    expect(paths.some((p) => p.startsWith('/api/auth/'))).toBe(true)
    expect(paths.some((p) => p.startsWith('/api/me'))).toBe(true)
    expect(paths.filter((p) => p.startsWith('/api/admin/')).length).toBeGreaterThan(30)
  })

  it('renderContractTable 生成 markdown 表格', () => {
    const table = renderContractTable()
    expect(table.split('\n')[0]).toContain('| 方法 | 路径 |')
    expect(table.split('\n').length).toBe(CONTRACT_MAP.length + 2)
  })
})
