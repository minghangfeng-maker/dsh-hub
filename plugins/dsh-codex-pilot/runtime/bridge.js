/**
 * dsh-codex-pilot —— 桥的实现（由 index.js 按 mtime 热加载，改完存盘即生效）。
 *
 * 会话预设 = codex-pilot 时：
 *   agent/pre-step → 把这一轮认领的消息写成 user/message → 在常驻的 codex app-server 上跑一轮
 *   （thread 续接上一轮）→ 通知逐条翻译成 DSH 原生事件 → 返回 {kind:'enter', messages:[]}，
 *   loop 以 completed 收尾，完全不调 DSH 的模型。
 *
 * Codex 手里多了一组 task_* 动态工具：派出的任务是这个对话下的真 DSH 子会话（见 tasks.js），
 * 任务结束时 DSH 发来的结算通知会让父会话再起一轮 → 这里把通知转成「[DSH 任务通知]」交给 Codex。
 *
 * ⚠ 本模块会被反复 import：可变状态一律放在 index.js 传进来的 state 里。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 同目录模块带上本模块的版本号再 import：ESM 按 URL 缓存，不带的话改了它们也不会热加载
const V = new URL(import.meta.url).search
const { createTranslator, truncate } = await import(`./translate.js${V}`)
const { PILOT_PROMPT, PSEUDO_PROVIDERS, TASK_TOOL_SPECS, createTaskHandlers, ensureTaskTracker } = await import(`./tasks.js${V}`)
const { appendDeliverables, attachmentPartsOf, attachmentPreamble, materializeAttachments } = await import(`./files.js${V}`)
const setup = await import(`./setup.js${V}`)
const rpc = await import(`./appserver.js${V}`)
const platform = await import(`./platform.js${V}`)

export const PILOT_PRESET = 'codex-pilot'
export const CX_PROVIDER = 'codex'
export const CX_MODEL_ID = 'cli-default'

/* ------------------------------------------------------------------ 小工具 */

function log(config, ...args) {
  if (config.verbose) console.log('[codex-pilot]', ...args)
}

function textOfMessage(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text || '')
    .join('\n')
    .trim()
}

function append(session, type, data, intent) {
  return intent ? session.append(type, data, intent) : session.append(type, data)
}

function appendNote(session, turn, step, text) {
  append(session, 'step/start', { turn, step })
  append(
    session,
    'assistant/message',
    {
      turn,
      step,
      message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: CX_PROVIDER, model: CX_PROVIDER }, id: randomUUID() },
      stream: [],
    },
    { surfaceOp: 'append' },
  )
  append(session, 'step/end', { turn, step })
}

function isSubagentSession(session) {
  const header = session?.header || {}
  return header.origin === 'subagent' || Boolean(header.parentSession) || (Number(header.delegationDepth) || 0) > 0
}

export function pilotMode(ctx, session, agent) {
  try {
    const composed = ctx.get('agentPresets')?.composedPreset?.(agent?.ctx)
    if (composed !== undefined) return composed === PILOT_PRESET
  } catch {
    /* 注册表不可用就看 header */
  }
  return session?.header?.agentPreset === PILOT_PRESET
}

function cwdOf(session, config) {
  for (const candidate of [session?.header?.cwd, config.fallbackCwd, homedir()]) {
    if (!candidate) continue
    try {
      if (statSync(candidate).isDirectory()) return resolve(candidate)
    } catch {
      /* 下一个 */
    }
  }
  return homedir()
}

/* --------------------------------------------------------- 会话记录（持久） */

function storeFile(config) {
  return config.storeFile || join(setup.pilotHome(config), 'sessions.json')
}

export function loadStore(state, config) {
  if (state.store) return state.store
  const file = storeFile(config)
  let data = { version: 1, sessions: {} }
  try {
    if (existsSync(file)) data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    console.warn(`[codex-pilot] 会话记录读取失败，重新开始：${error.message}`)
  }
  data.sessions ||= {}
  state.store = { file, data }
  return state.store
}

function saveStore(state) {
  const { file, data } = state.store
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, file)
}

function record(state, config, sessionId) {
  const store = loadStore(state, config)
  store.data.sessions[sessionId] ||= { createdAt: Date.now() }
  return store.data.sessions[sessionId]
}

function patchRecord(state, config, sessionId, patch) {
  Object.assign(record(state, config, sessionId), patch, { updatedAt: Date.now() })
  try {
    saveStore(state)
  } catch (error) {
    console.warn(`[codex-pilot] 会话记录保存失败：${error.message}`)
  }
}

/** Codex 已经通过 task_wait 看过结果的子任务（每个父会话一份，仅内存）。 */
function consumedSet(state, sessionId) {
  state.consumed ||= new Map()
  if (!state.consumed.has(sessionId)) state.consumed.set(sessionId, new Set())
  return state.consumed.get(sessionId)
}

/** hub-connector 注册进来的 Hub 配置来源（桌面端）；容器里没有它，走 HUB_CODEX_* 环境变量。 */
export function setHubProvider(fn) {
  setup.setHubProvider(fn)
}

/**
 * Hub 侧配置换了（hubAgentModes.onChange：登录/登出、管理员改模型或地址、被移出 targets、设备密钥轮换）：
 * 清掉 Hub 配置缓存 + 就绪缓存，下一轮/下一次状态查询按新配置重新走一遍 —— 和「设置页改了配置」
 * 走的是同一条刷新路径。app-server 会因 secretDigest 变化在下一轮自行重启。
 */
export function hubConfigChanged(state) {
  setup.invalidateHubConfig()
  if (state) state.authReady = { at: 0, ready: false }
}

/* ------------------------------------------------------------ app-server */

/** 服务端发来、但不属于任何在跑轮次的请求：按权限配置处理审批，其余拒绝。 */
function defaultRequestHandler(config) {
  return (method) => approvalAnswer(config, method)
}

function approvalAnswer(config, method) {
  const allow = (config.sandbox || 'danger-full-access') === 'danger-full-access' || config.autoApprove === true
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: allow ? 'accept' : 'decline' }
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: allow ? 'approved' : 'denied' }
    case 'item/tool/requestUserInput':
      // DSH 这边还没接问答卡：给空答案，让 Codex 在正文里问
      return { answers: {} }
    case 'mcpServer/elicitation/request':
      return { action: 'decline', content: null }
    default:
      return undefined
  }
}

export async function getServer(ctx, config, state) {
  const launch = await setup.launchSpec(ctx, config)
  const server = await rpc.ensureServer(state, launch, { onDefaultRequest: defaultRequestHandler(config) })
  if (state.modelsKey !== server.key && !state.modelsLoading) {
    const key = server.key
    const loading = rpc
      .request(server, 'model/list', { includeHidden: false, limit: 100 }, 30000)
      .then((result) => {
        state.models = (result?.data || []).filter((entry) => !entry.hidden)
        state.modelsKey = key
        // 目录变了就让浏览器端重建模型芯片（已开着的页面也能立刻出现可选模型）
        if (state.models.length) notifyCatalogUpdated(ctx)
      })
      .catch((error) => log(config, `读取模型列表失败：${error.message}`))
      .finally(() => {
        if (state.modelsLoading === loading) state.modelsLoading = null
      })
    state.modelsLoading = loading
  }
  return server
}

/* ------------------------------------------- 模型芯片说实话：codex 提供者 */

const GENERATION = (() => {
  try {
    return String(statSync(fileURLToPath(import.meta.url)).mtimeMs)
  } catch {
    return 'unknown'
  }
})()

