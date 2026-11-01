import { HubError } from '../../lib/errors.js'

/**
 * 用户 profile `package.json` 的读写工具（06 §2.3，**纯函数**，单元测试覆盖）。
 *
 * 文件形状（WP0b S3 真容器实测）：
 * ```json
 * { "name": "dsh-profile-web", "private": true, "dependencies": {},
 *   "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } } }
 * ```
 * Hub 只碰三处：`dependencies`、`dsh.profile.bundles`、`dshHub.managed`；
 * 其它字段与**键顺序**原样保留（用户/DSH 自己写的字段不能被我们搞乱）。
 */

/** profile 模板的出厂 bundles（WP0b S3 实测），永远排在最前 */
export const FACTORY_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const

/** 备份文件保留份数（06 §2.4：保留最近 3 份） */
export const PROFILE_BACKUP_KEEP = 3

export const BACKUP_SUFFIX = '.hub-bak-'

/** 任意 JSON 对象；键顺序即 JSON.stringify 的输出顺序，所以所有变换都必须保持原引用顺序 */
export type JsonObject = Record<string, unknown>

export interface PackagePluginAdd {
  packageName: string
  /** 写进 `dependencies` 的 spec（npm 精确版本 / URL / `file:…`） */
  spec: string
  /** 是否进 `dsh.profile.bundles` */
  isBundle: boolean
  /** bundles 排序权重（小的在前） */
  bundleOrder: number
  /** 记进 `dshHub.managed` 的版本号 */
  version: string
}

export interface ApplyPackageChangesInput {
  json: JsonObject
  add?: PackagePluginAdd[]
  /** 要卸载的包名（从 dependencies 与 bundles 里删掉） */
  remove?: string[]
  /** 已登记插件的 bundle_order（用于重排：管理端目录可能改了顺序） */
  bundleOrders?: Record<string, number>
  /** `dshHub.updatedAt` 用的时间（ISO） */
  now: string
}

export interface ApplyPackageChangesResult {
  json: JsonObject
  /** 变换后的 `dshHub.managed` */
  managed: Record<string, string>
  /** 是否真的改了内容（幂等判断：两次应用同一变更 → 第二次 changed=false） */
  changed: boolean
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读 `dshHub.managed`（容忍手改/缺字段；值必须是字符串） */
export function readManaged(json: JsonObject): Record<string, string> {
  const hub = json.dshHub
  if (!isObject(hub) || !isObject(hub.managed)) return {}
  const out: Record<string, string> = {}
  for (const [name, version] of Object.entries(hub.managed)) {
    if (typeof version === 'string') out[name] = version
  }
  return out
}

/** 读 `dsh.profile.bundles`（只保留字符串项） */
export function readBundles(json: JsonObject): string[] {
  const dsh = json.dsh
  if (!isObject(dsh)) return []
  const profile = dsh.profile
  if (!isObject(profile)) return []
  const bundles = profile.bundles
  if (!Array.isArray(bundles)) return []
  return bundles.filter((item): item is string => typeof item === 'string')
}

/** 读 `dependencies`（只保留字符串值） */
export function readDependencies(json: JsonObject): Record<string, string> {
  const deps = json.dependencies
  if (!isObject(deps)) return {}
  const out: Record<string, string> = {}
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec === 'string') out[name] = spec
  }
  return out
}

/**
 * bundles 重排（06 §2.3）：出厂 bundles（原样保留）→ Hub 管理（按 bundle_order）→ 用户自装（原样保留）。
 * 去重：同一包名只保留第一次出现的位置。
 */
