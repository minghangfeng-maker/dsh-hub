import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'

import { routes } from '@/router'
import AdminJobDetailView from '@/views/admin/AdminJobDetailView.vue'

/**
 * 任务详情（07 §7.9）的回归测试：编排者在截图里发现 task 状态 `pending` 没中文化。
 * 这里直接挂真实页面，断言渲染出来的是中文（而不是英文枚举）。
 */

const JOB = {
  id: 1042,
  type: 'rollout.plugin',
  title: '安装 邮件助手 0.16.0 → 5 位用户',
  status: 'running',
  total: 5,
  done: 3,
  failed: 1,
  createdBy: 1,
  createdByUsername: 'admin',
  createdAt: '2026-10-12T21:22:00.000Z',
  startedAt: '2026-10-12T21:23:00.000Z',
  finishedAt: null,
  error: null,
}

const TASKS = [
  {
    id: 9001,
    seq: 1,
    userId: 1,
    username: 'admin',
    status: 'succeeded',
    attempt: 1,
    startedAt: '2026-10-12T21:23:00.000Z',
    finishedAt: '2026-10-12T21:24:00.000Z',
    error: null,
  },
  {
    id: 9003,
    seq: 2,
    userId: 4,
    username: 'sakura',
    status: 'failed',
    attempt: 2,
    startedAt: '2026-10-12T21:24:00.000Z',
    finishedAt: '2026-10-12T21:25:00.000Z',
    error: 'pnpm install 失败：ETIMEDOUT',
  },
  {
    id: 9004,
    seq: 3,
    userId: 5,
    username: 'butter',
    status: 'running',
    attempt: 1,
    startedAt: '2026-10-12T21:25:00.000Z',
    finishedAt: null,
    error: null,
  },
  {
    id: 9005,
    seq: 4,
    userId: 6,
    username: 'quiet-leaf',
    status: 'pending',
    attempt: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
  },
  {
    id: 9006,
    seq: 5,
    userId: 3,
    username: 'skywalker',
    status: 'skipped',
    attempt: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
  },
]

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function mountDetail(): Promise<{ wrapper: ReturnType<typeof mount>; router: Router }> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (/\/api\/admin\/jobs\/\d+\/tasks\/\d+\/log/.test(url))
        return json({ text: '[21:22:24] task 完成：实际版本 0.16.0' })
      if (/\/api\/admin\/jobs\/\d+$/.test(url)) return json({ job: JOB, tasks: TASKS })
      return json({ error: { code: 'NOT_FOUND', message: '没有这个接口' } }, 404)
    }),
  )

  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/admin/jobs/1042')
  await router.isReady()

  const Host = defineComponent({
    render: () => h(NMessageProvider, null, { default: () => h(AdminJobDetailView) }),
  })
  const wrapper = mount(Host, { global: { plugins: [router] } })
  await flushPromises()
  await flushPromises()
  return { wrapper, router }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('任务详情：状态文案与操作', () => {
  it('task 状态全部中文化（pending → 排队中、skipped → 已跳过）', async () => {
    const { wrapper } = await mountDetail()
    const text = wrapper.text()

    expect(text).toContain('排队中')
    expect(text).toContain('已跳过')
    expect(text).toContain('已完成')
    expect(text).toContain('失败')
    expect(text).toContain('进行中')

    // 表格里不应该出现英文枚举
    const table = wrapper.find('.job-detail__table').text()
    for (const raw of ['pending', 'skipped', 'succeeded', 'canceled']) {
      expect(table, `表格里出现了英文枚举 ${raw}`).not.toContain(raw)
    }
  })

  it('进度、计数与操作按钮按 job 状态启用/禁用', async () => {
    const { wrapper } = await mountDetail()

    expect(wrapper.text()).toContain('3 / 5')
    expect(wrapper.text()).toContain('60%')
    // jsdom 没有 EventSource（只有 ?mock=1 才装假实现），所以状态是「静态」或「实时」
    expect(wrapper.text()).toMatch(/实时|静态/)

    const button = (label: string) => wrapper.findAll('button').find((item) => item.text() === label)
    expect(button('暂停')?.attributes('disabled')).toBeUndefined()
    expect(button('继续')?.attributes('disabled')).toBeDefined()
    expect(button('取消')?.attributes('disabled')).toBeUndefined()
    // 还有失败项但任务仍在跑 → 不能重试
    expect(button('重试失败')?.attributes('disabled')).toBeDefined()
  })

  it('默认选中第一个进行中的 task 并拉取它的日志', async () => {
    const { wrapper } = await mountDetail()
    expect(wrapper.text()).toContain('任务 #9004')
    expect(wrapper.text()).toContain('task 完成：实际版本 0.16.0')
  })
})
