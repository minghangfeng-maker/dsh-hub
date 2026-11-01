import { describe, expect, it } from 'vitest'
import type { ChatEntry, ThreadItem, ToolCard } from '@dsh-hub/mobile-core'
import {
  activityDurationMs,
  activityErrorCount,
  activityHeadline,
  activityIcon,
  activityKeyAfter,
  activityToolCount,
  activityTotalMs,
  buildConversationBlocks,
  durationText,
  latestSentence,
  LIVE_LABEL,
  liveStatus,
  turnCitations,
  type ActivityRow,
  type LiveActivity,
} from '@/lib/activity'

function entry(overrides: Partial<ChatEntry>): ChatEntry {
  return {
    seq: 1,
    localId: null,
    role: 'assistant',
    text: '',
    tools: [],
    at: 1,
    pending: false,
    failed: false,
    unknown: false,
    ...overrides,
  }
}

function card(overrides: Partial<ToolCard>): ToolCard {
  return {
    callId: 'c1',
    sessionId: 's1',
    kind: 'bash',
    name: 'bash',
    title: '运行命令',
    phase: 'end',
    status: 'ok',
    seq: 1,
    turn: 1,
    step: 1,
    inputPreview: 'ls',
    files: [],
    citations: [],
    ...overrides,
  }
}

function item(seq: number, value: ChatEntry): ThreadItem {
  return { kind: 'message', key: `seq-${String(seq)}`, seq, entry: value }
}

function tool(key: string, seq: number, overrides: Partial<ToolCard> = {}): ThreadItem {
  return { kind: 'tool', key, seq, card: card({ callId: key, ...overrides }) }
}

const IDLE: LiveActivity = {
  turnRunning: false,
  streamingReasoning: '',
  reasoningDone: false,
  hasStreamingText: false,
}

function live(overrides: Partial<LiveActivity>): LiveActivity {
  return { ...IDLE, turnRunning: true, ...overrides }
}

function activityKeys(blocks: ReturnType<typeof buildConversationBlocks>): string[] {
  return blocks.filter((block) => block.kind === 'activity').map((block) => block.key)
}

function lastActivity(blocks: ReturnType<typeof buildConversationBlocks>) {
  const block = blocks[blocks.length - 1]
  if (block?.kind !== 'activity') throw new Error('期望最后一块是过程行')
  return block
}

