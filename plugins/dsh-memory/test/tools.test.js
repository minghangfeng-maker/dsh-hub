/**
 * 模型工具：注册、读写、校验、受保护条目、子代理写权限、会话笔记。
 */

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { registerTools } from '../runtime/tools.js'
import { fakeAgent, fakeToolsContext, runTool, testService } from './helpers.js'

async function setup(options = {}) {
  const { home, service, cleanup } = await testService(options)
  const { ctx, tools } = fakeToolsContext()
  const dispose = registerTools(ctx, service)
  return { home, service, tools, dispose, cleanup }
}

const exec = () => ({ agent: fakeAgent(), signal: new AbortController().signal })

test('7 个工具都注册了，且描述里写了「用 memory_read 不要 cat」', async () => {
  const { tools, dispose, cleanup } = await setup()
  try {
    assert.deepEqual(
      [...tools.keys()].sort(),
      ['memory_archive', 'memory_note', 'memory_read', 'memory_search', 'memory_topic', 'memory_verify', 'memory_write'],
    )
    assert.match(tools.get('memory_read').description, /不要用 cat \/ read/)
    assert.match(tools.get('memory_write').description, /只记「下一个会话不知道就会做错或多走弯路」的事/)
    for (const definition of tools.values()) {
      assert.equal(definition.output.schema.type, 'object')
      assert.equal(typeof definition.output.render, 'function')
    }
  } finally {
    dispose()
    await cleanup()
  }
})

