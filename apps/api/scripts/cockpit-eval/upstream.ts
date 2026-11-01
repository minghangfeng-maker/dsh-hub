/**
 * 座舱评测 / 冒烟 / e2e 用的**假模型上游**（OpenAI 兼容，`/v1/chat/completions`）。
 *
 * 它替代真模型，按预设脚本一步步吐出工具调用：
 *
 *   assistant(tool_calls: ops_find) → 座舱插件执行 → assistant(tool_calls: ops_call) → …
 *   → assistant(content: 最终一句话，finish_reason=stop)
 *
 * 脚本怎么选（按优先级）：
 * 1. `POST /__control/script {name}` 显式指定（评测脚本每跑一条场景前设一次）；
 * 2. 请求里**第一条 user 消息**命中 `script.prompts` 的某一串（包含匹配）；
 * 3. 兜底：直接回一句「未匹配到回放脚本」。
 *
 * 第几步由**请求里已有的 assistant(tool_calls) 条数**决定 —— 座舱 DSH 每轮会把完整历史
 * 带上来，所以这个计数天然等于「这是本回合第几次模型调用」。脚本用完就回最终文本，
 * 于是同一份脚本可以反复喂给不同场景而不会串味。
 *
 * 只做测试用：不校验任何密钥（上游本来就没有），不写网络外的任何东西；
 * 收到的请求只记在内存里（`GET /__control/state`），可选写一份 JSONL（`--log`）。
 *
 * CLI：
 *   node --import tsx apps/api/scripts/cockpit-eval/upstream.ts --port 8303 --scenarios
 *   node --import tsx apps/api/scripts/cockpit-eval/upstream.ts --port 8303 --scripts a.json
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { appendFileSync } from 'node:fs'

/** 一个脚本步骤：发一次带工具调用的助手消息 */
export interface ScriptStep {
  /** 工具名（`ops_find` / `ops_call` / `canvas_show` / `ops_wait` / `canvas_update` / `secret_request`） */
  tool: string
  /** 工具参数（会被 JSON.stringify 后分片发出） */
  args: Record<string, unknown>
  /** 这一步附带的助手文本（可空；座舱过程行会显示） */
  text?: string
}

/** 一条回放脚本（对应一个评测场景） */
export interface ReplayScript {
  /** 名字（评测里就是场景 id） */
  name: string
  /** 用来按「第一条用户消息」匹配的几串文本（包含匹配即可） */
  prompts?: string[]
  /** 依次发出的工具调用 */
  steps: ScriptStep[]
  /** 工具都用完后助手说的最后一句话 */
  finalText: string
}

/** 一条被记录下来的模型请求（只用于排障/报告，不含密钥） */
export interface UpstreamRequestLog {
  at: string
  /** `chat` = 正常对话（带 tools）；`title` = 不含 tools 的辅助请求（会话标题等） */
  kind: 'chat' | 'title'
  script: string | null
  matchedBy: 'active' | 'prompt' | 'fallback' | 'no-tools'
  step: number
  stream: boolean
  messageCount: number
  toolNames: string[]
  /** 最后一条 user 消息的前 120 字（看模型到底收到了什么） */
  lastUser?: string
}

export interface FakeUpstreamOptions {
  port: number
  host?: string
  scripts: ReplayScript[]
  /** 每步工具调用的延迟（毫秒，模拟模型思考；评测里用 0 更快） */
  stepDelayMs?: number
  /** 请求日志额外写一份 JSONL（`--log` 用） */
  logFile?: string
}

export interface FakeUpstreamHandle {
  readonly port: number
  /** 给容器用的基地址（`http://<host>:<port>/v1`） */
  url(host: string): string
  /** 当前选中的脚本名（没有则 null） */
  activeScript(): string | null
  setActiveScript(name: string | null): void
  /** 已收到的请求（按时间顺序） */
  requests(): UpstreamRequestLog[]
  reset(): void
  close(): Promise<void>
}

/** 与 OpenAI 兼容的模型名（座舱默认模型；容器里 managed.patch.yml 也用它） */
export const FAKE_MODEL_ID = 'deepseek-v4.1-flash'

/**
 * 启动假上游。返回句柄；`close()` 会关掉监听（不留后台资源）。
 */
