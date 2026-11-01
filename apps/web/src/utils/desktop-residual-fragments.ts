import type { FragmentRow } from '@/composables/desktop-fragments'
import type { FragmentMode } from '@/utils/desktop-delivery'

/**
 * 「其它配置片段」（docs/22 §1.3 的 DSH 版本 · 桌面侧卡片）。
 *
 * 桌面白名单里的五个条目已经各有归属页：`llm-pi-ai` / `agent-default-model` 归**模型**页、
 * `hub-connector` 归**网络代理**页、两个 pilot 的 `hubMode` 归 **Claude Code / Codex** 页。
 * 剩下的键没人管（pilot 的权限模式、沙箱、默认模型、任务预设、输出上限等），就收在这张卡里。
 *
 * 归属按**键**而不是按条目：同一个 `claude-pilot` 条目由两个页面分别写 `hubMode` 与其余键，
 * 读改写由 `composables/desktop-fragments.ts` 的按键合并保证互不覆盖。
 */

/** 一个可编辑字段的控件类型（形状照契约里的 key 类型，不自由发挥） */
export interface ResidualFieldSpec {
  key: string
  label: string
  kind: 'text' | 'number' | 'switch' | 'select'
  placeholder?: string
  options?: { label: string; value: string }[]
}

export interface ResidualEntrySpec {
  entryId: 'claude-pilot' | 'codex-pilot'
  title: string
  /** 这个条目里**不由本卡接管**的键（其余页面在写） */
  managedElsewhere: readonly string[]
  fields: readonly ResidualFieldSpec[]
}

const VERBOSE: ResidualFieldSpec = { key: 'verbose', label: '详细日志', kind: 'switch' }

/** 两个 pilot 条目里归本卡的键（`hubMode` 除外：那是「桥接」开关，归 Claude Code / Codex 页） */
export const RESIDUAL_ENTRIES: readonly ResidualEntrySpec[] = [
  {
    entryId: 'claude-pilot',
    title: 'Claude Code 模式',
    managedElsewhere: ['hubMode'],
    fields: [
      {
        key: 'permissionMode',
        label: '权限模式',
        kind: 'select',
        options: [
          { label: '跳过权限确认', value: 'bypassPermissions' },
          { label: '自动接受编辑', value: 'acceptEdits' },
          { label: '每次询问', value: 'default' },
          { label: '只读计划', value: 'plan' },
        ],
      },
      { key: 'defaultModel', label: '默认模型', kind: 'text', placeholder: '例如 sonnet' },
      { key: 'defaultEffort', label: '思考档位', kind: 'text', placeholder: '例如 high' },
      { key: 'taskPreset', label: '任务预设', kind: 'text', placeholder: '预设名' },
      { key: 'maxToolResultChars', label: '工具输出上限', kind: 'number', placeholder: '1000 – 1000000' },
      VERBOSE,
    ],
  },
  {
    entryId: 'codex-pilot',
    title: 'Codex 模式',
    managedElsewhere: ['hubMode'],
    fields: [
      {
        key: 'sandbox',
        label: '沙箱',
        kind: 'select',
        options: [
          { label: '完全访问', value: 'danger-full-access' },
          { label: '只写工作区', value: 'workspace-write' },
          { label: '只读', value: 'read-only' },
        ],
      },
      {
        key: 'approvalPolicy',
        label: '审批策略',
        kind: 'select',
        options: [
          { label: '从不询问', value: 'never' },
          { label: '按需询问', value: 'on-request' },
          { label: '不信任', value: 'untrusted' },
        ],
      },
      { key: 'defaultModel', label: '默认模型', kind: 'text', placeholder: '例如 gpt-5-codex' },
      { key: 'defaultEffort', label: '思考档位', kind: 'text', placeholder: '例如 high' },
      { key: 'taskPreset', label: '任务预设', kind: 'text', placeholder: '预设名' },
      { key: 'maxToolResultChars', label: '工具输出上限', kind: 'number', placeholder: '1000 – 1000000' },
      VERBOSE,
    ],
  },
]

