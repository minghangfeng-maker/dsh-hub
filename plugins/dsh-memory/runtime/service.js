/**
 * 记忆服务的核心：把 paths/store/stats/indexer/notes 拼成「条目」这一层业务。
 *
 * tools.js（模型工具）、api.js（设置页 HTTP）和 consolidate.js（整理）都只调用
 * 这里的方法，不直接碰文件。这样「写一条记忆」的校验、journal、收件箱提议、
 * 索引失效只在一个地方实现，三条入口不会漂移。
 *
 * @module @local/dsh-memory/service
 */

import { randomUUID } from 'node:crypto'
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveConfig } from './config.js'
import { buildGraph } from './graph.js'
import {
  TYPES,
  assertName,
  itemKey,
  itemPath,
  memoryIndexPath,
  isName,
  isScope,
  normalizeScope,
  resolveMemoryHome,
  scopeDir,
  tagFileKey,
  topicsDir,
  workspaceKey,
} from './paths.js'
import {
  renderMemoryIndex,
  renderTopicPage,
} from './indexer.js'
import { heatOf, pruneStats, readStats, recordItemRead, recordScopeSession, writeStats } from './stats.js'
import {
  appendJournal,
  archiveItemFile,
  assertBodySize,
  assertNoSecrets,
  atomicWrite,
  clampDescription,
  ensureDir,
  learnTags,
  listInbox,
  listItems,
  listScopes,
  normalizeMeta,
  normalizeTagList,
  parseEntry,
  readItem,
  readSettings,
  readTags,
  readTextOrNull,
  restoreItemFile,
  serializeEntry,
  today,
  validateTags,
  writeInboxItem,
  writeItemRaw,
  writeTags,
} from './store.js'
import { listNotes, loadNotes, notesDigest } from './notes.js'

/** 自动轻整理的防抖窗口（DESIGN.md §8.1：5 秒）。 */
const AUTO_LIGHT_DEBOUNCE_MS = 5_000

/** 生成物里最多写多少个主题页（防止一个坏标签刷爆磁盘）。 */
const MAX_TOPIC_FILES = 500

/**
 * 创建记忆服务。
 * @param {object|null} ctx - Cordis 上下文（单元测试可传 null）。
 * @param {object} rawConfig - cordis 行 config。
 * @param {{env?: NodeJS.ProcessEnv, home?: string}} [options] - 测试注入。
 * @returns {object} 服务对象。
 */
