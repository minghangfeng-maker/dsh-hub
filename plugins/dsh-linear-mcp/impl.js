/**
 * linear-mcp —— Host 半实现。
 *
 * 目标：让当前 DSH 会话用上 Linear 官方 MCP server（https://mcp.linear.app/mcp），
 * 并且凭据可以在「设置 → Linear」里配置，而不是写死在 cordis.patch.yml 里。
 *
 * 三条职责：
 *
 *   1. 凭据：只用 Linear API key —— 存在 ctx.credentials 的「引用」空间里，引用名是
 *      config.credentialRef（默认 LINEAR_API_KEY，同名环境变量也能命中）。每次操作都
 *      重新 resolve，所以设置页保存后立刻生效，不需要重启。Linear 官方文档明确支持
 *      `Authorization: Bearer <API key>`。
 *      （曾经还有一条「用 Linear 账号登录」的 OAuth 2.1 路，因为本部署是门户代理的
 *      明文 http 地址、而 Linear 只接受 https 或回环地址作回调，已移除；见 README。）
 *
 *   2. MCP：把已安装的 @deepseek-ai/dsh-mcp-client 插件用真实凭据挂起来
 *      （serverName = config.serverName，于是模型看到 mcp__linear__* 工具）。凭据变化
 *      时卸载重挂，工具集会原子替换。本地插件在 profile 里是 `link:` 安装的，不在
 *      harness 的 node_modules 解析路径上，所以这里通过 loader 按包名 import（它知道
 *      怎么解析随 dsh 安装的包），失败时再退回按绝对路径 import。
 *
 *   3. 设置页的后端：/_dsh/linear-mcp/state 与 /_dsh/linear-mcp/action 两个同源路由，
 *      都走 ctx.connection.requestRejection（Host/Origin 栅栏 + 浏览器会话）。
 *
 * 安全约定：这里的所有操作都是「授予/撤销凭据」这类用户动作，只给设置页用，
 * 不注册成 Agent 工具——模型不该能自己给自己发凭据。（模型侧的入口是挂上来的
 * mcp__linear__* 工具本身。）
 *
 * @module @local/dsh-linear-mcp/impl
 */

import { pathToFileURL } from 'node:url'

/** 路由前缀：与 profile 里其它插件一致，走 /_dsh/<插件>/... 的同源命名空间。 */
const BASE_PATH = '/_dsh/linear-mcp'
/** 设置页读状态（GET，只为 curl 排查方便；设置页用 action 里的 state）。 */
const STATE_PATH = `${BASE_PATH}/state`
/** 设置页写操作（POST { action, ...payload }）。 */
const ACTION_PATH = `${BASE_PATH}/action`
/** 开发用：让本行重新挂载，从而加载改动后的 impl.js。 */
const DEV_RELOAD_PATH = `${BASE_PATH}/dev-reload`

/** 插件版本（显示在设置页，便于确认跑的是哪一代代码）。 */
const VERSION = '1.0.0'
/** 挂上来的 MCP client 插件包名。 */
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'
/** 支持的 MCP 协议版本（协商失败时回退到更早的修订）。 */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26']
/** 默认配置；与 cordis.patch.yml 里那一行保持一致。 */
const DEFAULTS = {
  serverName: 'linear',
  endpoint: 'https://mcp.linear.app/mcp',
  readonly: false,
  credentialRef: 'LINEAR_API_KEY',
  toolCallTimeoutMs: 60000,
  requestTimeoutMs: 20000,
}

/** 推断「只读端点」。 */
function readonlyEndpoint(endpoint) {
  const url = String(endpoint)
  return url.endsWith('/readonly') ? url : `${url.replace(/\/+$/, '')}/readonly`
}

