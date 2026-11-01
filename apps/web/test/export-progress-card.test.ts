import type { ExportItem } from '@dsh-hub/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import ExportProgressCard from '@/components/user/ExportProgressCard.vue'
import type { SseSource } from '@/composables/useSse'

/** 假 EventSource：手动驱动 `progress` / `done` / `failed` 事件（jsdom 没有 EventSource）。 */
class FakeSource implements SseSource {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  closed = false

  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>()

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  close(): void {
    this.closed = true
  }

  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) })
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function runningExport(partial: Partial<ExportItem> = {}): ExportItem {
  return {
    id: 32,
    parts: ['workspace', 'sessions'],
    format: 'zip',
    status: 'running',
    fileName: null,
    sizeBytes: null,
    sha256: null,
    createdAt: '2026-10-12T11:59:00.000Z',
    expiresAt: null,
    downloaded: false,
    error: null,
    progress: { bytesWritten: 470_000_000, filesDone: 1284, filesTotal: 3120 },
    ...partial,
  }
}

function readyExport(partial: Partial<ExportItem> = {}): ExportItem {
  return runningExport({
    status: 'ready',
    fileName: 'dsh-littletao-20261012.zip',
    sizeBytes: 1_900_000_000,
    expiresAt: '2026-10-13T12:00:00.000Z',
    progress: { bytesWritten: 1_900_000_000, filesDone: 3120, filesTotal: 3120 },
    ...partial,
  })
}

function mountCard(item: ExportItem) {
  const sources: FakeSource[] = []
  const wrapper = mount(ExportProgressCard, {
    props: {
      item,
      tickMs: 1_000_000,
      now: Date.parse('2026-10-12T13:00:00.000Z'),
      sseFactory: (url: string) => {
        const source = new FakeSource(url)
        sources.push(source)
        return source
      },
    },
  })
  return { wrapper, sources }
}

describe('导出进度卡（07 §6.2 / 04 §3.3）', () => {
  it('进行中：订阅该导出的 events，显示文件数与写入量', () => {
    const { wrapper, sources } = mountCard(runningExport())

    expect(sources).toHaveLength(1)
    expect(sources[0]?.url).toBe('/api/me/exports/32/events')
    expect(wrapper.get('[data-testid="export-progress-meta"]').text()).toContain('已处理 1284 / 3120 个文件')
    expect(wrapper.text()).toContain('正在打包你的数据')
    expect(wrapper.text()).toContain('工作区、会话记录')
  })

  it('progress 事件更新进度条；done 事件显示纸飞机 + 下载 + 过期倒计时', async () => {
    const { wrapper, sources } = mountCard(runningExport())
    const source = sources[0]!

    source.emit('progress', { bytesWritten: 900_000_000, filesDone: 2600, filesTotal: 3120 })
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="export-progress-meta"]').text()).toContain('已处理 2600 / 3120 个文件')

    source.emit('done', { export: readyExport() })
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('打包完成')
    expect(wrapper.findComponent({ name: 'PaperPlane' }).exists() || wrapper.find('svg').exists()).toBe(true)

    const download = wrapper.get('[data-testid="export-download"]')
    expect(download.attributes('href')).toBe('/api/me/exports/32/download')
    expect(wrapper.text()).toContain('1.8 GB')
    // 过期倒计时：2026-10-13T12:00 - now(2026-10-12T13:00) = 23 小时
    expect(wrapper.text()).toContain('23 小时后过期')
    expect(wrapper.emitted('done')).toHaveLength(1)
    // 完成后不再需要 SSE
    expect(source.closed).toBe(true)
  })

  it('failed 事件显示错误并向上抛（任务书要求失败态可见）', async () => {
    const { wrapper, sources } = mountCard(runningExport())

    sources[0]!.emit('failed', { error: { code: 'INTERNAL', message: '打包时磁盘满了' } })
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('打包失败')
    expect(wrapper.get('[role="alert"]').text()).toContain('打包时磁盘满了')
    expect(wrapper.emitted('failed')?.[0]).toEqual(['打包时磁盘满了'])
  })

  it('已经完成的导出不再订阅 SSE，直接给下载入口', () => {
    const { wrapper, sources } = mountCard(readyExport())

    expect(sources).toHaveLength(0)
    expect(wrapper.get('[data-testid="export-download"]').attributes('href')).toBe(
      '/api/me/exports/32/download',
    )
    expect(wrapper.text()).toContain('打包完成')
  })

  it('已过期的导出显示「已经过期了」', () => {
    const { wrapper } = mountCard(readyExport({ expiresAt: '2026-10-12T10:00:00.000Z' }))

    expect(wrapper.text()).toContain('已经过期了')
  })

  it('SSE 事件是 JSON 字符串时才解析（非 JSON 不抛错）', async () => {
    const { wrapper, sources } = mountCard(runningExport())
    const source = sources[0]! as unknown as { listeners: Map<string, Set<(e: MessageEvent) => void>> }

    const listener = [...(source.listeners.get('progress') ?? [])][0]
    expect(listener).toBeTypeOf('function')
    listener?.(new MessageEvent('progress', { data: 'not-json' }))
    await wrapper.vm.$nextTick()
    // 仍在进行中，没有崩
    expect(wrapper.text()).toContain('正在打包你的数据')
  })
})
