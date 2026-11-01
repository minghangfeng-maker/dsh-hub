/**
 * 路径与命名规则：工作区 key 必须和 DSH 会话目录一致；名字/作用域/标签不能变成路径。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertName,
  assertTags,
  normalizeScope,
  tagFileKey,
  workspaceKey,
} from '../runtime/paths.js'

test('workspaceKey 与 dsh-session-persistence-jsonl 的 projectKey 一致', () => {
  assert.equal(workspaceKey('/home/alice/project'), '--home-alice-project--')
  assert.equal(workspaceKey('/home/alice/project/dsh-memory'), '--home-alice-project-dsh-memory--')
  assert.equal(workspaceKey('/'), '--root--')
  assert.equal(workspaceKey('C:\\Users\\me\\proj'), '--C-Users-me-proj--')
  // 非安全码元写成 ~XXXX（中文路径）
  assert.equal(workspaceKey('/tmp/记忆'), '--tmp-~8BB0~5FC6--')
})

test('条目名白名单拒绝路径穿越与非法字符', () => {
  assert.equal(assertName('relay-needs-no-proxy'), 'relay-needs-no-proxy')
  assert.equal(assertName('a1'), 'a1')
  for (const bad of ['../etc/passwd', '/abs', 'a/b', '%2e%2e', 'A-Upper', '-lead', '', 'a'.repeat(65), '名字']) {
    assert.throws(() => assertName(bad), /记忆名不合法/, `应当拒绝 ${JSON.stringify(bad)}`)
  }
})

test('normalizeScope 只产出 global 或 workspaces/<key>', () => {
  const wsKey = '--home-alice-project--'
  assert.equal(normalizeScope('global', { wsKey }), 'global')
  assert.equal(normalizeScope('workspace', { wsKey }), `workspaces/${wsKey}`)
  assert.equal(normalizeScope(undefined, { wsKey }), `workspaces/${wsKey}`)
  assert.equal(normalizeScope(`workspaces/${wsKey}`, { wsKey: 'other' }), `workspaces/${wsKey}`)
  // 非法/路径注入一律回落到默认作用域，绝不拼进路径
  assert.equal(normalizeScope('../../etc', { wsKey }), `workspaces/${wsKey}`)
  assert.equal(normalizeScope('workspaces/../x', { wsKey }), `workspaces/${wsKey}`)
})

test('标签校验：1～3 个、去重、拒绝控制字符', () => {
  assert.deepEqual(assertTags(['dsh', '网络']), ['dsh', '网络'])
  assert.deepEqual(assertTags(['a', 'a']), ['a'])
  assert.throws(() => assertTags([]), /1～3/)
  assert.throws(() => assertTags(['a', 'b', 'c', 'd']), /1～3/)
  assert.throws(() => assertTags(['a\u0000b']), /标签不合法/)
})

test('主题页文件名编码不会产生路径', () => {
  assert.equal(tagFileKey('dsh'), 'dsh')
  assert.equal(tagFileKey('网络'), '网络')
  assert.equal(tagFileKey('../evil'), '~002Fevil')
  assert.equal(tagFileKey('..'), 'tag')
  assert.equal(tagFileKey('a/b'), 'a~002Fb')
  assert.ok(tagFileKey('长'.repeat(100)).length <= 80)
})
