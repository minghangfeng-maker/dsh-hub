/**
 * 网页版（WP54 / W3）的保存 / 分享 / 选择：**不碰浏览器**，只验决策与字节流。
 *
 * node 里没有 DOM：下面用最小的 document / URL / navigator 桩件，
 * 断言三件事：
 *  1. 「保存」= 触发一次下载（`<a download>`），文件名按现有规则清洗，字节原样进 Blob，
 *     下载后释放 object URL；
 *  2. 「分享」= `navigator.share`：`canShare({files})` 为真带文件，为假只分享文字，
 *     没有系统分享或分享失败（非用户取消）→ 退回下载并提示；用户取消不算失败；
 *  3. 选择器的三个入口属性（相机 capture=environment、相册 multiple、文件不限）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PICK_INPUT_ATTRS,
  canShareFiles,
  hasSystemShare,
  pickedFromFiles,
  saveFile,
  shareFile,
} from '@/lib/media'

interface FakeAnchor {
  tagName: string
  href: string
  download: string
  rel: string
  style: Record<string, string>
  clicked: number
  click: () => void
  setAttribute: (name: string, value: string) => void
  remove: () => void
}

interface DomStub {
  anchors: FakeAnchor[]
  blobs: Blob[]
  revoked: string[]
}

let dom: DomStub | null = null
const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

function installDom(): DomStub {
  const stub: DomStub = { anchors: [], blobs: [], revoked: [] }
  const body = {
    appendChild: (el: unknown) => el,
    removeChild: (el: unknown) => el,
  }
  const documentStub = {
    body,
    createElement(tag: string): FakeAnchor {
      const anchor: FakeAnchor = {
        tagName: tag,
        href: '',
        download: '',
        rel: '',
        style: {},
        clicked: 0,
        click() {
          anchor.clicked += 1
        },
        setAttribute(name: string, value: string) {
          ;(anchor as unknown as Record<string, string>)[name] = value
        },
        remove() {},
      }
      stub.anchors.push(anchor)
      return anchor
    },
  }
  ;(globalThis as unknown as { document: unknown }).document = documentStub
  const url = globalThis.URL as unknown as Record<string, unknown>
  url['createObjectURL'] = (blob: Blob): string => {
    stub.blobs.push(blob)
    return `blob:test/${stub.blobs.length}`
  }
  url['revokeObjectURL'] = (value: string): void => {
    stub.revoked.push(value)
  }
  dom = stub
  return stub
}

function installNavigator(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true })
}

beforeEach(() => {
  installDom()
})

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as unknown as { document?: unknown }).document
  const url = globalThis.URL as unknown as Record<string, unknown>
  delete url['createObjectURL']
  delete url['revokeObjectURL']
  if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator)
  dom = null
})

describe('选择器属性（网页版 = 三个隐藏 input）', () => {
  it('相机 accept=image/*、capture=environment；相册 multiple；文件不限类型', () => {
    expect(PICK_INPUT_ATTRS.camera).toEqual({ accept: 'image/*', capture: 'environment', multiple: false })
    expect(PICK_INPUT_ATTRS.gallery).toEqual({ accept: 'image/*', capture: null, multiple: true })
    expect(PICK_INPUT_ATTRS.file).toEqual({ accept: '*/*', capture: null, multiple: false })
  })

  it('空选择（用户取消）不产生附件', async () => {
    expect(await pickedFromFiles(null, 'gallery')).toEqual([])
    expect(await pickedFromFiles([], 'file')).toEqual([])
  })

  it('普通文件直接 base64（与 APK 的 PickedFile 结构一致）', async () => {
    const file = new File(['hello web'], 'note.txt', { type: 'text/plain' })
    const [picked] = await pickedFromFiles([file], 'file')
    expect(picked).toBeDefined()
    expect(picked!.kind).toBe('file')
    expect(picked!.name).toBe('note.txt')
    expect(picked!.mimeType).toBe('text/plain')
    expect(picked!.bytes).toBe(9)
    expect(picked!.base64).toBe(Buffer.from('hello web').toString('base64'))
    expect(picked!.previewUrl).toBeNull()
  })

  it('图片解不开（headless/无 canvas）只跳过这张，不抛错', async () => {
    const broken = new File(['not really a png'], 'broken.png', { type: 'image/png' })
    expect(await pickedFromFiles([broken], 'gallery')).toEqual([])
  })
})