const EFFORT_NAMES = { none: '不思考', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最大', ultra: '极限' }
const DEFAULT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

function catalog(state) {
  // Hub 下发模式：只列 Hub 管理员配的模型（Codex 自己的 model/list 是 OpenAI 官方表，对中转站没意义）；
  // 用户改用自己的配置后回到 Codex 内置那份，不再向 Hub 拉
  const hub = setup.hubMode(state.config || {}) ? setup.lastHubConfig() : null
  if (hub?.models?.length) {
    return [
      { id: CX_MODEL_ID, name: hub.defaultModel ? `跟随 Hub 默认（${hub.defaultModel}）` : '跟随 Hub 默认', description: '不指定模型，用 DSH Hub 管理员设的默认模型', efforts: DEFAULT_EFFORTS },
      ...hub.models.map((entry) => ({
        id: entry.id,
        name: entry.displayName || entry.id,
        description: entry.id,
        efforts: (entry.reasoningEfforts || []).filter((id) => id !== 'off'),
        defaultEffort: entry.defaultThinking || null,
      })),
    ]
  }
  const models = state.models || []
  return [
    { id: CX_MODEL_ID, name: '跟随 Codex 默认', description: '不指定模型，用 Codex 自己的默认（~/.codex/config.toml 或登录账号的默认）', efforts: DEFAULT_EFFORTS },
    ...models.map((entry) => ({
      id: entry.id || entry.model,
      name: entry.displayName || entry.id,
      description: entry.description || entry.id,
      efforts: (entry.supportedReasoningEfforts || []).map((item) => item.reasoningEffort).filter(Boolean),
      defaultEffort: entry.defaultReasoningEffort || null,
    })),
  ]
}

/**
 * 广播 llm/adapters-updated：模型目录对浏览器是缓存的（每次 Host 代只拉一次），
 * 拉到 Codex 的 model/list 之后必须让前端重建一次，否则已开着的页面永远只有「跟随」。
 */
function notifyCatalogUpdated(ctx) {
  try {
    if (typeof ctx?.events?.dispatch === 'function') ctx.events.dispatch('emit', ['llm/adapters-updated'])
    else if (typeof ctx?.emit === 'function') ctx.emit('llm/adapters-updated')
  } catch (error) {
    console.warn(`[codex-pilot] 通知模型目录更新失败：${error?.message}`)
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * 主动把 Codex 的模型目录拉进来（模型芯片要有模型可选）。
 *
 * Codex 的模型表来自 app-server 的 model/list，而它原本只在跑回合/执行命令时才拉；
 * 浏览器一加载就让 DSH 重建模型目录（buildModelCatalog → 适配器 listModels），那时还没拉过，
 * 于是 Codex 这一组里只剩一条「跟随 Codex 默认」。这里在 listModels 里补一次：
 * 首次最多等 timeoutMs（启动 app-server 约 1s），拿到就返回完整目录；超时也不阻塞，
 * 拉完后再广播一次 llm/adapters-updated 让页面自己刷新。
 */
export function warmModels(ctx, config, state, timeoutMs = 2500) {
  if (config) state.config = config
  // 插件刚启动、真正的配置（凭据方式等）还没送到：先不动，等 ensureWatchers / 第一次请求
  if (!state.config) return Promise.resolve(0)
  if (setup.hubMode(state.config)) return Promise.resolve(0)
  if (state.models?.length) return Promise.resolve(state.models.length)
  if (!state.modelsWarming) {
    const warming = (async () => {
      try {
        const server = await getServer(ctx, state.config, state)
        if (state.modelsLoading) await state.modelsLoading
        else if (state.modelsKey !== server.key) log(config, '模型目录没拉到：app-server 没有返回 model/list')
      } catch (error) {
        log(config, `预取模型列表失败：${error.message}`)
      } finally {
        if (state.modelsWarming === warming) state.modelsWarming = null
      }
    })()
    state.modelsWarming = warming
  }
  return Promise.race([state.modelsWarming.then(() => state.models?.length || 0), sleep(timeoutMs).then(() => state.models?.length || 0)])
}

function cxModelMeta(state, provider, model) {
  const list = catalog(state)
  const entry = list.find((item) => item.id === model) || { ...list[0], id: model || CX_MODEL_ID, name: model && model !== CX_MODEL_ID ? model : list[0].name }
  const efforts = (entry.efforts?.length ? entry.efforts : DEFAULT_EFFORTS).map((id) => ({ id, name: EFFORT_NAMES[id] || id }))
  return {
    provider,
    id: model || entry.id,
    name: entry.name,
    description: entry.description,
    inputModalities: ['text', 'image'],
    reasoning: { efforts, defaultEffort: entry.defaultEffort && efforts.some((item) => item.id === entry.defaultEffort) ? entry.defaultEffort : efforts.some((item) => item.id === 'high') ? 'high' : efforts[0].id },
  }
}

function codexAdapter(ctx, state) {
  return {
    providerInfo: (provider) => ({ id: provider, name: 'Codex' }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    async listModels(provider) {
      if (setup.hubMode(state.config || {})) {
        await setup.hubConfig().catch(() => null)
      } else {
        // Codex 自己的模型表要先从 app-server 拉一次，否则这一组只有「跟随 Codex 默认」
        await warmModels(ctx, state.config, state)
      }
      return catalog(state).map((entry) => cxModelMeta(state, provider, entry.id))
    },
    async resolveModel(provider, model) {
      return cxModelMeta(state, provider, model || CX_MODEL_ID)
    },
    async prepareCall(provider, model) {
      return { model: cxModelMeta(state, provider, model || CX_MODEL_ID), stream: (options) => this.stream(options) }
    },
    async *stream() {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: '这个对话由 Codex 驱动，DSH 的模型不会被调用。看到这条说明桥没生效（查 /codex-pilot 诊断）。', code: 'CODEX_PILOT_MODE' },
        },
      }
    },
  }
}

export function ensureModelAdapter(ctx, state, config = null) {
  // 模型的 Hub 判断要用得到 config（auth.json 在哪、hubOverride 状态）；拿不到时退回默认目录
  if (config) state.config = config
  const llm = ctx.get('llm')
  if (!llm?.registerAdapter) return false
  if (state.adapterRegistered && state.adapterGeneration === GENERATION) return true
  if (state.adapterRegistered) {
    try {
      state.adapterHandle?.()
    } catch {
      /* 旧适配器已经没了 */
    }
    state.adapterRegistered = false
  }
  try {
    state.adapterHandle = llm.registerAdapter([CX_PROVIDER], codexAdapter(ctx, state))
  } catch (error) {
    if (!/DUPLICATE_ADAPTER/.test(`${error?.code} ${error?.message}`)) {
      console.warn(`[codex-pilot] 注册 codex 提供者失败：${error.message}`)
      return false
    }
  }
  state.adapterRegistered = true
  state.adapterGeneration = GENERATION
  return true
}

/** 会话最后一条 model/selection（只认 codex 提供者）。 */
export function readSelection(session) {
  const events = session?.snapshotEvents?.() || []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'model/selection') continue
    const data = event.data || {}
    if (data.provider !== CX_PROVIDER) return null
    return { model: data.model, reasoningEffort: data.reasoningEffort }
  }
  return null
}

/** 第一次进模式时把会话的模型切到 codex（已有 codex 选择就不动 —— 那是用户选的）。 */
async function ensureSelection(ctx, config, state, session) {
  if (readSelection(session)) return
  state.selected ||= new Set()
  if (state.selected.has(session.id)) return
  const controller = ctx.get('sessionController')
  if (!controller?.selectModel) return
  try {
    await controller.selectModel({
      sessionId: session.id,
      provider: CX_PROVIDER,
      model: config.defaultModel || CX_MODEL_ID,
      ...(config.defaultEffort ? { reasoningEffort: config.defaultEffort } : {}),
    })
    state.selected.add(session.id)
    protectSoon(ctx, config, state)
  } catch (error) {
    console.warn(`[codex-pilot] 切换会话模型失败（不影响这一轮）：${error.message}`)
  }
}

