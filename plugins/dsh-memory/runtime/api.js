/**
 * `/memory/api` 同源 HTTP 端点（DESIGN.md §9）。
 *
 * 客户端只传 `scope` + `name`，永远不传路径；路径字符串由 service 层用
 * 白名单拼出来。所有返回都是 JSON；出错是 `{ error: { code, message } }`。
 *
 * 写请求要求同源（拒绝 `Sec-Fetch-Site: cross-site` 与 Origin 不匹配），
 * 同源路由用同一套理由：端口只监听回环，但不设防的话
 * 浏览器里任意网页都能 POST 进来改记忆。
 *
 * @module @local/dsh-memory/api
 */

import { isInboxId, isScope, NAME_RE } from './paths.js'

/** 路由前缀。 */
export const API_PREFIX = '/memory/api'

/** 请求体上限。 */
const MAX_BODY_BYTES = 256 * 1024

/** journal 默认/最大条数。 */
const JOURNAL_LIMIT = 50
const JOURNAL_LIMIT_MAX = 500

/* ────────────────────────────── HTTP 小工具 ────────────────────────────── */

/** 发 JSON。 */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 发错误（统一形状）。 */
export function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } })
}

/** 同源校验：只接受来自本 GUI 的写请求。 */
export function sameOriginOk(req) {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin) {
    const host = req.headers.host
    if (!host) return false
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  return true
}