export async function startFakeUpstream(options: FakeUpstreamOptions): Promise<FakeUpstreamHandle> {
  const scripts = new Map<string, ReplayScript>()
  for (const script of options.scripts) scripts.set(script.name, script)
  let active: string | null = null
  /** 运行时变量：脚本里的 `{{name}}` 在请求到来时替换（e2e 用它注入 secretRef 这类只能运行时拿到的值） */
  const vars = new Map<string, string>()
  const log: UpstreamRequestLog[] = []
  const stepDelayMs = options.stepDelayMs ?? 0

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }))
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake-upstream')
    const body = await readBody(req)

    // ── 控制端点（评测脚本 / e2e 用） ──────────────────────────────────
    if (url.pathname === '/__control/script' && req.method === 'POST') {
      const parsed = JSON.parse(body.text === '' ? '{}' : body.text) as { name?: unknown }
      const name = typeof parsed.name === 'string' && parsed.name !== '' ? parsed.name : null
      if (name !== null && !scripts.has(name)) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `没有脚本 ${name}` } }))
        return
      }
      active = name
      json(res, 200, { ok: true, active, names: [...scripts.keys()] })
      return
    }
    if (url.pathname === '/__control/state' && req.method === 'GET') {
      json(res, 200, { active, names: [...scripts.keys()], requests: log.slice(-500) })
      return
    }
    if (url.pathname === '/__control/scripts' && req.method === 'POST') {
      // 热换脚本：e2e 里 pluginId / versionId 要在 Hub 播种之后才知道（上游进程早起了）
      const parsed = JSON.parse(body.text === '' ? '{}' : body.text) as { scripts?: ReplayScript[] }
      for (const script of parsed.scripts ?? []) scripts.set(script.name, script)
      json(res, 200, { ok: true, names: [...scripts.keys()] })
      return
    }
    if (url.pathname === '/__control/vars' && req.method === 'POST') {
      // 运行时变量：`{vars:{name:value}}`（值为 null 时删掉）
      const parsed = JSON.parse(body.text === '' ? '{}' : body.text) as {
        vars?: Record<string, string | null>
      }
      for (const [name, value] of Object.entries(parsed.vars ?? {})) {
        if (value === null) vars.delete(name)
        else vars.set(name, String(value))
      }
      json(res, 200, { ok: true, vars: Object.fromEntries(vars) })
      return
    }
    if (url.pathname === '/__control/reset' && req.method === 'POST') {
      vars.clear()
      active = null
      log.splice(0, log.length)
      json(res, 200, { ok: true })
      return
    }
    if (url.pathname === '/__control/health' || url.pathname === '/healthz') {
      json(res, 200, { ok: true, names: [...scripts.keys()] })
      return
    }

    // ── OpenAI 兼容面 ────────────────────────────────────────────────
    if (url.pathname === '/v1/models' || url.pathname === '/models') {
      json(res, 200, {
        object: 'list',
        data: [{ id: FAKE_MODEL_ID, object: 'model', owned_by: 'cockpit-eval' }],
      })
      return
    }
    if ((url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions') && req.method === 'POST') {
      const request = JSON.parse(body.text === '' ? '{}' : body.text) as ChatRequest
      const messages = Array.isArray(request.messages) ? request.messages : []
      // 「本回合第几次模型调用」= **最后一条 user 消息之后**的 assistant(tool_calls) 条数。
      // 不能数整段历史：同一个会话里连续问第二个问题时，历史里的工具调用会把步号顶到脚本末尾，
      // 于是第二个问题直接拿到收尾文本、一个工具都不调（J11 验收 3 就是这样空跑的）。
      let lastUserIndex = -1
      messages.forEach((message, index) => {
        if (message.role === 'user') lastUserIndex = index
      })
      const toolCallTurns = messages
        .slice(lastUserIndex + 1)
        .filter(
          (message) => message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0,
        ).length
      const firstUser = firstUserText(messages)
      const requestTools = request.tools ?? []
      // 不带 tools 的请求是 DSH 的辅助调用（会话标题/压缩摘要）：**绝不能**当第一步回放工具调用
      const isChat = requestTools.length > 0
      const picked = isChat
        ? pickScript(active, firstUser, scripts)
        : { script: null, matchedBy: 'no-tools' as const }
      const step = picked.script?.steps[toolCallTurns] ?? null
      const entry: UpstreamRequestLog = {
        at: new Date().toISOString(),
        kind: isChat ? 'chat' : 'title',
        script: picked.script?.name ?? null,
        matchedBy: picked.matchedBy,
        step: toolCallTurns,
        stream: request.stream !== false,
        messageCount: messages.length,
        toolNames: (request.tools ?? []).map((tool) => tool?.function?.name ?? '').filter((name) => name !== ''),
        ...(firstUser === '' ? {} : { lastUser: firstUser.slice(0, 120) }),
      }
      log.push(entry)
      if (log.length > 2000) log.splice(0, log.length - 2000)
      if (options.logFile !== undefined) {
        try {
          appendFileSync(options.logFile, `${JSON.stringify(entry)}\n`)
        } catch {
          // 日志写不进去不影响回放
        }
      }
      if (stepDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, stepDelayMs))

      const resolved = step === null ? null : resolveDynamicArgs(step, messages, vars)
      if (resolved === null) {
        const text = !isChat
          ? titleOf(firstUser)
          : picked.script === null
            ? '（座舱评测：这一回合没有匹配到回放脚本，所以我不调用任何管理工具。）'
            : picked.script.finalText
        await respondText(res, request, text)
        return
      }
      await respondToolCall(res, request, resolved)
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `假上游没有实现 ${req.method ?? '?'} ${url.pathname}` } }))
  }

  function pickScript(
    activeName: string | null,
    firstUser: string,
    table: Map<string, ReplayScript>,
  ): { script: ReplayScript | null; matchedBy: 'active' | 'prompt' | 'fallback' } {
    if (activeName !== null) {
      const script = table.get(activeName)
      if (script !== undefined) return { script, matchedBy: 'active' }
    }
    if (firstUser !== '') {
      const haystack = normalize(firstUser)
      for (const script of table.values()) {
        for (const prompt of script.prompts ?? []) {
          if (prompt !== '' && haystack.includes(normalize(prompt))) return { script, matchedBy: 'prompt' }
        }
      }
    }
    return { script: null, matchedBy: 'fallback' }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host ?? '0.0.0.0', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : options.port

  return {
    port,
    url: (host: string) => `http://${host}:${String(port)}/v1`,
    activeScript: () => active,
    setActiveScript: (name: string | null) => {
      active = name
    },
    requests: () => [...log],
    reset: () => {
      active = null
      log.splice(0, log.length)
    },
    close: () => closeServer(server),
  }
}