/**
 * DSH 的 sessionController.selectModel 会顺手把选择存成「全局默认模型」。Codex 会话一选 codex，
 * 标准对话的默认模型就被带成 codex —— 新开的普通对话直接报错。这里守住：默认模型一旦变成
 * codex（或 Claude Code 模式的 claude-code），就恢复成上一个正常值（没有记录就用 taskModel）。
 */
export function protectDefaultModel(ctx, config, state) {
  const service = ctx.get('agentDefaultModel')
  if (!service?.currentSelection || !service.saveSelection) return
  let current
  try {
    current = service.currentSelection()
  } catch {
    return
  }
  if (current?.provider && !PSEUDO_PROVIDERS.has(current.provider)) {
    state.goodDefault = { ...current }
    return
  }
  if (current?.provider !== CX_PROVIDER) return // claude-code 归 Claude Code 模式的插件管
  const fallback = config.taskModel?.provider && !PSEUDO_PROVIDERS.has(config.taskModel.provider) ? { ...config.taskModel } : null
  const good = state.goodDefault || fallback
  if (!good) return
  Promise.resolve(service.saveSelection(good))
    .then(() => log(config, `默认模型被带成 codex，已恢复为 ${good.provider}/${good.model}`))
    .catch((error) => console.warn(`[codex-pilot] 恢复默认模型失败：${error.message}`))
}

function protectSoon(ctx, config, state) {
  for (const delay of [400, 1500]) setTimeout(() => protectDefaultModel(ctx, config, state), delay).unref?.()
}

/**
 * 会话预设与模型对齐：切到 Codex → 模型设为「Codex 默认」（已选过 codex 模型就不动）；
 * 从 Codex 切回别的预设 → 模型恢复成正常默认。只在空白会话里发生（DSH 只允许空白会话换预设）。
 */
export async function syncModelWithPreset(ctx, config, state, sessionId) {
  const session = ctx.get('sessions')?.get?.(sessionId)
  const agent = ctx.get('agents')?.get?.(sessionId)
  if (!session || !agent || isSubagentSession(session)) return
  ensureModelAdapter(ctx, state, config)
  if (pilotMode(ctx, session, agent)) {
    state.marked ||= new Set()
    state.marked.add(sessionId)
    // 切到 Codex 预设时就把模型目录拉好：模型芯片里能直接选 Codex 的模型
    void warmModels(ctx, config, state)
    await ensureSelection(ctx, config, state, session)
    return
  }
  state.marked?.delete(sessionId)
  state.selected?.delete(sessionId)
  const events = session.snapshotEvents?.() || []
  const last = [...events].reverse().find((event) => event.type === 'model/selection')
  if (last?.data?.provider !== CX_PROVIDER) return
  protectDefaultModel(ctx, config, state)
  const good = state.goodDefault || (config.taskModel?.provider ? config.taskModel : null)
  if (!good) return
  try {
    await ctx.get('sessionController')?.selectModel?.({ sessionId, provider: good.provider, model: good.model, ...(good.reasoningEffort ? { reasoningEffort: good.reasoningEffort } : {}) })
  } catch (error) {
    console.warn(`[codex-pilot] 切回预设时恢复模型失败：${error.message}`)
  }
}

/** 启动即挂上的监听：预设/模型对齐、默认模型保护、新建的 Codex 会话立刻切模型。 */
export function ensureWatchers(ctx, config, state) {
  ensureModelAdapter(ctx, state, config)
  ensureSelectionGuard(ctx, config, state)
  ensureTaskTracker(ctx, state)
  // 用过 Codex 模式的机器：先把模型目录拉进来，模型芯片打开就有模型可选（没用过的机器不白起 app-server）
  try {
    if (Object.keys(loadStore(state, config).data.sessions).length) void warmModels(ctx, config, state, 8000)
  } catch (error) {
    console.warn(`[codex-pilot] 预取模型目录失败（不影响使用）：${error?.message}`)
  }
  if (state.createdWatcher) return
  state.createdWatcher = ctx.on('agent/created', (payload) => {
    const id = payload?.agent?.id
    if (id) setTimeout(() => void syncModelWithPreset(ctx, config, state, id), 300)
  })
}

/** 模式会话里有人把模型切到别的提供者 → 切回来（客户端没有按会话过滤模型目录的钩子）。 */
function ensureSelectionGuard(ctx, config, state) {
  if (state.selectionGuard) return
  state.lastCxSelection ||= {}
  state.selectionGuard = ctx.on('session/event', (session, event) => {
    if (event?.type === 'agent-preset/selected' && session?.id) {
      setTimeout(() => void syncModelWithPreset(ctx, config, state, session.id), 50)
      return
    }
    if (event?.type !== 'model/selection' || !session?.id) return
    const data = event.data || {}
    if (data.provider === CX_PROVIDER) {
      state.lastCxSelection[session.id] = { provider: CX_PROVIDER, model: data.model, reasoningEffort: data.reasoningEffort }
      protectSoon(ctx, config, state)
      return
    }
    protectSoon(ctx, config, state)
    const agent = ctx.get('agents')?.get?.(session.id)
    if (!agent || isSubagentSession(session) || !pilotMode(ctx, session, agent)) return
    const wanted = state.lastCxSelection[session.id] || { provider: CX_PROVIDER, model: CX_MODEL_ID }
    Promise.resolve()
      .then(() => ctx.get('sessionController')?.selectModel?.({ sessionId: session.id, ...wanted }))
      .catch((error) => console.warn(`[codex-pilot] 切回 Codex 模型失败：${error.message}`))
  })
}

/* ---------------------------------------------------------------- 逐字直播 */

/** 同 Claude Code 模式：按 agent 独占一个 revision 计数器（接收端要求同一 agent 的帧连续）。 */
function liveEmitter(ctx, state, sessionId) {
  const agent = ctx.get('agents')?.get?.(sessionId)
  if (!agent || typeof ctx.emit !== 'function') return null
  state.streamRevisions ||= new WeakMap()
  let attemptId = null
  return (frame) => {
    if (frame.type === 'start') attemptId = `${sessionId}:codex-${randomUUID().slice(0, 8)}`
    if (!attemptId) return
    const revision = (state.streamRevisions.get(agent) || 0) + 1
    state.streamRevisions.set(agent, revision)
    try {
      ctx.emit('agent/assistant-stream', { agent, frame: { ...frame, attemptId, revision } })
    } catch (error) {
      if (!state.streamWarned) console.warn(`[codex-pilot] 逐字直播失败（不影响结果）：${error.message}`)
      state.streamWarned = true
    }
    if (frame.type === 'end') attemptId = null
  }
}

/* -------------------------------------------------------------- 一轮 Codex */

function threadParams(config, cwd, model) {
  return {
    cwd,
    approvalPolicy: config.approvalPolicy || 'never',
    sandbox: config.sandbox || 'danger-full-access',
    ...(model ? { model } : {}),
  }
}

/** 拿到这个 DSH 会话对应的 Codex thread（已加载 → 直接用；记录里有 → resume；都没有 → 新建）。 */
async function openThread(server, config, rec, cwd, model, logFn, memorySpecs = []) {
  const base = threadParams(config, cwd, model)
  if (rec.threadId && server.loaded.has(rec.threadId)) return { id: rec.threadId, resumed: true }
  if (rec.threadId) {
    try {
      const result = await rpc.request(server, 'thread/resume', { threadId: rec.threadId, ...base, excludeTurns: true }, 60000)
      const id = result?.thread?.id || rec.threadId
      server.loaded.add(id)
      return { id, resumed: true, model: result?.thread?.model }
    } catch (error) {
      logFn(`Codex thread ${rec.threadId} 续接失败（${error.message}），开新的`)
    }
  }
  const instructions = [PILOT_PROMPT, config.extraInstructions].filter(Boolean).join('\n\n')
  const dynamicTools = [...TASK_TOOL_SPECS, ...memorySpecs]
  const result = await rpc.request(server, 'thread/start', { ...base, developerInstructions: instructions, dynamicTools, serviceName: 'dsh' }, 60000)
  const id = result.thread.id
  server.loaded.add(id)
  return { id, resumed: false, fresh: true, model: result?.thread?.model }
}

