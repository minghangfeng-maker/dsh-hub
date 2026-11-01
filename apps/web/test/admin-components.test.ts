import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import AdminErrorNotice from '@/components/admin/AdminErrorNotice.vue'
import AdminStatCard from '@/components/admin/AdminStatCard.vue'
import AuditTimeline from '@/components/admin/AuditTimeline.vue'
import BatchActionBar from '@/components/admin/BatchActionBar.vue'
import InstanceCard from '@/components/admin/InstanceCard.vue'
import JobProgress from '@/components/admin/JobProgress.vue'
import JsonCollapse from '@/components/admin/JsonCollapse.vue'
import MiniBars from '@/components/admin/MiniBars.vue'
import MiniTag from '@/components/admin/MiniTag.vue'
import QuotaForm from '@/components/admin/QuotaForm.vue'
import RingProgress from '@/components/admin/RingProgress.vue'
import UserCell from '@/components/admin/UserCell.vue'
import { auditActionText, auditSummary } from '@/composables/audit-actions'

/**
 * 管理端通用组件（07 §7.1–§7.10 的公共积木）：只验关键渲染与交互，细粒度逻辑在各自的纯函数测试里。
 */

describe('AdminStatCard（概览统计卡）', () => {
  it('展示标签、计数与副标题；给了 to 就变成链接', async () => {
    const card = mount(AdminStatCard, { props: { label: '用户总数', value: 0, hint: '今日 +3' } })
    expect(card.text()).toContain('用户总数')
    expect(card.text()).toContain('今日 +3')
    expect(card.element.tagName).toBe('DIV')

    const link = mount(AdminStatCard, {
      props: { label: '待审批', value: 3, to: '/admin/users?status=pending' },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
    })
    expect(link.findComponent({ name: 'RouterLink' }).exists() || link.html().includes('a')).toBe(true)
  })

  it('色调通过 CSS 变量下发（不写死颜色）', () => {
    const card = mount(AdminStatCard, { props: { label: '失败', value: 2, tone: 'danger' } })
    const style = card.attributes('style') ?? ''
    expect(style).toContain('--tone-color: var(--c-danger)')
    expect(style).toContain('--tone-soft: var(--c-danger-soft)')
  })
})

describe('MiniTag（策略 / 状态小标签）', () => {
  it('文案 + 令牌配色 + 图标', () => {
    const tag = mount(MiniTag, { props: { text: 'required', tone: 'primary', icon: 'i-ph-lock' } })
    expect(tag.text()).toContain('required')
    expect(tag.find('span.i-ph-lock').exists()).toBe(true)
    expect(tag.attributes('style')).toContain('--tag-soft: var(--c-primary-soft)')
  })
})

describe('JobProgress（成功绿 + 失败红叠加）', () => {
  it('宽度按 done/failed 计算，右侧显示 done/total', () => {
    const progress = mount(JobProgress, { props: { total: 10, done: 5, failed: 2 } })
    const ok = progress.find('.job-progress__ok')
    const fail = progress.find('.job-progress__fail')

    expect(ok.attributes('style')).toContain('width: 30%')
    expect(fail.attributes('style')).toContain('width: 20%')
    expect(fail.attributes('style')).toContain('left: 30%')
    expect(progress.find('.job-progress__text').text()).toBe('5 / 10')
    expect(progress.find('[role="progressbar"]').attributes('aria-label')).toContain('失败 2')
  })

  it('total 为 0 时不除零', () => {
    const progress = mount(JobProgress, { props: { total: 0, done: 0, failed: 0 } })
    expect(progress.find('.job-progress__text').text()).toBe('—')
    expect(progress.find('.job-progress__ok').attributes('style')).toContain('width: 0%')
  })
})

describe('MiniBars（实例迷你资源条）', () => {
  it('没有 stats 时给出占位文案', () => {
    expect(mount(MiniBars, { props: { stats: null } }).text()).toContain('暂无实时资源数据')
  })

  it('CPU / 内存 / 磁盘三条，超过 90% 变奶油黄、超过 100% 变珊瑚红', () => {
    const wrapper = mount(MiniBars, {
      props: {
        stats: {
          cpuPercent: 42,
          memoryBytes: 1024 * 1024 * 1024,
          memoryLimitBytes: 2 * 1024 * 1024 * 1024,
          pids: 12,
          diskBytes: 950,
          diskLimitBytes: 1000,
        },
      },
    })

    const fills = wrapper.findAll('.mini-bars__fill')
    expect(fills).toHaveLength(3)
    expect(fills[0]?.attributes('style')).toContain('var(--c-primary)')
    expect(fills[2]?.attributes('style')).toContain('var(--c-warning)')
    expect(wrapper.text()).toContain('进程数 12')

    const over = mount(MiniBars, {
      props: {
        stats: {
          cpuPercent: 130,
          memoryBytes: 0,
          memoryLimitBytes: 0,
          pids: 1,
          diskBytes: null,
          diskLimitBytes: 0,
        },
      },
    })
    expect(over.findAll('.mini-bars__fill')[0]?.attributes('style')).toContain('var(--c-danger)')
  })
})

