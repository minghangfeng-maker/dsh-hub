/**
 * dsh-claude-pilot —— Host 入口（稳定薄壳，尽量不改；改了要重装 bundle + 重启 DSH）。
 *
 *   1. agent/pre-step：全局一份 + 每个 agent 一份（桥内部按 (agent, turn) 去重）；
 *   2. /claude-pilot 路由：GET 状态与最近派出的任务（客户端轮询它来开右侧栏），
 *      POST 端到端测试 / 查会话事件；
 *   3. runtime/bridge.js 按 mtime 热加载 —— 只改 runtime/*.js 不用重启。
 *
 * webServer 是可选依赖，必须用 ctx.inject 注入（apply 可能早于 WebServer 激活）。
 */
import { statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

export const name = 'claude-pilot'

const ROUTE = '/claude-pilot'
const RUNTIME = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime')
const IMPL = join(RUNTIME, 'bridge.js')

export function apply(ctx, config = {}) {
  const cfg = config && typeof config === 'object' ? config : {}
  const state = {}

  // 热加载：任何一个 runtime 文件变了都换新一代（子模块用同一个版本号，保证一致）
  let cached = { stamp: '', mod: null }
  const loadImpl = async () => {
    const stamp = ['bridge.js', 'translate.js', 'tasks.js', 'files.js', 'setup.js', 'platform.js']
      .map((file) => {
        try {
          return statSync(join(RUNTIME, file)).mtimeMs
        } catch {
          return 0
        }
      })
      .join('-')
    if (!cached.mod || cached.stamp !== stamp) {
      cached = { stamp, mod: await import(`${pathToFileURL(IMPL).href}?v=${stamp}`) }
    }
    return cached.mod
  }

  // 预设里的命令插件（commands.r1.js）经这里拿到实现与共享状态
  globalThis.__claudePilot = { ctx, cfg, state, loadImpl }
  ctx.effect(() => () => {
    if (globalThis.__claudePilot?.state === state) delete globalThis.__claudePilot
  }, 'claude-pilot: shared handle')

  // 启动后在后台刷新一次 Claude Code 的命令目录（含自定义命令与 skills），供新对话注册
  ctx.effect(() => {
    const timer = setTimeout(() => {
      void loadImpl()
        .then((impl) => impl.refreshCommands(state, cfg, ctx))
        .catch((error) => console.warn(`[claude-pilot] 刷新命令目录失败：${error?.message}`))
    }, 8000)
    return () => clearTimeout(timer)
  }, 'claude-pilot: refresh commands')

  const preStep = (payload, next) =>
    loadImpl()
      .then((impl) => impl.handlePreStep(ctx, cfg, state, payload, next))
      .catch((error) => {
        state.lastError = `${new Date().toISOString()} ${error?.stack || error}`
        console.warn(`[claude-pilot] pre-step 出错，退回正常 loop：${error?.message}`)
        return next()
      })

  ctx.effect(() => {
    const dispose = ctx.on('agent/pre-step', preStep)
    return () => typeof dispose === 'function' && dispose()
  }, 'claude-pilot: pre-step (root)')

  ctx.effect(() => {
    const dispose = ctx.on('agent/created', (payload) => {
      const agentCtx = payload?.agent?.ctx
      if (typeof agentCtx?.on === 'function') agentCtx.on('agent/pre-step', preStep)
    })
    return () => typeof dispose === 'function' && dispose()
  }, 'claude-pilot: pre-step (per agent)')

  // 预先注册 claude-code 提供者：重启后打开老会话时模型芯片也能认出它
  ctx.effect(() => {
    void loadImpl()
      .then((impl) => impl.ensureModelAdapter(ctx, state))
      .catch((error) => console.warn(`[claude-pilot] 预注册提供者失败：${error?.message}`))
    // 默认模型若已被带成 claude-code（DSH 的 selectModel 会顺手存默认），恢复成正常模型
    const guard = setTimeout(() => {
      void loadImpl()
        .then((impl) => {
          impl.ensureWatchers(ctx, cfg, state)
          impl.protectDefaultModel(ctx, cfg, state)
        })
        .catch(() => {})
    }, 3000)
    return () => {
      clearTimeout(guard)
      try {
        state.adapterHandle?.()
      } catch {
        /* 已经摘掉了 */
      }
      state.adapterRegistered = false
    }
  }, 'claude-pilot: model provider')

  /**
   * 桌面端：Hub 配置不再来自容器注入的 HUB_CLAUDE_* 环境变量，而是 hub-connector 注册的
   * `hubAgentModes` 服务（它用设备令牌去 Hub 换 /v1/hub/agent-mode 的配置与中转站密钥）。
   * 容器里没有这个服务 → 注入回调不执行 → 仍然是环境变量那条路（容器行为完全不变）。
   */
  ctx.inject(['hubAgentModes'], (hubCtx) => {
    hubCtx.effect(() => {
      const service = hubCtx.get?.('hubAgentModes')
      if (!service?.credentials) return () => {}
      let disposeChange = null
      let disposed = false
      // 配置变了（登录/登出、管理员改模型或地址、被移出 targets、设备密钥轮换）：
      // 清掉 Hub 配置与就绪缓存，下一轮按新配置重新走 —— 和「设置页改了配置」同一条刷新路径
      const onHubChange = (impl) => () => {
        try {
          impl.hubConfigChanged(state)
        } catch (error) {
          console.warn(`[claude-pilot] Hub 配置变化后刷新失败：${error?.message}`)
        }
      }
      void loadImpl()
        .then((impl) => {
          if (disposed) return
          impl.setHubProvider(() => (service.available?.('claude-code') === false ? null : service.credentials('claude-code')))
          try {
            disposeChange = service.onChange?.('claude-code', onHubChange(impl)) || null
          } catch (error) {
            console.warn(`[claude-pilot] 订阅 Hub 配置变化失败：${error?.message}`)
          }
        })
        .catch((error) => console.warn(`[claude-pilot] 接入 hub-connector 失败：${error?.message}`))
      return () => {
        disposed = true
        if (typeof disposeChange === 'function') disposeChange()
        disposeChange = null
        void loadImpl()
          .then((impl) => impl.setHubProvider(null))
          .catch(() => {})
      }
    }, 'claude-pilot: hub provider')
  })

  // 初始化/登录设置接口：挂在 connection 的受保护路由上（/api 下，只有已登录 DSH 的浏览器能调；
  // 插件自己的 webServer 路由不经过 DSH 登录，绝不能用来收密钥）
  ctx.inject(['connection'], (connCtx) => {
    connCtx.effect(() => {
      const connection = connCtx.get?.('connection')
      if (!connection?.fetch?.register) return () => {}
      return connection.fetch.register({
        path: '/api/claude-pilot.setup',
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            const impl = await loadImpl()
            const body = request.method === 'POST' ? await request.json().catch(() => ({})) : { action: 'state' }
            const result = await impl.handleSetupRequest(ctx, cfg, state, body)
            return Response.json(result, { headers: { 'cache-control': 'no-store' } })
          } catch (error) {
            return Response.json({ ok: false, error: String(error?.message || error) }, { status: 500, headers: { 'cache-control': 'no-store' } })
          }
        },
      })
    }, 'claude-pilot: setup route')
  })

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const webServer = webCtx.get?.('webServer')
      if (!webServer?.register) return () => {}
      return webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: async (req, res) => {
          const send = (code, payload) => {
            const body = JSON.stringify(payload)
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) })
            res.end(body)
          }
          try {
            const impl = await loadImpl()
            const url = new URL(req.url || ROUTE, 'http://local')
            if ((req.method ?? 'GET') === 'GET') {
              send(200, { ...impl.status(ctx, cfg, state, { since: url.searchParams.get('since') }), lastError: state.lastError || null })
              return
            }
            if (req.method !== 'POST') return send(405, { ok: false, error: 'GET 或 POST' })
            const site = String(req.headers?.['sec-fetch-site'] ?? '').toLowerCase()
            if (site && site !== 'same-origin' && site !== 'same-site' && site !== 'none') return send(403, { ok: false, error: '只接受同源请求' })
            if (!impl.labTokenOk(cfg, req.headers?.['x-pilot-token'])) return send(403, { ok: false, error: '需要 x-pilot-token（见 ~/.dsh/claude-pilot/lab-token）' })
            let text = ''
            for await (const chunk of req) text += chunk
            const body = text.trim() ? JSON.parse(text) : {}
            if (body.dump) return send(200, impl.dump(ctx, body.dump, body.limit))
            const result = await impl.lab(ctx, cfg, state, body)
            send(result.ok === false ? 400 : 200, result)
          } catch (error) {
            send(500, { ok: false, error: String(error?.stack || error?.message || error) })
          }
        },
      })
    }, 'claude-pilot: route')
  })
}