/** 收敛一份配置：Loader 行没有 schema，这里自己兜底。 */
function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const endpoint = typeof source.endpoint === 'string' && source.endpoint.trim() !== ''
    ? source.endpoint.trim()
    : DEFAULTS.endpoint
  const readonly = source.readonly === true
  const toolCallTimeoutMs = Number(source.toolCallTimeoutMs)
  const requestTimeoutMs = Number(source.requestTimeoutMs)
  return {
    serverName: typeof source.serverName === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(source.serverName)
      ? source.serverName
      : DEFAULTS.serverName,
    endpoint: readonly ? readonlyEndpoint(endpoint) : endpoint,
    configuredEndpoint: endpoint,
    readonly,
    credentialRef: typeof source.credentialRef === 'string' && source.credentialRef.trim() !== ''
      ? source.credentialRef.trim()
      : DEFAULTS.credentialRef,
    toolCallTimeoutMs: Number.isFinite(toolCallTimeoutMs) && toolCallTimeoutMs > 0
      ? Math.round(toolCallTimeoutMs)
      : DEFAULTS.toolCallTimeoutMs,
    requestTimeoutMs: Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
      ? Math.round(requestTimeoutMs)
      : DEFAULTS.requestTimeoutMs,
  }
}

/* ------------------------------------------------------------------ 小工具 */

/** 人类可读的错误文本。 */
function messageOf(error) {
  if (error === undefined || error === null) return 'unknown error'
  if (typeof error === 'string') return error
  return String(error.message ?? error)
}