/** 识别 /compact、/review 这两个要走专门接口的命令（其余斜杠开头的话原样交给 Codex）。 */
function specialCommand(prompt) {
  const match = /^\/(compact|review)(?:\s+([\s\S]*))?$/.exec(String(prompt || '').trim())
  return match ? { name: match[1], arg: (match[2] || '').trim() } : null
}

/** 用户在运行中「插话发送」的消息（DSH 放在收件箱 next-step；任务通知也走那里，但不算插话）。 */
function pendingSteers(agent) {
  try {
    return (agent?.inbox?.nextStep || []).filter((message) => message?.source?.kind === 'user')
  } catch {
    return []
  }
}

/**
 * 跑一轮 Codex，事件写进 session。返回 { ok, aborted, error, summary, steered, lastStep }。
 * steered：运行中的插话里 Codex 没来得及读到的，调用方在同一个 DSH turn 里带着它们接着跑下一段。
 * 调用方负责 turn/start、turn/end（pre-step 路径由 loop 写）。
 */
export async function runCodexTurn(ctx, config, state, { session, turn, prompt, images = [], signal, agent = null, stepBase = 0 }) {
  const sessionId = session.id
  const rec = record(state, config, sessionId)
  const cwd = cwdOf(session, config)
  const selection = readSelection(session)
  state.config = config
  const hubMode = setup.hubMode(config)
  if (hubMode) await setup.hubConfig().catch(() => null)
  const hub = hubMode ? setup.lastHubConfig() : null
  let model = selection?.model && selection.model !== CX_MODEL_ID ? selection.model : config.defaultModel || undefined
  // Hub 模式：选着的模型已不在 Hub 的列表里就退回 Hub 的默认；config.toml 里只有 env 给的模型，默认模型每轮显式传
  if (hub?.models?.length && model && !hub.models.some((entry) => entry.id === model)) model = undefined
  if (!model && hub?.defaultModel) model = hub.defaultModel
  const effort = selection?.reasoningEffort || config.defaultEffort || undefined
  state.activity ||= {}

  const translator = createTranslator({
    turn,
    append: (type, data, intent) => append(session, type, data, intent),
    live: config.stream === false ? null : liveEmitter(ctx, state, sessionId),
    maxToolResultChars: Number(config.maxToolResultChars) > 0 ? Number(config.maxToolResultChars) : 30000,
    model: model || null,
    onActivity: (text) => {
      state.activity[sessionId] = { text, at: Date.now() }
    },
    stepBase,
    onWrote: (touched) => presentNow([touched]),
  })
  // 交付物当场写 deliverables/presented（DSH 只显示收尾回复之前的交付）；同一轮里同一个文件只交付一次
  const presentedPaths = new Set()
  const presentNow = (items) => appendDeliverables(session, turn, items, cwd, presentedPaths)

  let aborted = false
  let error = null
  let server = null
  let threadId = null
  let turnId = null
  let settle = null
  let ended = false
  const finished = new Promise((resolveFinished) => {
    settle = resolveFinished
  }).then((value) => {
    ended = true
    return value
  })
  const interrupt = async () => {
    if (!server || !threadId || !turnId) return
    await rpc.request(server, 'turn/interrupt', { threadId, turnId }, 10000).catch(() => {})
    // Codex 中断回合时不杀正在跑的命令（会留成后台终端）：把这一轮还没结束的命令结束掉，模型自己开的后台任务不动
    try {
      const pending = new Set(translator.pendingItems())
      const { data = [] } = (await rpc.request(server, 'thread/backgroundTerminals/list', { threadId }, 10000)) || {}
      for (const terminal of data) {
        if (pending.has(terminal.itemId)) await rpc.request(server, 'thread/backgroundTerminals/terminate', { threadId, processId: terminal.processId }, 10000).catch(() => {})
      }
    } catch {
      /* 老版本没有这个接口 */
    }
  }
  const onAbort = () => {
    aborted = true
    void interrupt()
    // 先礼后兵：interrupt 让 Codex 自己收尾，几秒后还没结束就不等了
    setTimeout(() => settle({ status: 'interrupted' }), Number(config.abortGraceMs) || 5000).unref?.()
  }

  // 插话：运行中用户点了「插话发送」→ 从收件箱取走，用 turn/steer 塞进正在跑的这一轮（Codex 下一次采样就会读到，
  // 正在跑的命令不用停）。Codex 收下时发 item/started userMessage，这时写进记录（之后它的回应自然排在后面）；
  // 这一轮结束 Codex 还没收下的交回调用方。
  const steerWaiting = []
  const steerAccepted = []
  const leftover = []
  let steering = null
  let steeredCount = 0
  const showSteered = () => {
    if (!steerAccepted.length) return
    const shown = steerAccepted.splice(0)
    translator.interject(() => {
      for (const message of shown) append(session, 'user/message', { ...message, role: 'user' }, { surfaceOp: 'append' })
    })
  }
  const steerOnce = async () => {
    if (aborted || ended || !server || !threadId || !turnId) return
    const messages = pendingSteers(agent)
    if (!messages.length) return
    const taken = []
    for (const message of messages) {
      try {
        if (agent.inbox.remove(message.id)) taken.push(message)
      } catch (error) {
        console.warn(`[codex-pilot] 取插话消息失败：${error.message}`)
      }
    }
    if (!taken.length) return
    try {
      if (ended) throw new Error('这一轮已经结束')
      const steer = await buildPrompt(ctx, config, state, session, taken)
      const input = [{ type: 'text', text: steer.prompt, text_elements: [] }, ...steer.images.map((path) => ({ type: 'localImage', path }))]
      await rpc.request(server, 'turn/steer', { threadId, expectedTurnId: turnId, input }, 15000)
      steerWaiting.push(...taken)
      steeredCount += taken.length
      log(config, `steer: ${taken.length} 条插话已塞进 turn ${turnId}`)
    } catch (error) {
      leftover.push(...taken)
      log(config, `steer: 塞不进当前这一轮（${error?.message || error}），这一轮结束后接着跑`)
    }
  }
  const steerTimer = agent
    ? setInterval(() => {
        if (steering) return
        steering = steerOnce().finally(() => {
          steering = null
        })
      }, 400)
    : null

  try {
    server = await getServer(ctx, config, state)
    const memory = ctx.get('memoryPilot')
    const memorySpecs = (memory?.specs || []).map((spec) => ({ type: 'function', ...spec }))
    const opened = await openThread(server, config, rec, cwd, model, (text) => log(config, text), memorySpecs)
    threadId = opened.id
    if (opened.model) translator.setModel(opened.model)
    patchRecord(state, config, sessionId, { threadId, cwd, serverKey: server.key,
      ...(opened.fresh ? { memoryTools: memorySpecs.length > 0, memoryState: null } : {}),
    })

    const consumed = consumedSet(state, sessionId)
    const taskAbort = new AbortController()
    const runTool = createTaskHandlers(ctx, config, state, { sessionId, signal: taskAbort.signal, consumed, cwd, present: presentNow })
    server.threads.set(threadId, {
      onNotification(message) {
        const params = message.params || {}
        if (turnId && params.turnId && params.turnId !== turnId && message.method !== 'turn/completed') return
        translator.push(message)
        if (message.method === 'item/started' && params.item?.type === 'userMessage') {
          steerAccepted.push(...steerWaiting.splice(0))
          showSteered()
        }
        if (message.method === 'turn/started' && !turnId) turnId = params.turn?.id || null
        if (message.method === 'turn/completed' && (!turnId || params.turn?.id === turnId)) settle(params.turn || { status: 'completed' })
        if (message.method === 'server/exited') settle({ status: 'failed', error: { message: params.message } })
      },
      async onRequest(method, params) {
        if (method === 'item/tool/call') {
          const result = memory?.specs.some((spec) => spec.name === params.tool)
            ? await memory.execute(params.tool, params.arguments, { agent: agent || { session, options: {} }, signal: taskAbort.signal })
            : await runTool(params.tool, params.arguments)
          return { contentItems: [{ type: 'inputText', text: result.text }], success: !result.isError }
        }
        return approvalAnswer(config, method)
      },
    })
    if (signal?.aborted) onAbort()
    else signal?.addEventListener?.('abort', () => {
      taskAbort.abort()
      onAbort()
    }, { once: true })

    const special = specialCommand(prompt)
    if (special?.name === 'compact') {
      await rpc.request(server, 'thread/compact/start', { threadId }, 30000)
    } else if (special?.name === 'review') {
      const target = special.arg ? { type: 'custom', instructions: special.arg } : { type: 'uncommittedChanges' }
      const started = await rpc.request(server, 'review/start', { threadId, target, delivery: 'inline' }, 30000)
      turnId = started?.turn?.id || turnId
    } else {
      let prepared = null
      try {
        if (rec.memoryTools) prepared = await memory?.prepare(agent || { session, options: {} }, rec.memoryState || {})
      } catch (error) {
        console.warn(`[codex-pilot] 记忆索引读取失败：${error.message}`)
      }
      const input = [{ type: 'text', text: [prepared?.text, prompt].filter(Boolean).join('\n\n'), text_elements: [] }, ...images.map((path) => ({ type: 'localImage', path }))]
      const started = await rpc.request(server, 'turn/start', { threadId, input, cwd, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }, 60000)
      if (prepared) patchRecord(state, config, sessionId, { memoryState: prepared.state })
      turnId = started?.turn?.id || turnId
    }
    if (aborted && turnId) void interrupt()
    const final = await finished
    if (!aborted && final.status === 'failed') error = new Error(final.error?.message || translator.summary.errors.join('；') || 'Codex 这一轮失败了')
    if (final.status === 'interrupted') aborted = true
  } catch (caught) {
    if (!aborted) error = caught
  } finally {
    if (steerTimer) clearInterval(steerTimer)
    await steering
    if (server && threadId) server.threads.delete(threadId)
    delete state.activity[sessionId]
  }
  // 塞进去了但这一轮结束前 Codex 没收下的插话：跟塞不进去的一起交给下一段
  const steered = [...steerWaiting.splice(0), ...leftover]

  translator.finish(aborted ? '已被用户停止：这个工具调用没有等到结果' : '这个工具调用没有返回结果')
  showSteered()
  const summary = translator.summary

  if (!aborted && !error && !summary.texts && summary.compacted) appendNote(session, turn, translator.step + 1, '🗜 Codex 的上下文已压缩。')
  if (aborted) {
    appendNote(session, turn, translator.step + 1, '⏹ 已停止。下一句话会接着同一个 Codex 会话继续。')
  } else if (error) {
    const reason = String(error?.message || error)
    const detail = summary.errors.length && !reason.includes(summary.errors[0]) ? `\n\n\`\`\`\n${truncate(summary.errors.join('\n'), 1500)}\n\`\`\`` : ''
    const authHint = /not logged in|log ?in|api key|authenticat|unauthori[sz]ed|\b401\b|\b403\b|token|找不到 Codex/i.test(`${reason} ${summary.errors.join(' ')}`)
      ? '\n\n🔑 看起来是 Codex 登录/凭据的问题：到「设置 → Codex」里检查登录或 API Key。'
      : ''
    if (authHint) state.authReady = { at: 0, ready: false }
    appendNote(session, turn, translator.step + 1, `❌ Codex 这一轮没跑完：${reason}${authHint}${detail}`)
  }

  const total = summary.usage?.total || {}
  const prev = rec.stats || {}
  patchRecord(state, config, sessionId, {
    stats: {
      turns: (prev.turns || 0) + 1,
      abortedTurns: (prev.abortedTurns || 0) + (aborted ? 1 : 0),
      steeredMessages: (prev.steeredMessages || 0) + steeredCount,
      totalTokens: Number(total.totalTokens) || prev.totalTokens || 0,
      inputTokens: Number(total.inputTokens) || prev.inputTokens || 0,
      cachedInputTokens: Number(total.cachedInputTokens) || prev.cachedInputTokens || 0,
      outputTokens: Number(total.outputTokens) || prev.outputTokens || 0,
      lastContext: Number(summary.usage?.last?.inputTokens) || prev.lastContext || 0,
      contextWindow: Number(summary.usage?.modelContextWindow) || prev.contextWindow || null,
      model: summary.model || prev.model || null,
    },
  })
  try {
    await ctx.get('sessions')?.flush?.(session)
  } catch {
    /* 落盘失败不影响可见结果 */
  }
  log(config, `turn=${turn} model=${summary.model} steps=${summary.steps} tools=${summary.toolCalls} aborted=${aborted} error=${error?.message || ''}`)
  return { ok: !error && !aborted, aborted, error, summary, steered, lastStep: translator.step + 1 }
}

