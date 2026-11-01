/**
 * `@dshhub/ops` —— 座舱 DSH 的管理插件（docs/24 §5）。
 *
 * 装法：Hub 在启动座舱容器前从本仓库 `runtime/plugins/dshhub-ops/` 同步到容器内用户目录，
 * 再用官方命令 `dsh plugin --profile web add file:/home/dsh/ops-plugin` 装进 profile。
 * 它**不进插件库、不对普通用户可见**：普通用户的容器只有 Hub 下发过的插件。
 *
 * 结构：
 *   client.js   —— `/ops/*` HTTP 客户端（地址与令牌只来自容器 env）
 *   tools.js    —— 六个工具（sessionId 只从执行上下文取）
 *   guard.js    —— 「座舱守则」每回合注入 + `/ops/context` 摘要
 *
 * 可选依赖一律走 `ctx.inject`：`tools` 服务在加载器里可能比本插件晚 ACTIVE，
 * 直接 `ctx.get('tools')` 会拿到 undefined 并静默不注册（@local/dsh-memory 踩过这个坑）。
 *
 * @module @dshhub/ops
 */

import { createOpsClient, resolveOpsEndpoint } from './client.js'
import { installGuard } from './guard.js'
import { registerOpsTools } from './tools.js'

/** 插件在 Loader 里的诊断名。 */
export const name = 'dshhub-ops'

/** 不强制依赖任何服务：没有 tools 服务时守则注入照常工作。 */
export const inject = []

/** 默认配置（Loader 没有 schema 时也能看出默认值）。 */
export const DEFAULT_CONFIG = {
  /** `/ops` 基地址；缺省读 `DSHHUB_OPS_URL`（Hub 注入 `http://10.213.0.1:7710/ops`） */
  url: '',
  /** 座舱令牌；缺省读 `DSHHUB_OPS_TOKEN`。**任何时候都不要把令牌写进 profile 文件** */
  token: '',
  /** 单次 `/ops` 请求超时（毫秒） */
  timeoutMs: 20_000,
  /** `/ops/context` 的缓存时间（毫秒）：一个回合里多步不重复打 Hub */
  contextTtlMs: 30_000,
}

/**
 * 挂载插件。
 * @param {object} ctx - Cordis 上下文
 * @param {object} [rawConfig] - cordis 行 config
 */
export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) }
  const endpoint = resolveOpsEndpoint(process.env, { url: config.url, token: config.token })
  const log = makeLog(ctx)
  const client = createOpsClient({
    baseUrl: endpoint.baseUrl,
    token: endpoint.token,
    timeoutMs: config.timeoutMs,
    log,
  })
  if (!client.configured()) {
    warn(
      ctx,
      'dshhub-ops: 缺 DSHHUB_OPS_URL / DSHHUB_OPS_TOKEN，座舱工具会直接失败（请让管理员重启座舱 DSH）',
    )
  }

  // 工具：可选依赖 tools（加载器可能比本插件晚 ACTIVE）
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => registerOpsTools(toolCtx, { client, log }), 'dshhub-ops: tools')
  })

  // 守则注入：不依赖任何服务，直接挂事件
  ctx.effect(() => installGuard(ctx, { client, log, contextTtlMs: config.contextTtlMs }), 'dshhub-ops: guard')

  return { client, config }
}

/** 插件内日志：走 Loader 的 logger，拿不到就用 debug 级别静默。 */
function makeLog(ctx) {
  return (event, meta) => {
    try {
      const suffix = meta === undefined ? '' : ` ${JSON.stringify(meta)}`
      ctx.logger?.debug?.(`dshhub-ops ${event}${suffix}`)
    } catch {
      // 日志失败不影响业务
    }
  }
}

function warn(ctx, message) {
  try {
    ctx.logger?.warn?.(message)
  } catch {
    // 同上
  }
}

export { createOpsClient, resolveOpsEndpoint, OpsClientError } from './client.js'
export { registerOpsTools } from './tools.js'
export { buildGuardText, GUARD_MAX_CHARS, GUARD_RULES, installGuard, summarizeContext } from './guard.js'
export { sessionIdOf, withoutSessionId } from './session.js'
