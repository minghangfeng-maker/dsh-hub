import type {
  DesktopConfigFragmentInput,
  DesktopConfigFragmentView,
  DesktopDeliverResponse,
  DesktopDeliveryScope,
  DesktopDeliveryState,
  DesktopDeliveryTarget,
} from '@dsh-hub/shared'
import { computed, ref, type ComputedRef, type Ref } from 'vue'

import { deliverDesktopConfig } from '@/api/admin-desktop'
import { withReauth } from '@/composables/useReauth'
import { validateConfigRequest, type FragmentMode } from '@/utils/desktop-delivery'

/**
 * 桌面配置片段的**按条目读改写**（docs/22 §1.3：一个白名单条目的不同键分属不同页面）。
 *
 * 接口 `PUT /api/admin/desktop/config` 是**整体替换**某个目标的片段集合 —— 哪个页面都不能假装
 * 「这个目标只有我在管的那几条」，否则保存一次就把别的页面写的片段冲掉了。于是：
 *
 * - **读**：`rowsFor()` 只取本次接管的条目（以及条目里接管的键），别的片段不碰；
 * - **改**：`mergeFragments()` 把这次要写的 rows 合并回该目标的**全部**片段 ——
 *   接管的条目整体替换（只接管部分键时，条目里其余键原样保留），没接管的条目一字不改；
 * - **写**：`useDesktopFragments().save()` 合并后整体过一遍契约再提交。
 *
 * 接管范围用 {@link FragmentSelection} 描述：`entryIds` 是白名单条目 id；`keys` 可选，
 * 给某个条目时只接管它的这些顶层键（例如 `claude-pilot` 的 `hubMode` 归「Claude Code」页，
 * 其余键归「DSH 版本 · 其它配置片段」）。
 *
 * 全部核心逻辑是纯函数，可直接单测；composable 只负责把当前目标的片段接起来并提交。
 */

export type { FragmentMode }

/** 一条片段（纯数据：作用域已经由调用方按目标筛过） */
export interface FragmentRow {
  entryId: string
  mode: FragmentMode
  config: Record<string, unknown>
}

/** 本次接管哪些条目 / 条目里的哪些键 */
export interface FragmentSelection {
  /** 接管的条目 id（白名单里的） */
  entryIds: readonly string[]
  /**
   * 条目 → 只接管的顶层键。缺省（或条目没有列在这里）= **整个条目**都归本次接管。
   * 列了键的条目：条目里这些键由本次改写，其余键原样保留（条目里被清空时整条不发）。
   */
  keys?: Readonly<Record<string, readonly string[]>>
}

/** 保存被本地校验拦下（契约不合 / 一条都没写）时抛这个，`errors` 直接展示给管理员 */
export class FragmentValidationError extends Error {
  readonly errors: string[]

