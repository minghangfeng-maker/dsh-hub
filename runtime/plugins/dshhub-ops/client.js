/**
 * 座舱 DSH → Hub 的 `/ops/*` 客户端（docs/24 §3.1）。
 *
 * 令牌与地址只从容器环境变量来（`DSHHUB_OPS_URL` / `DSHHUB_OPS_TOKEN`，Hub 建容器时注入，
 * 每次启动重新生成），**不接受模型参数**：模型看不到、也改不了这两个值。
 *
 * @module @dshhub/ops/client
 */

/** `/ops/*` 调用失败（网络、超时、Hub 返回的错误体）统一成这一个错误类型。 */
export class OpsClientError extends Error {
  /**
   * @param {string} message - 给模型看的中文说明
   * @param {{code?: string, status?: number, details?: unknown}} [meta]
   */
  constructor(message, meta = {}) {
    super(message)
    this.name = 'OpsClientError'
    this.code = meta.code ?? 'OPS_ERROR'
    this.status = meta.status ?? null
    this.details = meta.details
  }
}

/** 默认超时：普通查询 20 秒（`/ops/call` 里 R1 自动执行可能有耗时）；长轮询另算。 */
const DEFAULT_TIMEOUT_MS = 20_000
/** `ops_wait` / 密钥长轮询的上限（契约 `waitSec` 0–60，客户端再留 5 秒网络余量）。 */
export const MAX_WAIT_SEC = 60

/**
 * 从 config（cordis 行）与环境变量解析出 `/ops` 地址与令牌。
 * config 优先（测试/手工 profile 可以覆盖），缺省读环境变量。
 *
 * **空字符串不算「覆盖」**（WP56e2 修的真问题）：`index.js` 的 `DEFAULT_CONFIG` 里
 * `url` / `token` 的默认值就是 `''`，`{...DEFAULT_CONFIG, ...rawConfig}` 之后这两个字段
 * 永远存在。原来的 `config.url ?? env.DSHHUB_OPS_URL` 只挡 `null`/`undefined`，
 * 于是空串把容器 env 里的地址和令牌全盖掉 —— 座舱容器里每个工具都回
 * 「座舱通道没有配置好」，而 Hub 侧看起来一切正常（`wp56b-smoke` 是直接 fetch `/ops`，
 * 不经过插件，所以没暴露）。现在只有「非空且非纯空白」的 config 才算覆盖。
 * @param {Record<string, string | undefined>} env
 * @param {{url?: string, token?: string}} [config]
 */
export function resolveOpsEndpoint(env = process.env, config = {}) {
  /** @param {unknown} value */
  const override = (value) => (typeof value === 'string' && value.trim() !== '' ? value : undefined)
  const rawUrl = String(override(config.url) ?? env.DSHHUB_OPS_URL ?? '').trim()
  const token = String(override(config.token) ?? env.DSHHUB_OPS_TOKEN ?? '').trim()
  return { baseUrl: normalizeBaseUrl(rawUrl), token }
}

/**
 * `DSHHUB_OPS_URL` 的规范形态：`http://10.213.0.1:7710/ops`（末尾不带斜杠）。
 * 也容忍「只给到端口」的写法（自动补 `/ops`），免得部署时一个手滑全盘 404。
 * @param {string} raw
 */
export function normalizeBaseUrl(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/\/+$/u, '')
  if (!text) return ''
  return /\/ops$/u.test(text) ? text : `${text}/ops`
}

/**
 * 建一个 `/ops` 客户端。
 * @param {{
 *   baseUrl?: string,
 *   token?: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   log?: (event: string, meta?: Record<string, unknown>) => void,
 * }} [options]
 */
