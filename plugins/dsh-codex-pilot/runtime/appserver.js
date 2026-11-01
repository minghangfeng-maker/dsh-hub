/**
 * 和 `codex app-server` 说话的 JSON-RPC 客户端（stdio，一行一条 JSON）。
 *
 * 整个 DSH 进程只起一个 app-server，所有 Codex 对话（thread）复用它：
 *   - 通知按 threadId 分发给正在跑的那一轮（bridge 注册的处理器）；
 *   - 服务端反过来发的请求（item/tool/call 动态工具、审批）同样按 threadId 交给那一轮处理；
 *   - 进程意外退出时，所有挂着的请求失败、所有在跑的轮次收到 server/exited，下次用到时重新拉起。
 *
 * ⚠ 本模块会被热加载：进程对象挂在 state.server 上跨代存活；行处理器只经 server.dispatch 间接调用，
 *    新一代模块每次 ensureServer 都把 dispatch 换成自己的实现。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import readline from 'node:readline'
// 带版本号 import：改 platform.js 也能热加载（ESM 按 URL 缓存）
const { terminateTree } = await import(`./platform.js${new URL(import.meta.url).search}`)

const CLIENT_INFO = { name: 'dsh-codex-pilot', title: 'DSH Codex', version: '0.1.0' }
// 这些通知对 DSH 没用，又很频繁（moderation 元数据每次几 KB）
const OPT_OUT = ['turn/moderationMetadata', 'rawResponseItem/completed', 'rawResponse/completed', 'account/rateLimits/updated', 'remoteControl/status/changed']

export function launchKey(launch) {
  return createHash('sha256')
    .update(JSON.stringify([launch.command, launch.args, launch.codexHome || '', launch.secretDigest || '']))
    .digest('hex')
    .slice(0, 16)
}

/**
 * 拿到可用的 app-server（必要时启动 / 按新的启动参数重启）。
 * launch = { command, args, env, codexHome, secretDigest }，由 setup.js 按当前凭据方式算出。
 */
export async function ensureServer(state, launch, { onDefaultRequest } = {}) {
  const key = launchKey(launch)
  let server = state.server
  // 启动参数变了但还有 Codex 回合在这个进程上跑：先接着用旧进程，等回合都结束了下次再换（不打断正在干的活）
  if (server && !server.closed && server.key !== key && server.threads.size > 0) {
    server.dispatch = (message) => dispatch(server, message)
    await server.ready
    return server
  }
  if (server && (server.closed || server.key !== key)) {
    if (!server.closed) shutdown(server, '启动参数变了（凭据或程序换了）')
    server = null
  }
  if (!server) {
    server = startServer(launch, key)
    state.server = server
  }
  server.onDefaultRequest = onDefaultRequest || server.onDefaultRequest
  server.dispatch = (message) => dispatch(server, message)
  await server.ready
  return server
}

function startServer(launch, key) {
  const child = spawn(launch.command, [...launch.args, 'app-server'], {
    env: launch.env,
    cwd: launch.cwd || undefined,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Windows：不隐藏窗口会带出一个黑窗口；经 cmd.exe 启动 .cmd 壳时要原样传参数
    windowsHide: true,
    ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}),
  })
  const server = {
    key,
    child,
    pid: child.pid,
    startedAt: Date.now(),
    nextId: 0,
    pending: new Map(),
    threads: new Map(),
    loaded: new Set(),
    listeners: new Set(),
    stderr: [],
    closed: false,
    exitInfo: null,
    dispatch: null,
    onDefaultRequest: null,
  }
  const lines = readline.createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    try {
      server.dispatch?.(message)
    } catch (error) {
      console.warn(`[codex-pilot] 处理 app-server 消息出错：${error?.message || error}`)
    }
  })
  child.stderr.on('data', (chunk) => {
    server.stderr.push(String(chunk))
    if (server.stderr.length > 200) server.stderr.splice(0, server.stderr.length - 200)
  })
  const onGone = (info) => {
    if (server.closed) return
    server.closed = true
    server.exitInfo = info
    const error = new Error(`codex app-server 已退出（${info}）${tail(server)}`)
    for (const { reject, timer } of server.pending.values()) {
      clearTimeout(timer)
      reject(error)
    }
    server.pending.clear()
    for (const handler of [...server.threads.values()]) {
      try {
        handler.onNotification?.({ method: 'server/exited', params: { message: error.message } })
      } catch {
        /* 那一轮自己收尾 */
      }
    }
  }
  child.on('exit', (code, signal) => onGone(signal ? `signal ${signal}` : `code ${code}`))
  child.on('error', (error) => onGone(error.message))
  server.dispatch = (message) => dispatch(server, message)
  server.ready = (async () => {
    await request(server, 'initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: OPT_OUT } }, 30000)
    notify(server, 'initialized')
  })()
  server.ready.catch(() => shutdown(server, '初始化失败'))
  return server
}

