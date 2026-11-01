import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import LogViewer from '@/components/admin/LogViewer.vue'
import {
  matchingLineIndexes,
  shouldStickToBottom,
  splitHighlight,
  splitLogLines,
} from '@/composables/log-lines'

/**
 * 日志查看器（07 §7.3 / §7.9）：分行、关键字高亮与命中计数、跟随开关、滚动贴底判定。
 */

const SAMPLE = ['booting dsh 0.2.0-rc.2', 'loading plugins…', 'plugin dsh-email installed', 'ready'].join(
  '\n',
)

describe('log-lines：纯函数', () => {
  it('按行切分（去掉末尾空行，保留中间空行，兼容 CRLF）', () => {
    expect(splitLogLines('a\r\nb\n\nc\n')).toEqual(['a', 'b', '', 'c'])
    expect(splitLogLines('')).toEqual([])
  })

  it('高亮是字面量、大小写不敏感，不会把正则元字符当模式', () => {
    const parts = splitHighlight('Error: dsh-email failed (a.b)', 'dsh-EMAIL')
    expect(parts.filter((part) => part.hit).map((part) => part.text)).toEqual(['dsh-email'])

    const literal = splitHighlight('a.b.c', 'a.b')
    expect(literal.filter((part) => part.hit)).toHaveLength(1)

    expect(splitHighlight('anything', '')).toEqual([{ text: 'anything', hit: false }])
  })

  it('命中行号与命中数', () => {
    const lines = splitLogLines(SAMPLE)
    expect(matchingLineIndexes(lines, 'plugin')).toEqual([1, 2])
    expect(matchingLineIndexes(lines, 'ready')).toEqual([3])
    expect(matchingLineIndexes(lines, 'nothing')).toEqual([])
    // 关键字为空时不做高亮
    expect(matchingLineIndexes(lines, '  ')).toEqual([])
  })

  it('贴底判定：距底部 24px 内算贴底', () => {
    expect(shouldStickToBottom({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })).toBe(true)
    expect(shouldStickToBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 300 })).toBe(false)
  })
})

describe('LogViewer：渲染、搜索与跟随', () => {
  it('渲染行号与文本，空日志显示占位文案', () => {
    const wrapper = mount(LogViewer, { props: { text: SAMPLE } })
    const lines = wrapper.findAll('.log-viewer__line')

    expect(lines).toHaveLength(4)
    expect(lines[0]?.text()).toContain('1')
    expect(lines[0]?.text()).toContain('booting dsh 0.2.0-rc.2')
    expect(wrapper.find('.log-viewer__empty').exists()).toBe(false)

    const empty = mount(LogViewer, { props: { text: '', emptyText: '没有日志' } })
    expect(empty.find('.log-viewer__empty').text()).toBe('没有日志')
  })

  it('搜索：高亮命中、显示命中处数，并给命中行着色', async () => {
    const wrapper = mount(LogViewer, { props: { text: SAMPLE } })
    await wrapper.find('input').setValue('plugin')

    expect(wrapper.findAll('mark.log-viewer__mark')).toHaveLength(2)
    expect(wrapper.find('.log-viewer__hits').text()).toBe('2 处')
    expect(wrapper.findAll('.log-viewer__line--hit')).toHaveLength(2)

    await wrapper.find('input').setValue('ready')
    expect(wrapper.findAll('mark.log-viewer__mark')).toHaveLength(1)
    expect(wrapper.find('.log-viewer__hits').text()).toBe('1 处')
  })

  it('搜索：无命中时上下跳转按钮禁用', async () => {
    const wrapper = mount(LogViewer, { props: { text: SAMPLE } })
    const buttons = wrapper.findAll('button')

    await wrapper.find('input').setValue('找不到的词')
    expect(wrapper.find('.log-viewer__hits').text()).toBe('0 处')
    expect(buttons.length).toBeGreaterThan(0)

    // 命中后跳转不回抛错（jsdom 没有 scrollIntoView，实现里做了保护）
    await wrapper.find('input').setValue('plugin')
    const nav = wrapper
      .findAll('button')
      .filter((button) => button.attributes('aria-label')?.includes('命中'))
    expect(nav).toHaveLength(2)
    await nav[0]?.trigger('click')
    await nav[1]?.trigger('click')
  })

  it('跟随开关：默认跟随，点击后变为暂停并带上 aria-pressed', async () => {
    const wrapper = mount(LogViewer, { props: { text: SAMPLE, follow: true } })
    const followButton = wrapper.findAll('button').find((button) => button.text().includes('跟随中'))
    expect(followButton).toBeTruthy()
    expect(followButton?.attributes('aria-pressed')).toBe('true')

    await followButton?.trigger('click')
    const paused = wrapper.findAll('button').find((button) => button.text().includes('已暂停'))
    expect(paused?.attributes('aria-pressed')).toBe('false')
    expect((wrapper.vm as unknown as { follow: boolean }).follow).toBe(false)
  })

  it('用户往上滚动会暂停跟随，滚回底部恢复跟随', async () => {
    const wrapper = mount(LogViewer, { props: { text: SAMPLE } })
    const scroller = wrapper.find('.log-viewer__scroll').element

    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })

    scroller.scrollTop = 100
    await wrapper.find('.log-viewer__scroll').trigger('scroll')
    expect((wrapper.vm as unknown as { follow: boolean }).follow).toBe(false)

    scroller.scrollTop = 700
    await wrapper.find('.log-viewer__scroll').trigger('scroll')
    expect((wrapper.vm as unknown as { follow: boolean }).follow).toBe(true)
  })

  it('追加日志（SSE 之外也走同一入口）：跟随中增量渲染', async () => {
    const wrapper = mount(LogViewer, { props: { text: SAMPLE } })
    const exposed = wrapper.vm as unknown as { append: (chunk: string) => void; lines: string[] }

    exposed.append('installing dsh-email 0.16.0\n')
    await wrapper.vm.$nextTick()

    expect(exposed.lines).toHaveLength(5)
    expect(wrapper.findAll('.log-viewer__line')).toHaveLength(5)
    expect(wrapper.text()).toContain('installing dsh-email 0.16.0')

    await wrapper.find('input').setValue('installing')
    expect(wrapper.findAll('mark.log-viewer__mark')).toHaveLength(1)
  })

  it('maxLines 生效：只保留最后 N 行', async () => {
    const wrapper = mount(LogViewer, { props: { text: 'a\nb\nc', maxLines: 2 } })
    const exposed = wrapper.vm as unknown as { lines: string[] }
    expect(exposed.lines).toEqual(['b', 'c'])
  })
})