export function createOpsClient(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? '')
  const token = String(options.token ?? '')
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const log = options.log ?? (() => {})

  /** 配置齐不齐：不齐时工具直接回一句明确的失败，而不是发一个注定 401 的请求。 */
  function configured() {
    return baseUrl.length > 0 && token.length > 0
  }

  /**
   * 发一个请求并解出 JSON。
   * @param {'GET'|'POST'|'PATCH'} method
   * @param {string} path - `/context`、`/canvas/xxx`
   * @param {{body?: unknown, query?: Record<string, string | number | undefined>, timeoutMs?: number}} [init]
   */
  async function request(method, path, init = {}) {
    if (!configured()) {
      throw new OpsClientError('座舱通道没有配置好（缺 DSHHUB_OPS_URL / DSHHUB_OPS_TOKEN）', {
        code: 'OPS_NOT_CONFIGURED',
      })
    }
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value === undefined || value === null || value === '') continue
      search.set(key, String(value))
    }
    const query = search.toString()
    const url = `${baseUrl}${path}${query ? `?${query}` : ''}`
    const timeoutMs = init.timeoutMs ?? defaultTimeoutMs
    const startedAt = Date.now()
    let response
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      log('ops.request-failed', { method, path, timeout, ms: Date.now() - startedAt })
      throw new OpsClientError(
        timeout ? `Hub 座舱通道超时（${String(timeoutMs)}ms）` : `连不上 Hub 座舱通道：${textOf(error)}`,
        { code: timeout ? 'OPS_TIMEOUT' : 'OPS_UNREACHABLE' },
      )
    }
    const text = await safeText(response)
    log('ops.request', { method, path, status: response.status, ms: Date.now() - startedAt })
    if (!response.ok) {
      throw new OpsClientError(describeFailure(response.status, text), {
        code: errorCodeOf(text) ?? `HTTP_${String(response.status)}`,
        status: response.status,
        details: parseJson(text),
      })
    }
    if (!text) return null
    const parsed = parseJson(text)
    if (parsed === undefined) {
      throw new OpsClientError('Hub 座舱通道返回了非 JSON 内容', { code: 'OPS_BAD_RESPONSE' })
    }
    return parsed
  }

  return {
    configured,
    /** `GET /ops/context`：Hub 版本、各域数量、策略、日期与时区（守则每回合注入一次） */
    context: () => request('GET', '/context'),
    /** `GET /ops/catalog?q=&area=`：能力目录（不带 q 返回全部） */
    catalog: ({ q, area } = {}) => request('GET', '/catalog', { query: { q, area } }),
    /** `POST /ops/call`：R0 直接返数据；写类返回方案卡（或 R1 自动执行的结果） */
    call: (payload, opts = {}) => request('POST', '/call', { body: payload, timeoutMs: opts.timeoutMs }),
    /** `GET /ops/proposals/:id?waitSec=`：长轮询方案状态 */
    proposal: (id, waitSec = 0) =>
      request('GET', `/proposals/${encodeURIComponent(String(id))}`, {
        query: { waitSec },
        timeoutMs: waitSec * 1000 + 5_000,
      }),
    /** `POST /ops/canvas`：出一张画布卡 */
    canvas: (payload) => request('POST', '/canvas', { body: payload }),
    /** `PATCH /ops/canvas/:id`：改本会话的卡 */
    patchCanvas: (id, payload) =>
      request('PATCH', `/canvas/${encodeURIComponent(String(id))}`, { body: payload }),
    /** `POST /ops/secret-requests`：请求一张密钥输入卡（值不经过对话） */
    secretRequest: (payload) => request('POST', '/secret-requests', { body: payload }),
    /** `GET /ops/secret-requests/:id?waitSec=`：只回 `{status, secretRef?}`，**不返回值** */
    secretStatus: (id, waitSec = 0) =>
      request('GET', `/secret-requests/${encodeURIComponent(String(id))}`, {
        query: { waitSec },
        timeoutMs: waitSec * 1000 + 5_000,
      }),
  }
}

function textOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

async function safeText(response) {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function parseJson(text) {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function errorCodeOf(text) {
  const body = parseJson(text)
  const code = body?.error?.code
  return typeof code === 'string' ? code : undefined
}

/** 把 Hub 的错误体翻成一句模型能读懂、也知道下一步该做什么的话。 */
function describeFailure(status, text) {
  const body = parseJson(text)
  const detail = typeof body?.error?.message === 'string' ? body.error.message : ''
  if (status === 401) {
    return '座舱令牌无效或来源不是座舱容器（Hub 拒绝了这次调用）。需要管理员重启座舱 DSH。'
  }
  if (status === 403) return detail || '座舱令牌没有这个权限'
  if (status === 429) return detail || '调用太频繁，请稍后再试'
  return detail || `Hub 座舱通道返回 ${String(status)}`
}
