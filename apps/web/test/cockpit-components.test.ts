import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { defineComponent, h } from 'vue'

import type { CanvasItem, CapabilityDescriptor, ProposalView, SecretRequestView } from '@/api/admin-cockpit'
import CanvasCard from '@/components/admin/cockpit/CanvasCard.vue'
import CockpitFrame from '@/components/admin/cockpit/CockpitFrame.vue'
import ProposalCard from '@/components/admin/cockpit/ProposalCard.vue'
import SecretRequestCard from '@/components/admin/cockpit/SecretRequestCard.vue'
import CanvasChart from '@/components/admin/cockpit/renderers/CanvasChart.vue'
import CanvasEntity from '@/components/admin/cockpit/renderers/CanvasEntity.vue'
import CanvasJob from '@/components/admin/cockpit/renderers/CanvasJob.vue'
import CanvasLogs from '@/components/admin/cockpit/renderers/CanvasLogs.vue'
import CanvasMarkdown from '@/components/admin/cockpit/renderers/CanvasMarkdown.vue'
import CanvasStats from '@/components/admin/cockpit/renderers/CanvasStats.vue'
import CanvasTable from '@/components/admin/cockpit/renderers/CanvasTable.vue'
import { reauthDialog, resetReauthDialog, resolveReauth } from '@/composables/useReauth'

/**
 * 座舱组件（WP56c「测试（必须）」）：
 * 每种渲染器、方案卡各状态、R3 需要密码、markdown 不渲染 HTML、postMessage 拒绝异源消息。
 */

vi.mock('@/api/admin-users', () => ({ getUser: vi.fn() }))
vi.mock('@/api/admin-jobs', () => ({ getJob: vi.fn() }))
vi.mock('@/api/admin-cockpit', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    approveProposal: vi.fn(),
    rejectProposal: vi.fn(),
    submitSecretRequest: vi.fn(),
    cancelSecretRequest: vi.fn(),
  }
})

const { getUser } = await import('@/api/admin-users')
const { getJob } = await import('@/api/admin-jobs')
const { approveProposal, rejectProposal, submitSecretRequest, cancelSecretRequest } =
  await import('@/api/admin-cockpit')

/** 组件里会用到 RouterLink（实体卡 / 方案卡的「在经典页面打开」） */
const stubs = {
  RouterLink: defineComponent({
    props: { to: { type: [String, Object], default: '' } },
    setup(props, { slots }) {
      return () => h('a', { href: String(props.to) }, slots['default']?.())
    },
  }),
}

function proposalFixture(partial: Partial<ProposalView> = {}): ProposalView {
  return {
    id: 12,
    sessionId: 'sess_plugin_upgrade',
    title: '下发 dsh-memory 0.1.4',
    rationale: '修了长会话里记忆丢失的问题，建议下次启动生效。',
    risk: 'R2',
    steps: [
      {
        capability: 'rollouts.plugin',
        args: { pluginId: 3 },
        preview: {
          summary: '影响 8 个用户；其中 2 个实例正在运行，重启后生效',
          affected: [
            { kind: 'user', id: 3, label: 'alice' },
            { kind: 'plugin', id: 3, label: 'dsh-memory@0.1.4' },
          ],
          warnings: ['2 个用户的实例正在运行'],
        },
      },
    ],
    status: 'pending',
    createdAt: '2026-10-29T20:00:00.000Z',
    expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    ...partial,
  }
}

const catalog: CapabilityDescriptor[] = [
  {
    id: 'rollouts.plugin',
    area: 'rollouts',
    title: '下发插件',
    description: '',
    risk: 'R2',
    input: {},
    classicPath: '/admin/rollouts',
  },
  {
    id: 'users.delete',
    area: 'users',
    title: '删除用户',
    description: '',
    risk: 'R3',
    input: {},
    classicPath: '/admin/users',
  },
]

function canvasItem(partial: Partial<CanvasItem> & Pick<CanvasItem, 'id'>): CanvasItem {
  return {
    sessionId: 'sess_weekly_usage',
    title: '一张卡',
    spec: { kind: 'markdown', text: 'hi' },
    pinned: false,
    order: 1,
    createdAt: '2026-10-29T20:00:00.000Z',
    updatedAt: '2026-10-29T20:00:00.000Z',
    origin: 'dsh',
    placement: 'left',
    size: 'm',
    ...partial,
  }
}

beforeEach(() => {
  resetReauthDialog()
  vi.mocked(approveProposal).mockReset()
  vi.mocked(rejectProposal).mockReset()
  vi.mocked(submitSecretRequest).mockReset()
  vi.mocked(cancelSecretRequest).mockReset()
  vi.mocked(getUser).mockReset()
  vi.mocked(getJob).mockReset()
})