/* ------------------------------------------------------------ 把消息变成提示 */

function noticeKind(message) {
  const kind = message?.source?.kind
  return kind === 'subagent-settled' || kind === 'agent-message' ? kind : null
}

/**
 * 认领的消息 → 给 Codex 的输入。用户消息原样（附件落盘后在前面注明，图片另给路径）；
 * DSH 任务通知包成「[DSH 任务通知]」。Codex 已经用 task_wait 看过的任务，其结算通知不再叫醒它。
 */
async function buildPrompt(ctx, config, state, session, claimed) {
  const consumed = consumedSet(state, session.id)
  const userTexts = []
  const notices = []
  const userMessages = []
  for (const message of claimed) {
    const kind = noticeKind(message)
    if (!kind) {
      userMessages.push(message)
      const text = textOfMessage(message)
      if (text) userTexts.push(text)
      continue
    }
    const sender = message.source?.senderSessionId
    if (kind === 'subagent-settled' && sender && consumed.has(sender)) continue
    const rec = sender ? state.tasks?.get(sender) : null
    const title = rec?.label ? `任务「${rec.label}」(${sender})` : sender || '任务'
    const what = kind === 'subagent-settled' ? '结束了' : '发来消息'
    notices.push(`${title}${what}：\n${textOfMessage(message)}`)
    if (sender) consumed.add(sender)
  }
  let preamble = ''
  let images = []
  const parts = attachmentPartsOf(userMessages)
  if (parts.length) {
    try {
      const inbound = await materializeAttachments(ctx, cwdOf(session, config), parts)
      preamble = attachmentPreamble(inbound.notes, inbound.skipped)
      images = inbound.files.filter((file) => file.image).map((file) => file.path)
    } catch (error) {
      preamble = attachmentPreamble([], parts.map((part) => ({ name: part?.attachment?.name || '附件', reason: error.message })))
    }
  }
  const sections = []
  if (preamble || userTexts.length) sections.push(`${preamble}${userTexts.join('\n\n')}`.trim())
  if (notices.length) sections.push(`[DSH 任务通知]\n${notices.join('\n\n')}`)
  return { prompt: sections.join('\n\n'), images }
}