/** 本卡接管的条目与键（传给 `useDesktopFragments` 的接管范围） */
export const RESIDUAL_SELECTION_KEYS: Record<string, readonly string[]> = Object.fromEntries(
  RESIDUAL_ENTRIES.map((entry) => [entry.entryId, entry.fields.map((field) => field.key)]),
)
export const RESIDUAL_ENTRY_IDS: readonly string[] = RESIDUAL_ENTRIES.map((entry) => entry.entryId)

/** 一个字段的草稿值（switch 是布尔，其余是字符串，空串 = 未填） */
export type ResidualFieldValue = string | boolean

export interface ResidualDraft {
  enabled: boolean
  mode: FragmentMode
  values: Record<string, ResidualFieldValue>
}

const NUMBER_MIN = 1_000
const NUMBER_MAX = 1_000_000

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * 已下发的条目配置 → 表单草稿（只关心本卡接管的键）。
 * `mode` 用条目**现在**的值：本卡不负责「强制 / 默认」（那是桥接开关所在页的语义），
 * 不传时缺省 enforce 只影响本卡新建的条目。
 */
export function residualDraftOf(
  entry: ResidualEntrySpec,
  config: Record<string, unknown>,
  mode: FragmentMode = 'enforce',
): ResidualDraft {
  const values: Record<string, ResidualFieldValue> = {}
  for (const field of entry.fields) {
    const raw = config[field.key]
    if (field.kind === 'switch') {
      values[field.key] = raw === true
      continue
    }
    values[field.key] = asText(raw)
  }
  return {
    // 「本卡配置过」= 接管的键里至少有一个出现在片段里（条目可能只被别的页面写过 hubMode）
    enabled: entry.fields.some((field) => field.key in config),
    mode,
    values,
  }
}

/** 表单草稿 + 条目已有片段的 mode → 这次要写的行（空配置不写） */
export function residualRowOf(
  entry: ResidualEntrySpec,
  draft: ResidualDraft,
  mode?: FragmentMode,
): { row: FragmentRow | null; errors: string[] } {
  const errors: string[] = []
  const config: Record<string, unknown> = {}

  for (const field of entry.fields) {
    const value = draft.values[field.key]
    if (field.kind === 'switch') {
      if (value === true) config[field.key] = true
      continue
    }
    const text = typeof value === 'string' ? value.trim() : ''
    if (text === '') continue
    if (field.kind === 'number') {
      const parsed = Number(text)
      if (!Number.isInteger(parsed) || parsed < NUMBER_MIN || parsed > NUMBER_MAX) {
        errors.push(`${field.label}：填 ${String(NUMBER_MIN)} – ${String(NUMBER_MAX)} 之间的整数`)
        continue
      }
      config[field.key] = parsed
      continue
    }
    config[field.key] = text
  }

  if (!draft.enabled) return { row: null, errors }
  if (Object.keys(config).length === 0 && errors.length === 0) {
    errors.push(`${entry.title}：开关打开了，但一项都没填`)
  }
  if (Object.keys(config).length === 0) return { row: null, errors }
  return { row: { entryId: entry.entryId, mode: mode ?? draft.mode, config }, errors }
}

/** 这次要写哪些行（两个条目一起；开关关掉的条目不出现在结果里 = 从清单里去掉这些键） */
export function residualRowsOf(
  drafts: Record<string, ResidualDraft>,
  modes: Record<string, FragmentMode> = {},
): { rows: FragmentRow[]; errors: string[] } {
  const rows: FragmentRow[] = []
  const errors: string[] = []
  for (const entry of RESIDUAL_ENTRIES) {
    const draft = drafts[entry.entryId]
    if (!draft) continue
    const built = residualRowOf(entry, draft, modes[entry.entryId] ?? draft.mode)
    errors.push(...built.errors)
    if (built.row) rows.push(built.row)
  }
  return { rows, errors }
}