/**
 * 让 `matchMedia('(prefers-reduced-motion: reduce)')` 返回 matches=true（vueuse 的
 * `usePrefersReducedMotion` 走的就是它），跑完恢复。WP56h 的动效开关全靠这个判断。
 */
function withReducedMotion<T>(run: () => T): T {
  const original = window.matchMedia
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  })
  try {
    return run()
  } finally {
    Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: original })
  }
}

describe('CanvasStats（stats 卡）', () => {
  it('指标、单位、环比与色调', () => {
    const wrapper = mount(CanvasStats, {
      props: {
        items: [
          { label: '运行中', value: 5, unit: '/ 12', tone: 'good' },
          { label: '积分', value: '3.21', unit: '积分', delta: 12 },
          { label: '失败', value: 3, tone: 'warn', delta: -4 },
        ],
      },
    })

    expect(wrapper.text()).toContain('运行中')
    expect(wrapper.text()).toContain('/ 12')
    expect(wrapper.text()).toContain('+12%')
    expect(wrapper.text()).toContain('-4%')
    expect(wrapper.findAll('.canvas-stat--good')).toHaveLength(1)
    expect(wrapper.findAll('.canvas-stat--warn')).toHaveLength(1)
  })

  it('带 max 画环形仪表（44px，细轨道 + 色弧），带 spark 画 64×20 迷你走势', () => {
    const wrapper = mount(CanvasStats, {
      props: {
        items: [
          { label: '运行实例', value: 5, max: 12, tone: 'good' },
          { label: '今日请求', value: 421, spark: [310, 402, 366, 512, 470, 604, 421] },
          { label: '纯数字', value: 7 },
        ],
      },
    })

    // 只有第一项有 max
    expect(wrapper.findAll('.canvas-stat__gauge')).toHaveLength(1)
    const gauge = wrapper.find('.canvas-stat__gauge')
    expect(gauge.attributes('width')).toBe('44')
    const arc = wrapper.find('.canvas-stat__gauge-arc')
    // 5/12 的比例写进 stroke-dasharray（前一段是「已填充」长度）
    const dash = arc.attributes('stroke-dasharray') ?? ''
    const circumference = 2 * Math.PI * 18
    expect(Number.parseFloat(dash)).toBeCloseTo((5 / 12) * circumference, 1)

    // 只有第二项有 spark
    expect(wrapper.findAll('.canvas-stat__spark')).toHaveLength(1)
    expect(wrapper.find('.canvas-stat__spark').attributes('width')).toBe('64')
    expect(wrapper.find('.canvas-stat__spark-line').attributes('d')).toContain('M0.0')

    // 数字直接落终态（首帧不做「从 0 数上去」）
    expect(wrapper.text()).toContain('5')
    expect(wrapper.text()).toContain('421')
    expect(wrapper.text()).toContain('7')
  })

  it('delta 用 ▲ / ▼ 带色：正数向上、负数向下', () => {
    const wrapper = mount(CanvasStats, {
      props: {
        items: [
          { label: '升', value: 1, delta: 12 },
          { label: '降', value: 1, delta: -4 },
          { label: '平', value: 1, delta: 0 },
        ],
      },
    })
    const arrows = wrapper.findAll('.canvas-stat__arrow').map((node) => node.text())
    expect(arrows).toEqual(['▲', '▼'])
    expect(wrapper.find('.canvas-stat__delta--up').exists()).toBe(true)
    expect(wrapper.find('.canvas-stat__delta--down').exists()).toBe(true)
  })

  it('取数中 / 空指标有就地提示', () => {
    const loading = mount(CanvasStats, { props: { items: [], loading: true } })
    expect(loading.text()).toContain('正在读取')
    const empty = mount(CanvasStats, { props: { items: [] } })
    expect(empty.text()).toContain('暂无指标')
    const failed = mount(CanvasStats, { props: { items: [], error: '数据源不可用' } })
    expect(failed.text()).toContain('数据源不可用')
  })

  it('reduced-motion：不加动画类、数字直接是终态', () => {
    withReducedMotion(() => {
      const wrapper = mount(CanvasStats, {
        props: { items: [{ label: '运行实例', value: 5, max: 12, spark: [1, 2, 3] }] },
      })
      expect(wrapper.find('.canvas-stats').classes()).not.toContain('canvas-stats--motion')
      expect(wrapper.find('.canvas-stat__number').text()).toBe('5')
    })
  })
})