// ── 响应构造 ──────────────────────────────────────────────────────────────

interface ChatRequest {
  model?: string
  stream?: boolean
  messages?: ChatMessage[]
  tools?: { function?: { name?: string } }[]
}

interface ChatMessage {
  role?: string
  content?: unknown
  tool_calls?: unknown[]
}

/** 助手说一句话（无工具调用）：`finish_reason=stop` */
async function respondText(res: ServerResponse, request: ChatRequest, text: string): Promise<void> {
  if (request.stream === false) {
    json(res, 200, {
      id: completionId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: request.model ?? FAKE_MODEL_ID,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: usageOf(0, text.length),
    })
    return
  }
  startSse(res)
  const base = chunkBase(request)
  writeChunk(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
  // 文本按 80 字一段发，贴近真模型的流式形态
  for (const piece of splitText(text, 80)) {
    writeChunk(res, { ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })
  }
  writeChunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  writeChunk(res, { ...base, choices: [], usage: usageOf(0, text.length) })
  endSse(res)
}

/** 助手发一次工具调用：`finish_reason=tool_calls` */
async function respondToolCall(res: ServerResponse, request: ChatRequest, step: ScriptStep): Promise<void> {
  const callId = `call_${Math.random().toString(36).slice(2, 12)}`
  const args = JSON.stringify(step.args ?? {})
  const text = step.text ?? ''
  if (request.stream === false) {
    json(res, 200, {
      id: completionId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: request.model ?? FAKE_MODEL_ID,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: text === '' ? null : text,
            tool_calls: [{ id: callId, type: 'function', function: { name: step.tool, arguments: args } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: usageOf(0, args.length),
    })
    return
  }
  startSse(res)
  const base = chunkBase(request)
  writeChunk(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
  if (text !== '') {
    for (const piece of splitText(text, 80)) {
      writeChunk(res, { ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })
    }
  }
  // 先发 id/name + 一半参数，再发剩下的参数：座舱插件按完整 JSON 解析，分片是 OpenAI 的正常形态
  const half = Math.max(1, Math.floor(args.length / 2))
  writeChunk(res, {
    ...base,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: callId,
              type: 'function',
              function: { name: step.tool, arguments: args.slice(0, half) },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  })
  writeChunk(res, {
    ...base,
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] },
        finish_reason: null,
      },
    ],
  })
  writeChunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  writeChunk(res, { ...base, choices: [], usage: usageOf(0, args.length) })
  endSse(res)
}

function chunkBase(request: ChatRequest): Record<string, unknown> {
  return {
    id: completionId(),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: request.model ?? FAKE_MODEL_ID,
  }
}

function usageOf(promptTokens: number, completionTokens: number): Record<string, unknown> {
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  }
}

function startSse(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
}

