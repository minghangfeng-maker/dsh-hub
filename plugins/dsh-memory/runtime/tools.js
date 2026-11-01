/**
 * 模型可用的记忆工具（DESIGN.md §6）。
 *
 * 全部用 `ctx.tools.register` 注册；文件读写走插件自己的 `node:fs`，不走会话沙箱。
 * 这不是绕过安全边界：路径全部由「作用域 + 白名单名字」拼出来，任何参数都不会
 * 被当作路径使用。
 *
 * @module @local/dsh-memory/tools
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  MAX_SESSION_NOTES_CHARS,
  NOTE_KINDS,
  TYPES,
  assertName,
  scopeDir,
  topicPath,
} from './paths.js'
import {
  addNote,
  loadNotes,
  notesChars,
  removeNote,
  updateNote,
} from './notes.js'
import { effectiveSubagentWrites, readSettings, readTextOrNull } from './store.js'

/** 工具描述里反复出现的写作准则（DESIGN.md §6「写入准则」）。 */
const WRITE_RULES = [
  '只记「下一个会话不知道就会做错或多走弯路」的事。',
  '不记能从代码、git、配置推导出来的东西。',
  '记结论，不记流水账；同一件事更新原条目，不新建。',
  '相对日期换成绝对日期。',
  '**不要把密钥写进记忆**（插件会拒绝）。',
].join('\n')

/** 统一的「读记忆用工具」提示。 */
const READ_HINT = '读记忆要用 memory_read / memory_topic，不要用 cat / read 直接读文件 —— 直接读不会计入使用计数，热度会失真。'

/** 工具输出里的文本渲染。 */
function textRender(value) {
  if (typeof value?.text === 'string' && value.text) return [{ type: 'text', text: value.text }]
  const parts = []
  if (typeof value?.message === 'string' && value.message) parts.push(value.message)
  if (Array.isArray(value?.items) && value.items.length > 0) {
    for (const item of value.items) {
      parts.push(`- ${item.scope}/${item.name} — ${item.description ?? ''}（${item.type ?? ''}${item.pinned ? ' 📌' : ''}${item.stale ? ' ⚠️' : ''}）`)
    }
  }
  return [{ type: 'text', text: parts.join('\n') || (value?.ok ? '完成' : '失败') }]
}

/** 把工具异常转成模型能读懂的失败值。 */
function failure(error) {
  return {
    ok: false,
    action: 'error',
    message: `记忆操作失败：${String(error?.message || error)}`,
  }
}

/** 记忆工具的输出 schema。 */
const OUTPUT = {
  type: 'object',
  additionalProperties: true,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    message: { type: 'string' },
    text: { type: 'string' },
    scope: { type: 'string' },
    name: { type: 'string' },
    fields: { type: 'object', additionalProperties: true },
    items: { type: 'array', items: { type: 'object', additionalProperties: true } },
    total: { type: 'number' },
    notes: { type: 'array', items: { type: 'object', additionalProperties: true } },
    pending: { type: 'boolean' },
    proposalId: { type: 'string' },
  },
}