describe('过程行分组（0.4.0 §2）', () => {
  it('思考 + 工具连续出现 → 一个过程行；用户/正文消息是边界', () => {
    const blocks = buildConversationBlocks([
      item(1, entry({ role: 'user', text: '画图' })),
      item(2, entry({ reasoning: '先想想' })),
      tool('tool-a', 3),
      tool('tool-b', 4, { inputPreview: 'python x.py' }),
      item(5, entry({ text: '画好了' })),
    ])
    expect(blocks.map((block) => block.kind)).toEqual(['item', 'activity', 'item'])
    const activity = blocks[1]
    if (activity?.kind !== 'activity') throw new Error('期望过程行')
    expect(activity.rows.map((row) => row.kind)).toEqual(['reasoning', 'tool', 'tool'])
  })

  it('只有正文的助手消息不过程化；交付物也是边界', () => {
    const blocks = buildConversationBlocks([
      item(1, entry({ reasoning: '想' })),
      item(2, entry({ text: '答' })),
      {
        kind: 'deliverable',
        key: 'deliverable-x',
        seq: 3,
        item: { sessionId: 's1', seq: 3, turn: 1, callId: 'x', files: [] },
      },
    ])
    expect(blocks.map((block) => block.kind)).toEqual(['activity', 'item', 'item'])
  })

  it('块 key 以前一个边界条目派生（不再用第一行的 key）', () => {
    const blocks = buildConversationBlocks([
      item(1, entry({ role: 'user', text: '问题' })),
      item(2, entry({ reasoning: '想' })),
      tool('tool-a', 3),
    ])
    expect(activityKeys(blocks)).toEqual([activityKeyAfter('seq-1')])
  })

  it('先思考、再工具、再思考：块的数量与 key 全程不变', () => {
    // ① 实时思考（第一条还没落库）
    const first = buildConversationBlocks(
      [item(1, entry({ role: 'user', text: '查一下' }))],
      live({ streamingReasoning: '先看看上下文' }),
    )
    expect(activityKeys(first)).toEqual([activityKeyAfter('seq-1')])

    // ② 第一条思考落库
    const second = buildConversationBlocks(
      [
        item(1, entry({ role: 'user', text: '查一下' })),
        item(2, entry({ reasoning: '先看看上下文' })),
      ],
      live({}),
    )
    expect(activityKeys(second)).toEqual([activityKeyAfter('seq-1')])

    // ③ 工具开始 / 结束
    const third = buildConversationBlocks(
      [
        item(1, entry({ role: 'user', text: '查一下' })),
        item(2, entry({ reasoning: '先看看上下文' })),
        tool('tool-search', 3, { kind: 'search', phase: 'start', status: 'running' }),
      ],
      live({}),
    )
    expect(activityKeys(third)).toEqual([activityKeyAfter('seq-1')])

    // ④ 第二次思考（实时，第二条还没落库）
    const fourth = buildConversationBlocks(
      [
        item(1, entry({ role: 'user', text: '查一下' })),
        item(2, entry({ reasoning: '先看看上下文' })),
        tool('tool-search', 3, { kind: 'search', citations: [{ title: 'a', url: 'u' }] }),
      ],
      live({ streamingReasoning: '再确认一下来源' }),
    )
    expect(activityKeys(fourth)).toEqual([activityKeyAfter('seq-1')])
    const rows = lastActivity(fourth).rows
    expect(rows.map((row) => row.kind)).toEqual(['reasoning', 'tool', 'reasoning'])
    expect(rows[rows.length - 1]).toMatchObject({ live: true, text: '再确认一下来源' })

    // ⑤ 第二条思考也落库 → 同一个块，行 key 从实时行换成条目 key（允许）
    const fifth = buildConversationBlocks(
      [
        item(1, entry({ role: 'user', text: '查一下' })),
        item(2, entry({ reasoning: '先看看上下文' })),
        tool('tool-search', 3, { kind: 'search', citations: [{ title: 'a', url: 'u' }] }),
        item(4, entry({ reasoning: '再确认一下来源' })),
      ],
      live({}),
    )
    expect(activityKeys(fifth)).toEqual([activityKeyAfter('seq-1')])
    expect(lastActivity(fifth).rows.map((row) => row.key)).toEqual(['seq-2', 'tool-search', 'seq-4'])
  })

  it('实时思考落库前后：块 key 不变，行 key 变化可接受', () => {
    const base = [item(1, entry({ role: 'user', text: '想个方案' }))]
    const before = buildConversationBlocks(base, live({ streamingReasoning: '先拆问题' }))
    const beforeBlock = lastActivity(before)
    expect(beforeBlock.key).toBe(activityKeyAfter('seq-1'))
    expect(beforeBlock.rows.map((row) => row.key)).toEqual(['live-reasoning'])

    const after = buildConversationBlocks(
      [...base, item(2, entry({ reasoning: '先拆问题' }))],
      live({}),
    )
    const afterBlock = lastActivity(after)
    expect(afterBlock.key).toBe(beforeBlock.key)
    expect(afterBlock.rows.map((row) => row.key)).toEqual(['seq-2'])
  })

  it('回合结束后：实时行消失，被真实条目取代', () => {
    const running = buildConversationBlocks(
      [item(1, entry({ role: 'user', text: '问' }))],
      live({ streamingReasoning: '想着呢' }),
    )
    expect(lastActivity(running).live).toBe(true)

    const done = buildConversationBlocks(
      [
        item(1, entry({ role: 'user', text: '问' })),
        item(2, entry({ reasoning: '想着呢' })),
        item(3, entry({ text: '答完了' })),
      ],
      IDLE,
    )
    expect(done.map((block) => block.kind)).toEqual(['item', 'activity', 'item'])
    const activity = done[1]
    if (activity?.kind !== 'activity') throw new Error('期望过程行')
    expect(activity.live).toBe(false)
    expect(activity.rows.map((row) => row.key)).toEqual(['seq-2'])
    expect(done.some((block) => block.kind === 'activity' && block.live)).toBe(false)
  })

  it('回合刚开始（还没有任何事件）时给同一位置的「思考中」占位行', () => {
    const blocks = buildConversationBlocks(
      [item(1, entry({ role: 'user', text: '开始' }))],
      live({}),
    )
    expect(blocks.map((block) => block.kind)).toEqual(['item', 'activity'])
    const placeholder = lastActivity(blocks)
    expect(placeholder.key).toBe(activityKeyAfter('seq-1'))
    expect(placeholder.live).toBe(true)
    expect(placeholder.rows).toEqual([])
    // 0.4.9：运行中左侧固定「正在深度求索中…」，右侧没有状态就留空（不再兜底「思考中」）
    expect(activityHeadline(placeholder.rows, { live: true })).toBe('')
    expect(liveStatus(placeholder.rows)).toBe('')
    // 落库后占位行的 key 与真实条目的块 key 相同
    const persisted = buildConversationBlocks(
      [item(1, entry({ role: 'user', text: '开始' })), item(2, entry({ reasoning: '想' }))],
      IDLE,
    )
    expect(activityKeys(persisted)).toEqual([placeholder.key])
  })

  it('正文开始输出后不再把实时思考并进过程行（正文永远在过程行下方）', () => {
    const blocks = buildConversationBlocks(
      [
        item(1, entry({ role: 'user', text: '问' })),
        item(2, entry({ reasoning: '想' })),
      ],
      live({ streamingReasoning: '又想了一下', hasStreamingText: true }),
    )
    expect(blocks.map((block) => block.kind)).toEqual(['item', 'activity'])
    const activity = blocks[1]
    if (activity?.kind !== 'activity') throw new Error('期望过程行')
    expect(activity.live).toBe(false)
    expect(activity.rows.map((row) => row.key)).toEqual(['seq-2'])
  })

  it('耗时只累加工具，reasoning 不计时', () => {
    const rows: ActivityRow[] = [
      { kind: 'reasoning', key: 'r', text: '想', live: false },
      { kind: 'tool', key: 't1', card: card({ callId: 't1', durationMs: 1200 }) },
      { kind: 'tool', key: 't2', card: card({ callId: 't2', durationMs: 800 }) },
    ]
    expect(activityDurationMs(rows)).toBe(2000)
    expect(activityToolCount(rows)).toBe(2)
    expect(activityErrorCount(rows)).toBe(0)
  })
})