function tail(server) {
  const text = server.stderr.join('').trim()
  return text ? `：${text.slice(-600)}` : ''
}

export function shutdown(server, why = '') {
  if (!server || server.closed) return
  server.closed = true
  server.exitInfo = why || 'shutdown'
  for (const { reject, timer } of server.pending.values()) {
    clearTimeout(timer)
    reject(new Error(`codex app-server 已关闭${why ? `（${why}）` : ''}`))
  }
  server.pending.clear()
  // 先关 stdin（app-server 读到 EOF 会自己退出，实测 exit code 0），过几秒还在就杀进程树。
  // Windows 上没有 SIGTERM 语义，child.kill() 是 TerminateProcess；如果是 .cmd 壳或 node 壳，
  // 真实进程不会被带走，所以 platform.terminateTree 兜底用 taskkill /T。
  void terminateTree(server.child, { graceMs: 3000 })
}

function write(server, message) {
  if (server.closed) throw new Error(`codex app-server 不在运行${server.exitInfo ? `（${server.exitInfo}）` : ''}`)
  server.child.stdin.write(`${JSON.stringify(message)}\n`)
}

export function notify(server, method, params) {
  write(server, params === undefined ? { method } : { method, params })
}

export function request(server, method, params, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const id = ++server.nextId
    const timer = setTimeout(() => {
      server.pending.delete(id)
      reject(new Error(`codex app-server 请求超时：${method}`))
    }, timeoutMs)
    timer.unref?.()
    server.pending.set(id, { resolve, reject, timer, method })
    try {
      write(server, { id, method, params: params ?? {} })
    } catch (error) {
      clearTimeout(timer)
      server.pending.delete(id)
      reject(error)
    }
  })
}

function respond(server, id, result) {
  try {
    write(server, { id, result })
  } catch {
    /* 进程没了 */
  }
}

function respondError(server, id, message, code = -32000) {
  try {
    write(server, { id, error: { code, message } })
  } catch {
    /* 进程没了 */
  }
}

function threadIdOf(params) {
  return params?.threadId || params?.thread?.id || params?.conversationId || null
}

function dispatch(server, message) {
  // 响应
  if (message.id !== undefined && message.method === undefined) {
    const entry = server.pending.get(message.id)
    if (!entry) return
    server.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) {
      const error = new Error(message.error.message || JSON.stringify(message.error))
      error.code = message.error.code
      error.data = message.error.data
      entry.reject(error)
    } else entry.resolve(message.result)
    return
  }
  const threadId = threadIdOf(message.params)
  // 服务端发来的请求：交给那个 thread 的这一轮；没人认领就用默认策略
  if (message.id !== undefined) {
    const handler = threadId ? server.threads.get(threadId) : null
    const run = handler?.onRequest
      ? handler.onRequest(message.method, message.params)
      : Promise.resolve(server.onDefaultRequest?.(message.method, message.params))
    Promise.resolve(run)
      .then((result) => (result === undefined ? respondError(server, message.id, `DSH 不处理 ${message.method}`, -32601) : respond(server, message.id, result)))
      .catch((error) => respondError(server, message.id, String(error?.message || error)))
    return
  }
  if (message.method === 'thread/closed' && threadId) server.loaded.delete(threadId)
  if (threadId) server.threads.get(threadId)?.onNotification?.(message)
  for (const listener of [...server.listeners]) {
    try {
      listener(message)
    } catch {
      /* 监听者自己的问题 */
    }
  }
}

/** 订阅全局通知（例如 account/login/completed）；返回取消函数。 */
export function listen(server, listener) {
  server.listeners.add(listener)
  return () => server.listeners.delete(listener)
}

export function serverInfo(server) {
  if (!server) return null
  return { pid: server.pid, startedAt: server.startedAt, closed: server.closed, exit: server.exitInfo, threadsLoaded: server.loaded.size, activeTurns: server.threads.size }
}
