import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryPilot } from '../runtime/pilot.js'
import { fakeAgent, testService } from './helpers.js'

test('pilot tools share entries, preserve workspace identity, heat and protected writes', async () => {
  const { service, home, cleanup } = await testService()
  try {
    const bridge = createMemoryPilot(service)
    assert.equal(bridge.specs.length, 7)
    const claude = fakeAgent({ id: 'claude-test', cwd: '/tmp/pilot-one' })
    const codex = fakeAgent({ id: 'codex-test', cwd: '/tmp/pilot-one' })
    const other = fakeAgent({ id: 'other-test', cwd: '/tmp/pilot-two' })
    const args = { name: 'shared-entry', description: 'Shared pilot entry', type: 'reference', tags: ['pilot'], body: 'shared value' }
    assert.equal((await bridge.execute('memory_write', args, { agent: claude })).isError, false)
    assert.match((await bridge.execute('memory_read', { name: args.name }, { agent: codex })).text, /shared value/)
    assert.equal((await bridge.execute('memory_read', { name: args.name }, { agent: other })).isError, true)
    const { readStats } = await import('../runtime/stats.js')
    assert.match(JSON.stringify(await readStats(home)), /codex-test/)
    await bridge.execute('memory_write', { ...args, name: 'protected-entry', pinned: true }, { agent: claude })
    const protectedResult = await bridge.execute('memory_write', { ...args, name: 'protected-entry', body: 'changed' }, { agent: codex })
    assert.match(protectedResult.text, /审批/)
    const child = fakeAgent({ id: 'child-test', cwd: '/tmp/pilot-one', depth: 1 })
    assert.match((await bridge.execute('memory_write', { ...args, name: 'child-entry' }, { agent: child })).text, /审批/)
    assert.equal((await bridge.execute('memory_read', { name: args.name })).isError, true)
  } finally { service.dispose(); await cleanup() }
})

test('pilot index sends baseline once, later updates, and notes again after compaction', async () => {
  const { service, cleanup } = await testService()
  try {
    const bridge = createMemoryPilot(service)
    const agent = fakeAgent()
    const events = []
    agent.session.snapshotEvents = () => events
    const first = await bridge.prepare(agent)
    assert.match(first.text, /<memory>/)
    const second = await bridge.prepare(agent, first.state)
    assert.equal(second.text, '')
    await bridge.execute('memory_write', { name: 'new-entry', description: 'new shared memory', type: 'reference', tags: ['pilot'], body: 'body' }, { agent })
    const updated = await bridge.prepare(agent, second.state)
    assert.match(updated.text, /<memory-update>/)
    assert.doesNotMatch(updated.text, /<memory>/)
    await bridge.execute('memory_note', { action: 'add', text: 'preserve this note', kind: 'fact' }, { agent })
    const withNotes = await bridge.prepare(agent, updated.state)
    assert.match(withNotes.text, /preserve this note/)
    assert.equal((await bridge.prepare(agent, withNotes.state)).text, '')
    events.push({ type: 'compaction/end' })
    assert.match((await bridge.prepare(agent, withNotes.state)).text, /preserve this note/)
  } finally { service.dispose(); await cleanup() }
})
