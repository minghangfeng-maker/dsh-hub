import { HubError } from '../../lib/errors.js'

/**
 * 可用 DSH 版本查询（06 §3）：`GET https://registry.npmmirror.com/@deepseek-ai%2Fdsh`，
 * 取 `versions` 与 `dist-tags`，**缓存 10 分钟**（管理后台刷新不刷爆镜像站）。
 */

export const AVAILABLE_CACHE_MS = 10 * 60_000

export interface AvailableVersions {
  versions: string[]
  latest: string | null
  next: string | null
}

interface CacheEntry {
  at: number
  value: AvailableVersions
}

const cache = new Map<string, CacheEntry>()

/** 测试用：清缓存 */
export function clearAvailableCache(): void {
  cache.clear()
}

function encodedName(packageName: string): string {
  return packageName.startsWith('@')
    ? `@${encodeURIComponent(packageName.slice(1))}`
    : encodeURIComponent(packageName)
}

export interface FetchAvailableOptions {
  packageName?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** 时间源（默认真实时间：缓存是性能优化，不该被可控时钟冻住） */
  now?: () => number
}

export async function fetchAvailableVersions(
  registry: string,
  opts: FetchAvailableOptions = {},
): Promise<AvailableVersions> {
  const packageName = opts.packageName ?? '@deepseek-ai/dsh'
  const url = `${registry.replace(/\/+$/u, '')}/${encodedName(packageName)}`
  const nowMs = (opts.now ?? Date.now)()
  const hit = cache.get(url)
  if (hit && nowMs - hit.at < AVAILABLE_CACHE_MS) return hit.value

  const doFetch = opts.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000)
  timer.unref?.()
  try {
    const response = await doFetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new HubError('UPSTREAM_ERROR', `查询 DSH 可用版本失败（HTTP ${String(response.status)}）`, {
        url,
      })
    }
    const body = (await response.json()) as {
      versions?: Record<string, unknown>
      'dist-tags'?: Record<string, string>
    }
    const versions = Object.keys(body.versions ?? {}).sort(compareVersionsDesc)
    const distTags = body['dist-tags'] ?? {}
    const value: AvailableVersions = {
      versions,
      latest: distTags.latest ?? versions[0] ?? null,
      next: distTags.next ?? null,
    }
    cache.set(url, { at: nowMs, value })
    return value
  } catch (error) {
    if (error instanceof HubError) throw error
    throw new HubError('UPSTREAM_ERROR', `查询 DSH 可用版本失败：${errorText(error)}`, { url })
  } finally {
    clearTimeout(timer)
  }
}

/** 版本倒序（新的在前）：语义化比较，预发布版排在正式版之后 */
export function compareVersionsDesc(a: string, b: string): number {
  return -compareVersions(a, b)
}

export function compareVersions(a: string, b: string): number {
  const parse = (value: string): { nums: number[]; pre: string } => {
    const [core = '', pre = ''] = value.replace(/^v/u, '').split('-', 2)
    return { nums: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre }
  }
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < Math.max(left.nums.length, right.nums.length); index += 1) {
    const diff = (left.nums[index] ?? 0) - (right.nums[index] ?? 0)
    if (diff !== 0) return diff
  }
  if (left.pre === right.pre) return 0
  if (left.pre === '') return 1
  if (right.pre === '') return -1
  return left.pre.localeCompare(right.pre)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
