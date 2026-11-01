import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import type { CanvasItem } from '@/api/admin-cockpit'
import AssistantEvents from '@/components/admin/assistant/AssistantEvents.vue'

/**
 * AI 助手页右侧的结果卡要画出正文（10-30 用户反馈「右侧没有出图表」）：
 * CanvasCard 只是外壳，正文靠默认插槽里的 CanvasSpecView；WP57b 起漏了这一层，卡片只剩标题行。
 */
const tableCard: CanvasItem = {
  id: 'cv_table',
  sessionId: 'session-1',
  title: '明细：本周按用户积分消耗',
  spec: {
    kind: 'table',
    columns: [
      { key: 'username', label: '用户' },
      { key: 'credits', label: '积分' },
    ],
    data: {
      rows: [
        { username: 'demo_prof', credits: 1.99 },
        { username: 'xdedmi', credits: 1.2 },
      ],
    },
  },
  pinned: false,
  order: 10,
  createdAt: '2026-10-30T13:18:17.289Z',
  updatedAt: '2026-10-30T13:18:19.877Z',
  origin: 'dsh',
  placement: 'left',
  size: 's',
}

describe('AssistantEvents：结果卡带正文', () => {
  it('表格卡渲染出列名和行数据，不只是标题', () => {
    const wrapper = mount(AssistantEvents, {
      props: {
        pendingProposals: [],
        pendingSecrets: [],
        resultCards: [tableCard],
        recentProposals: [],
        catalog: [],
        error: null,
        flashId: null,
        clearable: true,
      },
    })

    const card = wrapper.find('.canvas-card__body')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('用户')
    expect(card.text()).toContain('demo_prof')
    expect(card.text()).toContain('xdedmi')
    wrapper.unmount()
  })

  it('卡片有「放大查看」、没有「钉到态势板」；放大后弹窗里是完整表格', async () => {
    const wrapper = mount(AssistantEvents, {
      attachTo: document.body,
      props: {
        pendingProposals: [],
        pendingSecrets: [],
        resultCards: [tableCard],
        recentProposals: [],
        catalog: [],
        error: null,
        flashId: null,
        clearable: true,
      },
    })

    expect(wrapper.find('[aria-label="钉到态势板"]').exists()).toBe(false)
    const expand = wrapper.find('[data-testid="canvas-card-expand"]')
    expect(expand.exists()).toBe(true)

    await expand.trigger('click')
    await flushPromises()
    const modal = document.querySelector('.events__expanded')
    expect(modal).not.toBeNull()
    expect(modal?.textContent).toContain('明细：本周按用户积分消耗')
    expect(modal?.textContent).toContain('demo_prof')

    wrapper.unmount()
    document.body.innerHTML = ''
  })
})