export function orderBundles(input: {
  bundles: string[]
  managed: Record<string, string>
  bundleOrders: Record<string, number>
}): string[] {
  const { bundles, managed, bundleOrders } = input
  const seen = new Set<string>()
  const unique: string[] = []
  for (const name of bundles) {
    if (seen.has(name)) continue
    seen.add(name)
    unique.push(name)
  }
  const factory: string[] = []
  const hub: { name: string; index: number }[] = []
  const user: string[] = []
  unique.forEach((name, index) => {
    if ((FACTORY_BUNDLES as readonly string[]).includes(name)) factory.push(name)
    else if (name in managed) hub.push({ name, index })
    else user.push(name)
  })
  hub.sort((a, b) => {
    const orderA = bundleOrders[a.name] ?? 100
    const orderB = bundleOrders[b.name] ?? 100
    if (orderA !== orderB) return orderA - orderB
    if (a.index !== b.index) return a.index - b.index
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  return [...factory, ...hub.map((item) => item.name), ...user]
}

/**
 * 应用一次插件变更（安装/卸载/改顺序）。**纯函数**：输入输出都是普通对象，不碰文件系统。
 *
 * - `dependencies`：删除被卸载项、写入安装项的 `spec`；保留用户自装项与它们的顺序。
 * - `dsh.profile.bundles`：按 06 §2.3 的「出厂 → Hub 管理（bundle_order）→ 用户自装」重排。
 * - `dshHub.managed`：`{ 包名: 版本 }` 记录 Hub 管理的边界；`updatedAt` 只在内容真的变了时更新。
 * - 其它字段（含未知字段与顶层键顺序）原样保留。
 */
export function applyPackageChanges(input: ApplyPackageChangesInput): ApplyPackageChangesResult {
  const { json, add = [], remove = [], bundleOrders = {}, now } = input
  const before = JSON.stringify(json)

  const managed = { ...readManaged(json) }
  const deps = { ...readDependencies(json) }
  const bundles = readBundles(json)

  for (const name of remove) {
    delete deps[name]
    delete managed[name]
  }

  const addByName = new Map(add.map((item) => [item.packageName, item]))
  const nextBundles = bundles.filter((name) => !remove.includes(name))
  for (const item of [...add].sort((a, b) => (a.packageName < b.packageName ? -1 : 1))) {
    deps[item.packageName] = item.spec
    managed[item.packageName] = item.version
    if (item.isBundle && !nextBundles.includes(item.packageName)) nextBundles.push(item.packageName)
  }
  // 已经在 bundles 里但这次只改 spec 的，保持原位（不重复 push）
  for (const item of addByName.values()) {
    if (!item.isBundle) {
      const index = nextBundles.indexOf(item.packageName)
      if (index >= 0) nextBundles.splice(index, 1)
    }
  }

  const orders: Record<string, number> = { ...bundleOrders }
  for (const item of add) orders[item.packageName] = item.bundleOrder
  const orderedBundles = orderBundles({ bundles: nextBundles, managed, bundleOrders: orders })

  // ── 逐层写回，保持键顺序 ──────────────────────────────────────────────────
  const out: JsonObject = { ...json }
  const hadDeps = isObject(json.dependencies)
  if (hadDeps || Object.keys(deps).length > 0 || remove.length > 0) {
    out.dependencies = deps
  }

  const dsh = isObject(json.dsh) ? { ...json.dsh } : {}
  const profile = isObject(dsh.profile) ? { ...dsh.profile } : {}
  profile.bundles = orderedBundles
  dsh.profile = profile
  out.dsh = dsh

  const previousHub = isObject(json.dshHub) ? json.dshHub : {}
  const hub: JsonObject = { ...previousHub }
  hub.managed = sortKeys(managed)
  const managedChanged = JSON.stringify(readManaged(json)) !== JSON.stringify(hub.managed)
  const bundlesChanged = JSON.stringify(readBundles(json)) !== JSON.stringify(orderedBundles)
  const depsChanged = JSON.stringify(readDependencies(json)) !== JSON.stringify(deps)
  if (managedChanged || bundlesChanged || depsChanged || typeof hub.updatedAt !== 'string') {
    hub.updatedAt = now
  }
  out.dshHub = hub

  return {
    json: out,
    managed: sortKeys(managed),
    changed: JSON.stringify(out) !== before,
  }
}

/** 稳定输出：managed 的键按包名排序，避免同一变更因为插入顺序产生不同结果 */
function sortKeys(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(map).sort()) out[key] = map[key]!
  return out
}

/** 备份文件名：`package.json.hub-bak-<UTC 紧凑时间戳>`（可字典序排序） */
export function backupFileName(stamp: string): string {
  return `package.json${BACKUP_SUFFIX}${stamp}`
}

/** 时间戳（文件名安全）：`20261012T132000123Z` */
export function backupStamp(date: Date): string {
  return `${date.toISOString().replace(/[-:.]/gu, '').replace('Z', 'Z')}`
}

export function isHubBackup(fileName: string): boolean {
  return fileName.startsWith(`package.json${BACKUP_SUFFIX}`)
}

/**
 * 备份轮转：保留最近 `keep` 份，返回需要删除的文件名（旧的先删）。
 * 时间戳是定宽 UTC，字典序即时间序。
 */
export function selectBackupsToDelete(files: string[], keep = PROFILE_BACKUP_KEEP): string[] {
  const backups = files.filter(isHubBackup).sort()
  if (backups.length <= keep) return []
  return backups.slice(0, backups.length - keep)
}

/** 解析 profile `package.json` 文本（非法 JSON → HubError，调用方据此回滚） */
export function parsePackageJson(text: string): JsonObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HubError('INTERNAL', 'profile package.json 不是合法 JSON')
  }
  if (!isObject(parsed)) throw new HubError('INTERNAL', 'profile package.json 顶层不是对象')
  return parsed
}

/** 序列化：2 空格缩进 + 结尾换行（与 pnpm 写出来的格式一致，便于 diff） */
export function serializePackageJson(json: JsonObject): string {
  return `${JSON.stringify(json, null, 2)}\n`
}