export function createMemoryService(ctx, rawConfig = {}, options = {}) {
  const config = resolveConfig(rawConfig)
  const home = options.home ?? resolveMemoryHome(config, options.env ?? process.env)
  const debounceMs = options.autoLightMs ?? AUTO_LIGHT_DEBOUNCE_MS
  let autoLightTimer = null
  let disposed = false
  let version = 0
  /** 同一条收件箱提议同时只允许一个决定在跑（用户点击 vs 深整理 AI 审阅）。 */
  const decidingInbox = new Set()
  const listeners = new Set()

  /* ────────────────────────────── 会话/作用域 ────────────────────────────── */

  /** 从一个 agent 上读出本会话的身份（会话 id、cwd、工作区 key、是否子代理）。 */
  function sessionInfo(agent) {
    const header = agent?.session?.header ?? {}
    const sessionId = typeof agent?.session?.id === 'string'
      ? agent.session.id
      : (typeof header.id === 'string' ? header.id : 'unknown')
    let cwd = typeof header.cwd === 'string' && header.cwd ? header.cwd : process.cwd()
    try {
      workspaceKey(cwd)
    } catch {
      cwd = process.cwd()
    }
    let wsKey
    try {
      wsKey = workspaceKey(cwd)
    } catch {
      wsKey = '--root--'
    }
    const depth = Math.max(
      Number.isFinite(header.delegationDepth) ? header.delegationDepth : 0,
      Number.isFinite(agent?.options?.subagentDepth) ? agent.options.subagentDepth : 0,
    )
    return {
      sessionId,
      cwd,
      wsKey,
      scope: `workspaces/${wsKey}`,
      isSubagent: header.origin === 'subagent' || depth > 0,
      delegationDepth: depth,
    }
  }

  /** 解析作用域参数（模型/客户端只传 global / workspace）。 */
  function scopeOf(input, agent, fallback = 'workspace') {
    const info = agent ? sessionInfo(agent) : { wsKey: workspaceKey(process.cwd()) }
    return normalizeScope(input, { wsKey: info.wsKey, fallback })
  }

  /** 建出 home 下的基本目录。 */
  async function ensureDirs() {
    await ensureDir(home)
    await ensureDir(join(home, 'global'))
    await ensureDir(join(home, 'workspaces'))
    await ensureDir(join(home, 'sessions'))
    await ensureDir(join(home, 'archive'))
    await ensureDir(join(home, 'inbox'))
  }

  /** 读全部条目（跨作用域）。 */
  async function allItems() {
    const scopes = await listScopes(home)
    const items = []
    const broken = []
    for (const scope of scopes) {
      const result = await listItems(home, scope)
      items.push(...result.items)
      for (const entry of result.broken) broken.push({ ...entry, scope })
    }
    return { items, broken, scopes }
  }

  /** 计算一个作用域的冷热分层（不写盘）。 */
  async function tierInfo(scope, stats) {
    const { items } = await listItems(home, scope)
    const { text, hot, cold, usedChars, budgetChars, pinnedOverBudget, decorated } =
      renderMemoryIndex({ scope, items, stats, config })
    return { text, hot, cold, usedChars, budgetChars, pinnedOverBudget, decorated, items }
  }

  /** 全量分层表：scope → {hot:Set, ...}。 */
  async function tierMap(stats) {
    const scopes = await listScopes(home)
    const map = new Map()
    for (const scope of scopes) {
      const info = await tierInfo(scope, stats)
      map.set(scope, {
        hot: new Set(info.hot.map((item) => item.name)),
        cold: new Set(info.cold.map((item) => item.name)),
        usedChars: info.usedChars,
        budgetChars: info.budgetChars,
        pinnedOverBudget: info.pinnedOverBudget,
      })
    }
    return map
  }

  /* ────────────────────────────── 索引 ────────────────────────────── */

  /**
   * 重新生成一个作用域的 MEMORY.md 与 `_topics/*.md`。
   * @param {string} scope - 作用域。
   * @returns {Promise<object>} 渲染结果。
   */
  async function generateIndex(scope) {
    await ensureDir(join(home, scopeDir(scope)))
    const stats = await readStats(home)
    const info = await tierInfo(scope, stats)
    const notice = info.pinnedOverBudget
      ? '\n> ⚠️ pinned 条目已超出热层预算，但仍全部保留。考虑取消部分 pinned 或精简描述。\n'
      : ''
    const text = notice ? info.text.replace(/\n$/, '\n') + notice : info.text
    await atomicWrite(memoryIndexPath(home, scope), text)

    const dir = topicsDir(home, scope)
    await ensureDir(dir)
    const expected = new Set()
    for (const topic of groupTopics(info)) {
      const key = `${tagFileKey(topic.tag)}.md`
      expected.add(key)
      const page = renderTopicPage({
        scope,
        tag: topic.tag,
        items: info.items,
        stats,
        config,
        hotNames: new Set(info.hot.map((item) => item.name)),
      })
      await atomicWrite(join(dir, key), page.text)
    }
    try {
      const existing = await readdir(dir)
      for (const file of existing) {
        if (file.endsWith('.md') && !expected.has(file)) {
          // 主题页是生成物，不是记忆：标签消失后留着只会让模型跳进空页。
          await unlink(join(dir, file)).catch(() => {})
        }
      }
    } catch {
      // 读不到主题目录不影响主流程
    }
    bump()
    return { ...info, text }
  }

  /** 从渲染结果里取标签分组。 */
  function groupTopics(info) {
    const groups = new Map()
    for (const item of info.decorated ?? info.hot.concat(info.cold)) {
      for (const tag of item.meta?.tags ?? []) {
        if (!groups.has(tag)) groups.set(tag, { tag, items: [] })
        groups.get(tag).items.push(item)
      }
    }
    return [...groups.values()].slice(0, MAX_TOPIC_FILES)
  }

  /** 读索引文本，不存在就生成一份。 */
  async function readIndex(scope) {
    const path = memoryIndexPath(home, scope)
    const existing = await readTextOrNull(path)
    if (existing !== null) return existing
    const result = await generateIndex(scope)
    return result.text
  }

  /* ────────────────────────────── 条目写入 ────────────────────────────── */

  /**
   * 创建或整体更新一条记忆。
   *
   * 写同名即更新（DESIGN.md §3.2）。所有写入先进 journal，再写文件 ——
   * 这样即使写盘失败，日志里也不会出现一条「没发生」的改前/改后。
   * @param {object} input - 写入参数。
   * @returns {Promise<object>} {item, created, changed, raw}
   */
  async function prepareEntry(input) {
    await ensureDirs()
    const {
      scope,
      name,
      description,
      type = 'reference',
      tags,
      body,
      links = [],
      pinned,
      sessionId = 'unknown',
    } = input
    assertName(name)
    if (!TYPES.includes(type)) {
      const error = new Error(`type 只能是 ${TYPES.join(' / ')}`)
      error.code = 'invalid-type'
      throw error
    }
    const descriptionText = clampDescription(description)
    if (!descriptionText) {
      const error = new Error('description 不能为空：一句话说清这条记忆是什么，它进索引行')
      error.code = 'invalid-description'
      throw error
    }
    if (!Array.isArray(links) || links.some((link) => typeof link !== 'string' || link.length > 100)) {
      const error = new Error('links 必须是条目名字符串数组')
      error.code = 'invalid-links'
      throw error
    }
    const bodyText = String(body ?? '')
    assertBodySize(bodyText)
    const tagsDoc = await readTags(home)
    const tagList = validateTags(tags, tagsDoc)
    const existing = await readItem(home, scope, name)
    const meta = {
      name,
      description: descriptionText,
      type,
      tags: tagList,
      links: links.map((link) => String(link).trim()).filter(Boolean),
      pinned: pinned === undefined ? existing?.meta.pinned === true : pinned === true,
      created: existing?.meta.created ?? today(),
      updated: today(),
      verified_at: existing?.meta.verified_at ?? today(),
      source: sessionId,
      stale: existing?.meta.stale === true ? true : undefined,
    }
    const raw = serializeEntry(meta, bodyText)
    assertNoSecrets(raw)
    return { existing, meta, raw, bodyText, tags: tagList }
  }

  /**
   * 校验一条写入但**不落盘**（模型提案前先过一遍同样的校验）。
   * @param {object} input - 与 upsertEntry 相同。
   * @returns {Promise<{existing: object|null, meta: object, raw: string}>} 预演结果。
   */
  async function previewEntry(input) {
    const prepared = await prepareEntry(input)
    return { existing: prepared.existing, meta: prepared.meta, raw: prepared.raw }
  }

  /**
   * 创建或整体更新一条记忆。
   *
   * 写同名即更新（DESIGN.md §3.2）。所有写入先进 journal，再写文件 ——
   * 这样即使写盘失败，日志里也不会出现一条「没发生」的改前/改后。
   * @param {object} input - 写入参数。
   * @returns {Promise<object>} {item, created, changed, raw}
   */
  async function upsertEntry(input) {
    const prepared = await prepareEntry(input)
    const { existing, meta, raw, bodyText, tags: tagList } = prepared
    const {
      scope,
      name,
      actor = 'model',
      sessionId = 'unknown',
      reason = '',
      runId,
    } = input
    if (existing && existing.raw === raw) {
      return { item: { ...existing, meta, body: bodyText, raw }, created: false, changed: false }
    }
    await writeItemRaw(home, scope, name, raw)
    await appendJournal(home, {
      actor,
      op: existing ? 'update' : 'create',
      scope,
      name,
      before: existing?.raw ?? null,
      after: raw,
      reason,
      ...(runId ? { runId } : {}),
    })
    await learnTags(home, tagList)
    await recordScopeSession(home, scope, sessionId)
    bump()
    afterWrite('upsert')
    return {
      item: { scope, name, meta, body: bodyText, raw, path: itemPath(home, scope, name) },
      created: !existing,
      changed: true,
    }
  }

  /**
   * 归档一条记忆（不删除文件）。
   * @param {object} input - {scope, name, actor, sessionId, reason, runId}。
   * @returns {Promise<object>} {raw, archivedTo, existed}
   */
  async function archiveEntry(input) {
    await ensureDirs()
    const { scope, name, actor = 'model', sessionId = 'unknown', reason = '', runId } = input
    assertName(name)
    const existing = await readItem(home, scope, name)
    if (!existing) {
      return { existed: false, raw: null, archivedTo: null }
    }
    const archived = await archiveItemFile(home, scope, name)
    await appendJournal(home, {
      actor,
      op: 'archive',
      scope,
      name,
      before: existing.raw,
      after: null,
      reason,
      ...(runId ? { runId } : {}),
    })
    await recordScopeSession(home, scope, sessionId)
    bump()
    afterWrite('archive')
    return { existed: true, raw: existing.raw, archivedTo: archived?.archivedTo ?? null }
  }

  /**
   * 从归档区恢复一条记忆。
   * @param {object} input - {scope, name, actor, sessionId, reason, runId}。
   * @returns {Promise<object>} {restored, raw, from}
   */
  async function restoreEntry(input) {
    await ensureDirs()
    const { scope, name, actor = 'user', sessionId = 'user', reason = '', runId } = input
    assertName(name)
    const restored = await restoreItemFile(home, scope, name)
    if (!restored) return { restored: false, raw: null, from: null }
    await appendJournal(home, {
      actor,
      op: 'restore',
      scope,
      name,
      before: null,
      after: restored.raw,
      reason,
      ...(runId ? { runId } : {}),
    })
    await recordScopeSession(home, scope, sessionId)
    bump()
    afterWrite('restore')
    return { restored: true, raw: restored.raw, from: restored.from }
  }

  /**
   * 更新 verified_at（模型实际核实过之后调用）。
   * @param {object} input - {scope, name, actor, sessionId, reason}。
   * @returns {Promise<object>} {verified, item}
   */
  async function verifyEntry(input) {
    const { scope, name, actor = 'model', sessionId = 'unknown', reason = 'verified' } = input
    const existing = await readItem(home, scope, name)
    if (!existing) return { verified: false, item: null }
    const meta = { ...existing.meta, verified_at: today(), updated: existing.meta.updated, stale: false }
    const raw = serializeEntry(meta, existing.body)
    if (raw === existing.raw) return { verified: true, item: existing, changed: false }
    await writeItemRaw(home, scope, name, raw)
    await appendJournal(home, {
      actor,
      op: 'update',
      scope,
      name,
      before: existing.raw,
      after: raw,
      reason,
    })
    bump()
    afterWrite('verify')
    return { verified: true, item: { ...existing, meta, raw }, changed: true }
  }

  /**
   * 记录一次读取（stats）。
   * @param {string} scope - 作用域。
   * @param {string} name - 条目名。
   * @param {string} sessionId - 会话 id。
   */
  async function markRead(scope, name, sessionId) {
    await recordItemRead(home, scope, name, sessionId)
  }

  /**
   * 记录「本会话碰过这个作用域」（注入 baseline 时调用）。
   * @param {string} scope - 作用域。
   * @param {string} sessionId - 会话 id。
   */
  async function markScopeSeen(scope, sessionId) {
    await recordScopeSession(home, scope, sessionId)
  }

  /** 记下最近一次异常（设置页概览会显示）。 */
  const errors = []
  function recordError(error) {
    const message = String(error?.message || error)
    errors.push({ at: new Date().toISOString(), message })
    if (errors.length > 20) errors.shift()
  }
  function recentErrors() {
    return [...errors]
  }

  /**
   * 用户从设置页保存一条记忆全文（actor=user，不受 feedback/pinned 保护规则限制）。
   *
   * 文本可以带 frontmatter（设置页就是这么展示的），也可以只有正文 —— 后者只在
   * 条目已存在时允许（沿用原字段，避免用户删掉 frontmatter 就丢掉元数据）。
   * @param {{scope: string, name: string, text: string}} input - 保存参数。
   * @returns {Promise<object>} {item, created, changed}
   */
  async function saveUserItem(input) {
    await ensureDirs()
    const { scope, name } = input
    assertName(name)
    if (!isScope(scope)) {
      const error = new Error(`未知作用域：${JSON.stringify(scope)}`)
      error.code = 'invalid-scope'
      throw error
    }
    const existing = await readItem(home, scope, name)
    const parsed = parseEntry(String(input.text ?? ''))
    const tagsDoc = await readTags(home)
    let meta
    let body
    if (parsed.hasFrontmatter) {
      if (parsed.meta.name && parsed.meta.name !== name) {
        const error = new Error(`frontmatter 里的 name（${parsed.meta.name}）和路径里的 ${name} 不一致`)
        error.code = 'invalid-name'
        throw error
      }
      if (parsed.meta.type !== undefined && !TYPES.includes(parsed.meta.type)) {
        const error = new Error(`type 只能是 ${TYPES.join(' / ')}（当前 ${JSON.stringify(parsed.meta.type)}）`)
        error.code = 'invalid-type'
        throw error
      }
      const base = normalizeMeta(parsed.meta, { name })
      const tags = Array.isArray(base.tags) && base.tags.length > 0
        ? base.tags
        : (existing?.meta.tags ?? ['未分类'])
      meta = {
        ...base,
        name,
        description: base.description || existing?.meta.description || firstLine(parsed.body),
        type: TYPES.includes(base.type) && parsed.meta.type ? base.type : (existing?.meta.type ?? 'reference'),
        tags: validateTags(tags, tagsDoc),
        links: Array.isArray(base.links) ? base.links : (existing?.meta.links ?? []),
        pinned: parsed.meta.pinned === true,
        created: base.created || existing?.meta.created || today(),
        updated: today(),
        verified_at: base.verified_at || existing?.meta.verified_at || today(),
        source: base.source && base.source !== 'unknown' ? base.source : (existing?.meta.source ?? 'user'),
        stale: parsed.meta.stale === true ? true : undefined,
      }
      body = parsed.body
    } else {
      if (!existing) {
        const error = new Error('新条目需要 frontmatter（name/description/type/tags）；已经在的条目可以只保存正文。')
        error.code = 'invalid-item'
        throw error
      }
      meta = { ...existing.meta, name, updated: today(), stale: existing.meta.stale ? true : undefined }
      body = String(input.text ?? '')
    }
    if (!meta.description) {
      const error = new Error('description 不能为空')
      error.code = 'invalid-description'
      throw error
    }
    assertBodySize(body)
    const raw = serializeEntry(meta, body)
    assertNoSecrets(raw)
    if (existing && existing.raw === raw) {
      return { item: { ...existing, meta, body, raw }, created: false, changed: false }
    }
    await writeItemRaw(home, scope, name, raw)
    await appendJournal(home, {
      actor: 'user',
      op: existing ? 'update' : 'create',
      scope,
      name,
      before: existing?.raw ?? null,
      after: raw,
      reason: 'settings save',
    })
    await learnTags(home, meta.tags)
    bump()
    afterWrite('user-save')
    return { item: { ...existing, scope, name, meta, body, raw, path: itemPath(home, scope, name) }, created: !existing, changed: true }
  }

  /** 取正文第一行当 description 兜底。 */
  function firstLine(text) {
    const line = String(text ?? '').split('\n').map((value) => value.trim()).find((value) => value.length > 0) ?? ''
    return clampDescription(line.replace(/^#+\s*/, ''))
  }

  /* ────────────────────────────── 撤销 ────────────────────────────── */

  /**
   * 撤销：把 journal 里的 before 写回去，并追加 op=undo 的记录。
   *
   * 支持两种粒度：单条（journalId）和整次运行（runId）。永远不会删文件：
   * 撤销一次 create 的动作是「归档」，不是 unlink。
   * @param {{journalId?: string, runId?: string}} input - 撤销目标。
   * @returns {Promise<{undone: string[], skipped: number}>} 结果。
   */
  async function undoJournal(input) {
    const { readJournal } = await import('./store.js')
    let entries = []
    if (input.journalId) {
      entries = await readJournal(home, { id: input.journalId })
      if (entries.length === 0) {
        const error = new Error(`没有这条日志：${input.journalId}`)
        error.code = 'journal-not-found'
        throw error
      }
    } else if (input.runId) {
      entries = await readJournal(home, { runId: input.runId })
      entries = entries.filter((entry) => ['create', 'update', 'archive', 'restore', 'merge', 'retag'].includes(entry.op))
      if (entries.length === 0) {
        const error = new Error(`这次运行没有可撤销的写入：${input.runId}`)
        error.code = 'journal-not-found'
        throw error
      }
    } else {
      const error = new Error('需要 journalId 或 runId')
      error.code = 'bad-request'
      throw error
    }
    const undone = []
    let skipped = 0
    for (const entry of [...entries].reverse()) {
      if (!isScope(entry.scope) || !isName(entry.name)) {
        skipped += 1
        continue
      }
      const targetPath = itemPath(home, entry.scope, entry.name)
      const current = await readTextOrNull(targetPath)
      const target = typeof entry.before === 'string' ? entry.before : null
      if (target === null) {
        if (current === null) {
          skipped += 1
          continue
        }
        await archiveItemFile(home, entry.scope, entry.name)
      } else {
        if (current === target) {
          skipped += 1
          continue
        }
        await writeItemRaw(home, entry.scope, entry.name, target)
      }
      await appendJournal(home, {
        actor: 'user',
        op: 'undo',
        scope: entry.scope,
        name: entry.name,
        before: current,
        after: target,
        reason: `undo ${entry.id}`,
        ...(entry.runId ? { runId: entry.runId } : {}),
      })
      undone.push(entry.id)
    }
    if (undone.length > 0) {
      bump()
      afterWrite('undo')
    }
    return { undone, skipped }
  }

  /* ────────────────────────────── 收件箱 ────────────────────────────── */

  /**
   * 写一条待审批的修改提议。
   * @param {object} input - {kind, scope, name, before, after, reason, runId, proposedBy, origin, sessionId}。
   * @returns {Promise<object>} 提议。
   */
  async function propose(input) {
    await ensureDirs()
    const origin = ['subagent', 'model', 'consolidate', 'user'].includes(input.origin)
      ? input.origin
      : (input.proposedBy === 'consolidate' ? 'consolidate' : 'model')
    const proposal = {
      id: `p-${randomUUID()}`,
      at: new Date().toISOString(),
      kind: input.kind ?? 'update',
      scope: input.scope,
      name: input.name,
      before: input.before ?? null,
      after: input.after ?? null,
      reason: input.reason ?? '',
      proposedBy: input.proposedBy ?? 'model',
      // 来源：子代理的提议可以在深整理时交给 AI 审阅（settings.inboxReview=ai）。
      origin,
      ...(typeof input.sessionId === 'string' && input.sessionId ? { sessionId: input.sessionId.slice(0, 200) } : {}),
      // 提出提议的会话所在作用域：AI 审阅只自动批准写回自己作用域的提议。
      ...(typeof input.originScope === 'string' && isScope(input.originScope) ? { originScope: input.originScope } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(Array.isArray(input.archive) && input.archive.length > 0 ? { archive: input.archive } : {}),
    }
    await writeInboxItem(home, proposal)
    bump()
    return proposal
  }

  /** 列出收件箱。 */
  async function inbox() {
    return listInbox(home)
  }

  /**
   * 处理一条收件箱提议。默认是用户点的「批准/拒绝」，深整理里的 AI 审阅也走这里。
   * @param {string} id - 提议 id。
   * @param {'approve'|'reject'} decision - 决定。
   * @param {{actor?: 'user'|'consolidate', reason?: string, runId?: string, signal?: AbortSignal}} [options] - 谁做的决定、为什么、属于哪次运行、取消信号。
   * @returns {Promise<object>} {ok, applied, proposal}
   */
  async function decideInbox(id, decision, options = {}) {
    if (decidingInbox.has(id)) {
      const error = new Error(`这条提议正在被处理：${id}`)
      error.code = 'busy'
      throw error
    }
    decidingInbox.add(id)
    try {
      return await decideInboxUnlocked(id, decision, options)
    } finally {
      decidingInbox.delete(id)
    }
  }

  async function decideInboxUnlocked(id, decision, options = {}) {
    const assertNotAborted = () => {
      if (!options.signal?.aborted) return
      const error = new Error('整理已取消，跳过这条决定')
      error.code = 'ABORTED'
      throw error
    }
    assertNotAborted()
    const { readInboxItem, removeInboxItem } = await import('./store.js')
    const proposal = await readInboxItem(home, id)
    if (!proposal) {
      const error = new Error(`没有这条提议：${id}`)
      error.code = 'not-found'
      throw error
    }
    const actor = options.actor === 'consolidate' ? 'consolidate' : 'user'
    const by = actor === 'consolidate' ? 'ai' : 'user'
    const note = typeof options.reason === 'string' ? options.reason.slice(0, 300) : ''
    const runId = typeof options.runId === 'string' && options.runId ? options.runId : proposal.runId
    const audit = async (verdict) => {
      const { writeInboxDecision } = await import('./store.js')
      // 决定记录失败不影响主流程（提议本身的写入/删除已经完成）。
      await writeInboxDecision(home, {
        id: proposal.id,
        decidedAt: new Date().toISOString(),
        decision: verdict,
        by,
        reason: note,
        ...(runId ? { runId } : {}),
        proposal,
      }).catch(() => {})
    }
    if (decision === 'reject') {
      // 先留审计再删提议：进程崩在中间也不会丢失被拒绝的内容。
      await audit('reject')
      await removeInboxItem(home, id)
      bump()
      return { ok: true, applied: false, proposal }
    }
    if (decision !== 'approve') {
      const error = new Error(`decision 只能是 approve 或 reject`)
      error.code = 'bad-request'
      throw error
    }
    if (!isScope(proposal.scope) || !isName(proposal.name)) {
      const error = new Error('提议里的 scope/name 不合法')
      error.code = 'invalid-proposal'
      throw error
    }
    if (typeof proposal.after === 'string') {
      const parsed = parseEntry(proposal.after)
      const meta = normalizeMeta(parsed.meta, { name: proposal.name })
      const raw = serializeEntry({ ...meta, name: proposal.name }, parsed.body)
      assertBodySize(parsed.body)
      assertNoSecrets(raw)
      const current = await readItem(home, proposal.scope, proposal.name)
      // AI 无人值守批准：提议创建后目标可能被用户手改过，不能静默覆盖。
      if (actor === 'consolidate') {
        const stale = typeof proposal.before === 'string'
          ? current?.raw !== proposal.before
          : Boolean(current)
        if (stale) {
          const error = new Error('目标条目在提议创建后已被修改，留给用户确认')
          error.code = 'conflict'
          throw error
        }
      }
      assertNotAborted()
      await writeItemRaw(home, proposal.scope, proposal.name, raw)
      await appendJournal(home, {
        actor,
        op: current ? 'update' : 'create',
        scope: proposal.scope,
        name: proposal.name,
        before: current?.raw ?? null,
        after: raw,
        reason: note ? `inbox ${proposal.id}（${note}）` : `inbox ${proposal.id}`,
        ...(runId ? { runId } : {}),
      })
    }
    // 合并提议：被合并掉的条目也一并归档。
    for (const target of proposal.archive ?? []) {
      if (target?.scope === proposal.scope && isName(target?.name)) {
        const current = await readItem(home, target.scope, target.name)
        if (current) {
          await archiveItemFile(home, target.scope, target.name)
          await appendJournal(home, {
            actor,
            op: 'archive',
            scope: target.scope,
            name: target.name,
            before: current.raw,
            after: null,
            reason: `inbox ${proposal.id}（合并）`,
            ...(runId ? { runId } : {}),
          })
        }
      }
    }
    await audit('approve')
    await removeInboxItem(home, id)
    bump()
    afterWrite('inbox-approve')
    return { ok: true, applied: true, proposal }
  }

  /* ────────────────────────────── 检索 ────────────────────────────── */

  /** 把查询切成词（空白分隔 + 原文整串，兼容中文子串）。 */
  function tokenize(query) {
    const raw = String(query ?? '').trim().toLowerCase()
    if (!raw) return []
    const parts = raw.split(/\s+/).filter(Boolean)
    return [...new Set([raw, ...parts])]
  }

  /**
   * 搜索条目。
   * @param {object} input - {query, tags, type, scope, includeArchived, limit}。
   * @returns {Promise<object[]>} 摘要行。
   */
  async function search(input) {
    const query = String(input?.query ?? '').trim()
    if (!query) {
      const error = new Error('query 不能为空')
      error.code = 'invalid-query'
      throw error
    }
    const tokens = tokenize(query)
    const stats = await readStats(home)
    let items = []
    if (input.scope) {
      items = (await listItems(home, input.scope)).items
    } else {
      const all = await allItems()
      items = all.items
    }
    const tagFilter = Array.isArray(input.tags) ? input.tags.map((tag) => String(tag).toLowerCase()) : []
    const typeFilter = input.type ? String(input.type) : null
    const scored = []
    for (const item of items) {
      if (typeFilter && item.meta.type !== typeFilter) continue
      if (tagFilter.length > 0) {
        const own = (item.meta.tags ?? []).map((tag) => tag.toLowerCase())
        if (!tagFilter.every((tag) => own.includes(tag))) continue
      }
      const haystack = [
        item.name,
        item.meta.description,
        (item.meta.tags ?? []).join(' '),
        (item.meta.links ?? []).join(' '),
        item.body,
      ].join('\n').toLowerCase()
      let score = 0
      for (const token of tokens) {
        if (!haystack.includes(token)) continue
        score += 1
        if (item.name.toLowerCase().includes(token)) score += 3
        if (String(item.meta.description).toLowerCase().includes(token)) score += 2
        if ((item.meta.tags ?? []).some((tag) => tag.toLowerCase().includes(token))) score += 2
      }
      if (score === 0) continue
      scored.push({ item, score })
    }
    scored.sort((a, b) => (b.score - a.score) || b.item.meta.updated.localeCompare(a.item.meta.updated))
    const limited = scored.slice(0, input.limit ?? 20)
    return limited.map(({ item }) => {
      const heat = heatOf(stats, item.scope, item.name, { recentSessions: config.recentSessions })
      return {
        scope: item.scope,
        name: item.name,
        description: item.meta.description,
        type: item.meta.type,
        tags: item.meta.tags,
        pinned: item.meta.pinned === true,
        stale: item.meta.stale === true,
        updated: item.meta.updated,
        heat: heat.heat,
        lastUsed: heat.lastUsed,
      }
    })
  }

  /* ────────────────────────────── 索引失效/自动轻整理 ────────────────────────────── */

  /** 版本号：任何写操作都会 +1（注入层可以用它判断「变了」）。 */
  function bump() {
    version += 1
    for (const listener of listeners) {
      try {
        listener(version)
      } catch {
        // 监听器自己的错不该影响写入
      }
    }
  }

  /** 订阅写操作（测试/调度用）。 */
  function onWrite(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  /** 写操作后的收尾：5 秒防抖跑一次轻整理。 */
  function afterWrite(reason) {
    if (disposed || debounceMs <= 0) return
    if (autoLightTimer) clearTimeout(autoLightTimer)
    autoLightTimer = setTimeout(() => {
      autoLightTimer = null
      void runLight({ reason: `auto:${reason}`, silent: true }).catch(() => {})
    }, debounceMs)
    autoLightTimer.unref?.()
  }

  /* ────────────────────────────── 轻整理 ────────────────────────────── */

  /**
   * 轻整理：重算冷热、重建索引、清理 stats、归档旧会话笔记（DESIGN.md §8.1）。
   * @param {{reason?: string, silent?: boolean}} [input] - 触发原因。
   * @returns {Promise<object>} 运行摘要。
   */
  async function runLight(input = {}) {
    await ensureDirs()
    const startedAt = new Date().toISOString()
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const stats = await readStats(home)
    const scopes = await listScopes(home)
    if (!scopes.includes('global')) {
      await ensureDir(join(home, 'global'))
      scopes.unshift('global')
    }
    const summaries = []
    const all = await allItems()
    for (const scope of scopes) {
      const info = await generateIndex(scope)
      summaries.push({
        scope,
        total: info.hot.length + info.cold.length,
        hot: info.hot.length,
        cold: info.cold.length,
        topics: new Set(info.hot.concat(info.cold).flatMap((item) => item.meta.tags ?? [])).size,
        usedChars: info.usedChars,
        budgetChars: info.budgetChars,
        pinnedOverBudget: info.pinnedOverBudget,
      })
    }
    const validKeys = new Set(all.items.map((item) => itemKey(item.scope, item.name)))
    const pruned = pruneStats(stats, validKeys)
    await writeStats(home, pruned)

    // 超过 30 天的会话笔记移到 archive/sessions/（DESIGN.md §7）。
    let archivedSessions = []
    try {
      const { archiveOldSessionNotes } = await import('./notes.js')
      archivedSessions = await archiveOldSessionNotes(home, { days: 30 })
    } catch {
      archivedSessions = []
    }

    const finishedAt = new Date().toISOString()
    const settings = await readSettings(home)
    const summary = {
      runId,
      mode: 'light',
      startedAt,
      finishedAt,
      reason: input.reason ?? 'manual',
      scopes: summaries,
      archivedSessions,
      totalItems: summaries.reduce((total, scope) => total + scope.total, 0),
      broken: all.broken.length,
    }
    if (!input.silent) {
      const { patchSettings } = await import('./store.js')
      await patchSettings(home, {
        lastLight: finishedAt,
        lastRun: summary,
        lastError: null,
      })
    }
    bump()
    return summary
  }

  /* ────────────────────────────── 概览 / 图谱 ────────────────────────────── */

  /** 各作用域的归档条目数。 */
  async function archivedCount(scope) {
    const dir = join(home, 'archive', scopeDir(scope))
    try {
      const names = await readdir(dir)
      return names.filter((name) => name.endsWith('.md')).length
    } catch (error) {
      if (error?.code === 'ENOENT') return 0
      throw error
    }
  }

  /** 解析 settings 的下一次深整理时间。 */
  function nextRunOf(settings, now = new Date()) {
    if (!settings.enabled || settings.deepFrequency === 'off') return null
    const [hour, minute] = settings.deepTime.split(':').map(Number)
    const next = new Date(now)
    next.setSeconds(0, 0)
    next.setHours(hour, minute, 0, 0)
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
    if (settings.deepFrequency === 'weekly') {
      // 每周一；今天已经过了周一的时间就顺延一周。
      const delta = (8 - next.getDay()) % 7
      next.setDate(next.getDate() + delta)
    }
    return next.toISOString()
  }

  /**
   * 概览（设置页第一屏）。
   * @returns {Promise<object>} 概览数据。
   */
  async function overview() {
    await ensureDirs()
    const settings = await readSettings(home)
    const stats = await readStats(home)
    const { items, broken } = await allItems()
    const tiers = await tierMap(stats)
    const scopes = [...new Set([...tiers.keys(), 'global'])].sort((a, b) => (a === 'global' ? -1 : b === 'global' ? 1 : a.localeCompare(b)))
    const rows = []
    const warnings = []
    for (const scope of scopes) {
      const scopeItems = items.filter((item) => item.scope === scope)
      const info = tiers.get(scope) ?? { hot: new Set(), cold: new Set(), usedChars: 0, budgetChars: config.hotBudgetChars }
      const hot = scopeItems.filter((item) => info.hot.has(item.name)).length
      const stale = scopeItems.filter((item) => item.meta.stale === true).length
      const archived = await archivedCount(scope)
      rows.push({
        scope,
        label: scope === 'global' ? '全局' : scope.slice('workspaces/'.length),
        total: scopeItems.length,
        hot,
        cold: scopeItems.length - hot,
        archived,
        stale,
        pinned: scopeItems.filter((item) => item.meta.pinned).length,
        usedChars: info.usedChars,
        budgetChars: info.budgetChars,
        budgetRatio: info.budgetChars > 0 ? Math.min(1, info.usedChars / info.budgetChars) : 0,
        topics: new Set(scopeItems.flatMap((item) => item.meta.tags ?? [])).size,
      })
      if (info.pinnedOverBudget) {
        warnings.push({
          code: 'pinned-over-budget',
          scope,
          message: `${scope === 'global' ? '全局' : scope} 的 pinned 条目已经超出热层预算，索引会变长。`,
        })
      }
      if (scopeItems.length === 0) {
        warnings.push({ code: 'empty-scope', scope, message: `${scope} 还没有任何记忆。` })
      }
    }
    for (const file of broken) {
      warnings.push({
        code: 'broken-item',
        scope: file.scope,
        message: `${file.scope}/${file.file} 解析失败：${file.error}`,
      })
    }
    if (settings.lastError) warnings.push({ code: 'last-error', message: `上次整理失败：${settings.lastError}` })
    const inboxItems = await inbox()
    return {
      home,
      scopes: rows,
      totals: {
        items: items.length,
        hot: rows.reduce((total, row) => total + row.hot, 0),
        cold: rows.reduce((total, row) => total + row.cold, 0),
        archived: rows.reduce((total, row) => total + row.archived, 0),
        stale: rows.reduce((total, row) => total + row.stale, 0),
        pinned: rows.reduce((total, row) => total + row.pinned, 0),
        tags: new Set(items.flatMap((item) => item.meta.tags ?? [])).size,
      },
      budget: {
        usedChars: rows.reduce((total, row) => total + row.usedChars, 0),
        budgetChars: rows.reduce((total, row) => total + row.budgetChars, 0),
      },
      schedule: {
        enabled: settings.enabled,
        deepFrequency: settings.deepFrequency,
        deepTime: settings.deepTime,
        idleMinutes: settings.idleMinutes,
        model: settings.model,
        maxLlmCalls: settings.maxLlmCalls,
        lastRun: settings.lastRun,
        lastLight: settings.lastLight,
        lastDeep: settings.lastDeep,
        nextRun: nextRunOf(settings),
      },
      inbox: { count: inboxItems.length },
      warnings,
      generatedAt: new Date().toISOString(),
    }
  }

  /**
   * 条目列表（不含正文）。
   * @param {object} [filters] - {scope, tier, type, tag, q}。
   * @returns {Promise<{items: object[], total: number}>} 列表。
   */
  async function listItemsForApi(filters = {}) {
    const stats = await readStats(home)
    const { items } = await allItems()
    const tiers = await tierMap(stats)
    if (filters.tier === 'archived') return listArchivedForApi(filters)
    const q = String(filters.q ?? '').trim().toLowerCase()
    const rows = []
    for (const item of items) {
      if (filters.scope && item.scope !== filters.scope) continue
      if (filters.type && item.meta.type !== filters.type) continue
      if (filters.tag && !(item.meta.tags ?? []).includes(filters.tag)) continue
      const info = tiers.get(item.scope)
      const tier = info?.hot.has(item.name) ? 'hot' : 'cold'
      if (filters.tier && filters.tier !== 'all' && filters.tier !== tier) continue
      if (q) {
        const haystack = `${item.name}\n${item.meta.description}\n${(item.meta.tags ?? []).join(' ')}`.toLowerCase()
        if (!haystack.includes(q)) continue
      }
      const heat = heatOf(stats, item.scope, item.name, { recentSessions: config.recentSessions })
      rows.push({
        scope: item.scope,
        name: item.name,
        description: item.meta.description,
        type: item.meta.type,
        tags: item.meta.tags,
        links: item.meta.links,
        pinned: item.meta.pinned === true,
        stale: item.meta.stale === true,
        tier,
        heat: heat.heat,
        hits: heat.hits,
        lastUsed: heat.lastUsed,
        created: item.meta.created,
        updated: item.meta.updated,
        verified_at: item.meta.verified_at,
        source: item.meta.source,
        bytes: Buffer.byteLength(item.raw, 'utf8'),
      })
    }
    rows.sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.heat - a.heat || b.updated.localeCompare(a.updated)))
    return { items: rows, total: rows.length }
  }

  /**
   * 归档区列表（tier=archived）。
   * @param {object} filters - {scope, q, type, tag}。
   * @returns {Promise<{items: object[], total: number}>} 列表。
   */
  async function listArchivedForApi(filters = {}) {
    const { readdir } = await import('node:fs/promises')
    const scopes = filters.scope ? [filters.scope] : await listScopes(home)
    const rows = []
    for (const scope of scopes) {
      const dir = join(home, 'archive', scopeDir(scope))
      let names = []
      try {
        names = await readdir(dir)
      } catch {
        continue
      }
      for (const file of names) {
        if (!file.endsWith('.md')) continue
        const text = await readTextOrNull(join(dir, file))
        if (text === null) continue
        const parsed = parseEntry(text)
        const baseName = file.replace(/\.\d{4}-\d{2}-\d{2}T[\d-]+Z\.md$/, '').replace(/\.md$/, '')
        const name = isName(parsed.meta?.name) ? parsed.meta.name : baseName
        if (!isName(name)) continue
        const meta = normalizeMeta(parsed.meta, { name })
        if (filters.type && meta.type !== filters.type) continue
        if (filters.tag && !meta.tags.includes(filters.tag)) continue
        if (filters.q) {
          const haystack = `${name}\n${meta.description}`.toLowerCase()
          if (!haystack.includes(String(filters.q).toLowerCase())) continue
        }
        rows.push({
          scope,
          name,
          description: meta.description,
          type: meta.type,
          tags: meta.tags,
          links: meta.links,
          pinned: meta.pinned === true,
          stale: meta.stale === true,
          tier: 'archived',
          archived: true,
          heat: 0,
          hits: 0,
          lastUsed: null,
          created: meta.created,
          updated: meta.updated,
          verified_at: meta.verified_at,
          source: meta.source,
          bytes: Buffer.byteLength(text, 'utf8'),
        })
      }
    }
    rows.sort((a, b) => b.updated.localeCompare(a.updated))
    return { items: rows, total: rows.length }
  }

  /**
   * 单条完整数据（设置页详情）。
   * @param {string} scope - 作用域。
   * @param {string} name - 条目名。
   * @returns {Promise<object|null>} 详情。
   */
  async function itemDetail(scope, name) {
    const item = await readItem(home, scope, name)
    if (!item) return null
    const stats = await readStats(home)
    const info = heatOf(stats, scope, name, { recentSessions: config.recentSessions })
    const tiers = await tierMap(stats)
    const tier = tiers.get(scope)?.hot.has(name) ? 'hot' : 'cold'
    const siblings = []
    for (const link of item.meta.links ?? []) {
      const target = link.includes(':')
        ? link.replace(':', '/')
        : `${scope}/${link}`
      const [linkScope, linkName] = [target.slice(0, target.indexOf('/')), target.slice(target.indexOf('/') + 1)]
      if (!linkName) continue
      const linked = await readItem(home, linkScope, linkName).catch(() => null)
      if (linked) siblings.push({ scope: linked.scope, name: linked.name, description: linked.meta.description })
    }
    const sameTag = []
    const scopeItems = (await listItems(home, scope)).items
    for (const tag of item.meta.tags ?? []) {
      for (const other of scopeItems) {
        if (other.name !== name && (other.meta.tags ?? []).includes(tag)) {
          sameTag.push({ scope: other.scope, name: other.name, description: other.meta.description, tag })
        }
      }
    }
    return {
      ...item,
      tier,
      stats: { heat: info.heat, hits: info.hits, lastUsed: info.lastUsed, readSessions: info.readSessions },
      links: siblings,
      sameTag: dedupeByKey(sameTag),
    }
  }

  /** 按 scope/name 去重。 */
  function dedupeByKey(rows) {
    const seen = new Set()
    return rows.filter((row) => {
      const key = `${row.scope}/${row.name}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  /**
   * 图谱数据（DESIGN.md §11.1）。
   * @param {{scope?: string}} [options] - 作用域过滤。
   * @returns {Promise<object>} 图。
   */
  async function graph(options = {}) {
    const stats = await readStats(home)
    const { items } = await allItems()
    const tiers = await tierMap(stats)
    return buildGraph({ items, stats, tiers, config, scope: options.scope })
  }

  /** 取会话笔记（注入/工具/API 共用）。 */
  async function notesFor(sessionId, workspace) {
    return loadNotes(home, sessionId, workspace)
  }

  /** 列出全部会话笔记（设置页只读）。 */
  async function listSessions() {
    return listNotes(home)
  }

  /** 清理（插件卸载）。 */
  function dispose() {
    disposed = true
    if (autoLightTimer) clearTimeout(autoLightTimer)
    autoLightTimer = null
    listeners.clear()
  }

  return {
    ctx,
    home,
    config,
    version: () => version,
    sessionInfo,
    scopeOf,
    ensureDirs,
    allItems,
    tierInfo,
    tierMap,
    generateIndex,
    readIndex,
    upsertEntry,
    previewEntry,
    saveUserItem,
    undoJournal,
    decideInbox,
    archiveEntry,
    restoreEntry,
    verifyEntry,
    markRead,
    markScopeSeen,
    recordError,
    recentErrors,
    errors,
    propose,
    inbox,
    search,
    runLight,
    overview,
    nextRunOf,
    listItemsForApi,
    itemDetail,
    graph,
    notesFor,
    listSessions,
    notesDigest,
    onWrite,
    bump,
    dispose,
    // 内部工具（consolidate 用）
    readStats,
    writeStats,
    readSettings,
    readTags,
    writeTags,
    normalizeTagList: (tags, doc) => normalizeTagList(tags, doc),
    appendJournal,
    parseEntry,
  }
}
