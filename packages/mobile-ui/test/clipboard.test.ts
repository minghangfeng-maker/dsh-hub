/**
 * 剪贴板（WP54 / W3）：网页版先走 `navigator.clipboard.writeText`，失败 / 非安全上下文
 * 退回 `execCommand('copy')`；两条都不行返回 false（由调用方提示）。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { copyText } from '@/lib/clipboard'

const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

interface AreaStub {
  value: string
  selected: number
  removed: boolean
}

function installNavigator(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true })
}

function installDocument(options: { execResult?: boolean; throwOnExec?: boolean } = {}): {
  areas: AreaStub[]
  execCalls: () => number
  focused: string[]
} {
  const areas: AreaStub[] = []
  const focused: string[] = []
  const state = { execCalls: 0 }
  const documentStub = {
    activeElement: {
      focus: () => {
        focused.push('active')
      },
    },
    body: {
      appendChild: (el: AreaStub) => el,
      removeChild: () => {},
    },
    createElement(): AreaStub {
      const area: AreaStub = {
        value: '',
        selected: 0,
        removed: false,
        select() {
          area.selected += 1
        },
        setSelectionRange() {},
        setAttribute() {},
        style: {},
      } as unknown as AreaStub
      areas.push(area)
      return area
    },
    execCommand: (): boolean => {
      state.execCalls += 1
      if (options.throwOnExec) throw new Error('blocked')
      return options.execResult === true
    },
  }
  ;(globalThis as unknown as { document: unknown }).document = documentStub
  return { areas, execCalls: () => state.execCalls, focused }
}

afterEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document
  if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator)
})

describe('copyText（网页版）', () => {
  it('异步剪贴板可用 → 直接写入，不走 execCommand', async () => {
    const doc = installDocument({})
    const written: string[] = []
    installNavigator({
      clipboard: {
        writeText: async (text: string) => {
          written.push(text)
        },
      },
    })
    await expect(copyText('诊断信息')).resolves.toBe(true)
    expect(written).toEqual(['诊断信息'])
    expect(doc.execCalls()).toBe(0)
  })

  it('writeText 被拒（权限/失焦）→ 退回 execCommand', async () => {
    const doc = installDocument({ execResult: true })
    installNavigator({
      clipboard: {
        writeText: async () => {
          throw new Error('NotAllowedError')
        },
      },
    })
    await expect(copyText('hello')).resolves.toBe(true)
    expect(doc.execCalls()).toBe(1)
    expect(doc.areas[0]!.value).toBe('hello')
  })

  it('非安全上下文（http）不碰异步 API，直接回退', async () => {
    const doc = installDocument({ execResult: true })
    ;(globalThis as unknown as { isSecureContext: boolean }).isSecureContext = false
    try {
      installNavigator({
        clipboard: {
          writeText: async () => {
            throw new Error('should not be called')
          },
        },
      })
      await expect(copyText('x')).resolves.toBe(true)
      expect(doc.execCalls()).toBe(1)
    } finally {
      delete (globalThis as unknown as { isSecureContext?: boolean }).isSecureContext
    }
  })

  it('两条路都失败 → false（调用方提示「复制失败」）', async () => {
    installDocument({ execResult: false })
    installNavigator({})
    await expect(copyText('x')).resolves.toBe(false)
  })

  it('execCommand 抛错也不冒泡（老 WebView）', async () => {
    installDocument({ throwOnExec: true })
    installNavigator({})
    await expect(copyText('x')).resolves.toBe(false)
  })

  it('没有 document（node/后台）返回 false 而不是崩', async () => {
    delete (globalThis as unknown as { document?: unknown }).document
    installNavigator({})
    await expect(copyText('x')).resolves.toBe(false)
  })
})