/** 兜底：任务在 Codex 这一轮进行中结束、通知可能丢失时，这一轮结束后补发一条通知。 */
function scheduleMissedNotices(ctx, state, sessionId, since) {
  const consumed = consumedSet(state, sessionId)
  const missed = [...(state.tasks?.values() || [])].filter(
    (rec) => rec.parentId === sessionId && rec.status !== 'running' && !consumed.has(rec.childId) && (rec.endedAt || 0) >= since,
  )
  if (!missed.length) return
  setTimeout(() => {
    const still = missed.filter((rec) => !consumed.has(rec.childId) && rec.status !== 'running')
    if (!still.length) return
    const agent = ctx.get('agents')?.get?.(sessionId)
    if (!agent?.followup) return
    const text = still
      .map((rec) => `[DSH 任务通知] 任务「${rec.label}」(${rec.childId}) 已结束（${rec.status}${rec.reason ? `/${rec.reason}` : ''}）。结束语：\n${truncate(rec.finalText || '（没有结束语）', 12000)}`)
      .join('\n\n')
    for (const rec of still) consumed.add(rec.childId)
    try {
      agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
    } catch (error) {
      console.warn(`[codex-pilot] 补发任务通知失败：${error.message}`)
    }
  }, 1500).unref?.()
}

/* ------------------------------------------------------------ pre-step 接管 */

/**
 * 我们在 pre-step 里跑完整个 Codex 回合后返回「空 enter」，agent loop 走的是 `phase.step === 0` 的
 * 直接 return false —— 跳过了回合末尾的「收件箱里还有没有消息」检查。于是运行中排队的消息
 * 会一直躺在收件箱里，要等下一次有人叫醒它。这里在回合结束、agent 回到 idle 后补一次唤醒。
 */
function wakeForLeftovers(agent) {
  if (!agent) return
  let tries = 0
  const check = () => {
    tries += 1
    try {
      if (agent.status !== 'idle') {
        if (tries < 100) setTimeout(check, 200).unref?.()
        return
      }
      if (agent.inbox?.hasPending && typeof agent.wakeDriver === 'function') agent.wakeDriver()
    } catch (error) {
      console.warn(`[codex-pilot] 唤醒排队消息失败：${error.message}`)
    }
  }
  setTimeout(check, 200).unref?.()
}

export async function handlePreStep(ctx, config, state, payload, next) {
  const agent = payload?.agent
  const agentId = agent?.id
  if (!agentId) return next()
  const session = ctx.get('sessions')?.get?.(agentId)
  if (!session || isSubagentSession(session) || !pilotMode(ctx, session, agent)) return next()

  const key = `${agentId}#${payload.turn}`
  state.inflight ||= new Map()
  if (!(state.handled instanceof Map)) state.handled = new Map()
  const running = state.inflight.get(key)
  if (running) return running
  // 同一 turn 的后续 step：我们已经处理完了，绝不交给 DSH 的模型
  if (state.handled.has(key)) return { kind: 'enter', messages: [] }

  const task = (async () => {
    let claimed = Array.isArray(payload.messages) ? payload.messages : []
    ensureWatchers(ctx, config, state)
    state.marked ||= new Set()
    state.marked.add(session.id)
    await ensureSelection(ctx, config, state, session)

    const turnStartedAt = Date.now()
    let stepBase = 0
    try {
      // 一段 Codex 跑完；期间有没来得及塞进去的插话 → 带着它们在同一个 DSH turn 里接着跑下一段
      for (let round = 0; round < 50; round += 1) {
        // 走 enter 空消息时 loop 不写 user/message：自己写，用户才看得到自己的话（任务通知也照原样写）
        for (const message of claimed) {
          if (!message || typeof message !== 'object') continue
          if (!textOfMessage(message) && !attachmentPartsOf([message]).length) continue
          append(session, 'user/message', { ...message, role: 'user' }, { surfaceOp: 'append' })
        }
        const { prompt, images } = await buildPrompt(ctx, config, state, session, claimed)
        if (!prompt && !images.length) break
        const outcome = await runCodexTurn(ctx, config, state, { session, turn: payload.turn, prompt, images, signal: payload.signal, agent, stepBase })
        if (!outcome?.steered?.length || payload.signal?.aborted) break
        claimed = outcome.steered
        stepBase = outcome.lastStep
      }
      scheduleMissedNotices(ctx, state, agentId, turnStartedAt)
    } catch (error) {
      console.warn(`[codex-pilot] 这一轮出错：${error?.stack || error}`)
      try {
        appendNote(session, payload.turn, 99, `❌ Codex 桥出错：${error?.message || error}`)
      } catch {
        /* 连提示都写不了 */
      }
    }
    return { kind: 'enter', messages: [] }
  })()

  state.inflight.set(key, task)
  try {
    return await task
  } catch (error) {
    console.warn(`[codex-pilot] pre-step 异常：${error?.stack || error}`)
    return { kind: 'enter', messages: [] }
  } finally {
    wakeForLeftovers(agent)
    state.handled.set(key, true)
    if (state.handled.size > 400) for (const old of [...state.handled.keys()].slice(0, 200)) state.handled.delete(old)
    state.inflight.delete(key)
  }
}

/* ----------------------------------------------------------- Codex 斜杠命令 */

// model：DSH 前端自带同名的客户端命令（撞名会让整个斜杠菜单报错），切模型用输入框的模型芯片
const COMMANDS = [
  { name: 'compact', description: '压缩 Codex 的上下文（总结之前的对话，释放窗口）' },
  { name: 'review', description: '让 Codex 审查当前未提交的改动（可附加审查要求）', hint: '[审查要求]' },
  { name: 'status', description: '查看 Codex 会话状态：模型、思考程度、上下文用量、账号' },
  { name: 'clear', description: '下一句话开一个新的 Codex 会话（清空上下文）' },
  { name: 'effort', description: '设置思考程度', hint: '<low|medium|high|xhigh|max|ultra>' },
  { name: 'init', description: '为当前项目生成 AGENTS.md（给 Codex 的项目说明）' },
  { name: 'mcp', description: '列出 Codex 已配置的 MCP 服务' },
]

const INIT_PROMPT = [
  'Generate a file named AGENTS.md that serves as a contributor guide for this repository.',
  'Explore the repository first (structure, build/test commands, code style, commit conventions), then write a concise guide (200–400 words) with sections such as Project Structure, Build & Test Commands, Coding Style, Testing Guidelines, and Commit & PR Guidelines.',
  'If AGENTS.md already exists, improve it instead of replacing useful content. Reply in the user\'s language when summarizing what you did.',
].join(' ')

export function commandList() {
  return COMMANDS
}

/** 执行一条 Codex 命令（DSH 命令处理器调过来）。 */
export async function runCommand(ctx, config, state, name, { agent, rawInput }) {
  const sessionId = agent?.id
  const session = ctx.get('sessions')?.get?.(sessionId)
  if (!session || !pilotMode(ctx, session, agent)) return { kind: 'error', text: '这个对话不是 Codex 模式' }
  const arg = String(rawInput || '').trim()
  const followup = (text) => agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
  switch (name) {
    case 'clear':
      patchRecord(state, config, sessionId, { threadId: null })
      return { kind: 'success', text: '下一句话会开一个新的 Codex 会话（之前的会话还在 Codex 的历史里）。' }
    case 'effort': {
      ensureModelAdapter(ctx, state, config)
      const current = readSelection(session) || {}
      const effort = arg.toLowerCase()
      const allowed = Object.keys(EFFORT_NAMES)
      if (!allowed.includes(effort)) return { kind: 'error', text: `可选：${allowed.join(' / ')}` }
      await ctx.get('sessionController')?.selectModel?.({ sessionId, provider: CX_PROVIDER, model: current.model || CX_MODEL_ID, reasoningEffort: effort })
      return { kind: 'success', text: `思考程度：${effort}（下一轮生效）` }
    }
    case 'status': {
      const rec = loadStore(state, config).data.sessions[sessionId] || {}
      const selection = readSelection(session) || {}
      const auth = await setup.authStatus(ctx, config, state)
      const stats = rec.stats || {}
      const context = stats.contextWindow ? `${Math.round((stats.lastContext || 0) / 1000)}k / ${Math.round(stats.contextWindow / 1000)}k` : `${Math.round((stats.lastContext || 0) / 1000)}k`
      const lines = [
        `模型：${selection.model && selection.model !== CX_MODEL_ID ? selection.model : `Codex 默认${stats.model ? `（${stats.model}）` : ''}`}`,
        `思考程度：${selection.reasoningEffort || '默认'}`,
        `上下文：${context} tokens · 本会话累计 ${Math.round((stats.totalTokens || 0) / 1000)}k`,
        `账号：${auth.loggedIn ? [auth.authType, auth.email, auth.planType].filter(Boolean).join(' · ') || '已登录' : `未登录（${auth.error || ''}）`}`,
        `Codex 会话：${rec.threadId || '（还没开始）'}`,
      ]
      return { kind: 'success', text: lines.join('\n') }
    }
    case 'mcp': {
      try {
        const server = await getServer(ctx, config, state)
        const result = await rpc.request(server, 'mcpServerStatus/list', { limit: 50 }, 30000)
        const list = (result?.data || []).map((entry) => `${entry.name}：${Object.keys(entry.tools || {}).length} 个工具${entry.toolsError ? `（${entry.toolsError}）` : ''}`)
        return { kind: 'success', text: list.length ? list.join('\n') : 'Codex 没有配置 MCP 服务。' }
      } catch (error) {
        return { kind: 'error', text: `读取失败：${error.message}` }
      }
    }
    case 'init':
      followup(INIT_PROMPT)
      return { kind: 'success', text: '' }
    case 'compact':
      followup('/compact')
      return { kind: 'success', text: '' }
    case 'review':
      followup(`/review${arg ? ` ${arg}` : ''}`)
      return { kind: 'success', text: '' }
    default:
      followup(`/${name}${arg ? ` ${arg}` : ''}`)
      return { kind: 'success', text: '' }
  }
}