test('memory_write → memory_read → memory_search → memory_topic', async () => {
  const { home, tools, dispose, cleanup } = await setup()
  try {
    const written = await runTool(tools, 'memory_write', {
      name: 'relay-no-proxy',
      description: '访问 relay 必须设 NO_PROXY',
      type: 'reference',
      tags: ['dsh', '网络'],
      body: '**How:** export NO_PROXY=127.0.0.1，端口 7890',
      scope: 'global',
    }, exec())
    assert.equal(written.ok, true)
    assert.match(written.message, /已创建 global\/relay-no-proxy/)
    const file = await readFile(join(home, 'global', 'relay-no-proxy.md'), 'utf8')
    assert.match(file, /^name: relay-no-proxy$/m)
    assert.match(file, /^tags: \[dsh, 网络\]$/m)

    const read = await runTool(tools, 'memory_read', { name: 'relay-no-proxy', scope: 'global' }, exec())
    assert.equal(read.ok, true)
    assert.match(read.text, /export NO_PROXY/)
    assert.equal(read.fields.type, 'reference')
    assert.equal(read.fields.heat, 0)

    const search = await runTool(tools, 'memory_search', { query: 'NO_PROXY' }, exec())
    assert.equal(search.ok, true)
    assert.equal(search.total, 1)
    assert.equal(search.items[0].name, 'relay-no-proxy')

    const topic = await runTool(tools, 'memory_topic', { tag: '网络', scope: 'global' }, exec())
    assert.equal(topic.ok, true)
    assert.match(topic.text, /# 主题：网络/)
    assert.match(topic.text, /relay-no-proxy/)
  } finally {
    dispose()
    await cleanup()
  }
})

test('memory_read 不传 scope 时先查工作区再查全局', async () => {
  const { service, tools, dispose, cleanup } = await setup()
  try {
    const agent = { session: { id: 'session-tools', header: { id: 'session-tools', cwd: '/tmp/tools-ws' } }, options: {} }
    await service.upsertEntry({
      scope: 'global',
      name: 'both-scopes',
      description: '全局版本',
      type: 'reference',
      tags: ['dsh'],
      body: 'GLOBAL',
      sessionId: 's1',
    })
    await service.upsertEntry({
      scope: 'workspaces/--tmp-tools-ws--',
      name: 'both-scopes',
      description: '工作区版本',
      type: 'reference',
      tags: ['dsh'],
      body: 'WORKSPACE',
      sessionId: 's1',
    })
    const value = await runTool(tools, 'memory_read', { name: 'both-scopes' }, { agent, signal: new AbortController().signal })
    assert.equal(value.ok, true)
    assert.match(value.text, /WORKSPACE/)
    const explicit = await runTool(tools, 'memory_read', { name: 'both-scopes', scope: 'global' }, { agent, signal: new AbortController().signal })
    assert.match(explicit.text, /GLOBAL/)
  } finally {
    dispose()
    await cleanup()
  }
})

test('memory_archive / memory_verify', async () => {
  const { home, tools, dispose, cleanup } = await setup()
  try {
    await runTool(tools, 'memory_write', {
      name: 'old-note',
      description: '过时说明',
      type: 'project',
      tags: ['dsh'],
      body: '旧内容',
      scope: 'global',
    }, exec())
    const archived = await runTool(tools, 'memory_archive', { name: 'old-note', reason: '已经不做这个项目了', scope: 'global' }, exec())
    assert.equal(archived.ok, true)
    const archiveFiles = await readdir(join(home, 'archive', 'global'))
    assert.ok(archiveFiles.some((name) => name.startsWith('old-note')))
    assert.equal((await runTool(tools, 'memory_read', { name: 'old-note', scope: 'global' }, exec())).ok, false)

    await runTool(tools, 'memory_write', {
      name: 'project-live',
      description: '进行中的项目',
      type: 'project',
      tags: ['dsh'],
      body: '进度',
      scope: 'global',
    }, exec())
    const verified = await runTool(tools, 'memory_verify', { name: 'project-live', scope: 'global' }, exec())
    assert.equal(verified.ok, true)
    assert.match(verified.message, /已确认/)
  } finally {
    dispose()
    await cleanup()
  }
})

test('记忆名/标签/密钥的校验都在工具层生效', async () => {
  const { tools, dispose, cleanup } = await setup()
  try {
    const badName = await runTool(tools, 'memory_write', {
      name: '../etc/passwd',
      description: 'x',
      type: 'reference',
      tags: ['dsh'],
      body: 'x',
    }, exec())
    assert.equal(badName.ok, false)
    assert.match(badName.message, /记忆名不合法/)

    const badTags = await runTool(tools, 'memory_write', {
      name: 'ok-name',
      description: 'x',
      type: 'reference',
      tags: ['a', 'b', 'c', 'd'],
      body: 'x',
    }, exec())
    assert.equal(badTags.ok, false)
    assert.match(badTags.message, /1～3/)

    const secret = await runTool(tools, 'memory_write', {
      name: 'secret-leak',
      description: '别学我',
      type: 'reference',
      tags: ['dsh'],
      body: 'token = ghp_abcdefghijklmnopqrstuvwxyz',
    }, exec())
    assert.equal(secret.ok, false)
    assert.match(secret.message, /不要把密钥写进记忆/)
  } finally {
    dispose()
    await cleanup()
  }
})

test('受保护条目（feedback / pinned）的模型改写转成收件箱提议', async () => {
  const { home, service, tools, dispose, cleanup } = await setup()
  try {
    await service.upsertEntry({
      scope: 'global',
      name: 'protected-rule',
      description: '用户确认过的规则',
      type: 'feedback',
      tags: ['dsh'],
      body: '原正文',
      sessionId: 's1',
    })
    const result = await runTool(tools, 'memory_write', {
      name: 'protected-rule',
      description: '模型想改的规则',
      type: 'feedback',
      tags: ['dsh'],
      body: '模型改的正文',
      scope: 'global',
    }, exec())
    assert.equal(result.ok, true)
    assert.equal(result.pending, true)
    assert.match(result.message, /待用户审批/)
    // 原文件没变
    const file = await readFile(join(home, 'global', 'protected-rule.md'), 'utf8')
    assert.match(file, /原正文/)
    assert.doesNotMatch(file, /模型改的正文/)
    // 收件箱里有一条完整的改前/改后
    const inbox = await service.inbox()
    assert.equal(inbox.length, 1)
    assert.match(inbox[0].before, /原正文/)
    assert.match(inbox[0].after, /模型改的正文/)
  } finally {
    dispose()
    await cleanup()
  }
})

test('子代理：默认转收件箱；deny 直接拒绝；allow 放行', async () => {
  const subExec = () => ({
    agent: fakeAgent({ id: 'session-child', origin: 'subagent', depth: 1 }),
    signal: new AbortController().signal,
  })
  const { home, service, tools, dispose, cleanup } = await setup()
  try {
    const pending = await runTool(tools, 'memory_write', {
      name: 'child-proposal',
      description: '子代理的结论',
      type: 'reference',
      tags: ['dsh'],
      body: '正文',
      scope: 'global',
    }, subExec())
    assert.equal(pending.pending, true)
    assert.equal(await readFile(join(home, 'global', 'child-proposal.md'), 'utf8').catch(() => null), null)
    const inbox = await service.inbox()
    assert.equal(inbox.length, 1)
    // 记下来源，深整理时 AI 才知道这条提议是子代理提交的。
    assert.equal(inbox[0].origin, 'subagent')
    assert.equal(inbox[0].sessionId, 'session-child')

    const denyService = await testService({ prefix: 'dsh-mem-deny-', subagentWrites: 'deny' })
    try {
      const deny = fakeToolsContext()
      const disposeDeny = registerTools(deny.ctx, denyService.service)
      const denied = await runTool(deny.tools, 'memory_write', {
        name: 'child-denied',
        description: '不许写',
        type: 'reference',
        tags: ['dsh'],
        body: 'x',
        scope: 'global',
      }, subExec())
      assert.equal(denied.ok, false)
      assert.match(denied.message, /subagentWrites=deny/)
      assert.equal((await denyService.service.inbox()).length, 0)
      disposeDeny()
    } finally {
      await denyService.cleanup()
    }

    const allowService = await testService({ prefix: 'dsh-mem-allow-', subagentWrites: 'allow' })
    try {
      const allow = fakeToolsContext()
      const disposeAllow = registerTools(allow.ctx, allowService.service)
      const allowed = await runTool(allow.tools, 'memory_write', {
        name: 'child-allowed',
        description: '放行写入',
        type: 'reference',
        tags: ['dsh'],
        body: 'x',
        scope: 'global',
      }, subExec())
      assert.equal(allowed.ok, true)
      assert.equal(allowed.pending, undefined)
      assert.ok(await readFile(join(allowService.home, 'global', 'child-allowed.md'), 'utf8'))
      disposeAllow()
    } finally {
      await allowService.cleanup()
    }
  } finally {
    dispose()
    await cleanup()
  }
})

test('memory_note 的 add/list/update/remove 和总长校验', async () => {
  const { tools, dispose, cleanup } = await setup()
  try {
    const added = await runTool(tools, 'memory_note', { action: 'add', text: '不要动 prod', kind: 'constraint' }, exec())
    assert.equal(added.ok, true)
    assert.match(added.message, /已钉住笔记 n1/)

    const listed = await runTool(tools, 'memory_note', { action: 'list' }, exec())
    assert.equal(listed.notes.length, 1)
    assert.equal(listed.notes[0].kind, 'constraint')

    const updated = await runTool(tools, 'memory_note', { action: 'update', id: 'n1', text: '绝对不要动 prod' }, exec())
    assert.equal(updated.ok, true)
    assert.equal(updated.notes[0].text, '绝对不要动 prod')

    const removed = await runTool(tools, 'memory_note', { action: 'remove', id: 'n1' }, exec())
    assert.equal(removed.notes.length, 0)

    const bad = await runTool(tools, 'memory_note', { action: 'add', text: '' }, exec())
    assert.equal(bad.ok, false)
  } finally {
    dispose()
    await cleanup()
  }
})

test('子代理：settings.json 的临时覆盖在有效期内生效，过期后回落到插件配置', async () => {
  const { patchSettings } = await import('../runtime/store.js')
  const subExec = () => ({
    agent: fakeAgent({ id: 'session-child', origin: 'subagent', depth: 1 }),
    signal: new AbortController().signal,
  })
  const write = (tools, name) => runTool(tools, 'memory_write', {
    name, description: '导入', type: 'reference', tags: ['dsh'], body: '正文', scope: 'global',
  }, subExec())
  const { home, service, tools, dispose, cleanup } = await setup()
  try {
    // 有效期内的 allow：直接落盘
    await patchSettings(home, {
      subagentWritesOverride: 'allow',
      subagentWritesOverrideUntil: new Date(Date.now() + 60_000).toISOString(),
    })
    const allowed = await write(tools, 'override-allowed')
    assert.notEqual(allowed.pending, true)
    assert.ok(await readFile(join(home, 'global', 'override-allowed.md'), 'utf8'))

    // 已过期：回落到默认 inbox
    await patchSettings(home, { subagentWritesOverrideUntil: new Date(Date.now() - 1000).toISOString() })
    const expired = await write(tools, 'override-expired')
    assert.equal(expired.pending, true)
    assert.equal(await readFile(join(home, 'global', 'override-expired.md'), 'utf8').catch(() => null), null)

    // 非法值被 normalizeSettings 丢弃
    const settings = await patchSettings(home, { subagentWritesOverride: 'yolo' })
    assert.equal(settings.subagentWritesOverride, null)
    assert.equal(service.config.subagentWrites, 'inbox')
  } finally {
    await dispose?.()
    await cleanup()
  }
})
