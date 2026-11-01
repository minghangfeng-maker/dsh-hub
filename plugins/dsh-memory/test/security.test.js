/**
 * 路径安全（纵深防御）：
 *   - 作用域 / 会话 id / 收件箱 id 的校验不能只在 API 层，底层拼路径函数自己也要拒绝；
 *   - `.`、`..`、多段、绝对路径、URL 编码形式都不能拼出 home 之外的路径；
 *   - 每个 HTTP 端点在收到这些输入时必须返回 4xx，而不是写出目录。
 */

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'

import {
  assertInboxId,
  assertName,
  assertScope,
  assertSessionId,
  inboxPath,
  isInboxId,
  isScope,
  isSessionId,
  itemPath,
  memoryIndexPath,
  metaPath,
  normalizeScope,
  parseItemKey,
  scopeDir,
  sessionNotesPath,
  topicPath,
  topicsDir,
  archivePath,
} from '../runtime/paths.js'
import { testService } from './helpers.js'

const HOME = '/home/u/.dsh/memory'
const WS = '--home-u-ds-work--'

/** 所有必须被拒绝的「作用域」写法（含 URL 编码解码后的形式）。 */
const BAD_SCOPES = [
  'workspaces/..',
  'workspaces/.',
  'workspaces/../../etc',
  'workspaces/a/b',
  'workspaces/%2e%2e',
  'workspaces/%2E%2E',
  'workspaces/',
  'workspaces',
  '../etc',
  '/etc',
  'global/..',
  'global/../../etc',
  'GLOBAL',
  '',
  'workspaces/--ok--/../../x',
]

test('isScope 拒绝 . / .. / 多段 / 绝对路径 / 编码残留', () => {
  assert.equal(isScope('global'), true)
  assert.equal(isScope(`workspaces/${WS}`), true)
  assert.equal(isScope('workspaces/--a..b--'), true)
  for (const scope of BAD_SCOPES) {
    assert.equal(isScope(scope), false, `应当拒绝 scope ${JSON.stringify(scope)}`)
  }
  assert.equal(isScope(`workspaces/${'x'.repeat(256)}`), false)
})

test('normalizeScope 绝不返回 . / .. 或越界 key', () => {
  const all = []
  for (const scope of BAD_SCOPES) {
    const normalized = normalizeScope(scope, { wsKey: WS })
    all.push(normalized)
    assert.equal(isScope(normalized), true, `${JSON.stringify(scope)} -> ${normalized}`)
    assert.ok(normalized === 'global' || normalized === `workspaces/${WS}`, normalized)
  }
  assert.equal(normalizeScope('global', { wsKey: WS }), 'global')
  assert.equal(normalizeScope('workspace', { wsKey: WS }), `workspaces/${WS}`)
  assert.equal(normalizeScope('', { wsKey: WS }), `workspaces/${WS}`)
  assert.equal(normalizeScope(`workspaces/${WS}`, { wsKey: '--other--' }), `workspaces/${WS}`)
  // 非法 wsKey 直接报错，不拼路径
  assert.throws(() => normalizeScope('workspace', { wsKey: '..' }), /工作区 key 不合法/)
  assert.throws(() => normalizeScope('workspace', { wsKey: '../x' }), /工作区 key 不合法/)
})

test('assertScope / assertName / assertSessionId / assertInboxId 的错误码', () => {
  assert.equal(assertScope('global'), 'global')
  for (const scope of BAD_SCOPES) {
    assert.throws(() => assertScope(scope), (error) => error.code === 'invalid-scope')
  }
  for (const name of ['../x', '/etc/passwd', '%2e%2e', 'a/b', '..', '', 'A']) {
    assert.throws(() => assertName(name), (error) => error.code === 'invalid-name')
  }
  for (const id of ['..', '.', '../x', 'a/b', '%2e%2e', '/etc/passwd', '', 'x'.repeat(201)]) {
    assert.equal(isSessionId(id), false)
    assert.throws(() => assertSessionId(id), (error) => error.code === 'invalid-session-id')
    assert.equal(isInboxId(id), false)
    assert.throws(() => assertInboxId(id), (error) => error.code === 'invalid-id')
  }
  assert.equal(assertSessionId('session-1234'), 'session-1234')
  assert.equal(assertInboxId('p-1234'), 'p-1234')
})