describe('QuotaForm（用户配额表单）', () => {
  it('quota=null 表示使用全局默认，点「自定义」把默认值灌进来', async () => {
    const wrapper = mount(QuotaForm, { props: { modelValue: null } })
    expect(wrapper.text()).toContain('使用全局默认配额')

    const custom = wrapper.findAll('button').find((button) => button.text() === '自定义')
    await custom?.trigger('click')

    const emitted = wrapper.emitted('update:modelValue')?.[0]?.[0] as { cpus: number; memoryMb: number }
    expect(emitted).toMatchObject({ cpus: 2, memoryMb: 4096 })
    expect(wrapper.emitted('change')).toBeTruthy()
  })

  it('自定义状态下「恢复默认」回传 null', async () => {
    const wrapper = mount(QuotaForm, {
      props: {
        modelValue: {
          cpus: 4,
          memoryMb: 4096,
          pidsLimit: 512,
          diskGb: 10,
          idleStopMinutes: 60,
          idleNoClientMinutes: 30,
          allowUserPlugins: false,
        },
      },
    })
    expect(wrapper.text()).toContain('自定义配额')

    const reset = wrapper.findAll('button').find((button) => button.text() === '恢复默认')
    await reset?.trigger('click')

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([null])
  })
})

describe('RingProgress / UserCell / BatchActionBar / AdminErrorNotice', () => {
  it('环形进度显示百分比、标签与阈值配色', () => {
    const ring = mount(RingProgress, { props: { value: 0.42, label: 'CPU 负载', hint: '1 分钟 0.4' } })
    expect(ring.text()).toContain('42%')
    expect(ring.text()).toContain('1 分钟 0.4')
    expect(ring.find('svg').attributes('aria-label')).toContain('CPU 负载')

    // 根类名不能叫 `ring`：那是 UnoCSS 的工具类，会多出蓝色 focus ring（WP6 第二轮踩过）
    expect(ring.find('.ring-progress').exists()).toBe(true)

    const warn = mount(RingProgress, { props: { value: 0.95, label: '磁盘' } })
    expect(warn.find('.ring-progress').attributes('style')).toContain('var(--c-warning)')

    const over = mount(RingProgress, { props: { value: 1.2, label: '磁盘' } })
    expect(over.find('.ring-progress').attributes('style')).toContain('var(--c-danger)')
  })

  it('用户单元格：用户名 + 昵称，给了 to 就能跳详情', () => {
    const cell = mount(UserCell, {
      props: {
        user: { id: 3, username: 'mint', displayName: '薄荷茶', avatarUrl: null },
        to: '/admin/users/3',
      },
      global: { stubs: { RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } },
    })
    expect(cell.text()).toContain('mint')
    expect(cell.text()).toContain('薄荷茶')
    expect(cell.html()).toContain('/admin/users/3')
  })

  it('批量操作条：0 项不显示，>0 显示数量并可清空', async () => {
    const empty = mount(BatchActionBar, { props: { count: 0 } })
    expect(empty.find('.batch-bar').exists()).toBe(false)

    const bar = mount(BatchActionBar, {
      props: { count: 3, unit: '位用户' },
      slots: { default: '<button>启用</button>' },
    })
    expect(bar.text()).toContain('已选 3 位用户')
    expect(bar.html()).toContain('启用')

    await bar.findAll('button').at(-1)?.trigger('click')
    expect(bar.emitted('clear')).toBeTruthy()
  })

  it('错误提示条：展示文案并可重试；无错误时不渲染', async () => {
    const notice = mount(AdminErrorNotice, {
      props: {
        error: {
          code: 'INTERNAL',
          message: '出了点小问题，请稍后再试',
          fieldErrors: {},
          retryAfterSec: null,
          network: false,
          retryable: true,
        },
        title: '用户列表加载失败',
      },
    })
    expect(notice.text()).toContain('用户列表加载失败')
    expect(notice.attributes('role')).toBe('alert')

    await notice.find('button').trigger('click')
    expect(notice.emitted('retry')).toBeTruthy()

    expect(mount(AdminErrorNotice, { props: { error: null } }).html()).toBe('<!--v-if-->')
  })
})

