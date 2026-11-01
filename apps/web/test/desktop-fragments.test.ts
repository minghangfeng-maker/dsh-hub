import type { DesktopConfigFragmentView, DesktopDeliveryTarget } from '@dsh-hub/shared'
import { describe, expect, it } from 'vitest'

import {
  configOf,
  fragmentsOfTarget,
  mergeFragments,
  pickKeys,
  rowsFor,
  scopeOfFragmentTarget,
  stripKeys,
  toFragmentInputs,
  type FragmentRow,
} from '@/composables/desktop-fragments'

/**
 * 桌面配置片段的读改写（WP32b）：一个白名单条目的不同键分属不同页面，
 * 保存又是整体替换 —— 这里锁住「只改自己接管的条目 / 键，其余一字不动」。
 */

const ALL: DesktopDeliveryTarget = { scope: 'all' }

function view(
  entryId: string,
  mode: 'enforce' | 'default',
  config: Record<string, unknown>,
  scope: { scope: 'all' | 'role' | 'user'; role?: 'admin' | 'user' | null; userId?: number | null } = {
    scope: 'all',
  },
): DesktopConfigFragmentView {
  return {
    id: 1,
    entryId,
    mode,
    config,
    note: '',
    scope: scope.scope,
    role: scope.role ?? null,
    userId: scope.userId ?? null,
  }
}

const ROWS: FragmentRow[] = [
  { entryId: 'llm-pi-ai', mode: 'enforce', config: { providers: { hub: { displayName: 'Hub' } } } },
  { entryId: 'claude-pilot', mode: 'default', config: { hubMode: true, permissionMode: 'plan', verbose: false } },
  { entryId: 'hub-connector', mode: 'enforce', config: { hubProxy: { http: 'http://127.0.0.1:7890' } } },
]

describe('fragmentsOfTarget', () => {
  it('只取当前目标的片段，其它目标（角色 / 用户）的过滤掉', () => {
    const fragments = [
      view('claude-pilot', 'enforce', { hubMode: true }),
      view('claude-pilot', 'default', { hubMode: false }, { scope: 'role', role: 'admin' }),
      view('codex-pilot', 'enforce', { hubMode: true }, { scope: 'user', userId: 7 }),
    ]
    expect(fragmentsOfTarget(fragments, ALL).map((row) => row.entryId)).toEqual(['claude-pilot'])
    expect(fragmentsOfTarget(fragments, { scope: 'role', role: 'admin' }).map((row) => row.entryId)).toEqual([
      'claude-pilot',
    ])
    expect(fragmentsOfTarget(fragments, { scope: 'user', userId: 7 }).map((row) => row.entryId)).toEqual([
      'codex-pilot',
    ])
  })

  it('目标没选定（指定用户没选人）时读不到任何片段', () => {
    expect(fragmentsOfTarget([view('claude-pilot', 'enforce', { hubMode: true })], null)).toEqual([])
  })

  it('作用域键与片段行的 scope / role / userId 口径一致', () => {
    expect(scopeOfFragmentTarget(null)).toBeNull()
    expect(scopeOfFragmentTarget(ALL)).toEqual({ scope: 'all', role: null, userId: null })
    expect(scopeOfFragmentTarget({ scope: 'role', role: 'user' })).toEqual({
      scope: 'role',
      role: 'user',
      userId: null,
    })
    expect(scopeOfFragmentTarget({ scope: 'user', userId: 3 })).toEqual({
      scope: 'user',
      role: null,
      userId: 3,
    })
  })
})

describe('rowsFor / configOf', () => {
  it('按条目 id 过滤，整个条目接管时原样返回', () => {
    const rows = rowsFor(ROWS, { entryIds: ['claude-pilot'] })
    expect(rows).toEqual([ROWS[1]])
  })

  it('只接管部分键时只读这几个键', () => {
    const rows = rowsFor(ROWS, { entryIds: ['claude-pilot'], keys: { 'claude-pilot': ['hubMode'] } })
    expect(rows).toEqual([{ entryId: 'claude-pilot', mode: 'default', config: { hubMode: true } }])
    expect(configOf(ROWS, { entryIds: ['claude-pilot'], keys: { 'claude-pilot': ['hubMode'] } }, 'claude-pilot')).toEqual(
      { hubMode: true },
    )
  })

  it('没下发过的条目读出来是空对象', () => {
    expect(configOf(ROWS, { entryIds: ['codex-pilot'] }, 'codex-pilot')).toEqual({})
  })

  it('pickKeys / stripKeys 互逆（整个条目接管时 strip 成全空）', () => {
    const config = { hubMode: true, permissionMode: 'plan' }
    expect(pickKeys(config, ['hubMode'])).toEqual({ hubMode: true })
    expect(stripKeys(config, ['hubMode'])).toEqual({ permissionMode: 'plan' })
    expect(stripKeys(config, undefined)).toEqual({})
  })
})