/** 这个请求的 Host 是不是回环地址。 */
function isLoopbackHost(host) {
  if (typeof host !== 'string' || host === '') return false
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

/** 发送 JSON 响应。 */
function sendJson(res, status, payload) {
  const text = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

/**
 * 取一份可用凭据。
 *
 * 只有 API key 一条路：凭据库/环境变量里的 `config.credentialRef`（默认
 * `LINEAR_API_KEY`）。Linear 官方文档明确支持 `Authorization: Bearer <API key>`，
 * 所以这里不需要任何 OAuth 授权记录。
 *
 * @param ctx - 插件 Context。
 * @param cfg - 归一化配置。
 * @returns 凭据描述；没配置时 `token` 为空字符串。
 */
async function resolveCredential(ctx, cfg) {
  const credentials = ctx.get('credentials')
  if (!credentials || typeof credentials.resolve !== 'function') {
    return { configured: false, source: 'none', token: '', reason: 'no-credentials-service', refName: cfg.credentialRef }
  }
  return (await resolveApiKey(credentials, cfg))
    ?? { configured: false, source: 'none', token: '', reason: 'unset', refName: cfg.credentialRef }
}

/** 解析 API key 引用；没有就返回 null。 */
async function resolveApiKey(credentials, cfg) {
  try {
    const info = typeof credentials.describe === 'function' ? await credentials.describe(cfg.credentialRef) : undefined
    const hit = await credentials.resolve(cfg.credentialRef)
    const value = hit && typeof hit === 'object' && 'value' in hit ? hit.value : hit
    if (typeof value === 'string' && value !== '') {
      return {
        configured: true,
        source: 'api-key',
        token: value,
        refName: cfg.credentialRef,
        refSource: hit?.source,
        refWritable: info?.writable !== false,
      }
    }
  } catch {
    /* 解析失败按「没有」处理 */
  }
  return null
}

/** 带超时的 fetch（每个请求一个 AbortController）。 */
async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs))
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** 解析已安装的 dsh-mcp-client 插件模块；两条路都失败就抛错。 */
async function loadMcpClientModule(ctx) {
  const loader = ctx.get('loader')
  if (loader && typeof loader.import === 'function') {
    try {
      return await loader.import(MCP_CLIENT_PACKAGE, () => ['    at linear-mcp'])
    } catch (error) {
      ctx.logger?.debug?.(`linear-mcp: loader.import(${MCP_CLIENT_PACKAGE}) 失败：${messageOf(error)}`)
    }
  }
  // 兜底：从 dsh CLI 的位置按包名解析（随 dsh 安装的包在它的 node_modules 里）。
  // process.argv[1] 常常是 /usr/bin/dsh 这样的软链，先取真实路径再交给 createRequire。
  const { createRequire } = await import('node:module')
  const { realpathSync } = await import('node:fs')
  const bases = []
  for (const candidate of [process.argv[1], process.execPath]) {
    if (typeof candidate !== 'string' || candidate === '') continue
    try {
      bases.push(realpathSync(candidate))
    } catch {
      bases.push(candidate)
    }
  }
  for (const base of bases) {
    try {
      const resolved = createRequire(base).resolve(MCP_CLIENT_PACKAGE)
      return await import(pathToFileURL(resolved).href)
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error(`找不到 ${MCP_CLIENT_PACKAGE}（随 dsh 安装的 MCP 桥插件）`)
}

/** 把 MCP client 插件挂到本插件的 Context 下，用给定 token 连 Linear。 */
async function mountMcp(ctx, state) {
  await unmountMcp(state)
  const credential = state.credential
  if (!credential?.token) {
    state.mcp = { mounted: false, reason: 'no-credential' }
    return
  }
  const loader = ctx.get('loader')
  let module
  try {
    module = await loadMcpClientModule(ctx)
  } catch (error) {
    state.mcp = { mounted: false, error: messageOf(error) }
    return
  }
  const plugin = module?.default ?? module
  const config = {
    serverName: state.cfg.serverName,
    transport: 'streamable-http',
    url: state.cfg.endpoint,
    headers: { Authorization: `Bearer ${credential.token}` },
    toolCallTimeoutMs: state.cfg.toolCallTimeoutMs,
    failOnStartupError: false,
  }
  try {
    const fiber = ctx.plugin(plugin, config)
    state.mcpFiber = fiber
    state.mcp = { mounted: true, loaderImport: loader !== undefined }
    // 等它把连接和工具同步做完；连不上也不影响本插件（failOnStartupError: false），
    // 所以这里只记录结果、不向上抛。
    await Promise.race([
      Promise.resolve(fiber).then(() => undefined, (error) => { state.mcp.error = messageOf(error) }),
      new Promise((resolve) => { const timer = setTimeout(resolve, 20000); timer.unref?.() }),
    ])
  } catch (error) {
    state.mcp = { mounted: false, error: messageOf(error) }
  }
}

/** 卸载 MCP client（工具随之注销，serverName 命名空间释放）。 */
async function unmountMcp(state) {
  const fiber = state.mcpFiber
  state.mcpFiber = undefined
  if (!fiber) return
  try {
    fiber.dispose?.()
    await Promise.resolve(fiber).catch(() => undefined)
  } catch {
    /* 卸载失败不影响后续重挂 */
  }
}

/** 重新解析凭据并（按需）重挂 MCP client。 */
async function refreshMcp(ctx, state, options = {}) {
  const credential = await resolveCredential(ctx, state.cfg)
  state.credentialCheckedAt = Date.now()
  const changed = credential.token !== state.credential?.token
  state.credential = credential
  if (changed || options.force === true) await mountMcp(ctx, state)
  return credential
}

/**
 * 取工具表服务。
 *
 * `ctx.tools` 这种属性访问会被 Cordis 的注入检查拦住（"cannot get property ... without
 * inject"），而 `ctx.get('tools')` 是显式的服务查询，不受 inject 声明限制；两条路都试，
 * 保证本插件在 inject 声明生效前后都能工作。
 */
function toolsService(ctx) {
  try {
    const viaGet = ctx.get?.('tools')
    if (viaGet) return viaGet
  } catch {
    /* 落到属性访问 */
  }
  try {
    return ctx.tools
  } catch {
    return undefined
  }
}

/** 当前挂上来的 Linear 工具名（按 serverName 前缀过滤）。 */
function currentTools(ctx, cfg) {
  const prefix = `mcp__${cfg.serverName}__`
  const tools = toolsService(ctx)
  try {
    const schemas = tools?.schemas?.() ?? []
    return schemas.map((schema) => schema?.name).filter((name) => typeof name === 'string' && name.startsWith(prefix))
  } catch {
    return []
  }
}

/**
 * 直接对 MCP 端点做一次 initialize + tools/list。
 *
 * 设置页的「测试连接」用它：不依赖挂上来的 MCP client，能立刻区分「凭据被拒」
 * 与「网络不通」，并把服务端当前的工具名报出来。
 */
async function probeMcp(cfg, token) {
  if (!token) return { ok: false, error: { code: 'no-credential', message: '还没有凭据：先填 API key 或用 Linear 账号登录' } }
  const baseHeaders = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
  }
  let sessionId
  let lastError
  for (const version of PROTOCOL_VERSIONS) {
    try {
      const init = await mcpRequest(cfg, cfg.endpoint, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'dsh-linear-mcp', version: VERSION } },
      }, baseHeaders, undefined, cfg.requestTimeoutMs)
      if (init.status === 401 || init.status === 403) {
        return {
          ok: false,
          error: {
            code: 'unauthorized',
            message: `Linear MCP 拒绝了这份凭据（HTTP ${init.status}）。请在 Linear → Settings → Account → Security & Access 里重新创建一个 API key（只读用途可以只勾 Read），再填到设置页。`,
          },
        }
      }
      if (!init.ok) {
        lastError = { code: `http-${init.status}`, message: `initialize 失败：HTTP ${init.status} ${init.text.slice(0, 200)}` }
        continue
      }
      if (init.result?.error) {
        lastError = { code: 'initialize-error', message: `initialize 被拒绝：${messageOf(init.result.error)}` }
        continue
      }
      sessionId = init.sessionId
      await mcpRequest(cfg, cfg.endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' }, baseHeaders, sessionId, cfg.requestTimeoutMs)
      const list = await mcpRequest(cfg, cfg.endpoint, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, baseHeaders, sessionId, cfg.requestTimeoutMs)
      if (!list.ok) {
        return { ok: false, error: { code: `http-${list.status}`, message: `tools/list 失败：HTTP ${list.status} ${list.text.slice(0, 200)}` } }
      }
      if (list.result?.error) {
        return { ok: false, error: { code: 'tools-error', message: `tools/list 被拒绝：${messageOf(list.result.error)}` } }
      }
      const tools = Array.isArray(list.result?.result?.tools) ? list.result.result.tools : []
      return {
        ok: true,
        protocolVersion: init.result?.result?.protocolVersion ?? version,
        serverInfo: init.result?.result?.serverInfo,
        tools: tools.map((tool) => ({ name: tool?.name, description: typeof tool?.description === 'string' ? tool.description : '' })),
      }
    } catch (error) {
      lastError = {
        code: error?.name === 'AbortError' ? 'timeout' : 'network',
        message: error?.name === 'AbortError' ? `请求超时（${cfg.requestTimeoutMs}ms）` : `请求失败：${messageOf(error)}`,
      }
    }
  }
  return { ok: false, error: lastError ?? { code: 'unknown', message: '探测失败' } }
}

