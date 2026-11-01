/**
 * 会话记忆：增删改查、4000 字符上限、晋升候选、30 天归档。
 */

import assert from 'node:assert/strict'
import { readFile, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  addNote,
  archiveOldSessionNotes,
  listNotes,
  loadNotes,
  markPromoted,
  notesChars,
  notesDigest,
  promotionCandidates,
  removeNote,
  renderNotesForInjection,
  updateNote,
} from '../runtime/notes.js'
import { MAX_SESSION_NOTES_CHARS } from '../runtime/paths.js'
import { testService } from './helpers.js'

test('新增/修改/删除笔记，id 递增且写盘', async () => {
  const { home, cleanup } = await testService()
  try {
    const workspace = '--home-alice-project--'
    const first = await addNote(home, 'session-1', workspace, { text: '不要动 prod', kind: 'constraint' })
    assert.equal(first.note.id, 'n1')
    const second = await addNote(home, 'session-1', workspace, { text: '先跑测试', kind: 'todo' })
    assert.equal(second.note.id, 'n2')
    const doc = await loadNotes(home, 'session-1', workspace)
    assert.equal(doc.workspace, workspace)
    assert.equal(doc.notes.length, 2)

    const updated = await updateNote(home, 'session-1', 'n2', { text: '先跑全部测试', kind: 'decision' })
    assert.equal(updated.notes[1].text, '先跑全部测试')
    assert.equal(updated.notes[1].kind, 'decision')

    const removed = await removeNote(home, 'session-1', 'n1')
    assert.equal(removed.notes.length, 1)

    const file = JSON.parse(await readFile(join(home, 'sessions', 'session-1.json'), 'utf8'))
    assert.equal(file.notes.length, 1)
  } finally {
    await cleanup()
  }
})

test('笔记类型与空正文校验', async () => {
  const { home, cleanup } = await testService()
  try {
    await assert.rejects(addNote(home, 's', '', { text: '', kind: 'fact' }), /不能为空/)
    await assert.rejects(addNote(home, 's', '', { text: 'x', kind: 'bogus' }), /笔记类型只能是/)
    await assert.rejects(updateNote(home, 's', 'n9', { text: 'x' }), /没有这条笔记/)
    await assert.rejects(removeNote(home, 's', 'n9'), /没有这条笔记/)
  } finally {
    await cleanup()
  }
})

test('总长超过 4000 字符被拒绝（要求先合并）', async () => {
  const { home, cleanup } = await testService()
  try {
    await addNote(home, 's', '', { text: '字'.repeat(MAX_SESSION_NOTES_CHARS - 10), kind: 'fact' })
    await assert.rejects(
      addNote(home, 's', '', { text: '字'.repeat(20), kind: 'fact' }),
      /会话笔记总共最多 4000 字符/,
    )
  } finally {
    await cleanup()
  }
})

test('notesDigest 只随内容变化；renderNotesForInjection 逐字列出', async () => {
  const { home, cleanup } = await testService()
  try {
    const before = notesDigest(await loadNotes(home, 's', ''))
    await addNote(home, 's', '', { text: '逐字保留的约束', kind: 'constraint' })
    const doc = await loadNotes(home, 's', '')
    assert.notEqual(notesDigest(doc), before)
    const text = renderNotesForInjection(doc)
    assert.match(text, /^<session-notes>/)
    assert.match(text, /- \[constraint\] 逐字保留的约束/)
    assert.equal(notesChars(doc), 7)
    assert.equal(renderNotesForInjection({ notes: [] }), '')
  } finally {
    await cleanup()
  }
})

test('晋升候选只看空闲 ≥6 小时、未处理过的 constraint/decision', async () => {
  const { home, cleanup } = await testService()
  try {
    await addNote(home, 'old', 'ws', { text: '不要动 prod', kind: 'constraint' })
    await addNote(home, 'old', 'ws', { text: '普通事实', kind: 'fact' })
    await addNote(home, 'fresh', 'ws', { text: '刚落下的决定', kind: 'decision' })
    const old = new Date(Date.now() - 8 * 3_600_000)
    await utimes(join(home, 'sessions', 'old.json'), old, old)

    const candidates = await promotionCandidates(home, { idleHours: 6 })
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0].sessionId, 'old')
    assert.deepEqual(candidates[0].notes.map((note) => note.id), ['n1'])

    await markPromoted(home, 'old', ['n1'])
    assert.equal((await loadNotes(home, 'old')).promoted.includes('n1'), true)
    assert.deepEqual(await promotionCandidates(home, { idleHours: 6 }), [])
  } finally {
    await cleanup()
  }
})

test('超过 30 天的会话笔记移到 archive/sessions/', async () => {
  const { home, cleanup } = await testService()
  try {
    await addNote(home, 'stale-session', 'ws', { text: '旧会话', kind: 'fact' })
    const old = new Date(Date.now() - 40 * 86_400_000)
    await utimes(join(home, 'sessions', 'stale-session.json'), old, old)
    const moved = await archiveOldSessionNotes(home, { days: 30 })
    assert.deepEqual(moved, ['stale-session'])
    const archived = JSON.parse(await readFile(join(home, 'archive', 'sessions', 'stale-session.json'), 'utf8'))
    assert.equal(archived.notes.length, 1)
    assert.deepEqual(await listNotes(home), [])
  } finally {
    await cleanup()
  }
})