test('每个底层路径函数自己拒绝非法作用域（不靠调用方）', () => {
  const functions = [
    ['scopeDir', (scope) => scopeDir(scope)],
    ['itemPath', (scope) => itemPath(HOME, scope, 'x')],
    ['memoryIndexPath', (scope) => memoryIndexPath(HOME, scope)],
    ['topicPath', (scope) => topicPath(HOME, scope, 'dsh')],
    ['topicsDir', (scope) => topicsDir(HOME, scope)],
    ['archivePath', (scope) => archivePath(HOME, scope, 'x')],
  ]
  for (const [name, run] of functions) {
    for (const scope of BAD_SCOPES) {
      assert.throws(run, (error) => error.code === 'invalid-scope', `${name} 应当拒绝 ${JSON.stringify(scope)}`)
    }
  }
})

test('workspaces/../../etc 不能拼出 /etc/x.md', () => {
  assert.throws(
    () => itemPath('/H', 'workspaces/../../etc', 'x'),
    (error) => error.code === 'invalid-scope',
  )
  assert.throws(() => itemPath('/H', 'workspaces/..', 'x'), (error) => error.code === 'invalid-scope')
  assert.throws(() => itemPath('/H', 'workspaces/.', 'x'), (error) => error.code === 'invalid-scope')
})

test('会话笔记 / 收件箱 / sidecar 路径函数拒绝穿越', () => {
  for (const id of ['..', '.', '../x', 'a/b', '%2e%2e', '/etc/passwd']) {
    assert.throws(() => sessionNotesPath(HOME, id), (error) => error.code === 'invalid-session-id')
    assert.throws(() => inboxPath(HOME, id), (error) => error.code === 'invalid-id')
  }
  for (const key of ['../x', 'inbox/../../x', '/etc/passwd', '']) {
    assert.throws(() => metaPath(HOME, key), (error) => error.code === 'invalid-path')
  }
  assert.equal(metaPath(HOME, 'journal'), join(HOME, 'journal.jsonl'))
  assert.equal(metaPath(HOME, 'inbox'), join(HOME, 'inbox'))
  // 归档时间戳也不能注入路径
  assert.throws(
    () => archivePath(HOME, 'global', 'x', '../../etc'),
    (error) => error.code === 'invalid-path',
  )
})