describe('过程行摘要（折叠态单行）', () => {
  const reasoningRow: ActivityRow = { kind: 'reasoning', key: 'r', text: '想', live: false }
  const searchRow: ActivityRow = {
    kind: 'tool',
    key: 'search',
    card: card({ kind: 'search', citations: [{ title: 'a', url: 'u1' }, { title: 'b', url: 'u2' }] }),
  }

  it('运行中取当前步骤：工具优先，其次最新一句思考，都没有就留空（0.4.9 不再兜底）', () => {
    const running: ActivityRow = {
      kind: 'tool',
      key: 'running',
      card: card({ phase: 'start', status: 'running', kind: 'bash', inputPreview: 'pnpm test' }),
    }
    expect(activityHeadline([reasoningRow, running], { live: true })).toContain('pnpm test')
    expect(
      activityHeadline([{ kind: 'reasoning', key: 'live', text: '第一句。最后一个想法', live: true }], {
        live: true,
      }),
    ).toBe('最后一个想法')
    expect(activityHeadline([], { live: true })).toBe('')
  })

  it('完成后给结果：单个工具用工具摘要，多个工具累计，只有思考用秒数', () => {
    expect(activityHeadline([searchRow], { live: false })).toBe('搜索了 2 个网页')
    expect(
      activityHeadline(
        [searchRow, { kind: 'tool', key: 't2', card: card({ callId: 't2', durationMs: 15800 }) }],
        { live: false },
      ),
    ).toBe('执行了 2 个操作')
    expect(activityHeadline([reasoningRow], { live: false, elapsedMs: 12_400 })).toBe('思考了 12 秒')
    expect(activityHeadline([reasoningRow], { live: false })).toBe('思考过程')
  })

  it('出错时单独数错误（红色角标由组件渲染）', () => {
    const rows: ActivityRow[] = [
      searchRow,
      { kind: 'tool', key: 'bad', card: card({ status: 'error' }) },
    ]
    expect(activityErrorCount(rows)).toBe(1)
  })

  it('图标跟着摘要走：思考时钟 / 搜索地球 / 命令终端 / 文件文档', () => {
    expect(activityIcon([reasoningRow])).toBe('clock')
    expect(activityIcon([searchRow])).toBe('search')
    expect(activityIcon([{ kind: 'tool', key: 'b', card: card({ kind: 'bash' }) }])).toBe('terminal')
    expect(activityIcon([{ kind: 'tool', key: 'f', card: card({ kind: 'file-read' }) }])).toBe('file')
  })

  it('思考取最新一句并截到 30 字；耗时文案 <1s 用 ms', () => {
    expect(latestSentence('第一句。第二句，还没说完', 30)).toBe('第二句，还没说完')
    expect(latestSentence('一二三四五六七八九十', 4)).toBe('一二三四')
    expect(latestSentence('   ', 30)).toBe('')
    expect(durationText(860)).toBe('860ms')
    expect(durationText(15_800)).toBe('15.8 秒')
    expect(durationText(0)).toBe('')
  })
})