/* ------------------------------------------------------------------ 初始化 */

export async function handleSetupRequest(ctx, config, state, body) {
  // 用量条：套餐额度（只有 ChatGPT 账号登录才有）+ 本会话累计
  if (body?.action === 'usage') {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    return {
      ok: true,
      plan: await setup.planUsage(ctx, config, state, { force: body.force === true }),
      session: sessionId ? loadStore(state, config).data.sessions[sessionId]?.stats || null : null,
    }
  }
  const result = await setup.handleSetup(ctx, config, state, body)
  if (body?.action && body.action !== 'state' && body.action !== 'test' && body.action !== 'login-status') state.authReady = { at: 0, ready: false }
  if (result && typeof result.ready === 'boolean') state.authReady = { at: Date.now(), ready: result.ready, note: setupNoteOf(result.status) }
  return result
}

/**
 * 状态接口只给「一句原因」：优先说「程序没找到」（平台包没装上），其次说 Hub 的拒绝原因。
 * 没登录的普通情况不占用横幅（前端自己有默认文案）。
 */
function setupNoteOf(status) {
  if (!status) return null
  if (!status.binary?.path && status.error) return status.error
  if (status.authType === 'hub' && !status.loggedIn) return status.error || null
  return null
}

/** 是否已有可用凭据（account/read，缓存 30 秒；过期就在后台刷新，先回旧值）。 */
function authReady(ctx, config, state) {
  const cached = state.authReady
  if (!cached || Date.now() - cached.at > 30000) {
    if (!state.authChecking) {
      state.authChecking = setup
        .authStatus(ctx, config, state)
        .then((status) => {
          // 程序没找到 / Hub 模式下没开放或没模型的原因给提示条显示（都不含账号信息）
          state.authReady = { at: Date.now(), ready: Boolean(status.loggedIn), note: setupNoteOf(status) }
        })
        .catch(() => {})
        .finally(() => {
          state.authChecking = null
        })
    }
  }
  return cached ? cached.ready : null
}

/* --------------------------------------------------------------- HTTP 路由 */

/** GET /codex-pilot：状态 + 最近派出的任务 + 运行中会话的状态行（客户端轮询）。 */
export function status(ctx, config, state, { since = 0 } = {}) {
  const store = loadStore(state, config)
  const activity = {}
  for (const [id, entry] of Object.entries(state.activity || {})) if (Date.now() - entry.at < 120000) activity[id] = entry.text
  return {
    ok: true,
    codex: setup.resolveBinary(config).path || '找不到',
    memoryTools: ctx.get('memoryPilot')?.specs.length || 0,
    server: rpc.serverInfo(state.server),
    pilotSessions: [...new Set([...Object.keys(store.data.sessions), ...(state.marked || [])])],
    spawns: (state.spawns || []).filter((item) => item.at > Number(since || 0)),
    activity,
    tasks: [...(state.tasks?.values() || [])].map((rec) => ({ id: rec.childId, parent: rec.parentId, label: rec.label, status: rec.status, reason: rec.reason || null, model: rec.model })),
    sessions: Object.keys(store.data.sessions).length,
    // 模型芯片的目录来源（诊断用）：app-server model/list 拉到了几个模型
    models: { count: (state.models || []).length, ids: (state.models || []).slice(0, 30).map((entry) => entry.id || entry.model), key: state.modelsKey || null },
    // 只给布尔值（这个 GET 不经过 DSH 登录，不能泄露账号信息）；null = 还没检测完
    setupReady: authReady(ctx, config, state),
    setupNote: state.authReady?.note || null,
    defaultSelection: (() => {
      try {
        return ctx.get('agentDefaultModel')?.currentSelection?.() ?? null
      } catch (error) {
        return { error: error.message }
      }
    })(),
    now: Date.now(),
  }
}

function eventsOf(session, limit = 300) {
  return (session?.snapshotEvents?.() || []).slice(-limit).map((event) => {
    const data = event.data || {}
    const brief = { type: event.type }
    if (data.turn !== undefined) brief.turn = data.turn
    if (data.step !== undefined) brief.step = data.step
    if (event.type === 'assistant/message') brief.content = (data.message?.content || []).map((b) => (b.type === 'text' ? truncate(b.text, 300) : b.type === 'tool-call' ? `[call ${b.name}]` : `[${b.type}${b.text ? `:${truncate(b.text, 80)}` : ''}]`))
    if (event.type === 'tool/call') brief.call = `${data.name} ${truncate(data.arguments, 160)}`
    if (event.type === 'tool/result') brief.result = truncate(textOfMessage(data.message), 200)
    if (event.type === 'user/message') brief.text = truncate(textOfMessage(data), 200)
    if (event.type === 'user/message') brief.source = data.source?.kind
    if (event.type === 'turn/end') brief.reason = data.reason?.kind
    if (event.type === 'deliverables/presented') brief.files = (data.files || []).map((f) => `${f.path}（${f.description}）`)
    if (event.type === 'model/selection') brief.selection = `${data.provider}/${data.model}`
    return brief
  })
}

/**
 * POST /codex-pilot {prompt|prompts, cwd?, keep?, waitTasks?, timeoutMs?, commands?, abortAfterMs?, steerAfterMs?, steerText?, queueAfterMs?, queueText?, settleExtraMs?, archive?, preset?}
 * 不用浏览器的端到端测试：新建一个 codex-pilot 会话，按真实提交路径（agent.followup）发消息，等它空闲。
 */