/**
 * 发一次 MCP JSON-RPC 请求；JSON 与 SSE 两种响应都认。
 *
 * @returns `{ ok, status, sessionId, result, text }`；`result` 是解析出来的 JSON-RPC 报文。
 */
async function mcpRequest(cfg, url, payload, headers, sessionId, timeoutMs) {
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: sessionId ? { ...headers, 'mcp-session-id': sessionId } : headers,
    body: JSON.stringify(payload),
  }, timeoutMs)
  const nextSession = response.headers.get('mcp-session-id') ?? sessionId
  const text = await response.text()
  if (!response.ok && text === '') return { ok: false, status: response.status, sessionId: nextSession, text }
  const contentType = response.headers.get('content-type') ?? ''
  let result
  if (contentType.includes('text/event-stream')) {
    for (const chunk of text.split('\n\n')) {
      const data = chunk.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('')
      if (data === '') continue
      try {
        const parsed = JSON.parse(data)
        if (parsed && typeof parsed === 'object') { result = parsed; break }
      } catch {
        /* 忽略非 JSON 的事件 */
      }
    }
  } else if (text !== '') {
    try {
      result = JSON.parse(text)
    } catch {
      /* 非 JSON 响应：留给调用方看文本 */
    }
  }
  return { ok: response.ok, status: response.status, sessionId: nextSession, result, text }
}

/* ------------------------------------------------------------------ 路由 */