/**
 * 0.4.9 运行中的头部：左侧固定「正在深度求索中」+ 动态省略号，右侧当前状态。
 *
 * 规则：
 *  - 左侧文案是常量 `LIVE_LABEL`，**不带**省略号（省略号是 CSS 画的，减少动效时换成静态「…」）；
 *  - 右侧状态：正在跑的工具优先，其次最新一句思考；两者都没有时是空串——
 *    不能再兜底「思考中」，否则会显示成「正在深度求索中… 思考中」；
 *  - 状态只放一句，超长交给 CSS 省略号截断（单行、占剩余宽度）。
 */
describe('运行中头部：固定文案 + 当前状态（0.4.9）', () => {
  const think: ActivityRow = {
    kind: 'reasoning',
    key: 'live',
    text: '先看看时间线。再看一下过程行的位置',
    live: true,
  }

  it('左侧文案是常量，且不带省略号（省略号由 CSS 画）', () => {
    expect(LIVE_LABEL).toBe('正在深度求索中')
    expect(LIVE_LABEL).not.toContain('…')
    expect(LIVE_LABEL).not.toContain('...')
  })

  it('工具优先于思考：正在跑的工具摘要盖过最新一句思考', () => {
    const running: ActivityRow = {
      kind: 'tool',
      key: 'run',
      card: card({ phase: 'start', status: 'running', kind: 'search', inputPreview: 'DSH Hub 手机通道' }),
    }
    expect(liveStatus([think, running])).toContain('DSH Hub 手机通道')
    // 工具在前在后都以「正在跑的工具」为准（最后一张 running 卡）
    expect(liveStatus([running, think])).toContain('DSH Hub 手机通道')
  })

  it('没有工具时取最新一句思考（只一句，不含上一句）', () => {
    expect(liveStatus([think])).toBe('再看一下过程行的位置')
    expect(liveStatus([think])).not.toContain('先看看时间线')
  })

  it('兜底时右侧为空：不出现「思考中」，也不重复左侧文案', () => {
    expect(liveStatus([])).toBe('')
    expect(activityHeadline([], { live: true })).toBe('')
    // 工具已经结束、又没有实时思考：也没东西可说 → 留空
    expect(liveStatus([{ kind: 'tool', key: 'done', card: card({ status: 'ok' }) }])).toBe('')
    // 拼起来只有文案本身，不会变成「正在深度求索中… 思考中」
    expect([LIVE_LABEL, liveStatus([])].join('').trim()).toBe(LIVE_LABEL)
    expect([LIVE_LABEL, liveStatus([])].join('')).not.toContain('思考中')
  })
})

/**
 * 0.4.0 收尾打磨：完成态标题的三种规则 + 右侧灰色总耗时。
 *
 * 规则（设计文档 §2.2 + 本次打磨）：
 *  - 只有思考 →「思考了 N 秒」；
 *  - 思考 + 1 个工具 → 该工具的结果摘要；
 *  - ≥2 个工具 →「执行了 N 个操作」；
 *  - 头部不再拼耗时，总耗时单独交给右侧灰字（`activityTotalMs`）。
 * 折叠与展开共用同一份 `activityHeadline` / `activityTotalMs`，所以规则对两种状态一致。
 */
