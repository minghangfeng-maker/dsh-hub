import { ref, watch, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

/**
 * 表格筛选状态 ↔ URL 查询串（07 §7.2 的工具栏筛选要能刷新/分享后保持）。
 *
 * 纯函数部分（{@link parseTableQuery} / {@link toTableQuery}）不依赖 router，便于单测；
 * {@link useTableQuery} 把它们接到当前路由上（含浏览器前进/后退同步）。
 */
export type QueryScalar = string | number | boolean
export type TableQueryValues = Record<string, QueryScalar>

/** 路由 query 的宽松形状（vue-router 的 LocationQuery 里的值是 `string | null | (string|null)[]`）。 */
export type RawQuery = Record<string, unknown>

function firstValue(value: unknown): string | null {
  if (Array.isArray(value)) return value.length > 0 ? firstValue(value[0]) : null
  if (value === null || value === undefined) return null
  return String(value)
}

function coerce(raw: string, fallback: QueryScalar): QueryScalar {
  if (typeof fallback === 'number') {
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  if (typeof fallback === 'boolean') return raw === 'true' || raw === '1'
  return raw
}

/**
 * URL → 状态：只认 `defaults` 里出现过的键，缺省/非法值回落默认值。
 * 布尔键支持 `?onlyRunning=1`。
 */
export function parseTableQuery<T extends TableQueryValues>(defaults: T, query: RawQuery): T {
  const result = { ...defaults }

  for (const key of Object.keys(defaults) as (keyof T & string)[]) {
    const raw = firstValue(query[key])
    if (raw === null || raw === '') continue
    const fallback = defaults[key] as QueryScalar
    result[key] = coerce(raw, fallback) as T[keyof T & string]
  }

  return result
}

/** 状态 → URL：与默认值相同的键不写进地址栏（保持链接干净，如 `/admin/users?page=2`）。 */
export function toTableQuery<T extends TableQueryValues>(defaults: T, state: T): Record<string, string> {
  const query: Record<string, string> = {}

  for (const key of Object.keys(defaults) as (keyof T & string)[]) {
    const value = state[key]
    if (value === defaults[key]) continue
    if (value === '' || value === null || value === undefined) continue
    query[key] = String(value)
  }

  return query
}

export interface UseTableQueryReturn<T extends TableQueryValues> {
  state: Ref<T>
  /** 合并式更新（`resetPage` 默认在改动非 page 键时回到第 1 页） */
  update: (patch: Partial<T>, options?: { resetPage?: boolean }) => Promise<void>
  /** 立即把当前状态写回 URL（打字搜索防抖后调用） */
  sync: () => Promise<void>
  reset: () => Promise<void>
}

/**
 * 把表格状态与当前路由的查询串双向绑定：
 * - `update()` 合并状态并 `router.replace`（不产生历史堆积，输入框防抖友好）；
 * - 浏览器前进/后退、外部链接进来的 `?q=` 会自动同步回状态。
 */
export function useTableQuery<T extends TableQueryValues>(defaults: T): UseTableQueryReturn<T> {
  const route = useRoute()
  const router = useRouter()

  const fresh = (): T => ({ ...defaults })
  const state = ref(parseTableQuery(defaults, route.query as RawQuery)) as Ref<T>

  // URL → 状态（前进/后退）
  watch(
    () => route.query,
    (query) => {
      const next = parseTableQuery(defaults, query as RawQuery)
      if (JSON.stringify(next) !== JSON.stringify(state.value)) state.value = next
    },
  )

  /**
   * 状态 → URL：表格键按当前状态重写（与默认值相同就不出现），**非表格键原样保留**
   * （详情页的 `?tab=` 之类不能被筛掉）；没有变化时不产生一次路由跳转。
   */
  function sync(): Promise<void> {
    const wanted = toTableQuery(defaults, state.value)
    const query: Record<string, unknown> = {}
    const current: Record<string, string> = {}

    for (const [key, value] of Object.entries(route.query)) {
      if (key in defaults) {
        const text = firstValue(value)
        if (text !== null) current[key] = text
        continue
      }
      query[key] = value
    }

    if (JSON.stringify(wanted) === JSON.stringify(current)) return Promise.resolve()

    Object.assign(query, wanted)
    return router.replace({ query: query as never }).then(() => undefined)
  }

  async function update(patch: Partial<T>, options: { resetPage?: boolean } = {}): Promise<void> {
    const touchesFilter = Object.keys(patch).some((key) => key !== 'page')
    const resetPage = options.resetPage ?? touchesFilter
    state.value = { ...state.value, ...patch }
    if (resetPage && 'page' in defaults && !('page' in patch)) {
      state.value = { ...state.value, page: defaults['page'] }
    }
    await sync()
  }

  async function reset(): Promise<void> {
    state.value = fresh()
    await sync()
  }

  return { state, update, sync, reset }
}