export async function lab(ctx, config, state, body = {}) {
  if (Array.isArray(body.archive)) {
    const registry = ctx.get('workspaceRegistry')
    const results = []
    for (const id of body.archive) {
      try {
        await registry?.archiveSession?.(id)
        results.push({ id, ok: true })
      } catch (error) {
        results.push({ id, ok: false, error: error.message })
      }
    }
    return { ok: true, results }
  }
  // 测试界面用：在没有 ChatGPT 账号的机器上模拟套餐额度（{usageMock: {...}} 设置，{usageMock: null} 清除）
  if ('usageMock' in body) {
    state.usageMock = body.usageMock || null
    return { ok: true, usageMock: state.usageMock }
  }
  if (body.usage) return handleSetupRequest(ctx, config, state, { action: 'usage', sessionId: body.sessionId, force: true })
  if (body.setup) return handleSetupRequest(ctx, config, state, { action: body.setup === true ? 'state' : body.setup })
  // 产看模型芯片会显示什么（诊断模型目录：先像模型选择器那样拉一次，再列目录）
  if (body.catalog) {
    const before = (state.models || []).length
    const warmed = await warmModels(ctx, config, state)
    return { ok: true, before, warmed, models: catalog(state).slice(0, 60) }
  }
  const prompts = Array.isArray(body.prompts) && body.prompts.length ? body.prompts : [body.prompt || '只回复：桥已就绪']
  const timeoutMs = Number(body.timeoutMs) || 300000
  const sessions = ctx.get('sessions')
  const agentLoop = ctx.get('agentLoop')
  if (!agentLoop?.create || !sessions?.get) return { ok: false, error: 'SERVICE_MISSING' }
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.() || {}
  const sessionId = body.sessionId || `session-codex-lab-${randomUUID().slice(0, 8)}`
  let agent = ctx.get('agents')?.get?.(sessionId)
  if (!agent) {
    agent = await agentLoop.create(sessionId, { provider: selection.provider, model: selection.model }, { cwd: body.cwd || config.fallbackCwd || homedir() })
    await ctx.get('agentPresets')?.select?.(agent, body.preset || PILOT_PRESET)
  }
  const session = sessions.get(sessionId)
  const info = { sessionId, composedPreset: ctx.get('agentPresets')?.composedPreset?.(agent.ctx) ?? null }
  const frames = { count: 0, kinds: {}, revisions: [], text: '', ends: [] }
  const offFrames = ctx.on(
    'agent/assistant-stream',
    ({ agent: from, frame }) => {
      if (from?.id !== sessionId || !frame) return
      frames.count += 1
      const kind = `${frame.type}${frame.chunk ? `:${frame.chunk.type}` : ''}`
      frames.kinds[kind] = (frames.kinds[kind] || 0) + 1
      if (frames.revisions.length < 400) frames.revisions.push(frame.revision)
      if (frame.chunk?.type === 'text-delta') frames.text += frame.chunk.text
      if (frame.type === 'end') frames.ends.push(frame.outcome?.kind)
    },
    { global: true },
  )
  const deadline = Date.now() + timeoutMs
  const idle = async () => {
    while (Date.now() < deadline) {
      await Promise.race([agent.whenIdle?.(), new Promise((ok) => setTimeout(ok, 2000))])
      if (agent.status === 'idle') return true
    }
    return false
  }
  if (Array.isArray(body.commands)) {
    const commands = ctx.get('commands')
    info.commandList = (commands?.list?.(agent) || []).map((cmd) => cmd.name).slice(0, 120)
    info.commandResults = []
    for (const line of body.commands) {
      const execution = await commands?.execute?.(agent, line, [], new AbortController().signal)
      info.commandResults.push({ line, result: execution?.result ?? (execution === undefined ? 'REJECTED(未知命令)' : null) })
      await new Promise((ok) => setTimeout(ok, 500))
      info.settled = await idle()
    }
  }
  for (const text of body.commands && !body.prompt && !body.prompts ? [] : prompts) {
    agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
    if (Number(body.abortAfterMs) > 0) setTimeout(() => agent.cancel({ kind: 'user' }, { keepInbox: true }), Number(body.abortAfterMs)).unref?.()
    // 模拟运行中「插话发送」（会话控制器 mode=steer 同一句）和运行中排队（mode=queue）
    if (body.steerOnTool) {
      // 等 Codex 真的开始跑工具（有 tool/call 还没 tool/result）再插话
      const steerStarted = Date.now()
      const poll = setInterval(() => {
        const evs = session.snapshotEvents?.() || []
        const calls = evs.filter((e) => e.type === 'tool/call').length
        const results = evs.filter((e) => e.type === 'tool/result').length
        if (calls > results) {
          clearInterval(poll)
          setTimeout(() => agent.steer({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: String(body.steerText || '停，改成只回复：插话收到') }], source: { kind: 'user' } }), Number(body.steerAfterMs) || 0)
        } else if (Date.now() - steerStarted > 180000) clearInterval(poll)
      }, 300)
      poll.unref?.()
    } else if (Number(body.steerAfterMs) > 0)
      setTimeout(() => agent.steer({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: String(body.steerText || '停，改成只回复：插话收到') }], source: { kind: 'user' } }), Number(body.steerAfterMs)).unref?.()
    if (Number(body.queueAfterMs) > 0)
      setTimeout(() => agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: String(body.queueText || '只回复：排队消息收到') }], source: { kind: 'user' } }), Number(body.queueAfterMs)).unref?.()
    await new Promise((ok) => setTimeout(ok, 300))
    info.settled = await idle()
    // 插话/排队的消息要等它们那一轮也跑完（或确认它们卡在收件箱里）
    if (body.steerOnTool || Number(body.steerAfterMs) > 0 || Number(body.queueAfterMs) > 0) {
      await new Promise((ok) => setTimeout(ok, Number(body.settleExtraMs) || 4000))
      info.settled = await idle()
      info.inboxLeft = { nextStep: agent.inbox?.nextStep?.length ?? null, nextTurn: agent.inbox?.nextTurn?.length ?? null }
    }
    if (!info.settled) break
  }
  if (body.waitTasks) {
    while (Date.now() < deadline) {
      const mine = [...(state.tasks?.values() || [])].filter((rec) => rec.parentId === sessionId)
      if (mine.length && mine.every((rec) => rec.status !== 'running') && agent.status === 'idle') {
        await new Promise((ok) => setTimeout(ok, 3000))
        if (agent.status === 'idle') break
      }
      await new Promise((ok) => setTimeout(ok, 1500))
    }
    info.tasks = status(ctx, config, state).tasks.filter((t) => t.parent === sessionId)
  }
  if (typeof offFrames === 'function') offFrames()
  const dense = frames.revisions.every((value, index) => index === 0 || value === frames.revisions[index - 1] + 1 || value === 1)
  info.frames = { count: frames.count, kinds: frames.kinds, dense, firstRevisions: frames.revisions.slice(0, 5), ends: frames.ends, text: truncate(frames.text, 300) }
  info.record = loadStore(state, config).data.sessions[sessionId] || null
  info.events = eventsOf(session)
  if (!body.keep) {
    try {
      ctx.get('workspaceRegistry')?.archiveSession?.(sessionId)
      info.archived = true
    } catch (error) {
      info.archiveError = error.message
    }
  }
  return { ok: true, ...info }
}

/**
 * POST 能以完全权限跑 Codex，而插件路由不经过 DSH 的登录校验，
 * 所以 POST 必须带本机文件里的密钥：x-pilot-token = ~/.dsh/codex-pilot/lab-token（0600，首次自动生成）。
 */
export function labTokenOk(config, header) {
  const file = join(setup.pilotHome(config), 'lab-token')
  let token = ''
  try {
    token = readFileSync(file, 'utf8').trim()
  } catch {
    mkdirSync(dirname(file), { recursive: true })
    token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
    writeFileSync(file, `${token}\n`, { mode: 0o600 })
  }
  return Boolean(token) && typeof header === 'string' && header.trim() === token
}

/** 查任意会话的事件（调试子会话用）。 */
export function dump(ctx, sessionId, limit) {
  const session = ctx.get('sessions')?.get?.(sessionId)
  if (!session) return { ok: false, error: 'SESSION_NOT_LOADED' }
  return { ok: true, header: session.header, events: eventsOf(session, Number(limit) || 200) }
}

/** 宿主关闭时停掉 app-server。 */
export function shutdownAll(state) {
  rpc.shutdown(state.server, 'DSH 关闭')
  if (state.login?.server) rpc.shutdown(state.login.server, 'DSH 关闭')
}