/** 注册全部工具。 */
export function registerTools(ctx, service) {
  /** 子代理写入策略：settings.json 里未过期的临时覆盖优先。读失败就回落到插件配置。 */
  async function subagentWritesPolicy() {
    try {
      return effectiveSubagentWrites(await readSettings(service.home), service.config.subagentWrites)
    } catch {
      return service.config.subagentWrites
    }
  }

  const pending = []
  const add = (definition) => {
    pending.push(ctx.tools.register(definition))
  }

  /* ────────────────────────── memory_read ────────────────────────── */
  add({
    name: 'memory_read',
    description: [
      '读一条长期记忆的完整正文。',
      READ_HINT,
      '不传 scope 时先查本工作区，再查全局。读完会在 stats 里记一次「读过」，用来算热度。',
      '',
      '写入准则（memory_write 时用）：',
      WRITE_RULES,
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', description: '条目名（小写字母/数字/连字符）' },
        scope: { type: 'string', enum: ['global', 'workspace'], description: '不传则先工作区再全局' },
      },
    },
    output: { schema: OUTPUT, render: (_args, value) => textRender(value) },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        assertName(args?.name)
        const info = service.sessionInfo(exec?.agent)
        const candidates = args?.scope
          ? [service.scopeOf(args.scope, exec?.agent)]
          : [info.scope, 'global']
        for (const scope of candidates) {
          const item = await service.itemDetail(scope, args.name)
          if (!item) continue
          await service.markRead(scope, args.name, info.sessionId)
          return {
            ok: true,
            action: 'read',
            scope,
            name: args.name,
            text: item.raw,
            fields: {
              description: item.meta.description,
              type: item.meta.type,
              tags: item.meta.tags,
              links: item.meta.links,
              pinned: item.meta.pinned,
              stale: item.meta.stale,
              created: item.meta.created,
              updated: item.meta.updated,
              verified_at: item.meta.verified_at,
              heat: item.stats.heat,
            },
            message: `读到 ${scope}/${args.name}`,
          }
        }
        return {
          ok: false,
          action: 'read',
          message: `没有找到记忆 ${args.name}。可以先用 memory_search 搜关键词，或用 memory_topic(tag) 浏览冷记忆。`,
        }
      } catch (error) {
        return failure(error)
      }
    },
  })

  /* ────────────────────────── memory_topic ────────────────────────── */
  add({
    name: 'memory_topic',
    description: [
      '查看某个标签下的全部记忆（第 1 跳：索引 → 主题页 → 条目）。',
      READ_HINT,
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['tag'],
      properties: {
        tag: { type: 'string', description: '标签名，例如 dsh、网络' },
        scope: { type: 'string', enum: ['global', 'workspace'], description: '不传则工作区优先' },
      },
    },
    output: { schema: OUTPUT, render: (_args, value) => textRender(value) },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        const tag = String(args?.tag ?? '').trim()
        if (!tag) throw new Error('tag 不能为空')
        const info = service.sessionInfo(exec?.agent)
        const candidates = args?.scope
          ? [service.scopeOf(args.scope, exec?.agent)]
          : [info.scope, 'global']
        let text = null
        let scope = null
        for (const candidate of candidates) {
          text = await readTextOrNull(topicPath(service.home, candidate, tag))
          if (text !== null) {
            scope = candidate
            break
          }
        }
        if (text === null) {
          await service.generateIndex(candidates[0])
          for (const candidate of candidates) {
            text = await readTextOrNull(topicPath(service.home, candidate, tag))
            if (text !== null) {
              scope = candidate
              break
            }
          }
        }
        if (text === null) {
          const tags = new Set()
          for (const candidate of candidates) {
            const { items } = await service.allItems()
            for (const item of items.filter((entry) => entry.scope === candidate)) {
              for (const entryTag of item.meta.tags ?? []) tags.add(entryTag)
            }
          }
          return {
            ok: false,
            action: 'topic',
            message: `没有标签 ${tag} 的主题页。现有标签：${[...tags].slice(0, 30).join('、') || '（还没有）'}`,
          }
        }
        return { ok: true, action: 'topic', scope, text, message: `主题页 ${tag}（${scope}）` }
      } catch (error) {
        return failure(error)
      }
    },
  })

  /* ────────────────────────── memory_search ────────────────────────── */
  add({
    name: 'memory_search',
    description: [
      '按关键词搜索记忆（name、description、tags、正文）。只返回摘要行，不返回正文，也不计热度。',
      '冷记忆、不确定名字时先用它。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: '关键词（中文整串也能匹配）' },
        tags: { type: 'array', items: { type: 'string' }, description: '只返回同时带这些标签的条目' },
        type: { type: 'string', enum: TYPES },
        scope: { type: 'string', enum: ['global', 'workspace', 'all'], description: '默认全部作用域' },
        includeArchived: { type: 'boolean', description: '连归档区一起搜（默认 false）' },
      },
    },
    output: { schema: OUTPUT, render: (_args, value) => textRender(value) },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        const info = service.sessionInfo(exec?.agent)
        const scopeArg = args?.scope
        const scope = scopeArg === 'all' || scopeArg === undefined
          ? undefined
          : service.scopeOf(scopeArg, exec?.agent)
        const items = await service.search({
          query: args?.query,
          tags: args?.tags,
          type: args?.type,
          scope,
          limit: 20,
        })
        let archived = []
        if (args?.includeArchived) {
          archived = await searchArchived(service, String(args?.query ?? ''), scope)
        }
        const all = [...items, ...archived]
        return {
          ok: true,
          action: 'search',
          total: all.length,
          items: all,
          message: all.length === 0
            ? '没有匹配的记忆。'
            : `找到 ${all.length} 条（最多显示 20 条）。用 memory_read(name) 看正文。`,
        }
      } catch (error) {
        return failure(error)
      }
    },
  })

  /* ────────────────────────── memory_write ────────────────────────── */
  add({
    name: 'memory_write',
    description: [
      '新建或整体更新一条长期记忆。同名即更新（不会追加第二条）。',
      '',
      '什么时候写：',
      WRITE_RULES,
      '',
      'type 的含义：user（用户是谁/偏好）、feedback（纠正与确认过的做法）、project（进行中的工作）、reference（外部资源指针）。',
      'type=feedback 或 pinned 的已有条目，模型不能直接覆盖，会转成「待用户审批」的收件箱提议。',
      '正文上限 8 KB；feedback/project 类建议附 **Why:** 与 **How to apply:**。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'description', 'type', 'tags', 'body'],
      properties: {
        name: { type: 'string', description: '身份键：小写字母/数字/连字符，最长 64；同名即更新' },
        description: { type: 'string', description: '一行说明，≤120 字符，会出现在索引行里' },
        type: { type: 'string', enum: TYPES },
        tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
        body: { type: 'string', description: '正文：事实本身；feedback/project 附 Why / How to apply' },
        links: { type: 'array', items: { type: 'string' }, description: '相关条目名，可跨作用域写 global:<name>' },
        scope: { type: 'string', enum: ['global', 'workspace'], description: '默认 workspace' },
        pinned: { type: 'boolean', description: 'true = 永远在热层（改动需要用户审批）' },
      },
    },
    output: { schema: OUTPUT, render: (_args, value) => textRender(value) },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      try {
        const info = service.sessionInfo(exec?.agent)
        const scope = service.scopeOf(args?.scope, exec?.agent)
        const name = assertName(args?.name)
        // 先用与真正写入完全相同的校验做一次预演（不落盘）：
        // 子代理/受保护条目的分支要先把 after 文本算出来给收件箱，不能绕过校验。
        const preview = await service.previewEntry({
          scope,
          name,
          description: args?.description,
          type: args?.type,
          tags: args?.tags,
          body: args?.body,
          links: args?.links ?? [],
          pinned: args?.pinned,
          sessionId: info.sessionId,
        })
        const existing = preview.existing
        const rawAfter = preview.raw
        // 内容完全没变：不写盘，也不产生收件箱噪音。
        if (existing && existing.raw === rawAfter) {
          return {
            ok: true,
            action: 'write',
            scope,
            name,
            message: `${scope}/${name} 没有变化，未写入。`,
            fields: { created: false, changed: false },
          }
        }

        // 子代理：按配置转收件箱 / 拒绝 / 放行。
        const subagentPolicy = info.isSubagent ? await subagentWritesPolicy() : 'allow'
        if (subagentPolicy !== 'allow') {
          if (subagentPolicy === 'deny') {
            return { ok: false, action: 'write', message: '子代理会话不允许直接写记忆（subagentWrites=deny）。把结论交回主会话写。' }
          }
          const proposal = await service.propose({
            kind: existing ? 'update' : 'create',
            scope,
            name,
            before: existing?.raw ?? null,
            after: rawAfter,
            reason: '子代理会话的写入提议',
            proposedBy: 'model',
            origin: 'subagent',
            sessionId: info.sessionId,
            originScope: info.scope,
          })
          return {
            ok: true,
            action: 'write',
            pending: true,
            proposalId: proposal.id,
            message: `已提交待用户审批（提议 ${proposal.id}）。子代理不能在收件箱里直接落盘。（深整理时可能由 AI 审阅自动落盘）`,
          }
        }

        // 受保护条目（feedback / pinned）：模型不直接覆盖。
        if (existing && (existing.meta.type === 'feedback' || existing.meta.pinned === true)) {
          const proposal = await service.propose({
            kind: 'update',
            scope,
            name,
            before: existing.raw,
            after: rawAfter,
            reason: '受保护条目（feedback/pinned）的修改提议',
            proposedBy: 'model',
            sessionId: info.sessionId,
          })
          return {
            ok: true,
            action: 'write',
            pending: true,
            proposalId: proposal.id,
            message: `「${name}」是受保护条目（feedback/pinned），已提交待用户审批（提议 ${proposal.id}）。`,
          }
        }

        const result = await service.upsertEntry({
          scope,
          name,
          description: args?.description,
          type: args?.type,
          tags: args?.tags,
          body: args?.body,
          links: args?.links ?? [],
          pinned: args?.pinned,
          actor: 'model',
          sessionId: info.sessionId,
          reason: 'memory_write',
        })
        return {
          ok: true,
          action: 'write',
          scope,
          name,
          message: result.changed
            ? `${result.created ? '已创建' : '已更新'} ${scope}/${name}（索引会在几秒内重建）。`
            : `${scope}/${name} 没有变化，未写入。`,
          fields: { created: result.created, changed: result.changed },
        }
      } catch (error) {
        return failure(error)
      }
    },
  })

  /* ────────────────────────── memory_archive ────────────────────────── */
  add({
    name: 'memory_archive',
    description: [
      '归档一条过时或错误的记忆。文件不会删除，只是移到 archive/，可以在设置页恢复。',
      '只在「这条记忆确实没用了」时用；拿不准就先用 memory_verify 确认。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'reason'],
      properties: {
        name: { type: 'string' },
        reason: { type: 'string', description: '为什么归档（会写进 journal）' },
        scope: { type: 'string', enum: ['global', 'workspace'], description: '不传则先工作区再全局' },
      },
    },
    output: { schema: OUTPUT, render: (_args, value) => textRender(value) },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      try {
        const info = service.sessionInfo(exec?.agent)
        const name = assertName(args?.name)
        const candidates = args?.scope
          ? [service.scopeOf(args.scope, exec?.agent)]
          : [info.scope, 'global']
        let scope = null
        for (const candidate of candidates) {
          if (await service.itemDetail(candidate, name)) {
            scope = candidate
            break
          }
        }
        if (!scope) return { ok: false, action: 'archive', message: `没有找到记忆 ${name}。` }
        const existing = await service.itemDetail(scope, name)
        const subagentPolicy = info.isSubagent ? await subagentWritesPolicy() : 'allow'
        if (subagentPolicy !== 'allow') {
          if (subagentPolicy === 'deny') {
            return { ok: false, action: 'archive', message: '子代理会话不允许直接归档记忆（subagentWrites=deny）。' }
          }
          const proposal = await service.propose({
            kind: 'archive',
            scope,
            name,
            before: existing.raw,
            after: null,
            reason: `子代理提议归档：${args?.reason ?? ''}`,
            proposedBy: 'model',
            origin: 'subagent',
            sessionId: info.sessionId,
            originScope: info.scope,
          })
          return { ok: true, action: 'archive', pending: true, proposalId: proposal.id, message: `已提交待用户审批（提议 ${proposal.id}）。` }
        }
        const result = await service.archiveEntry({
          scope,
          name,
          actor: 'model',
          sessionId: info.sessionId,
          reason: String(args?.reason ?? 'memory_archive'),
        })
        return {
          ok: true,
          action: 'archive',
          scope,
          name,
          message: result.existed ? `已归档 ${scope}/${name}（可在设置页恢复）。` : `没有找到 ${scope}/${name}。`,
        }
      } catch (error) {
        return failure(error)
      }
    },
  })

  /* ────────────────────────── memory_verify ────────────────────────── */
  add({
    name: 'memory_verify',
    description: '在**实际核实过**某条记忆仍然成立之后调用：把 verified_at 更新为今天，并清掉过期标记。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string' },
        scope: { type: 'string', enum: ['global', 'workspace'], description: '不传则先工作区再全局' },
      },
    },
    output: { schema: OUTPUT, render: (_args, value) => textRender(value) },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      try {
        const info = service.sessionInfo(exec?.agent)
        const name = assertName(args?.name)
        const candidates = args?.scope
          ? [service.scopeOf(args.scope, exec?.agent)]
          : [info.scope, 'global']
        for (const scope of candidates) {
          const result = await service.verifyEntry({ scope, name, actor: 'model', sessionId: info.sessionId })
          if (result.verified) {
            return { ok: true, action: 'verify', scope, name, message: `已确认 ${scope}/${name} 仍然成立（${new Date().toISOString().slice(0, 10)}）。` }
          }
        }
        return { ok: false, action: 'verify', message: `没有找到记忆 ${name}。` }
      } catch (error) {
        return failure(error)
      }
    },
  })

  /* ────────────────────────── memory_note ────────────────────────── */
  add({
    name: 'memory_note',
    description: [
      '本会话钉住的笔记：压缩之后会被逐字重发，不交给摘要模型改写。',
      `action=add/update/remove/list；kind 取 ${NOTE_KINDS.join(' / ')}。`,
      `总长上限 ${MAX_SESSION_NOTES_CHARS} 字符，满了先合并或删掉旧的。`,
      '笔记不是长期记忆：跨会话还有用的结论请用 memory_write 写成条目。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['add', 'update', 'remove', 'list'] },
        id: { type: 'string', description: 'update/remove 时的笔记 id（n1…）' },
        text: { type: 'string' },
        kind: { type: 'string', enum: NOTE_KINDS },
      },
    },
    output: { schema: OUTPUT, render: (_args, value) => textRender(value) },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      try {
        const info = service.sessionInfo(exec?.agent)
        const action = String(args?.action ?? '')
        if (action === 'list') {
          const doc = await loadNotes(service.home, info.sessionId, info.wsKey)
          return {
            ok: true,
            action,
            notes: doc.notes,
            message: doc.notes.length === 0
              ? '本会话还没有钉住的笔记。'
              : `本会话有 ${doc.notes.length} 条笔记（${notesChars(doc)}/${MAX_SESSION_NOTES_CHARS} 字符）。`,
          }
        }
        if (action === 'add') {
          const { doc, note } = await addNote(service.home, info.sessionId, info.wsKey, { text: args?.text, kind: args?.kind })
          return {
            ok: true,
            action,
            notes: doc.notes,
            message: `已钉住笔记 ${note.id}（${notesChars(doc)}/${MAX_SESSION_NOTES_CHARS} 字符）。`,
          }
        }
        if (action === 'update') {
          const doc = await updateNote(service.home, info.sessionId, String(args?.id ?? ''), { text: args?.text, kind: args?.kind })
          return { ok: true, action, notes: doc.notes, message: `已更新笔记 ${args?.id}。` }
        }
        if (action === 'remove') {
          const doc = await removeNote(service.home, info.sessionId, String(args?.id ?? ''))
          return { ok: true, action, notes: doc.notes, message: `已删除笔记 ${args?.id}。` }
        }
        return { ok: false, action: 'note', message: `未知 action：${action}` }
      } catch (error) {
        return failure(error)
      }
    },
  })

  return () => {
    for (const dispose of pending) {
      try {
        dispose?.()
      } catch {
        // 卸载期的错误不阻塞其它工具
      }
    }
  }
}

/** 在归档区搜关键词（`includeArchived`）。 */
async function searchArchived(service, query, scope) {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const { listScopes } = await import('./store.js')
  const scopes = scope ? [scope] : await listScopes(service.home)
  const out = []
  for (const candidate of scopes) {
    const dir = join(service.home, 'archive', scopeDir(candidate))
    let names = []
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const file of names) {
      if (!file.endsWith('.md')) continue
      const text = await readTextOrNull(join(dir, file))
      if (!text || !text.toLowerCase().includes(needle)) continue
      const name = file.replace(/\.\d{4}-\d{2}-\d{2}T.*\.md$/, '').replace(/\.md$/, '')
      out.push({
        scope: candidate,
        name,
        description: `（归档）最后更新 ${String(text.match(/^updated:\s*(.+)$/m)?.[1] ?? '未知')}`,
        type: 'archived',
        archived: true,
      })
      if (out.length >= 20) return out
    }
  }
  return out
}