/** 读 JSON 请求体。 */
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    let tooLarge = false
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // 不要 destroy：连接被掐掉时客户端只会看到 HTTP 000，拿不到 413 和错误码。
        // 继续把剩余字节读掉（不缓存），在 end 时统一拒绝。
        tooLarge = true
        chunks.length = 0
        return
      }
      if (!tooLarge) chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) {
        const error = new Error(`请求体过大（上限 ${MAX_BODY_BYTES} 字节）`)
        error.code = 'payload-too-large'
        return reject(error)
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) return resolve({})
      try {
        const parsed = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          const error = new Error('请求体必须是 JSON 对象')
          error.code = 'bad-request'
          return reject(error)
        }
        resolve(parsed)
      } catch {
        const error = new Error('请求体不是合法 JSON')
        error.code = 'bad-request'
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** 从查询串取字符串。 */
function q(url, key) {
  const value = url.searchParams.get(key)
  return value === null ? undefined : value
}

/** 需要 scope。 */
function requireScope(value) {
  if (!isScope(value)) {
    const error = new Error('缺少或非法的 scope（global / workspaces/<key>）')
    error.code = 'invalid-scope'
    throw error
  }
  return value
}

/** 需要 name。 */
function requireName(value) {
  if (typeof value !== 'string' || !NAME_RE.test(value)) {
    const error = new Error('缺少或非法的 name')
    error.code = 'invalid-name'
    throw error
  }
  return value
}

/* ────────────────────────────── 路由表 ────────────────────────────── */

/**
 * 创建 API 处理器。
 * @param {{service: object, consolidator: object, scheduler?: object}} deps - 依赖。
 * @returns {{handle: (req, res) => Promise<void>, routes: string[]}} 处理器。
 */
export function createApi(deps) {
  const { service, consolidator } = deps
  const scheduler = deps.scheduler

  const routes = [
    ['GET', /^\/overview$/, overview],
    ['GET', /^\/items$/, items],
    ['GET', /^\/item$/, getItem],
    ['POST', /^\/item$/, saveItem],
    ['POST', /^\/archive$/, archive],
    ['POST', /^\/restore$/, restore],
    ['GET', /^\/journal$/, journal],
    ['POST', /^\/undo$/, undo],
    ['GET', /^\/inbox$/, inboxList],
    ['POST', /^\/inbox\/([^/]+)$/, inboxAct],
    ['GET', /^\/settings$/, getSettings],
    ['POST', /^\/settings$/, saveSettings],
    ['POST', /^\/run$/, startRun],
    ['GET', /^\/run\/([^/]+)$/, getRun],
    ['GET', /^\/runs$/, listRuns],
    ['GET', /^\/graph$/, graph],
    ['GET', /^\/sessions$/, sessions],
  ]

  /* ── 概览 ── */
  async function overview(req, res, url) {
    const data = await service.overview()
    sendJson(res, 200, {
      ok: true,
      ...data,
      errors: service.recentErrors?.() ?? [],
    })
  }

  /* ── 条目列表 ── */
  async function items(req, res, url) {
    const scope = q(url, 'scope')
    if (scope !== undefined && scope !== '' && !isScope(scope)) {
      return sendError(res, 400, 'invalid-scope', 'scope 只能是 global 或 workspaces/<key>')
    }
    const tier = q(url, 'tier')
    if (tier !== undefined && !['hot', 'cold', 'archived', 'all'].includes(tier)) {
      return sendError(res, 400, 'bad-request', 'tier 只能是 hot / cold / archived / all')
    }
    const result = await service.listItemsForApi({
      scope: scope || undefined,
      tier: tier || undefined,
      type: q(url, 'type'),
      tag: q(url, 'tag'),
      q: q(url, 'q'),
    })
    sendJson(res, 200, { ok: true, ...result })
  }

  /* ── 单条 ── */
  async function getItem(req, res, url) {
    const scope = requireScope(q(url, 'scope'))
    const name = requireName(q(url, 'name'))
    const item = await service.itemDetail(scope, name)
    if (!item) return sendError(res, 404, 'not-found', `没有找到 ${scope}/${name}`)
    sendJson(res, 200, { ok: true, item })
  }

  async function saveItem(req, res) {
    const body = await readJsonBody(req)
    const scope = requireScope(body.scope)
    const name = requireName(body.name)
    if (typeof body.text !== 'string') {
      return sendError(res, 400, 'bad-request', '缺少 text')
    }
    const result = await service.saveUserItem({ scope, name, text: body.text })
    const item = await service.itemDetail(scope, name)
    sendJson(res, 200, { ok: true, created: result.created, changed: result.changed, item })
  }

  /* ── 归档 / 恢复 ── */
  async function archive(req, res) {
    const body = await readJsonBody(req)
    const scope = requireScope(body.scope)
    const name = requireName(body.name)
    const result = await service.archiveEntry({
      scope,
      name,
      actor: 'user',
      sessionId: 'user',
      reason: typeof body.reason === 'string' ? body.reason : 'settings archive',
    })
    if (!result.existed) return sendError(res, 404, 'not-found', `没有找到 ${scope}/${name}`)
    sendJson(res, 200, { ok: true, archived: true, scope, name })
  }

  async function restore(req, res) {
    const body = await readJsonBody(req)
    const scope = requireScope(body.scope)
    const name = requireName(body.name)
    const result = await service.restoreEntry({
      scope,
      name,
      actor: 'user',
      sessionId: 'user',
      reason: 'settings restore',
    })
    if (!result.restored) return sendError(res, 404, 'not-found', `归档区里没有 ${scope}/${name}`)
    sendJson(res, 200, { ok: true, restored: true, scope, name })
  }

  /* ── 日志 / 撤销 ── */
  async function journal(req, res, url) {
    const { readJournal } = await import('./store.js')
    const limit = Math.min(JOURNAL_LIMIT_MAX, Math.max(1, Number(q(url, 'limit') ?? JOURNAL_LIMIT) || JOURNAL_LIMIT))
    const runId = q(url, 'runId')
    const entries = await readJournal(service.home, {
      limit,
      ...(runId ? { runId } : {}),
    })
    sendJson(res, 200, { ok: true, entries, total: entries.length })
  }

  async function undo(req, res) {
    const body = await readJsonBody(req)
    const journalId = typeof body.journalId === 'string' ? body.journalId : undefined
    const runId = typeof body.runId === 'string' ? body.runId : undefined
    if (!journalId && !runId) return sendError(res, 400, 'bad-request', '需要 journalId 或 runId')
    const result = await service.undoJournal({ journalId, runId })
    sendJson(res, 200, { ok: true, ...result })
  }

  /* ── 收件箱 ── */
  async function inboxList(req, res) {
    const items = await service.inbox()
    sendJson(res, 200, { ok: true, items, total: items.length })
  }

  async function inboxAct(req, res, url, params) {
    if (!isInboxId(params[0])) {
      return sendError(res, 400, 'invalid-id', '收件箱 id 非法')
    }
    const body = await readJsonBody(req)
    const decision = body.decision
    if (decision !== 'approve' && decision !== 'reject') {
      return sendError(res, 400, 'bad-request', 'decision 只能是 approve / reject')
    }
    try {
      const result = await service.decideInbox(params[0], decision)
      sendJson(res, 200, { ok: true, applied: result.applied, id: params[0] })
    } catch (error) {
      if (error?.code === 'not-found') return sendError(res, 404, 'not-found', error.message)
      throw error
    }
  }

  /* ── 设置 ── */
  async function getSettings(req, res) {
    const { readSettings } = await import('./store.js')
    const settings = await readSettings(service.home)
    sendJson(res, 200, {
      ok: true,
      settings,
      nextRun: scheduler?.lastScheduledAt ? nextRunIso(settings) : null,
    })
  }

  async function saveSettings(req, res) {
    const { patchSettings } = await import('./store.js')
    const body = await readJsonBody(req)
    const patch = body.settings && typeof body.settings === 'object' ? body.settings : body
    // 只允许客户端改这几个字段；lastRun/lastLight/lastDeep 是运行结果，不能回写。
    const allowed = [
      'enabled',
      'deepFrequency',
      'deepTime',
      'idleMinutes',
      'model',
      'maxLlmCalls',
      'sessionIdleHours',
      'inboxReview',
      'inboxReviewMinConfidence',
      'inboxReviewMax',
    ]
    const rest = {}
    for (const key of allowed) {
      if (patch[key] !== undefined) rest[key] = patch[key]
    }
    const settings = await patchSettings(service.home, rest)
    sendJson(res, 200, { ok: true, settings, nextRun: nextRunIso(settings) })
  }

  /** 用设置算下一次深整理时间（复用 service 的实现）。 */
  function nextRunIso(settings) {
    try {
      return service.nextRunOf(settings)
    } catch {
      return null
    }
  }

  /* ── 运行 ── */
  async function startRun(req, res) {
    const body = await readJsonBody(req)
    const mode = body.mode === 'light' ? 'light' : body.mode === 'deep' ? 'deep' : null
    if (!mode) return sendError(res, 400, 'bad-request', 'mode 只能是 light / deep')
    if (mode === 'light') {
      const run = await consolidator.runLight({ reason: 'manual' })
      return sendJson(res, 200, { ok: true, runId: run.id, mode, run })
    }
    const run = await consolidator.startDeep({ reason: 'manual' })
    sendJson(res, 200, { ok: true, runId: run.id, mode, run })
  }

  async function getRun(req, res, url, params) {
    const id = params[0]
    const run = await consolidator.getRun(id)
    if (!run) return sendError(res, 404, 'not-found', `没有这次运行：${id}`)
    sendJson(res, 200, { ok: true, run })
  }

  async function listRuns(req, res) {
    const runs = await consolidator.listRuns()
    sendJson(res, 200, { ok: true, runs, total: runs.length })
  }

  /* ── 图谱 ── */
  async function graph(req, res, url) {
    const scope = q(url, 'scope')
    if (scope !== undefined && scope !== '' && !isScope(scope)) {
      return sendError(res, 400, 'invalid-scope', 'scope 只能是 global 或 workspaces/<key>')
    }
    const data = await service.graph({ scope: scope || undefined })
    sendJson(res, 200, { ok: true, ...data })
  }

  /* ── 会话记忆 ── */
  async function sessions(req, res) {
    const list = await service.listSessions()
    sendJson(res, 200, {
      ok: true,
      sessions: list.map((session) => ({
        sessionId: session.sessionId,
        workspace: session.workspace,
        notes: session.notes,
        promoted: session.promoted ?? [],
        mtime: session.mtime,
      })),
      total: list.length,
    })
  }

  /* ── 分发 ── */
  async function handle(req, res) {
    let pathname
    try {
      pathname = decodeURIComponent((req.url || '').split('?')[0])
    } catch {
      // 畸形的 % 编码会让 decodeURIComponent 抛错；不能让请求悬着。
      return sendError(res, 400, 'bad-request', 'URL 编码不合法')
    }
    if (!pathname.startsWith(API_PREFIX)) {
      return sendError(res, 404, 'not-found', '未知端点')
    }
    const url = new URL(req.url || '/', 'http://localhost')
    const rest = pathname.slice(API_PREFIX.length) || '/'
    const method = req.method || 'GET'
    let pathMatched = false
    for (const [routeMethod, pattern, handler] of routes) {
      const match = pattern.exec(rest)
      if (!match) continue
      pathMatched = true
      if (routeMethod !== method) continue
      if (method !== 'GET' && !sameOriginOk(req)) {
        return sendError(res, 403, 'forbidden', '只接受来自同一 Web UI 的写入')
      }
      let params
      try {
        params = match.slice(1).map((part) => decodeURIComponent(part))
      } catch {
        return sendError(res, 400, 'bad-request', 'URL 编码不合法')
      }
      try {
        return await handler(req, res, url, params)
      } catch (error) {
        return handleError(res, error)
      }
    }
    if (pathMatched) {
      res.writeHead(405, { allow: routes.filter(([, pattern]) => pattern.exec(rest)).map(([m]) => m).join(', ') })
      return res.end()
    }
    return sendError(res, 404, 'not-found', `未知端点：${method} ${rest}`)
  }

  return {
    handle,
    routes: [
      'GET  /memory/api/overview',
      'GET  /memory/api/items',
      'GET  /memory/api/item',
      'POST /memory/api/item',
      'POST /memory/api/archive',
      'POST /memory/api/restore',
      'GET  /memory/api/journal',
      'POST /memory/api/undo',
      'GET  /memory/api/inbox',
      'POST /memory/api/inbox/:id',
      'GET  /memory/api/settings',
      'POST /memory/api/settings',
      'POST /memory/api/run',
      'GET  /memory/api/run/:id',
      'GET  /memory/api/runs',
      'GET  /memory/api/graph',
      'GET  /memory/api/sessions',
    ],
  }
}

/** 把异常映射成 HTTP 响应。 */
function handleError(res, error) {
  const code = error?.code ?? 'internal'
  const statusByCode = {
    'invalid-name': 400,
    'invalid-scope': 400,
    'invalid-session-id': 400,
    'invalid-id': 400,
    'invalid-path': 400,
    'invalid-type': 400,
    'invalid-tags': 400,
    'invalid-description': 400,
    'invalid-links': 400,
    'invalid-item': 400,
    'invalid-query': 400,
    'invalid-kind': 400,
    'invalid-note': 400,
    'invalid-proposal': 400,
    'bad-request': 400,
    'payload-too-large': 413,
    'secret-detected': 422,
    'body-too-large': 422,
    'notes-full': 409,
    'note-not-found': 404,
    'journal-not-found': 404,
    'not-found': 404,
    'locked': 409,
    'busy': 409,
    'conflict': 409,
  }
  const status = statusByCode[code] ?? 500
  sendJson(res, status, { error: { code, message: String(error?.message || error) } })
}

/**
 * 注册路由到 webServer（照本仓其它插件的 `registerPanelRoute` 写法）。
 * @param {object} ctx - 带 webServer 的上下文的子上下文。
 * @param {object} deps - {service, consolidator, scheduler}。
 * @returns {() => void} 清理函数。
 */
export function registerMemoryRoutes(ctx, deps) {
  const webServer = ctx.get?.('webServer')
  if (!webServer?.register) return () => {}
  const api = createApi(deps)
  const dispose = webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: (req, res) => api.handle(req, res),
  })
  return () => dispose?.()
}
