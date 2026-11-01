import { Document, parse as parseYaml, parseDocument, stringify as stringifyYaml } from 'yaml'
import { HubError } from '../../lib/errors.js'

/**
 * managed.patch.yml / 插件 `config_yaml` 的 patch 条目工具（05 §1 F6/F17、06 §4.3）。
 *
 * 要点：
 * - **顶层必须是数组**：DSH 的 `loadOverlayPatches` 对非数组直接 fatal（WP2 真容器实测 F17）。
 * - 条目 `- id: <entry-id>` + `config:`（**整块替换，不深合并**），所以每个 config 必须写全字段。
 * - DSH 的 patch 支持 `!!js` 标签（出厂 patch 给 webserver 用了）；解析时要容忍未知标签，
 *   把这类标量原样当字符串保留（Hub 只做「插件配置片段搬运」，不求值）。
 */

export interface PatchEntry {
  id?: string
  config?: Record<string, unknown>
  [key: string]: unknown
}

/** 允许的 patch 条目：有 id（普通条目）或有 insert（插入条目，出厂 patch 用法） */
function isPatchEntry(value: unknown): value is PatchEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entry = value as PatchEntry
  if (typeof entry.id === 'string' && entry.id.trim().length > 0) return true
  return Array.isArray(entry.insert)
}

/** 解析 patch 条目数组文本；空文本视为「没有配置」（返回空数组，不报错） */
export function parsePatchEntries(text: string): PatchEntry[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return []
  let parsed: unknown
  try {
    parsed = parseYaml(trimmed, { logLevel: 'silent' })
  } catch (error) {
    throw new HubError('VALIDATION_FAILED', `YAML 语法错误：${errorText(error)}`)
  }
  if (parsed === null || parsed === undefined) return []
  if (!Array.isArray(parsed)) {
    throw new HubError(
      'VALIDATION_FAILED',
      '插件配置必须是 patch 条目数组（顶层 `- id: …`），DSH 对非数组会启动失败',
    )
  }
  const entries: PatchEntry[] = []
  parsed.forEach((item, index) => {
    if (!isPatchEntry(item)) {
      throw new HubError('VALIDATION_FAILED', `第 ${String(index + 1)} 个条目既没有 id 也不是 insert 条目`)
    }
    if (item.config !== undefined && (typeof item.config !== 'object' || item.config === null)) {
      throw new HubError('VALIDATION_FAILED', `第 ${String(index + 1)} 个条目的 config 必须是对象`)
    }
    entries.push(item)
  })
  return entries
}

/** 校验失败时抛 HubError；成功返回条目（管理端 PATCH 时用） */
export function validateConfigYaml(text: string): PatchEntry[] {
  return parsePatchEntries(text)
}

/** 序列化为 patch 数组文本（顶层数组 + 2 空格缩进，`!!js` 之类的自定义标签不会被重新生成） */
export function stringifyPatchEntries(entries: PatchEntry[]): string {
  return stringifyYaml(entries, { lineWidth: 0, indent: 2 })
}

export interface PluginConfigSource {
  packageName: string
  yaml: string
}

export interface RenderPluginEntriesResult {
  /** 保留下来的插件条目 YAML 文本（顶层数组片段；没有条目时为空串） */
  text: string
  warnings: string[]
}

/**
 * 把多个插件的 `config_yaml` 合并成一段 patch 条目文本（06 §4.3）。
 *
 * 用 YAML AST 而不是「parse → JS → stringify」：插件配置里可能有 `!!js` 这类 DSH 自定义标签，
 * 转成 JS 再序列化会把标签吃掉（语义就变了）。这里按 `bundle_order` 的次序过滤条目后
 * 逐个文档重新序列化，标签、注释都保留。
 */
export function renderPatchEntryBlocks(
  sources: PluginConfigSource[],
  reservedIds: Set<string>,
): RenderPluginEntriesResult {
  interface Item {
    node: unknown
    id: string | null
    sourceIndex: number
  }
  const items: Item[] = []
  const warnings: string[] = []
  const docs: { packageName: string; doc: Document; sourceIndex: number }[] = []
  sources.forEach((source, sourceIndex) => {
    if (source.yaml.trim().length === 0) return
    const doc = parseDocument(source.yaml, { logLevel: 'silent' })
    if (doc.errors.length > 0) {
      throw new HubError(
        'VALIDATION_FAILED',
        `插件 ${source.packageName} 的 configYaml 不是合法 YAML：${doc.errors[0]?.message ?? ''}`,
      )
    }
    if (doc.contents === null) return
    if (doc.contents.constructor.name !== 'YAMLSeq') {
      throw new HubError(
        'VALIDATION_FAILED',
        `插件 ${source.packageName} 的 configYaml 必须是 patch 条目数组`,
      )
    }
    docs.push({ packageName: source.packageName, doc, sourceIndex })
    const seqItems = (doc.contents as { items: unknown[] }).items
    seqItems.forEach((node) => {
      const idValue = (node as { get?: (key: string) => unknown }).get?.('id')
      const id = typeof idValue === 'string' && idValue.trim().length > 0 ? idValue : null
      items.push({ node, id, sourceIndex })
    })
  })

  const lastIndexById = new Map<string, number>()
  items.forEach((item, index) => {
    if (item.id !== null) lastIndexById.set(item.id, index)
  })
  const warnOnce = new Set<string>()
  const keptBySource = new Map<number, unknown[]>()
  items.forEach((item, index) => {
    if (item.id === null) {
      push(keptBySource, item.sourceIndex, item.node)
      return
    }
    if (reservedIds.has(item.id)) {
      const key = `reserved:${item.id}`
      if (!warnOnce.has(key)) {
        warnOnce.add(key)
        warnings.push(
          `插件 ${sources[item.sourceIndex]?.packageName ?? ''} 的条目 id "${item.id}" 与 Hub 管理的条目冲突，已忽略`,
        )
      }
      return
    }
    if (lastIndexById.get(item.id) !== index) {
      const key = `dup:${item.id}`
      if (!warnOnce.has(key)) {
        warnOnce.add(key)
        warnings.push(`条目 id "${item.id}" 重复定义，已保留最后一次定义`)
      }
      return
    }
    push(keptBySource, item.sourceIndex, item.node)
  })

  const blocks: string[] = []
  for (const { sourceIndex } of docs) {
    const kept = keptBySource.get(sourceIndex) ?? []
    if (kept.length === 0) continue
    blocks.push(new Document(kept).toString({ lineWidth: 0 }).trimEnd())
  }
  return { text: blocks.join('\n'), warnings }
}

function push(map: Map<number, unknown[]>, key: number, value: unknown): void {
  const list = map.get(key) ?? []
  list.push(value)
  map.set(key, list)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