describe('CanvasTable（table 卡）', () => {
  const columns = [
    { key: 'username', label: '用户' },
    { key: 'points', label: '积分', format: 'credits' as const },
    { key: 'lastLoginAt', label: '最近登录', format: 'datetime' as const },
  ]

  it('按列格式化，行末「追问这一行」把行数据抛给上层', async () => {
    const wrapper = mount(CanvasTable, {
      props: {
        columns,
        rows: [{ username: 'alice', points: 32.14, lastLoginAt: '2026-10-29T10:00:00.000Z' }],
      },
    })

    expect(wrapper.text()).toContain('alice')
    expect(wrapper.text()).toContain('32.14')

    const ask = wrapper.find('.canvas-table__ask')
    expect(ask.exists()).toBe(true)
    await ask.trigger('click')
    expect(wrapper.emitted('ask')?.[0]?.[0]).toMatchObject({ username: 'alice', points: 32.14 })
  })

  it('空数据与错误就地提示', () => {
    const empty = mount(CanvasTable, { props: { columns, rows: [] } })
    expect(empty.text()).toContain('没有数据')
    // 空表不留空表头：连 thead 都不渲染
    expect(empty.find('table').exists()).toBe(false)

    const failed = mount(CanvasTable, { props: { columns, rows: [], error: '数据源不可用' } })
    expect(failed.text()).toContain('数据源不可用')
  })

  it('空态可以说人话（「一切正常」「没有待确认的操作」）', () => {
    const ok = mount(CanvasTable, {
      props: { columns, rows: [], emptyText: '一切正常' },
    })
    expect(ok.text()).toContain('一切正常')
    expect(ok.find('table').exists()).toBe(false)
  })

  it('数值列 ≤20 行时画数据条，按列最大值归一；>20 行不画', () => {
    const rows = [
      { username: 'alice', points: 40, lastLoginAt: '2026-10-29T10:00:00.000Z' },
      { username: 'bob', points: 10, lastLoginAt: '2026-10-29T10:00:00.000Z' },
      { username: 'carol', points: 0, lastLoginAt: '2026-10-29T10:00:00.000Z' },
    ]
    const wrapper = mount(CanvasTable, { props: { columns, rows } })
    const bars = wrapper.findAll('.canvas-table__bar')
    // points 两行非 0（0 不画条），username / datetime 列不是数值列
    expect(bars).toHaveLength(2)
    expect(bars[0]?.attributes('style')).toContain('width: 100%')
    expect(bars[1]?.attributes('style')).toContain('width: 25%')

    const many = mount(CanvasTable, {
      props: {
        columns,
        rows: Array.from({ length: 21 }, (_, index) => ({
          username: `u${String(index)}`,
          points: index + 1,
          lastLoginAt: '2026-10-29T10:00:00.000Z',
        })),
      },
    })
    expect(many.findAll('.canvas-table__bar')).toHaveLength(0)
  })
})

