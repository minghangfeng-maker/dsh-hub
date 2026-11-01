import { randomUUID } from 'node:crypto'
import { request } from 'node:http'
import type { DshCookieMinter } from './dsh-cookie.js'
import type { UpstreamTarget } from './types.js'

/**
 * 会话探针（docs/22 §6.1；WP33）：向容器里的 DSH 发一次 `session/list` RPC，读
 * `result.value.items[].running` 与 `updatedAt`。
 *
 * 上游语义（`@deepseek-ai/dsh` 的 session-controller）：
 * - `index.ts:268-279` `@Remote('list') list(_request, signal)`：注释明确
 *   “Read all visible Session rows without resuming an Agent”，**只读、不 attach、不建会话**；
 * - `list.ts:127-165` `ApiSessionList.list`：先读持久化的 `sessionQuery.listSessions`（134），
 *   冷会话走 `summarizeCold`（167-181）不恢复 Agent；结果按 `updatedAt` 降序，**没有分页**
 *   （`SessionListRequest.cursor` 保留未用，types.ts:267-270），所以一次响应就是全量；
 * - `list.ts:120` `running = agents.get(session.id)?.status === 'running'`；冷会话恒 `false`
 *   （list.ts:176）；子代理会话是独立行（`origin:'subagent'` + `parentSessionId`，types.ts:186-189），
 *   所以「含子代理会话」自然成立；
 * - `list.ts:52-53` `lastPromptAt` 只在 `user/message` 且 `source.kind === 'user'` 时推进，
 *   `updatedAt = max(createdAt, lastPromptAt)`（list.ts:349-351）——正是「用户消息推进的活动时间」。
 *
 * 线格式（`packages/client/connection/src/rpc-host.ts:302-334`）：`POST /api/<method>`，
 * body 必须是 `client-request`（`rpc-schema.ts:38-43`），响应 `server-response`（:46-53）；
 * 参数名 `_request`（`index.ts:274`）→ payload `{args:{_request:{}}}`（typert `request.args`）。
 *
 * 生产镜像 `dshhub/runtime:0.2.1-rc.2`（DSH 0.2.1-rc.2）里字段存在：
 * `@deepseek-ai/dsh-api-session-controller/lib/index.js:1948`（live）与 `:1998`（冷会话 false）。
 */

/** 探针总超时（docs/22 §6.1：3 s） */
export const SESSION_PROBE_TIMEOUT_MS = 3_000
/** 探针一轮的最大并发（docs/22 §6.1：≤ 8） */
export const SESSION_PROBE_CONCURRENCY = 8
/** RPC 方法名与 HTTP 路径（`POST /api/<method>`） */
export const SESSION_PROBE_METHOD = 'session/list'
export const SESSION_PROBE_PATH = '/api/session/list'
/** 响应体上限：全量会话列表，超过就当探针失败（不进内存黑洞） */
export const SESSION_PROBE_BODY_LIMIT_BYTES = 4 * 1024 * 1024

export interface SessionProbeItem {
  /** 会话是否有正在跑的 Agent（上游 `SessionSummary.running`） */
  running: boolean
  /** 上游 `SessionSummary.updatedAt`（epoch 毫秒；只在用户消息时推进） */
  updatedAt: number | null
}

export interface SessionProbeResult {
  ok: boolean
  items: SessionProbeItem[]
  message: string
  status?: number
}

/** 请求体（与上游客户端逐字节同形；`rpcId` 只用于对响应） */
export function sessionProbeBody(rpcId: string): string {
  return JSON.stringify({
    type: 'client-request',
    rpcId,
    method: SESSION_PROBE_METHOD,
    payload: { args: { _request: {} } },
  })
}

/** 把上游的一条 item 读成探针值；`running` 不是布尔（旧 DSH）→ null（未知） */
function readItem(raw: unknown): SessionProbeItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as { running?: unknown; updatedAt?: unknown }
  if (typeof value.running !== 'boolean') return null
  const updatedAt =
    typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : null
  return { running: value.running, updatedAt }
}