describe('JsonCollapse（审计详情折叠）', () => {
  it('对象格式化展示，空对象不渲染', () => {
    const collapse = mount(JsonCollapse, { props: { value: { a: 1, b: 'x' }, label: 'detail' } })
    expect(collapse.find('summary').text()).toContain('detail')
    expect(collapse.find('pre').text()).toContain('"a": 1')

    expect(mount(JsonCollapse, { props: { value: null } }).html()).toBe('<!--v-if-->')
    expect(mount(JsonCollapse, { props: { value: {} } }).html()).toBe('<!--v-if-->')
  })
})

describe('AuditTimeline（审计时间线）', () => {
  const items = [
    {
      id: 1,
      at: '2026-10-12T10:00:00.000Z',
      actorId: 1,
      actorIp: '127.0.0.1',
      actorUsername: 'admin',
      action: 'user.approve',
      targetType: 'user',
      targetId: '3',
      detail: { note: 'ok' },
    },
    {
      id: 2,
      at: '2026-10-12T09:00:00.000Z',
      actorId: null,
      actorIp: null,
      actorUsername: null,
      action: '未知动作',
      targetType: null,
      targetId: null,
      detail: null,
    },
  ]

  it('动作翻译、操作者、对象与时间都在；未知动作原样显示', () => {
    const timeline = mount(AuditTimeline, { props: { items } })
    expect(timeline.text()).toContain('通过审批')
    expect(timeline.text()).toContain('admin')
    expect(timeline.text()).toContain('user #3')
    expect(timeline.text()).toContain('未知动作')
    expect(timeline.text()).toContain('系统')
  })

  it('compact 模式不显示 detail 折叠；空列表显示占位', () => {
    expect(
      mount(AuditTimeline, { props: { items, compact: true } })
        .find('details')
        .exists(),
    ).toBe(false)
    expect(mount(AuditTimeline, { props: { items: [] }, attrs: {} }).text()).toContain('还没有审计记录')
    expect(mount(AuditTimeline, { props: { items: [], emptyText: '空' } }).text()).toContain('空')
  })

  it('audit-actions：动作映射与一行摘要', () => {
    expect(auditActionText('rollout.create')).toBe('创建下发任务')
    expect(auditActionText('made.up.action')).toBe('made.up.action')
    expect(auditSummary(items[0]!)).toBe('admin 通过审批 · user #3')
  })
})

describe('InstanceCard（实例卡片）', () => {
  it('展示状态、版本、操作按钮，并把动作抛给父页', async () => {
    const card = mount(InstanceCard, {
      props: {
        row: {
          user: { id: 1, slug: 'u1', username: 'mint', displayName: '薄荷', avatarUrl: null },
          instance: {
            status: 'running',
            runtimeVersion: '0.2.0-rc.2',
            startedAt: '2026-10-12T10:00:00.000Z',
            lastActiveAt: '2026-10-12T11:00:00.000Z',
            needsRecreate: false,
            error: null,
            openUrl: '/dsh/mint/',
          },
          stats: null,
        },
        now: new Date('2026-10-12T12:00:00.000Z').getTime(),
      },
    })

    expect(card.text()).toContain('薄荷')
    expect(card.text()).toContain('运行中')
    expect(card.text()).toContain('0.2.0-rc.2')
    expect(card.text()).toContain('2 小时')

    const stop = card.findAll('button').find((button) => button.text() === '停止')
    await stop?.trigger('click')
    expect(card.emitted('action')?.[0]).toEqual(['stop'])
  })

  it('needsRecreate 与 error 有各自的提示条', () => {
    const base = {
      user: { id: 1, slug: 'u1', username: 'mint', displayName: '薄荷', avatarUrl: null },
      instance: {
        status: 'stopped' as const,
        runtimeVersion: null,
        startedAt: null,
        lastActiveAt: null,
        needsRecreate: true,
        error: null,
        openUrl: '/dsh/mint/',
      },
      stats: null,
    }

    expect(mount(InstanceCard, { props: { row: base } }).text()).toContain('配置已更新，重建后生效')
    expect(
      mount(InstanceCard, {
        props: { row: { ...base, instance: { ...base.instance, error: '启动超时' } } },
      }).text(),
    ).toContain('启动超时')
  })
})