describe('mergeFragments', () => {
  it('只改接管的条目，其它片段（含顺序）一字不动', () => {
    const merged = mergeFragments(
      ROWS,
      [{ entryId: 'claude-pilot', mode: 'enforce', config: { hubMode: false } }],
      { entryIds: ['claude-pilot'] },
    )
    expect(merged).toEqual([
      ROWS[0],
      { entryId: 'claude-pilot', mode: 'enforce', config: { hubMode: false } },
      ROWS[2],
    ])
  })

  it('只接管 hubMode 时，条目里其它键保留、mode 用这次的', () => {
    const merged = mergeFragments(
      ROWS,
      [{ entryId: 'claude-pilot', mode: 'enforce', config: { hubMode: false } }],
      { entryIds: ['claude-pilot'], keys: { 'claude-pilot': ['hubMode'] } },
    )
    expect(merged[1]).toEqual({
      entryId: 'claude-pilot',
      mode: 'enforce',
      config: { hubMode: false, permissionMode: 'plan', verbose: false },
    })
  })

  it('这次没给的条目：整个接管时删掉，只接管部分键时保留其它键', () => {
    const whole = mergeFragments(ROWS, [], { entryIds: ['claude-pilot'] })
    expect(whole.map((row) => row.entryId)).toEqual(['llm-pi-ai', 'hub-connector'])

    const partial = mergeFragments(ROWS, [], {
      entryIds: ['claude-pilot'],
      keys: { 'claude-pilot': ['hubMode', 'permissionMode', 'verbose'] },
    })
    expect(partial.map((row) => row.entryId)).toEqual(['llm-pi-ai', 'hub-connector'])
  })

  it('新条目追加在末尾，重复条目不会出现两次', () => {
    const merged = mergeFragments(
      ROWS,
      [
        { entryId: 'codex-pilot', mode: 'enforce', config: { hubMode: true } },
        { entryId: 'codex-pilot', mode: 'default', config: { hubMode: false } },
      ],
      { entryIds: ['codex-pilot'] },
    )
    expect(merged.map((row) => row.entryId)).toEqual(['llm-pi-ai', 'claude-pilot', 'hub-connector', 'codex-pilot'])
    expect(merged.at(-1)?.mode).toBe('default')
  })

  it('接管的条目内容清空后不会以空对象发出去', () => {
    const merged = mergeFragments(
      ROWS,
      [{ entryId: 'claude-pilot', mode: 'enforce', config: {} }],
      { entryIds: ['claude-pilot'] },
    )
    expect(merged.map((row) => row.entryId)).toEqual(['llm-pi-ai', 'hub-connector'])
  })

  it('入参里不属于接管的条目被忽略（不会误改别的条目）', () => {
    const merged = mergeFragments(
      ROWS,
      [
        { entryId: 'llm-pi-ai', mode: 'default', config: { providers: {} } },
        { entryId: 'claude-pilot', mode: 'enforce', config: { hubMode: false } },
      ],
      { entryIds: ['claude-pilot'] },
    )
    expect(merged[0]).toEqual(ROWS[0])
    expect(merged[1]).toEqual({ entryId: 'claude-pilot', mode: 'enforce', config: { hubMode: false } })
    expect(merged[2]).toEqual(ROWS[2])
  })
})

describe('toFragmentInputs', () => {
  it('entryId → id，过契约（重复 id 由契约层拒绝）', () => {
    expect(toFragmentInputs([{ entryId: 'claude-pilot', mode: 'enforce', config: { hubMode: true } }])).toEqual([
      { id: 'claude-pilot', mode: 'enforce', config: { hubMode: true } },
    ])
  })
})