/** 设置页路由的鉴权：Host/Origin 栅栏 + 浏览器会话 Cookie。 */
function guardSettingsRequest(ctx, req, res) {
  const connection = ctx.get('connection')
  if (connection && typeof connection.requestRejection === 'function') {
    const rejection = connection.requestRejection(req)
    if (rejection !== undefined) {
      res.statusCode = rejection
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end(rejection === 401 ? 'dsh web authentication required\n' : 'forbidden\n')
      return false
    }
    return true
  }
  // 没有 connection 服务时退回最小检查：只接受回环 Host。
  if (!isLoopbackHost(req.headers?.host)) {
    sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'loopback only' } })
    return false
  }
  return true
}

/** 读一个 JSON 请求体（上限 64 KiB）。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/** 组装设置页需要的状态。 */
function statusOf(ctx, state) {
  const cfg = state.cfg
  const tools = currentTools(ctx, cfg)
  const credential = state.credential ?? { configured: false, source: 'none', token: '' }
  return {
    version: VERSION,
    endpoint: cfg.endpoint,
    configuredEndpoint: cfg.configuredEndpoint,
    readonly: cfg.readonly,
    serverName: cfg.serverName,
    toolPrefix: `mcp__${cfg.serverName}__`,
    credentialRef: cfg.credentialRef,
    credential: {
      configured: credential.configured === true,
      source: credential.source,
      refName: credential.refName ?? cfg.credentialRef,
      refSource: credential.refSource,
      refWritable: credential.refWritable !== false,
      reason: credential.reason,
    },
    mcp: {
      mounted: state.mcp?.mounted === true,
      error: state.mcp?.error,
      fiberError: state.mcpFiber?._error ? messageOf(state.mcpFiber._error) : undefined,
      connected: tools.length > 0,
      toolCount: tools.length,
      tools,
    },
    lastProbe: state.lastProbe ?? null,
    lastError: state.lastError ?? '',
  }
}

/** 处理一个设置页动作。 */
async function handleAction(ctx, state, action, payload) {
  const cfg = state.cfg
  const credentials = ctx.get('credentials')
  switch (action) {
    case 'state':
      // 凭据可能在别处被改（环境变量、设置 → 模型 → 凭据），隔一会儿重看一眼。
      if (isCredentialStale(state)) await refreshMcp(ctx, state)
      return statusOf(ctx, state)

    case 'saveKey': {
      const apiKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : ''
      if (apiKey === '') throw new Error('API key 不能为空')
      if (!credentials || typeof credentials.set !== 'function') throw new Error('这个部署没有凭据服务，无法保存 key')
      await credentials.set(cfg.credentialRef, apiKey)
      state.lastError = ''
      await refreshMcp(ctx, state, { force: true })
      state.lastProbe = await probeMcp(cfg, state.credential?.token ?? '')
      return statusOf(ctx, state)
    }

    case 'clearKey': {
      if (!credentials || typeof credentials.unset !== 'function') throw new Error('这个部署没有凭据服务')
      await credentials.unset(cfg.credentialRef)
      await refreshMcp(ctx, state)
      return statusOf(ctx, state)
    }

    case 'test': {
      const credential = await resolveCredential(ctx, cfg)
      state.credential = credential
      const probe = await probeMcp(cfg, credential.token)
      state.lastProbe = { at: Date.now(), ...probe }
      if (probe.ok && !state.mcpFiber && credential.token) await mountMcp(ctx, state)
      return statusOf(ctx, state)
    }

    case 'reload': {
      await refreshMcp(ctx, state, { force: true })
      return statusOf(ctx, state)
    }

    default:
      throw new Error(`未知动作：${String(action)}`)
  }
}

/**
 * 插件入口：注册路由，并在有凭据时把 Linear MCP 挂上来。
 *
 * @param ctx - 插件 Context。
 * @param rawConfig - Loader 行 config（无 Config schema，原样传入）。
 */