describe('保存 = 浏览器下载', () => {
  it('点一次 <a download>，文件名按现有规则清洗，字节原样进 Blob，10 秒后释放 URL', async () => {
    vi.useFakeTimers()
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const result = await saveFile({ name: '报表/2026:10.png', mimeType: 'image/png', bytes })
    expect(result.ok).toBe(true)
    expect(result.where).toBe('浏览器下载目录')
    const anchor = dom!.anchors[0]!
    expect(anchor.download).toBe('报表_2026_10.png')
    expect(anchor.clicked).toBe(1)
    const blob = dom!.blobs[0]!
    expect(blob.type).toBe('image/png')
    expect(blob.size).toBe(5)
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes)
    expect(dom!.revoked).toEqual([])
    vi.advanceTimersByTime(10_000)
    expect(dom!.revoked).toEqual(['blob:test/1'])
  })

  it('已经有 Blob 时不再转字节（大文件不多拷一份）', async () => {
    const blob = new Blob([new Uint8Array(2048)], { type: 'application/pdf' })
    const result = await saveFile({ name: 'a.pdf', mimeType: 'application/pdf', blob })
    expect(result.ok).toBe(true)
    expect(dom!.blobs[0]).toBe(blob)
  })
})

describe('分享 = navigator.share', () => {
  const payload = {
    name: 'notes.md',
    mimeType: 'text/markdown',
    bytes: new Uint8Array([35, 32, 104, 105]), // "# hi"
  }

  it('没有 navigator.share → 退回下载并提示', async () => {
    installNavigator({})
    expect(hasSystemShare()).toBe(false)
    const result = await shareFile(payload)
    expect(result.ok).toBe(true)
    expect(result.shared).toBe(false)
    expect(result.fallback).toBe(true)
    expect(result.message ?? '').toContain('已改为下载')
    expect(dom!.anchors[0]!.download).toBe('notes.md')
    expect(dom!.anchors[0]!.clicked).toBe(1)
  })

  it('canShare({files}) 为真 → 带文件分享', async () => {
    const calls: Array<Record<string, unknown>> = []
    const probe: File[] = []
    installNavigator({
      share: async (data: Record<string, unknown>) => {
        calls.push(data)
      },
      canShare: (data?: { files?: File[] }) => {
        probe.push(...(data?.files ?? []))
        return true
      },
    })
    expect(hasSystemShare()).toBe(true)
    const file = new File([new Uint8Array([1])], 'x.txt', { type: 'text/plain' })
    expect(canShareFiles(file)).toBe(true)

    const result = await shareFile({ ...payload, text: '给你' })
    expect(result.ok).toBe(true)
    expect(result.shared).toBe(true)
    expect(calls).toHaveLength(1)
    const shared = calls[0]!
    expect(shared['title']).toBe('notes.md')
    expect(shared['text']).toBe('给你')
    const files = shared['files'] as File[]
    expect(files).toHaveLength(1)
    expect(files[0]!.name).toBe('notes.md')
    expect(files[0]!.type).toBe('text/markdown')
    expect(files[0]!.size).toBe(4)
    expect(dom!.anchors).toHaveLength(0) // 没有退回下载
  })

  it('canShare 为假 → 只分享文字（不带文件），不算失败', async () => {
    const calls: Array<Record<string, unknown>> = []
    installNavigator({
      share: async (data: Record<string, unknown>) => {
        calls.push(data)
      },
      canShare: () => false,
    })
    const result = await shareFile({ ...payload, url: 'https://hub.example/x' })
    expect(result.ok).toBe(true)
    expect(result.shared).toBe(true)
    const shared = calls[0]!
    expect(shared['files']).toBeUndefined()
    expect(shared['url']).toBe('https://hub.example/x')
    expect(result.message ?? '').toContain('不能分享文件')
  })

  it('用户取消（AbortError）不算失败、也不退回下载', async () => {
    installNavigator({
      share: async () => {
        const error = new Error('cancelled')
        error.name = 'AbortError'
        throw error
      },
      canShare: () => true,
    })
    const result = await shareFile(payload)
    expect(result.ok).toBe(true)
    expect(result.shared).toBe(false)
    expect(result.message).toBe('已取消分享')
    expect(dom!.anchors).toHaveLength(0)
  })

  it('分享面板起不来（非 AbortError）→ 退回下载', async () => {
    installNavigator({
      share: async () => {
        throw new Error('not allowed')
      },
      canShare: () => true,
    })
    const result = await shareFile(payload)
    expect(result.ok).toBe(true)
    expect(result.fallback).toBe(true)
    expect(dom!.anchors[0]!.download).toBe('notes.md')
  })
})