  constructor(errors: string[]) {
    super(errors[0] ?? '配置片段不合法')
    this.name = 'FragmentValidationError'
    this.errors = errors
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 目标的稳定键（和 `utils/desktop-delivery.ts` 的 `scopeKey` 同一个口径） */
function scopeKeyOf(scope: DesktopDeliveryScope): string {
  if (scope.scope === 'all') return 'all'
  if (scope.scope === 'role') return `role:${scope.role ?? ''}`
  return `user:${String(scope.userId ?? '')}`
}

/** 契约里的目标 → 作用域（片段行按作用域存） */
export function scopeOfFragmentTarget(target: DesktopDeliveryTarget | null): DesktopDeliveryScope | null {
  if (!target) return null
  if (target.scope === 'all') return { scope: 'all', role: null, userId: null }
  if (target.scope === 'role') return { scope: 'role', role: target.role, userId: null }
  return { scope: 'user', role: null, userId: target.userId }
}

/** 期望状态 + 目标 → 该目标已有的片段行（其它目标的过滤掉，认不出的条目保留原样） */
export function fragmentsOfTarget(
  fragments: readonly DesktopConfigFragmentView[] | undefined,
  target: DesktopDeliveryTarget | null,
): FragmentRow[] {
  const scope = scopeOfFragmentTarget(target)
  if (!scope) return []
  const key = scopeKeyOf(scope)
  return (fragments ?? [])
    .filter((fragment) => scopeKeyOf(fragment) === key)
    .map((fragment) => ({
      entryId: fragment.entryId,
      mode: fragment.mode,
      config: isRecord(fragment.config) ? fragment.config : {},
    }))
}

function keysOf(selection: FragmentSelection, entryId: string): readonly string[] | undefined {
  return selection.keys?.[entryId]
}

/** 只留这些键（`keys` 缺省 = 原样整份） */
export function pickKeys(
  config: Record<string, unknown>,
  keys: readonly string[] | undefined,
): Record<string, unknown> {
  if (!keys) return { ...config }
  const picked: Record<string, unknown> = {}
  for (const key of keys) {
    if (key in config) picked[key] = config[key]
  }
  return picked
}

/** 去掉这些键（`keys` 缺省 = 整个条目都不留，返回空对象） */
export function stripKeys(
  config: Record<string, unknown>,
  keys: readonly string[] | undefined,
): Record<string, unknown> {
  if (!keys) return {}
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (!keys.includes(key)) rest[key] = value
  }
  return rest
}

/** 本次接管的片段行（读：只取自己管的条目 / 键） */
export function rowsFor(rows: readonly FragmentRow[], selection: FragmentSelection): FragmentRow[] {
  const managed = new Set(selection.entryIds)
  return rows
    .filter((row) => managed.has(row.entryId))
    .map((row) => ({
      entryId: row.entryId,
      mode: row.mode,
      config: pickKeys(row.config, keysOf(selection, row.entryId)),
    }))
    .filter((row) => Object.keys(row.config).length > 0)
}

/** 某个条目当前已下发的值（只含本次接管的键；没有就是空对象） */
export function configOf(
  rows: readonly FragmentRow[],
  selection: FragmentSelection,
  entryId: string,
): Record<string, unknown> {
  const found = rowsFor(rows, selection).find((row) => row.entryId === entryId)
  return found ? { ...found.config } : {}
}

/**
 * 读改写：把这次要写的片段合并回该目标的**全部**片段。
 *
 * - 没接管的条目：原样保留（连顺序都不动）；
 * - 接管的条目：这次给了就替换（只接管部分键时，其余键保留、`mode` 用这次的），
 *   这次没给就删掉（只接管部分键时只删这些键，条目还有别的键就留着）；
 * - 新条目追加在末尾。
 */
export function mergeFragments(
  existing: readonly FragmentRow[],
  next: readonly FragmentRow[],
  selection: FragmentSelection,
): FragmentRow[] {
  const managed = new Set(selection.entryIds)
  const incoming = new Map(next.filter((row) => managed.has(row.entryId)).map((row) => [row.entryId, row]))
  const merged: FragmentRow[] = []
  const used = new Set<string>()

  for (const row of existing) {
    if (!managed.has(row.entryId)) {
      merged.push({ entryId: row.entryId, mode: row.mode, config: { ...row.config } })
      continue
    }
    const keys = keysOf(selection, row.entryId)
    const replacement = incoming.get(row.entryId)
    used.add(row.entryId)
    const config = replacement
      ? { ...stripKeys(row.config, keys), ...pickKeys(replacement.config, keys) }
      : stripKeys(row.config, keys)
    if (Object.keys(config).length === 0) continue
    merged.push({ entryId: row.entryId, mode: replacement?.mode ?? row.mode, config })
  }

  // 新条目：同一个条目在入参里出现多次时只写一次（后写的值生效，位置按第一次出现）
  for (const row of incoming.values()) {
    if (used.has(row.entryId)) continue
    const config = pickKeys(row.config, keysOf(selection, row.entryId))
    if (Object.keys(config).length === 0) continue
    merged.push({ entryId: row.entryId, mode: row.mode, config })
  }

  return merged
}

/** 片段行 → 契约入参（`id` 由 `entryId` 得来） */
export function toFragmentInputs(rows: readonly FragmentRow[]): DesktopConfigFragmentInput[] {
  return rows.map((row) => ({ id: row.entryId, mode: row.mode, config: row.config }) as DesktopConfigFragmentInput)
}

export interface UseDesktopFragmentsOptions {
  /** 期望状态（`GET /api/admin/desktop/delivery`）：只用里面的 `configFragments` */
  state: Ref<DesktopDeliveryState | null | undefined>
  /** 当前目标；`null` = 还没选定（例如「指定用户」没选人），此时读不到也写不了 */
  target: Ref<DesktopDeliveryTarget | null>
  /** 本次接管哪些条目 / 键 */
  selection: FragmentSelection
}

export interface UseDesktopFragments {
  /** 当前目标已有的全部片段行（只读） */
  existing: ComputedRef<FragmentRow[]>
  /** 其中本次接管的那些（只含接管的键） */
  managed: ComputedRef<FragmentRow[]>
  /** 某个条目当前的值（只含接管的键） */
  configOf: (entryId: string) => Record<string, unknown>
  /** 把这次要写的片段合并回全部片段后的结果（预览用，不会提交） */
  buildMerged: (next: readonly FragmentRow[]) => FragmentRow[]
  /** 合并 → 契约校验 → 下发（`withReauth` 包着）；校验不过抛 {@link FragmentValidationError} */
  save: (
    next: readonly FragmentRow[],
    meta?: { title?: string; description?: string; confirmText?: string },
  ) => Promise<DesktopDeliverResponse>
  /** 正在提交（按钮 loading 用） */
  saving: Ref<boolean>
}

/**
 * 片段读改写的 composable。用法（页面里）：
 *
 * ```ts
 * const fragments = useDesktopFragments({
 *   state: delivery,            // Ref<DesktopDeliveryState | null>
 *   target,                     // Ref<DesktopDeliveryTarget | null>
 *   selection: { entryIds: ['claude-pilot', 'codex-pilot'], keys: { 'claude-pilot': ['hubMode'] } },
 * })
 * fragments.configOf('claude-pilot') // → { hubMode: true }
 * await fragments.save([{ entryId: 'claude-pilot', mode: 'enforce', config: { hubMode: true } }])
 * ```
 */
export function useDesktopFragments(options: UseDesktopFragmentsOptions): UseDesktopFragments {
  const { state, target, selection } = options
  const saving = ref(false)

  const existing = computed<FragmentRow[]>(() => fragmentsOfTarget(state.value?.configFragments, target.value))
  const managed = computed<FragmentRow[]>(() => rowsFor(existing.value, selection))

  function readConfig(entryId: string): Record<string, unknown> {
    return configOf(existing.value, selection, entryId)
  }

  function buildMerged(next: readonly FragmentRow[]): FragmentRow[] {
    return mergeFragments(existing.value, next, selection)
  }

  async function save(
    next: readonly FragmentRow[],
    meta: { title?: string; description?: string; confirmText?: string } = {},
  ): Promise<DesktopDeliverResponse> {
    const resolved = target.value
    if (!resolved) throw new FragmentValidationError(['先选定下发目标'])

    const merged = buildMerged(next)
    const errors: string[] = []
    if (next.length === 0) errors.push('还没填要下发的条目')
    for (const row of next) {
      if (Object.keys(row.config).length === 0) errors.push(`${row.entryId}：还没有填任何一项`)
    }
    if (errors.length === 0) {
      const contractError = validateConfigRequest(resolved, toFragmentInputs(merged))
      if (contractError) errors.push(contractError)
    }
    if (errors.length > 0) throw new FragmentValidationError(errors)

    saving.value = true
    try {
      return await withReauth(() => deliverDesktopConfig({ target: resolved, fragments: toFragmentInputs(merged) }), {
        title: meta.title ?? '下发配置片段',
        description: meta.description ?? '会整体替换这个目标的配置片段，并生成新 revision。',
        confirmText: meta.confirmText ?? '下发',
      })
    } finally {
      saving.value = false
    }
  }

  return { existing, managed, configOf: readConfig, buildMerged, save, saving }
}