describe('过程行完成态标题与总耗时（0.4.0 打磨）', () => {
  const think: ActivityRow = { kind: 'reasoning', key: 'r1', text: '先看一眼数据', live: false }
  const search = (callId: string, durationMs?: number): ActivityRow => ({
    kind: 'tool',
    key: callId,
    card: card({
      callId,
      kind: 'search',
      ...(durationMs === undefined ? {} : { durationMs }),
      citations: [
        { title: 'a', url: `https://a/${callId}` },
        { title: 'b', url: `https://b/${callId}` },
        { title: 'c', url: `https://c/${callId}` },
      ],
    }),
  })

  it('只有思考：标题就是「思考了 N 秒」（秒数四舍五入，最少 1 秒）', () => {
    expect(activityHeadline([think], { live: false, elapsedMs: 4200 })).toBe('思考了 4 秒')
    expect(activityHeadline([think], { live: false, elapsedMs: 12_400 })).toBe('思考了 12 秒')
    expect(activityHeadline([think], { live: false, elapsedMs: 300 })).toBe('思考了 1 秒')
    // 历史会话没有实时窗口：退回「思考过程」，不编造秒数
    expect(activityHeadline([think], { live: false, elapsedMs: null })).toBe('思考过程')
  })

  it('思考 + 1 个工具：标题是该工具的结果摘要（不出现「思考了」）', () => {
    expect(activityHeadline([think, search('s1')], { live: false, elapsedMs: 4200 })).toBe(
      '搜索了 3 个网页',
    )
  })

  it('≥2 个工具：标题是「执行了 N 个操作」，耗时不再拼进标题', () => {
    const rows = [think, search('s1', 4000), search('s2', 11_800)]
    const headline = activityHeadline(rows, { live: false, elapsedMs: 20_000 })
    expect(headline).toBe('执行了 2 个操作')
    expect(headline).not.toContain('秒')
  })

  it('右侧总耗时：有实时窗口用窗口（含思考与等待），否则用工具耗时之和', () => {
    expect(activityTotalMs([think, search('s1', 4000)], 4200)).toBe(4200)
    expect(activityTotalMs([think, search('s1', 4000), search('s2', 11_800)], null)).toBe(15_800)
    expect(activityTotalMs([think, search('s1', 4000)], null)).toBe(4000)
  })

  it('只有思考时不重复显示右侧耗时（头部已经有「思考了 N 秒」）', () => {
    expect(activityTotalMs([think], 4200)).toBe(0)
    expect(durationText(activityTotalMs([think], 4200))).toBe('')
  })

  it('工具没有耗时信息时不显示右侧耗时（不显示 0 秒）', () => {
    expect(activityTotalMs([search('s1')], null)).toBe(0)
  })

  it('运行中仍然给「当前步骤」，总耗时等这一块结束再算', () => {
    const running: ActivityRow = {
      kind: 'tool',
      key: 'run',
      card: card({ phase: 'start', status: 'running', kind: 'bash', inputPreview: 'pnpm test' }),
    }
    expect(activityHeadline([think, running], { live: true })).toContain('pnpm test')
    expect(activityTotalMs([think, running], null)).toBe(0)
  })
})

describe('本轮引用来源', () => {
  it('收集本轮过程行里的来源，按时间线顺序去重、遇到用户消息停', () => {
    const blocks = buildConversationBlocks([
      item(1, entry({ role: 'user', text: '第一问' })),
      tool('tool-a', 2, { kind: 'search', citations: [{ title: 'A', url: 'u1' }] }),
      item(3, entry({ text: '回答一' })),
      item(4, entry({ role: 'user', text: '第二问' })),
      tool('tool-b', 5, {
        kind: 'search',
        citations: [
          { title: 'A', url: 'u1' },
          { title: 'B', url: 'u2' },
        ],
      }),
      item(6, entry({ text: '回答二' })),
    ])
    const secondAnswerIndex = blocks.findIndex((block) => block.kind === 'item' && block.key === 'seq-6')
    expect(turnCitations(blocks, secondAnswerIndex)).toEqual([
      { title: 'A', url: 'u1' },
      { title: 'B', url: 'u2' },
    ])
    const firstAnswerIndex = blocks.findIndex((block) => block.kind === 'item' && block.key === 'seq-3')
    expect(turnCitations(blocks, firstAnswerIndex)).toEqual([{ title: 'A', url: 'u1' }])
  })
})
