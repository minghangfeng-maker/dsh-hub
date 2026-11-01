/**
 * 会话记忆（钉住的笔记）。
 *
 * 存在 `sessions/<session-id>.json`，和 DSH 的会话日志目录分开：这是插件自己的
 * 数据，不参与会话回放，也不会被压缩。压缩之后由注入层逐字重发（DESIGN.md §5.3）。
 *
 * @module @local/dsh-memory/notes
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { MAX_SESSION_NOTES_CHARS, NOTE_KINDS, assertInside, assertSessionId, sessionNotesPath } from './paths.js'
import {
  listSessionNotes,
  readSessionNotes,
  writeSessionNotes,
} from './store.js'

/** 空会话笔记。 */
export function emptyNotes(sessionId, workspace = '') {
  return { sessionId, workspace, notes: [], promoted: [] }
}

/**
 * 计算一份笔记的内容摘要（注入层用它判断「笔记是否变了」）。
 * @param {object|null} doc - 会话笔记文档。
 * @returns {string} 短摘要；没有笔记时是空串的哈希（固定值）。
 */
export function notesDigest(doc) {
  const notes = Array.isArray(doc?.notes) ? doc.notes : []
  const canonical = notes.map((note) => [note.id ?? '', note.kind ?? '', String(note.text ?? '')])
  return createHash('sha1').update(JSON.stringify(canonical)).digest('hex').slice(0, 16)
}

/** 会话笔记的字符数（正文总长，含 id/kind 的固定开销不算）。 */
export function notesChars(doc) {
  return (doc?.notes ?? []).reduce((total, note) => total + [...String(note.text ?? '')].length, 0)
}