/**
 * 单次会话探针。失败（超时、401、非 200、响应不是 `server-response`、`result.ok=false`、
 * 或者拿不到布尔 `running`）一律返回 `{ok:false}`，调用方按「未知状态」走旧规则。
 */
export function probeSessions(
  target: UpstreamTarget,
  authority: string,
  minter: DshCookieMinter,
  timeoutMs = SESSION_PROBE_TIMEOUT_MS,
): Promise<SessionProbeResult> {
  const rpcId = `wp33-${randomUUID()}`
  const body = sessionProbeBody(rpcId)
  return new Promise<SessionProbeResult>((resolve) => {
    let settled = false
    const finish = (result: SessionProbeResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    let cookie: { name: string; value: string }
    try {
      cookie = minter.cookie(authority)
    } catch (error) {
      finish({ ok: false, items: [], message: `拿不到 DSH cookie：${errorMessage(error)}` })
      return
    }
    const req = request(
      {
        host: target.host,
        port: target.port,
        path: SESSION_PROBE_PATH,
        method: 'POST',
        headers: {
          host: authority,
          cookie: `${cookie.name}=${cookie.value}`,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          accept: 'application/json',
          'accept-encoding': 'identity',
          connection: 'close',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0
        const chunks: Buffer[] = []
        let size = 0
        let tooLarge = false
        res.on('data', (chunk: Buffer) => {
          if (tooLarge) return
          size += chunk.length
          if (size > SESSION_PROBE_BODY_LIMIT_BYTES) {
            tooLarge = true
            res.destroy()
            finish({ ok: false, items: [], message: 'session/list 响应超过 4MB', status })
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          if (tooLarge) return
          if (status !== 200) {
            finish({ ok: false, items: [], message: `session/list 返回 ${String(status)}`, status })
            return
          }
          finish(parseSessionProbeResponse(Buffer.concat(chunks).toString('utf8'), rpcId, status))
        })
        res.on('error', (error: Error) => {
          finish({ ok: false, items: [], message: `响应错误：${error.message}`, status })
        })
      },
    )
    const timer = setTimeout(() => {
      req.destroy()
      finish({ ok: false, items: [], message: `探针超时（${String(timeoutMs)}ms）` })
    }, timeoutMs)
    timer.unref?.()
    req.on('error', (error: Error) => {
      clearTimeout(timer)
      finish({ ok: false, items: [], message: `连接失败：${error.message}` })
    })
    req.on('close', () => clearTimeout(timer))
    req.end(body)
  })
}

/** 解析 `server-response`；导出给单测直接喂构造好的响应 */
export function parseSessionProbeResponse(
  text: string,
  rpcId: string,
  status = 200,
): SessionProbeResult {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, items: [], message: 'session/list 响应不是 JSON', status }
  }
  if (typeof body !== 'object' || body === null) {
    return { ok: false, items: [], message: 'session/list 响应不是对象', status }
  }
  const envelope = body as {
    type?: unknown
    rpcId?: unknown
    result?: { ok?: unknown; value?: { items?: unknown }; error?: { code?: unknown } }
  }
  if (envelope.type !== 'server-response') {
    return { ok: false, items: [], message: 'session/list 响应不是 server-response', status }
  }
  if (envelope.rpcId !== rpcId) {
    return { ok: false, items: [], message: 'session/list 响应的 rpcId 不匹配', status }
  }
  if (!envelope.result || envelope.result.ok !== true) {
    const code = typeof envelope.result?.error?.code === 'string' ? envelope.result.error.code : 'unknown'
    return { ok: false, items: [], message: `session/list 失败（${code}）`, status }
  }
  const items = envelope.result.value?.items
  if (!Array.isArray(items)) {
    return { ok: false, items: [], message: 'session/list 响应没有 items 数组', status }
  }
  const parsed: SessionProbeItem[] = []
  for (const item of items) {
    const read = readItem(item)
    // 旧版 DSH 的 SessionSummary 没有 running：整轮按未知处理，绝不据此停实例
    if (!read) return { ok: false, items: [], message: '会话项没有布尔 running 字段', status }
    parsed.push(read)
  }
  return { ok: true, items: parsed, message: 'ok', status }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