describe('CanvasChart（chart 卡）', () => {
  const series = [
    { label: 'DSH', color: 'var(--c-series-1)', values: [3, 5, 2], dashed: false },
    { label: 'Claude Code', color: 'var(--c-series-2)', values: [1, 2, 4], dashed: false },
  ]

  it('折线：每条系列一条路径 + 图例 + 无障碍描述', () => {
    const wrapper = mount(CanvasChart, {
      props: { chart: 'line', labels: ['10-27', '10-28', '10-29'], series, unit: '积分' },
    })

    expect(wrapper.findAll('path.canvas-chart__line')).toHaveLength(2)
    expect(wrapper.text()).toContain('DSH')
    expect(wrapper.text()).toContain('Claude Code')
    expect(wrapper.find('svg').attributes('aria-label')).toContain('3 个数据点')
  })

  it('堆叠柱：每个有值的格子一根柱；空数据显示空状态', () => {
    const wrapper = mount(CanvasChart, {
      props: { chart: 'stacked-bar', labels: ['10-27', '10-28'], series },
    })
    // 2 天 × 2 系列 = 4 段
    expect(wrapper.findAll('path.canvas-chart__bar')).toHaveLength(4)

    const empty = mount(CanvasChart, { props: { chart: 'bar', labels: [], series: [] } })
    expect(empty.text()).toContain('这段时间还没有数据')
  })

  it('折线走单调三次曲线（C 指令），描边 2px + 辉光滤镜 + 最后一个点的呼吸光点', () => {
    const wrapper = mount(CanvasChart, {
      props: { chart: 'line', labels: ['10-27', '10-28', '10-29'], series },
    })
    const path = wrapper.find('path.canvas-chart__line')
    expect(path.attributes('d')).toContain(' C')
    expect(path.attributes('stroke-width')).toBe('2')
    expect(path.attributes('filter')).toMatch(/url\(#chart\d+-glow-0\)/)
    // 两条系列 = 两个呼吸光点
    expect(wrapper.findAll('circle.canvas-chart__pulse')).toHaveLength(2)
  })

  it('面积：纵向渐变（系列色 35% → 0%）', () => {
    const wrapper = mount(CanvasChart, {
      props: { chart: 'area', labels: ['10-27', '10-28'], series: [series[0]!] },
    })
    expect(wrapper.findAll('path.canvas-chart__area')).toHaveLength(1)
    const stops = wrapper.findAll('linearGradient stop')
    const areaStops = stops.filter((stop) => stop.attributes('stop-opacity') !== undefined)
    expect(areaStops.map((stop) => stop.attributes('stop-opacity'))).toContain('0.35')
    expect(areaStops.map((stop) => stop.attributes('stop-opacity'))).toContain('0')
  })

  it('柱子 ≤12 根时柱顶标数值（紧凑写法），>12 根不标', () => {
    const few = mount(CanvasChart, {
      props: {
        chart: 'bar',
        labels: ['alice', 'bob'],
        series: [{ label: '内存 MB', color: 'var(--c-series-1)', values: [812, 640], dashed: false }],
        unit: 'MB',
      },
    })
    expect(few.findAll('text.canvas-chart__bar-value').map((node) => node.text())).toEqual(['812', '640'])

    const many = mount(CanvasChart, {
      props: {
        chart: 'bar',
        labels: Array.from({ length: 13 }, (_, index) => `u${String(index)}`),
        series: [
          {
            label: '内存 MB',
            color: 'var(--c-series-1)',
            values: Array.from({ length: 13 }, (_, index) => index + 1),
            dashed: false,
          },
        ],
      },
    })
    expect(many.findAll('text.canvas-chart__bar-value')).toHaveLength(0)

    // 大数字紧凑显示：坐标轴刻度与柱顶标签都走 1.2M / 500K
    const big = mount(CanvasChart, {
      props: {
        chart: 'bar',
        labels: ['a', 'b'],
        series: [
          {
            label: 'tokens',
            color: 'var(--c-series-1)',
            values: [1_200_000, 500_000],
            dashed: false,
          },
        ],
        unit: 'tokens',
      },
    })
    expect(big.findAll('text.canvas-chart__bar-value').map((node) => node.text())).toEqual(['1.2M', '500K'])
  })

  it('悬停：竖向十字准线 + 浮层列出各系列该点的数值', async () => {
    const wrapper = mount(CanvasChart, {
      props: { chart: 'line', labels: ['10-27', '10-28', '10-29'], series, unit: '积分' },
    })
    const svg = wrapper.find('svg')
    expect(svg.exists()).toBe(true)
    // 落在中间那个点（fallback 宽度 520，plot.left=44、宽 466）
    await svg.trigger('mousemove', { clientX: 44 + 466 * 0.5, clientY: 100 })

    expect(wrapper.find('.canvas-chart__cross').exists()).toBe(true)
    const tip = wrapper.find('.canvas-chart__tip')
    expect(tip.exists()).toBe(true)
    expect(tip.text()).toContain('10-28')
    expect(tip.text()).toContain('DSH')
    expect(tip.text()).toContain('5积分')
    expect(wrapper.findAll('.canvas-chart__hover-dot')).toHaveLength(2)

    await svg.trigger('mouseleave')
    expect(wrapper.find('.canvas-chart__tip').exists()).toBe(false)
  })

  it('donut：14px 粗环、中心总数 + 单位、图例带百分比', () => {
    const slices = [
      { label: 'alice', value: 60, percent: 60, color: 'var(--c-series-1)' },
      { label: 'bob', value: 30, percent: 30, color: 'var(--c-series-2)' },
      { label: 'carol', value: 10, percent: 10, color: 'var(--c-series-3)' },
    ]
    const wrapper = mount(CanvasChart, {
      props: { chart: 'donut', labels: [], series: [], slices, donutLabel: '积分', unit: '积分' },
    })
    expect(wrapper.findAll('circle.canvas-chart__slice')).toHaveLength(3)
    for (const slice of wrapper.findAll('circle.canvas-chart__slice')) {
      expect(slice.attributes('stroke-width')).toBe('14')
    }
    expect(wrapper.find('.canvas-chart__donut-total').text()).toContain('100积分')
    // 中心已经有「总数 + 单位」了：图例头与单位重复时显示「合计」，否则显示系列名
    expect(wrapper.find('.canvas-chart__donut-label').text()).toBe('合计')
    const named = mount(CanvasChart, {
      props: { chart: 'donut', labels: [], series: [], slices, donutLabel: '消耗', unit: '积分' },
    })
    expect(named.find('.canvas-chart__donut-label').text()).toBe('消耗')
    expect(wrapper.findAll('.canvas-chart__legend-percent').map((node) => node.text())).toEqual([
      '60%',
      '30%',
      '10%',
    ])
    expect(wrapper.find('svg').attributes('aria-label')).toContain('alice')
  })

  it('donut：没有可比较的数据时给空态', () => {
    const wrapper = mount(CanvasChart, {
      props: { chart: 'donut', labels: [], series: [], slices: [] },
    })
    expect(wrapper.text()).toContain('没有可比较的数据')
  })

  it('reduced-motion：描线 / 柱生长 / 呼吸光点 / donut 扫出都不加动画类', () => {
    withReducedMotion(() => {
      const line = mount(CanvasChart, {
        props: { chart: 'area', labels: ['10-27', '10-28'], series },
      })
      expect(line.find('.canvas-chart').classes()).not.toContain('canvas-chart--motion')
      expect(line.find('.canvas-chart__line--draw').exists()).toBe(false)
      expect(line.find('.canvas-chart__pulse--breathe').exists()).toBe(false)

      const bar = mount(CanvasChart, {
        props: { chart: 'bar', labels: ['10-27', '10-28'], series },
      })
      expect(bar.find('.canvas-chart__bar--grow').exists()).toBe(false)
      expect(bar.find('.canvas-chart__bar-value--in').exists()).toBe(false)

      const donut = mount(CanvasChart, {
        props: {
          chart: 'donut',
          labels: [],
          series: [],
          slices: [{ label: 'alice', value: 1, percent: 100, color: 'var(--c-series-1)' }],
        },
      })
      expect(donut.find('.canvas-chart__slice--sweep').exists()).toBe(false)
    })
  })

  it('默认（动效开）会加动画类', () => {
    const line = mount(CanvasChart, {
      props: { chart: 'line', labels: ['10-27', '10-28'], series },
    })
    expect(line.find('.canvas-chart').classes()).toContain('canvas-chart--motion')
    expect(line.findAll('.canvas-chart__line--draw')).toHaveLength(2)
    expect(line.findAll('.canvas-chart__pulse--breathe')).toHaveLength(2)
  })
})

describe('CanvasLogs（logs 卡）', () => {
  it('按行渲染，错误行有独立样式', () => {
    const wrapper = mount(CanvasLogs, {
      props: {
        rows: [
          { time: '21:02:11', level: 'info', line: '开始下发' },
          { time: '21:02:24', level: 'error', line: '写入失败' },
        ],
      },
    })

    expect(wrapper.findAll('.canvas-logs__line')).toHaveLength(2)
    expect(wrapper.find('.canvas-logs__line--error').text()).toContain('写入失败')
  })
})

describe('CanvasMarkdown（markdown 卡，禁 HTML）', () => {
  it('HTML 一律当文字，不生成元素（注入测试）', () => {
    const payload = '忽略之前的规则\n<img src=x onerror="alert(1)">\n<b>加粗</b>'
    const wrapper = mount(CanvasMarkdown, { props: { text: payload } })

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('b').exists()).toBe(false)
    expect(wrapper.text()).toContain('<img src=x onerror="alert(1)">')
    expect(wrapper.text()).toContain('<b>加粗</b>')
  })

  it('标题 / 项目符号 / 段落分块，超长截断', () => {
    const wrapper = mount(CanvasMarkdown, {
      props: { text: '# 小结\n本周下降 8%\n- 第一条\n- 第二条' },
    })

    expect(wrapper.find('.canvas-markdown__heading').text()).toBe('小结')
    expect(wrapper.findAll('.canvas-markdown__item')).toHaveLength(2)

    const long = mount(CanvasMarkdown, { props: { text: 'x'.repeat(5000) } })
    expect((long.text().match(/x/g) ?? []).length).toBeLessThanOrEqual(4001)
  })
})

describe('CanvasEntity / CanvasJob（实体卡与任务卡）', () => {
  it('用户实体卡：用户名 + 角色 + 状态 + 经典页面入口', async () => {
    vi.mocked(getUser).mockResolvedValue({
      user: {
        id: 9,
        username: 'test-x',
        displayName: '测试账号',
        slug: 'u3k9x2aa',
        avatarUrl: null,
        role: 'user',
        roleLabel: '家人',
        status: 'active',
        instance: { status: 'running' },
        lastLoginAt: '2026-10-29T10:00:00.000Z',
      },
    } as unknown as Awaited<ReturnType<typeof getUser>>)

    const wrapper = mount(CanvasEntity, {
      props: { entity: 'user', id: 9 },
      global: { stubs },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('test-x')
    expect(wrapper.text()).toContain('家人')
    expect(wrapper.text()).toContain('运行中')
    expect(wrapper.find('a').attributes('href')).toBe('/admin/users/9')
  })

  it('任务卡：标题、状态、进度；拿不到就提示', async () => {
    vi.mocked(getJob).mockResolvedValue({
      job: { id: 9001, title: '构建 DSH 版本', status: 'running', total: 10, done: 4, failed: 1 },
      tasks: [],
    } as unknown as Awaited<ReturnType<typeof getJob>>)

    const wrapper = mount(CanvasJob, {
      props: { jobId: 9001 },
      global: { stubs: { RouterLink: stubs.RouterLink } },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('构建 DSH 版本')
    expect(wrapper.text()).toContain('进行中')
    expect(wrapper.text()).toContain('失败 1')
    wrapper.unmount()
  })
})

describe('ProposalCard（方案卡各状态）', () => {
  it('pending：DSH 的说明单独标注、影响面来自 Hub preview、有执行/拒绝', async () => {
    vi.mocked(approveProposal).mockResolvedValue({ proposal: proposalFixture({ status: 'running' }) })

    const wrapper = mount(ProposalCard, {
      props: { proposal: proposalFixture(), catalog },
      global: { stubs },
    })

    expect(wrapper.text()).toContain('DSH 的说明')
    expect(wrapper.text()).toContain('修了长会话里记忆丢失的问题')
    expect(wrapper.text()).toContain('R2 有影响')
    expect(wrapper.text()).toContain('待确认')
    expect(wrapper.text()).toContain('影响 8 个用户')
    expect(wrapper.text()).toContain('alice')
    expect(wrapper.text()).toContain('下发插件')
    expect(wrapper.text()).toContain('在经典页面打开')

    const approve = wrapper.findAll('button').find((button) => button.text() === '执行')
    expect(approve).toBeTruthy()
    await approve?.trigger('click')
    await flushPromises()

    expect(vi.mocked(approveProposal)).toHaveBeenCalledWith(12)
    expect(wrapper.emitted('updated')?.[0]?.[0]).toMatchObject({ id: 12, status: 'running' })
  })

  it('running：不能点，显示执行中', () => {
    const wrapper = mount(ProposalCard, {
      props: { proposal: proposalFixture({ status: 'running' }), catalog },
      global: { stubs },
    })
    expect(wrapper.text()).toContain('正在执行')
    expect(wrapper.findAll('button').map((button) => button.text())).not.toContain('执行')
  })

  it('failed：逐步骤显示失败原因，按钮消失', () => {
    const wrapper = mount(ProposalCard, {
      props: {
        proposal: proposalFixture({
          status: 'failed',
          decidedBy: { id: 1, username: 'admin' },
          outcome: [
            {
              stepIndex: 0,
              ok: false,
              error: { code: 'CONFLICT', message: '用户 test-y 的实例正在重建，请稍后再试' },
            },
          ],
        }),
        catalog,
      },
      global: { stubs },
    })

    expect(wrapper.text()).toContain('失败')
    expect(wrapper.text()).toContain('用户 test-y 的实例正在重建')
    expect(wrapper.findAll('button').map((button) => button.text())).not.toContain('执行')
  })

  it('过期：置灰并显示「方案已过期」', () => {
    const wrapper = mount(ProposalCard, {
      props: {
        proposal: proposalFixture({ expiresAt: new Date(Date.now() - 60_000).toISOString() }),
        catalog,
      },
      global: { stubs },
    })
    expect(wrapper.text()).toContain('方案已过期')
    expect(wrapper.findAll('button').map((button) => button.text())).not.toContain('执行')
  })

  it('R3：点执行先要管理员密码，没输不发请求', async () => {
    vi.mocked(approveProposal).mockResolvedValue({
      proposal: proposalFixture({ id: 15, risk: 'R3', status: 'running' }),
    })

    const wrapper = mount(ProposalCard, {
      props: {
        proposal: proposalFixture({
          id: 15,
          risk: 'R3',
          title: '删除用户 test-x',
          steps: [
            {
              capability: 'users.delete',
              args: { username: 'test-x' },
              preview: { summary: '删除 1 个用户' },
            },
          ],
        }),
        catalog,
      },
      global: { stubs },
    })

    const approve = wrapper.findAll('button').find((button) => button.text().includes('需密码'))
    expect(approve).toBeTruthy()
    await approve?.trigger('click')
    await flushPromises()

    // 弹了密码框，但还没发请求
    expect(reauthDialog.visible).toBe(true)
    expect(vi.mocked(approveProposal)).not.toHaveBeenCalled()

    resolveReauth()
    await flushPromises()
    expect(vi.mocked(approveProposal)).toHaveBeenCalledWith(15)
  })

  it('拒绝：调用 reject 并抛 updated', async () => {
    vi.mocked(rejectProposal).mockResolvedValue({ proposal: proposalFixture({ status: 'rejected' }) })

    const wrapper = mount(ProposalCard, {
      props: { proposal: proposalFixture(), catalog },
      global: { stubs },
    })

    const reject = wrapper.findAll('button').find((button) => button.text() === '拒绝')
    await reject?.trigger('click')
    await flushPromises()

    expect(vi.mocked(rejectProposal)).toHaveBeenCalledWith(12)
    expect(wrapper.emitted('updated')?.[0]?.[0]).toMatchObject({ status: 'rejected' })
  })
})

describe('SecretRequestCard（密钥卡）', () => {
  const request: SecretRequestView = {
    id: 'sec_req_1',
    sessionId: 'sess_oncall_1029',
    purpose: '新渠道「DeepSeek 官方」的 API Key',
    capability: 'relay.channels.upsert',
    field: 'apiKey',
    status: 'pending',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  }

  it('用途 / 来源会话 / 能力都写在卡上；提交后清空输入框并抛 updated', async () => {
    vi.mocked(submitSecretRequest).mockResolvedValue(undefined)

    const wrapper = mount(SecretRequestCard, { props: { requestId: request.id, request } })

    expect(wrapper.text()).toContain('DeepSeek 官方')
    expect(wrapper.text()).toContain('sess_oncall_1029')
    expect(wrapper.text()).toContain('relay.channels.upsert')

    const input = wrapper.find('input')
    expect(input.attributes('type')).toBe('password')

    const submit = wrapper.findAll('button').find((button) => button.text() === '提交')
    expect(submit?.attributes('disabled')).toBeDefined()

    await input.setValue('sk-not-a-real-key')
    await submit?.trigger('click')
    await flushPromises()

    expect(vi.mocked(submitSecretRequest)).toHaveBeenCalledWith('sec_req_1', 'sk-not-a-real-key')
    expect(wrapper.emitted('updated')?.[0]?.[0]).toMatchObject({ status: 'filled' })
    // 值不留在前端
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('')
  })

  it('详情没同步到时退化成「只知道 requestId 的输入框」，照样能填', async () => {
    vi.mocked(submitSecretRequest).mockResolvedValue(undefined)
    const wrapper = mount(SecretRequestCard, { props: { requestId: 'sec_req_9' } })

    expect(wrapper.text()).toContain('sec_req_9')
    expect(wrapper.text()).toContain('详情未同步')

    await wrapper.find('input').setValue('sk-degraded')
    const submit = wrapper.findAll('button').find((button) => button.text() === '提交')
    await submit?.trigger('click')
    await flushPromises()

    expect(vi.mocked(submitSecretRequest)).toHaveBeenCalledWith('sec_req_9', 'sk-degraded')
    expect(wrapper.emitted('updated')?.[0]?.[0]).toMatchObject({ id: 'sec_req_9', status: 'filled' })
  })

  it('已填写的卡只显示引用号；取消会调 DELETE', async () => {
    const filled = mount(SecretRequestCard, {
      props: { requestId: request.id, request: { ...request, status: 'filled' } },
    })
    expect(filled.text()).toContain('引用号')
    expect(filled.find('input').exists()).toBe(false)

    vi.mocked(cancelSecretRequest).mockResolvedValue(undefined)
    const pending = mount(SecretRequestCard, { props: { requestId: request.id, request } })
    const cancel = pending.findAll('button').find((button) => button.text() === '取消')
    await cancel?.trigger('click')
    await flushPromises()
    expect(vi.mocked(cancelSecretRequest)).toHaveBeenCalledWith('sec_req_1')
  })
})

describe('CanvasCard（卡片外壳）', () => {
  it('Hub 数据 / DSH 计算角标按数据来源显示；DSH 卡才有钉住与关闭', () => {
    const hub = mount(CanvasCard, {
      props: {
        item: canvasItem({
          id: 'hub-1',
          title: '今日用量',
          origin: 'hub',
          spec: { kind: 'table', columns: [{ key: 'a', label: 'A' }], data: { rows: [] } },
        }),
      },
    })
    expect(hub.text()).toContain('Hub 数据')
    expect(hub.find('[aria-label="关闭这张卡"]').exists()).toBe(false)

    const dsh = mount(CanvasCard, {
      props: {
        item: canvasItem({
          id: 'dsh-1',
          title: 'DSH 算的',
          spec: { kind: 'table', columns: [{ key: 'a', label: 'A' }], data: { rows: [] } },
        }),
      },
    })
    expect(dsh.text()).toContain('DSH 计算')
    expect(dsh.find('[aria-label="关闭这张卡"]').exists()).toBe(true)

    const markdown = mount(CanvasCard, {
      props: { item: canvasItem({ id: 'md-1', title: '说明' }) },
    })
    expect(markdown.find('.canvas-card__kind').text()).toBe('说明')
  })
})

describe('CockpitFrame（postMessage 协议，docs/24 §6）', () => {
  const sessions = [{ id: 'sess_weekly_usage', title: '本周用量', owner: 'admin' }]

  function mountFrame(props: Record<string, unknown> = {}) {
    return mount(CockpitFrame, {
      props: {
        mode: 'placeholder',
        code: null,
        sessionId: null,
        prefill: null,
        sessions,
        placeholderPrefill: '',
        ...props,
      },
    })
  }

  it('拒绝异源消息（形状正确也不行）', async () => {
    const wrapper = mountFrame()

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'cockpit.session', sessionId: 'sess_evil' },
        origin: 'https://evil.example',
        source: window,
      }),
    )
    await flushPromises()

    expect(wrapper.emitted('session')).toBeUndefined()
    wrapper.unmount()
  })

  it('同源消息：session / auth-expired / focus-proposal 都能透出', async () => {
    const wrapper = mountFrame()

    for (const data of [
      { type: 'cockpit.session', sessionId: 'sess_plugin_upgrade' },
      { type: 'cockpit.auth-expired' },
      { type: 'cockpit.focus-proposal', id: 12 },
    ]) {
      window.dispatchEvent(
        new MessageEvent('message', { data, origin: window.location.origin, source: window }),
      )
    }
    await flushPromises()

    expect(wrapper.emitted('session')?.[0]).toEqual(['sess_plugin_upgrade'])
    expect(wrapper.emitted('auth-expired')).toHaveLength(1)
    expect(wrapper.emitted('focus-proposal')?.[0]).toEqual([12])
    wrapper.unmount()
  })

  it('换码时同一个码只发一次（code 的 watch 与 sendHandoff 同时触发，WP57d 交接风暴）', async () => {
    const wrapper = mount(CockpitFrame, {
      attachTo: document.body,
      props: {
        mode: 'iframe',
        code: 'code-boot',
        sessionId: null,
        prefill: null,
        sessions,
        placeholderPrefill: '',
        theme: null,
      },
    })
    const frame = wrapper.find('iframe').element as HTMLIFrameElement
    const target = frame.contentWindow as Window
    const posted = vi.spyOn(target, 'postMessage').mockImplementation(() => undefined)
    const handoffs = () =>
      posted.mock.calls.filter(([message]) => (message as { type?: string }).type === 'cockpit.handoff')

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'cockpit.ready' },
        origin: window.location.origin,
        source: target,
      }),
    )
    await flushPromises()
    // 首个码走 URL hash，不再 postMessage
    expect(handoffs()).toHaveLength(0)

    // OpsAssistantSection.onAuthExpired 的写法：先改 code，再直接 sendHandoff
    await wrapper.setProps({ code: 'code-2' })
    ;(wrapper.vm as unknown as { sendHandoff: (code: string) => void }).sendHandoff('code-2')
    await flushPromises()
    expect(handoffs()).toHaveLength(1)
    expect(handoffs()[0]?.[0]).toEqual({ type: 'cockpit.handoff', code: 'code-2' })

    wrapper.unmount()
  })

  it('占位面板从「航行日志」里选会话：与 iframe 消息走同一份处理逻辑', async () => {
    const wrapper = mountFrame()

    await wrapper.find('[aria-label="航行日志（会话列表）"]').trigger('click')
    await flushPromises()
    const item = wrapper.findAll('.ph__dropdown-item').find((row) => row.text().includes('本周用量'))
    expect(item).toBeTruthy()
    await item?.trigger('click')
    await flushPromises()

    expect(wrapper.emitted('session')?.[0]).toEqual(['sess_weekly_usage'])
    wrapper.unmount()
  })

  it('预填文字进占位面板的输入框', async () => {
    const wrapper = mountFrame({ placeholderPrefill: '追问「本周用量」里的一行。' })
    await flushPromises()
    expect((wrapper.find('.ph__input').element as HTMLTextAreaElement).value).toContain('追问')
    wrapper.unmount()
  })
})