/** 下一个笔记 id（n1、n2……）。 */
function nextNoteId(notes) {
  let max = 0
  for (const note of notes) {
    const match = /^n(\d+)$/.exec(String(note.id ?? ''))
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `n${max + 1}`
}

/** 校验 kind。 */
export function assertNoteKind(kind) {
  if (!NOTE_KINDS.includes(kind)) {
    const error = new Error(`笔记类型只能是 ${NOTE_KINDS.join(' / ')}`)
    error.code = 'invalid-kind'
    throw error
  }
  return kind
}

/**
 * 读一份会话笔记（不存在返回空结构，不创建文件）。
 * @param {string} home - 记忆根目录。
 * @param {string} sessionId - 会话 id。
 * @param {string} [workspace] - 工作区 key（文件不存在时填进空结构）。
 * @returns {Promise<object>} 会话笔记文档。
 */
export async function loadNotes(home, sessionId, workspace = '') {
  const doc = await readSessionNotes(home, sessionId)
  return doc ?? emptyNotes(sessionId, workspace)
}

/**
 * 新增一条笔记。
 * @param {string} home - 记忆根目录。
 * @param {string} sessionId - 会话 id。
 * @param {string} workspace - 工作区 key。
 * @param {{text: string, kind?: string}} input - 笔记正文与类型。
 * @returns {Promise<{doc: object, note: object}>} 更新后的文档与新笔记。
 */
export async function addNote(home, sessionId, workspace, input) {
  const text = String(input?.text ?? '').trim()
  if (!text) {
    const error = new Error('笔记正文不能为空')
    error.code = 'invalid-note'
    throw error
  }
  const kind = assertNoteKind(input?.kind ?? 'fact')
  const doc = await loadNotes(home, sessionId, workspace)
  const next = {
    ...doc,
    workspace: doc.workspace || workspace,
    notes: [...doc.notes, { id: nextNoteId(doc.notes), text, kind, at: new Date().toISOString() }],
  }
  assertNotesBudget(next)
  await writeSessionNotes(home, sessionId, next)
  return { doc: next, note: next.notes.at(-1) }
}

/** 校验笔记总长。 */
export function assertNotesBudget(doc) {
  const chars = notesChars(doc)
  if (chars > MAX_SESSION_NOTES_CHARS) {
    const error = new Error(
      `会话笔记总共最多 ${MAX_SESSION_NOTES_CHARS} 字符（当前 ${chars}）。先合并或删掉几条，再记新的。`,
    )
    error.code = 'notes-full'
    throw error
  }
  return doc
}

/**
 * 修改一条笔记的正文/类型。
 * @param {string} home - 记忆根目录。
 * @param {string} sessionId - 会话 id。
 * @param {string} id - 笔记 id（n1）。
 * @param {{text?: string, kind?: string}} patch - 要改的字段。
 * @returns {Promise<object>} 更新后的文档。
 */
export async function updateNote(home, sessionId, id, patch) {
  const doc = await loadNotes(home, sessionId)
  const index = doc.notes.findIndex((note) => note.id === id)
  if (index < 0) {
    const error = new Error(`没有这条笔记：${id}`)
    error.code = 'note-not-found'
    throw error
  }
  const current = doc.notes[index]
  const next = { ...current }
  if (patch?.text !== undefined) {
    const text = String(patch.text).trim()
    if (!text) {
      const error = new Error('笔记正文不能为空')
      error.code = 'invalid-note'
      throw error
    }
    next.text = text
  }
  if (patch?.kind !== undefined) next.kind = assertNoteKind(patch.kind)
  const notes = [...doc.notes]
  notes[index] = next
  const updated = { ...doc, notes }
  assertNotesBudget(updated)
  await writeSessionNotes(home, sessionId, updated)
  return updated
}

/**
 * 删一条笔记。
 * @param {string} home - 记忆根目录。
 * @param {string} sessionId - 会话 id。
 * @param {string} id - 笔记 id。
 * @returns {Promise<object>} 更新后的文档。
 */
export async function removeNote(home, sessionId, id) {
  const doc = await loadNotes(home, sessionId)
  const notes = doc.notes.filter((note) => note.id !== id)
  if (notes.length === doc.notes.length) {
    const error = new Error(`没有这条笔记：${id}`)
    error.code = 'note-not-found'
    throw error
  }
  const updated = { ...doc, notes }
  await writeSessionNotes(home, sessionId, updated)
  return updated
}

/**
 * 列出全部会话笔记（设置页只读视图）。
 * @param {string} home - 记忆根目录。
 * @returns {Promise<object[]>} 按修改时间倒序。
 */
export async function listNotes(home) {
  return listSessionNotes(home)
}

/**
 * 找出可以交给深整理判断晋升的笔记。
 *
 * 只看超过 `idleHours` 没活动、且还有未处理 constraint/decision 笔记的会话
 * （DESIGN.md §7）。"活动"用文件 mtime 近似。
 * @param {string} home - 记忆根目录。
 * @param {{idleHours?: number, now?: Date}} [options] - 空闲阈值。
 * @returns {Promise<{sessionId: string, workspace: string, notes: object[], mtime: number}[]>} 候选。
 */
export async function promotionCandidates(home, options = {}) {
  const idleHours = options.idleHours ?? 6
  const now = options.now ?? new Date()
  const sessions = await listSessionNotes(home)
  const out = []
  for (const session of sessions) {
    const idleMs = now.getTime() - Number(session.mtime ?? 0)
    if (idleMs < idleHours * 3_600_000) continue
    const promoted = new Set(session.promoted ?? [])
    const notes = (session.notes ?? []).filter(
      (note) => ['constraint', 'decision'].includes(note.kind) && !promoted.has(note.id),
    )
    if (notes.length > 0) out.push({ ...session, notes })
  }
  return out
}

/**
 * 标记若干笔记已被处理（晋升或判定为无价值），避免下次重复交给 LLM。
 * @param {string} home - 记忆根目录。
 * @param {string} sessionId - 会话 id。
 * @param {string[]} ids - 笔记 id 列表。
 * @returns {Promise<object>} 更新后的文档。
 */
export async function markPromoted(home, sessionId, ids) {
  const doc = await loadNotes(home, sessionId)
  const promoted = new Set(doc.promoted ?? [])
  for (const id of ids) promoted.add(id)
  const updated = { ...doc, promoted: [...promoted] }
  await writeSessionNotes(home, sessionId, updated)
  return updated
}

/**
 * 归档超过 N 天的会话笔记文件（轻整理做，DESIGN.md §7）。
 * @param {string} home - 记忆根目录。
 * @param {{days?: number, now?: Date}} [options] - 天数阈值。
 * @returns {Promise<string[]>} 被移动的会话 id。
 */
export async function archiveOldSessionNotes(home, options = {}) {
  const days = options.days ?? 30
  const now = options.now ?? new Date()
  const sessions = await listSessionNotes(home)
  const moved = []
  const { mkdir, rename } = await import('node:fs/promises')
  const archiveDir = join(home, 'archive', 'sessions')
  for (const session of sessions) {
    const ageMs = now.getTime() - Number(session.mtime ?? 0)
    if (ageMs < days * 86_400_000) continue
    try {
      // sessionId 来自文件内容，可能是手改的 `../x`：先过白名单再拼路径。
      const sessionId = assertSessionId(session.sessionId)
      await mkdir(archiveDir, { recursive: true, mode: 0o700 })
      const target = assertInside(home, join(archiveDir, `${sessionId}.json`), '归档会话笔记路径')
      await rename(sessionNotesPath(home, sessionId), target)
      moved.push(sessionId)
    } catch {
      // 文件刚好被删/被占用：跳过，下一次轻整理再试
    }
  }
  return moved
}

/**
 * 渲染注入用的 `<session-notes>` 正文（逐字列出全部笔记）。
 * @param {object} doc - 会话笔记文档。
 * @returns {string} 注入文本；没有笔记时返回空串。
 */
export function renderNotesForInjection(doc) {
  const notes = Array.isArray(doc?.notes) ? doc.notes : []
  if (notes.length === 0) return ''
  const lines = [
    '<session-notes>',
    '以下是本会话钉住的笔记（用户或模型明确要求记住的约束与决定，逐字保留，压缩不丢）：',
  ]
  for (const note of notes) {
    lines.push(`- [${note.kind ?? 'fact'}] ${note.text}`)
  }
  lines.push('</session-notes>')
  return lines.join('\n')
}