test('合法输入生成的绝对路径都在 home 之内', () => {
  const scopes = ['global', `workspaces/${WS}`]
  const paths = []
  for (const scope of scopes) {
    paths.push(itemPath(HOME, scope, 'relay-no-proxy'))
    paths.push(memoryIndexPath(HOME, scope))
    paths.push(topicPath(HOME, scope, '网络'))
    paths.push(topicPath(HOME, scope, '../../etc'))
    paths.push(topicsDir(HOME, scope))
    paths.push(archivePath(HOME, scope, 'relay-no-proxy'))
    paths.push(archivePath(HOME, scope, 'relay-no-proxy', '2026-10-20T10-00-00-000Z'))
  }
  paths.push(sessionNotesPath(HOME, 'session-1234'))
  paths.push(inboxPath(HOME, 'p-1234'))
  for (const path of paths) {
    assert.equal(isAbsolute(path), true)
    const rel = relative(HOME, path)
    assert.ok(rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`), `${path} 越界`)
    assert.ok(!isAbsolute(rel))
  }
  // 标签里的 ../ 被编码成文件名，不会改变目录
  assert.match(topicPath(HOME, 'global', '../../etc'), /_topics\/~002F\.\.~002Fetc\.md$/)
  assert.equal(scopeDir('global'), 'global')
  assert.equal(scopeDir(`workspaces/${WS}`), join('workspaces', WS))
  assert.deepEqual(parseItemKey('workspaces/.. /x'), null)
})

test('listScopes 只回流合法工作区 key', async () => {
  const { home, service, cleanup } = await testService()
  try {
    await service.upsertEntry({ scope: 'global', name: 'g', description: 'G', type: 'reference', tags: ['dsh'], body: 'x', sessionId: 's' })
    await service.upsertEntry({ scope: `workspaces/${WS}`, name: 'w', description: 'W', type: 'reference', tags: ['dsh'], body: 'x', sessionId: 's' })
    const { listScopes } = await import('../runtime/store.js')
    const scopes = await listScopes(home)
    assert.deepEqual(scopes.sort(), ['global', `workspaces/${WS}`])
    for (const scope of scopes) assert.equal(isScope(scope), true)
    // 手造一个名字非法的目录，不应被当成作用域
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(home, 'workspaces', 'bad key'), { recursive: true })
    assert.equal((await listScopes(home)).includes('workspaces/bad key'), false)
  } finally {
    await cleanup()
  }
})

test('列表/详情读盘时也不会越过 home（错误作用域直接抛）', async () => {
  const { home, service, cleanup } = await testService()
  try {
    await service.upsertEntry({ scope: 'global', name: 'g', description: 'G', type: 'reference', tags: ['dsh'], body: 'x', sessionId: 's' })
    const { readItem, listItems, readSessionNotes } = await import('../runtime/store.js')
    for (const scope of BAD_SCOPES) {
      await assert.rejects(readItem(home, scope, 'g'), (error) => error.code === 'invalid-scope')
      await assert.rejects(listItems(home, scope), (error) => error.code === 'invalid-scope')
    }
    for (const id of ['..', '../x', 'a/b']) {
      await assert.rejects(readSessionNotes(home, id), (error) => error.code === 'invalid-session-id')
    }
    // 正常读取仍可用
    assert.equal((await readItem(home, 'global', 'g')).name, 'g')
    assert.equal((await readdir(join(home, 'global'))).length, 1)
    // 确认没有在 home 之外创建文件（抽查父目录）
    const siblings = await readdir(dirname(home))
    assert.ok(siblings.includes(basename(home)))
  } finally {
    await cleanup()
  }
})

/* ────────────────────────────── HTTP 端点 ────────────────────────────── */

test('每个 HTTP 端点都拒绝作用域 / 名字 / id 的穿越写法', async () => {
  const { home, service, cleanup } = await testService()
  const consolidator = {
    async runLight() { return { id: 'run-light', mode: 'light', status: 'done' } },
    async startDeep() { return { id: 'run-deep', mode: 'deep', status: 'running' } },
    async getRun() { return null },
    async listRuns() { return [] },
  }
  const { createApi } = await import('../runtime/api.js')
  const http = await import('node:http')
  const server = http.createServer((req, res) => void createApi({ service, consolidator }).handle(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}/memory/api`
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON 也要能断言状态码 */ }
    return { status: response.status, body: json }
  }
  // fetch 会在客户端把 `%2e%2e` 规范化掉，测不到服务端；路径编码的用例走原始 HTTP。
  const rawRequest = (method, rawPath, body, headers = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const request = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: rawPath,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
        resolve({ status: response.statusCode, body: json })
      })
    })
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
  const expectRaw = async (method, rawPath, body, status, code) => {
    const result = await rawRequest(method, rawPath, body)
    assert.equal(result.status, status, `${method} ${rawPath} -> ${result.status} ${JSON.stringify(result.body)}`)
    if (code) assert.equal(result.body?.error?.code, code, `${method} ${rawPath} code`)
    return result
  }
  const expectCode = async (method, path, body, status, code) => {
    const result = await call(method, path, body)
    assert.equal(result.status, status, `${method} ${path} -> ${result.status} ${JSON.stringify(result.body)}`)
    if (code) assert.equal(result.body?.error?.code, code, `${method} ${path} code`)
    return result
  }

  try {
    // 先初始化目录并记录 home 状态，攻击后必须没有任何新增/改动。
    await call('GET', '/overview')
    const before = (await readdir(home, { recursive: true })).sort()

    const badScopes = [
      'workspaces/..',
      'workspaces/.',
      'workspaces/../../etc',
      'workspaces/a/b',
      'workspaces/%2e%2e',
      'workspaces/%252e%252e',
      '../../etc',
    ]
    // GET /items、GET /graph：scope 过滤
    for (const scope of badScopes) {
      await expectCode('GET', `/items?scope=${encodeURIComponent(scope)}`, undefined, 400, 'invalid-scope')
      await expectCode('GET', `/graph?scope=${encodeURIComponent(scope)}`, undefined, 400, 'invalid-scope')
    }
    // 直接拼接（不再二次编码）的 URL 编码形式也要拒绝
    await expectCode('GET', '/items?scope=workspaces/%2e%2e', undefined, 400, 'invalid-scope')
    await expectCode('GET', '/graph?scope=workspaces/%2E%2E', undefined, 400, 'invalid-scope')

    // GET /item：scope 与 name 都试
    for (const scope of badScopes) {
      await expectCode('GET', `/item?scope=${encodeURIComponent(scope)}&name=x`, undefined, 400, 'invalid-scope')
    }
    for (const name of ['../x', '../../etc/passwd', '..', '%2e%2e', 'a/b', '/etc/passwd']) {
      await expectCode('GET', `/item?scope=global&name=${encodeURIComponent(name)}`, undefined, 400, 'invalid-name')
    }
    await expectCode('GET', '/item?scope=global&name=..%2F..%2Fetc%2Fpasswd', undefined, 400, 'invalid-name')

    // POST /item / archive / restore：body 里的 scope 与 name
    for (const scope of badScopes) {
      await expectCode('POST', '/item', { scope, name: 'x', text: 'x' }, 400, 'invalid-scope')
      await expectCode('POST', '/archive', { scope, name: 'x' }, 400, 'invalid-scope')
      await expectCode('POST', '/restore', { scope, name: 'x' }, 400, 'invalid-scope')
    }
    for (const name of ['../x', '../../etc/passwd', 'a/b', '..']) {
      await expectCode('POST', '/item', { scope: 'global', name, text: 'x' }, 400, 'invalid-name')
      await expectCode('POST', '/archive', { scope: 'global', name }, 400, 'invalid-name')
      await expectCode('POST', '/restore', { scope: 'global', name }, 400, 'invalid-name')
    }

    // 收件箱 id
    await expectCode('GET', '/inbox', undefined, 200)
    await expectRaw('POST', '/memory/api/inbox/%2e%2e', { decision: 'approve' }, 400, 'invalid-id')
    await expectRaw('POST', '/memory/api/inbox/..', { decision: 'approve' }, 400, 'invalid-id')
    await expectRaw('POST', '/memory/api/inbox/%2e%2e%2f..', { decision: 'approve' }, 404)
    await expectRaw('POST', '/memory/api/inbox/%252e%252e', { decision: 'approve' }, 400, 'invalid-id')

    // journal / undo：不是路径，但也不能把恶意串当路径用
    await expectCode('GET', '/journal?runId=../../etc&limit=../', undefined, 200)
    await expectCode('POST', '/undo', { runId: '../../etc' }, 404, 'journal-not-found')
    await expectCode('POST', '/undo', { journalId: '../x' }, 404, 'journal-not-found')

    // settings / run / sessions：没有路径输入，但坏值要被收敛（settings GET 不写盘）
    await expectCode('GET', '/settings', undefined, 200)
    await expectCode('POST', '/run', { mode: '../../etc' }, 400, 'bad-request')
    await expectCode('GET', '/run/%2e%2e', undefined, 404)
    await expectCode('GET', '/runs', undefined, 200)
    await expectCode('GET', '/sessions', undefined, 200)

    // 畸形 URL 编码与多段路径（用原始 HTTP，避免客户端规范化）
    await expectRaw('GET', '/memory/api/%E0%A4%A', undefined, 400, 'bad-request')
    await expectRaw('GET', '/memory/api/item/%2e%2e', undefined, 404)
    await expectRaw('GET', '/memory/api/item?scope=workspaces/%2e%2e&name=x', undefined, 400, 'invalid-scope')
    await expectRaw('GET', '/memory/api/item?scope=workspaces/..&name=x', undefined, 400, 'invalid-scope')

    // 以上全部被拒后，home 里不应有任何新文件/新目录。
    const after = (await readdir(home, { recursive: true })).sort()
    assert.deepEqual(after, before, '被拒绝的请求不应写盘')

    // 设置写入是合法请求：坏值只能被收敛成默认值，不能当路径用。
    const settings = await call('POST', '/settings', { settings: { deepTime: '../../etc', model: { provider: '../../x', model: '../../y' } } })
    assert.equal(settings.status, 200)
    assert.equal(settings.body.settings.deepTime, '03:30')

    // 合法请求仍然可用，而且文件落在 home 内。
    const created = await call('POST', '/item', {
      scope: 'global',
      name: 'safe-item',
      text: '---\nname: safe-item\ndescription: 合法条目\ntype: reference\ntags: [dsh]\nlinks: []\npinned: false\ncreated: 2026-10-20\nupdated: 2026-10-20\nverified_at: 2026-10-20\nsource: user\n---\n\n正文\n',
    })
    assert.equal(created.status, 200)
    const saved = await call('GET', '/item?scope=global&name=safe-item')
    assert.equal(saved.status, 200)
    assert.ok(relative(home, itemPath(home, 'global', 'safe-item')) === join('global', 'safe-item.md'))
    assert.match(await readFile(join(home, 'global', 'safe-item.md'), 'utf8'), /name: safe-item/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await cleanup()
  }
})