function writeChunk(res: ServerResponse, chunk: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`)
}

function endSse(res: ServerResponse): void {
  res.write('data: [DONE]\n\n')
  res.end()
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function completionId(): string {
  return `chatcmpl-fake-${Math.random().toString(36).slice(2, 12)}`
}

function splitText(text: string, size: number): string[] {
  const parts: string[] = []
  for (let index = 0; index < text.length; index += size) parts.push(text.slice(index, index + size))
  return parts
}

async function readBody(req: IncomingMessage): Promise<{ text: string }> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return { text: Buffer.concat(chunks).toString('utf8') }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections?.()
  })
}

function normalize(text: string): string {
  return text.replace(/\s+/gu, '').toLowerCase()
}

/** 第一条 user 消息的纯文本（多段 content 拼起来） */
/**
 * 动态参数：脚本里的 `{{lastProposalId}}` 换成「对话历史里最后一张方案卡的 id」。
 *
 * 为什么需要：`ops_wait` 要等的是**刚创建的那张方案卡**，而 id 是 Hub 分配的，
 * 回放脚本写不出来。历史里最后一条工具结果（插件渲染给人看的那句话）带着
 * 「方案卡 #12 已创建」，从这里取。
 */
function resolveDynamicArgs(step: ScriptStep, messages: ChatMessage[], vars?: Map<string, string>): ScriptStep {
  const raw = JSON.stringify(step.args ?? {})
  if (!raw.includes('{{')) return step
  if (vars !== undefined && vars.size > 0) {
    let text = raw
    for (const [name, value] of vars) text = text.replaceAll(`{{${name}}}`, value)
    if (!text.includes('{{lastProposalId}}')) return { ...step, args: JSON.parse(text) as Record<string, unknown> }
  }
  if (!raw.includes('{{lastProposalId}}')) return step
  let lastProposalId: number | null = null
  for (const message of messages) {
    const text = textOf(message.content)
    const matched = /方案卡\s*#(\d+)/u.exec(text) ?? /"proposal"\s*:\s*\{[^}]*"id"\s*:\s*(\d+)/u.exec(text)
    if (matched !== null) lastProposalId = Number(matched[1])
  }
  if (lastProposalId === null) return { ...step, args: JSON.parse(raw.replaceAll('{{lastProposalId}}', '1')) as Record<string, unknown> }
  return { ...step, args: JSON.parse(raw.replaceAll('{{lastProposalId}}', String(lastProposalId))) as Record<string, unknown> }
}

/** 辅助调用（标题生成）的答复：取用户话里的前 12 字，足够 DSH 当标题用 */
function titleOf(firstUser: string): string {
  const text = firstUser.trim()
  if (text === '') return '座舱会话'
  return text.length > 12 ? text.slice(0, 12) : text
}

function firstUserText(messages: ChatMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    return textOf(message.content)
  }
  return ''
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part !== null && typeof part === 'object' && 'text' in part) {
          const value = (part as { text?: unknown }).text
          return typeof value === 'string' ? value : ''
        }
        return ''
      })
      .join('\n')
  }
  return ''
}

// ── CLI（e2e / 手工排障） ──────────────────────────────────────────────────

function isMain(): boolean {
  const entry = process.argv[1] ?? ''
  return entry.endsWith('upstream.ts') || entry.endsWith('upstream.js')
}

if (isMain()) {
  const argv = process.argv.slice(2)
  const argOf = (name: string): string | null => {
    const index = argv.indexOf(name)
    return index >= 0 && index + 1 < argv.length ? (argv[index + 1] ?? null) : null
  }
  const port = Number(argOf('--port') ?? '8303')
  const scriptsFile = argOf('--scripts')
  const logFile = argOf('--log') ?? undefined
  const load = async (): Promise<ReplayScript[]> => {
    if (scriptsFile !== null) {
      const { readFileSync } = await import('node:fs')
      return JSON.parse(readFileSync(scriptsFile, 'utf8')) as ReplayScript[]
    }
    const scenarios = await import('./scenarios.js')
    return scenarios.replayScripts()
  }
  void load()
    .then(async (scripts) => {
      const handle = await startFakeUpstream({ port, scripts, ...(logFile === undefined ? {} : { logFile }) })
      process.stdout.write(
        `假模型上游已启动：http://127.0.0.1:${String(handle.port)}/v1（脚本 ${String(scripts.length)} 条：${scripts
          .map((script) => script.name)
          .join('、')}）\n`,
      )
      const shutdown = (): void => {
        void handle.close().then(() => process.exit(0))
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    })
    .catch((error: unknown) => {
      process.stderr.write(`假上游启动失败：${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    })
}