export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  const state = {
    cfg,
    credential: undefined,
    mcpFiber: undefined,
    mcp: { mounted: false },
    lastProbe: null,
    lastError: '',
  }

  // 首次连接放到下一个 tick：Linear 慢或不通时不应该拖慢 DSH 启动。
  ctx.effect(() => {
    const timer = setTimeout(() => {
      refreshMcp(ctx, state, { force: true }).catch((error) => {
        state.lastError = messageOf(error)
        ctx.logger?.warn?.(`linear-mcp: 初始化失败：${messageOf(error)}`)
      })
    }, 0)
    timer.unref?.()
    return () => clearTimeout(timer)
  }, 'linear-mcp: initial mount')

  ctx.effect(() => () => { void unmountMcp(state) }, 'linear-mcp: dispose mcp client')

  // GET /_dsh/linear-mcp/state —— curl 排查用。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATE_PATH,
    handler: (req, res) => {
      if (!guardSettingsRequest(ctx, req, res)) return
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('allow', 'GET, HEAD')
        sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use GET' } })
        return
      }
      if (isCredentialStale(state)) {
        refreshMcp(ctx, state).then(
          () => sendJson(res, 200, { ok: true, value: statusOf(ctx, state) }),
          (error) => sendJson(res, 200, { ok: true, value: { ...statusOf(ctx, state), lastError: messageOf(error) } }),
        )
        return
      }
      sendJson(res, 200, { ok: true, value: statusOf(ctx, state) })
    },
  }), `linear-mcp: GET ${STATE_PATH}`)

  // POST /_dsh/linear-mcp/action —— 设置页的全部写操作。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ACTION_PATH,
    handler: (req, res) => {
      void (async () => {
        if (!guardSettingsRequest(ctx, req, res)) return
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } })
          return
        }
        try {
          const body = await readJsonBody(req)
          const value = await handleAction(ctx, state, String(body.action ?? ''), body)
          sendJson(res, 200, { ok: true, value })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: { code: 'action-failed', message: messageOf(error) } })
        }
      })()
    },
  }), `linear-mcp: POST ${ACTION_PATH}`)

  // POST /_dsh/linear-mcp/dev-reload —— 让本行重新挂载以加载改动后的 impl.js。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DEV_RELOAD_PATH,
    handler: (req, res) => {
      if (!guardSettingsRequest(ctx, req, res)) return
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } })
        return
      }
      const loader = ctx.get('loader')
      if (!loader || typeof loader.entries !== 'function') {
        sendJson(res, 500, { ok: false, error: { code: 'no-loader', message: '拿不到 loader 服务，无法自刷新（重启 DSH 亦可）' } })
        return
      }
      let entry
      for (const row of loader.entries()) {
        if (row?.options?.id === 'linear-mcp') { entry = row; break }
      }
      if (!entry?.fiber) {
        sendJson(res, 500, { ok: false, error: { code: 'no-entry', message: '找不到本插件的 Loader 行' } })
        return
      }
      sendJson(res, 200, { ok: true, value: { reloading: true, version: VERSION } })
      const timer = setTimeout(() => {
        entry.fiber.restart().catch((error) => ctx.logger?.warn?.(`linear-mcp: 自刷新失败：${messageOf(error)}`))
      }, 250)
      timer.unref?.()
    },
  }), `linear-mcp: POST ${DEV_RELOAD_PATH}`)

  ctx.logger?.info?.(`linear-mcp: ${cfg.endpoint}（serverName=${cfg.serverName}，凭据引用 ${cfg.credentialRef}）`)
}

/**
 * 状态查询是否需要顺带重新解析一次凭据。
 *
 * API key 不会过期，但可能在别处被换掉（设置 → 模型 → 凭据 或环境变量）。设置页每
 * 几秒轮询一次，所以这里只加最小间隔：最长 10 秒一定会重看一眼，不给凭据库添压力。
 */
function isCredentialStale(state) {
  return Date.now() - (state.credentialCheckedAt ?? 0) >= 10000
}

/** 离线测试钩子（运行时不用）。 */
export const __test = {
  BASE_PATH,
  STATE_PATH,
  ACTION_PATH,
  DEV_RELOAD_PATH,
  DEFAULTS,
  normalizeConfig,
  readonlyEndpoint,
  isLoopbackHost,
}
