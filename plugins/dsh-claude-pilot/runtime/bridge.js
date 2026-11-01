/**
 * dsh-claude-pilot —— 桥的实现（由 index.js 按 mtime 热加载，改完存盘即生效）。
 *
 * 会话预设 = claude-pilot 时：
 *   agent/pre-step → 把这一轮认领的消息写成 user/message → 用 Claude Agent SDK 跑一轮 Claude Code
 *   （resume 上一轮的 Claude 会话）→ 消息逐条翻译成 DSH 原生事件 → 返回 {kind:'enter', messages:[]}，
 *   loop 以 completed 收尾，完全不调 DSH 的模型。
 *
 * Claude 手里多了一组 mcp__dsh__task_* 工具：派出的任务是这个对话下的真 DSH 子会话（见 tasks.js），
 * 任务结束时 DSH 发来的结算通知会让父会话再起一轮 → 这里把通知转成「[DSH 任务通知]」交给 Claude。
 *
 * ⚠ 本模块会被反复 import：可变状态一律放在 index.js 传进来的 state 里。
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 同目录模块带上本模块的版本号再 import：ESM 按 URL 缓存，不带的话改了它们也不会热加载
const V = new URL(import.meta.url).search
const { createTranslator, truncate } = await import(`./translate.js${V}`)
const { PILOT_PROMPT, createTaskServer, ensureTaskTracker } = await import(`./tasks.js${V}`)
const { appendDeliverables, attachmentPartsOf, attachmentPreamble, materializeAttachments } = await import(`./files.js${V}`)
const setup = await import(`./setup.js${V}`)
const platform = await import(`./platform.js${V}`)

export const PILOT_PRESET = 'claude-pilot'
export const CC_PROVIDER = 'claude-code'
export const CC_MODEL_ID = 'cli-default'
// 对话模式的占位提供者（Codex 模式的插件用 codex）：都不是能拿来当默认模型的真模型
const PSEUDO_PROVIDERS = new Set([CC_PROVIDER, 'codex'])

/* ------------------------------------------------------------------ 小工具 */

function log(config, ...args) {
  if (config.verbose) console.log('[claude-pilot]', ...args)
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
      message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: CC_PROVIDER, model: CC_PROVIDER }, id: randomUUID() },
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

export function resolveClaude(config) {
  // 系统里装的 > SDK 自带的（claudePath: bundled 强制自带）；见 setup.js
  return setup.resolveBinary(config).path
}

/**
 * 给 Claude Code 子进程的环境。Windows 上与 POSIX 的差别都在 platform.js：
 *   - PATH 用 `;` 分隔，键名可能是 `Path`（直接 `env.PATH = …` 会把它顶掉，孩子的 PATH 就只剩我们加的那几个）；
 *   - 要补的是 %APPDATA%\npm、Node 的安装目录（Git 目录**不**补：Git Bash 只经 CLAUDE_CODE_GIT_BASH_PATH 给 claude）；
 *   - HOME 可能没设（Windows 用 USERPROFILE），Git Bash 却认 HOME。
 */
export function childEnv() {
  return platform.baseChildEnv()
}

/** hub-connector 注册进来的 Hub 配置来源（桌面端）；容器里没有它，走 HUB_CLAUDE_* 环境变量。 */
export function setHubProvider(fn) {
  setup.setHubProvider(fn)
}

/**
 * Hub 侧配置换了（hubAgentModes.onChange：登录/登出、管理员改模型或地址、被移出 targets、设备密钥轮换）：
 * 清掉 Hub 配置缓存 + 就绪缓存，下一轮/下一次状态查询按新配置重新走一遍 —— 和「设置页改了配置」
 * 走的是同一条刷新路径，不需要重启。
 */
export function hubConfigChanged(state) {
  setup.invalidateHubConfig()
  if (state) state.authReady = { at: 0, ready: false }
}

/** 订阅额度用满时给一句人话。 */
function describeLimit(limit) {
  if (!limit || limit.status !== 'rejected') return ''
  const window = limit.rateLimitType === 'five_hour' ? '5 小时窗口' : limit.rateLimitType === 'seven_day' ? '每周窗口' : '用量窗口'
  const resetsAt = Number(limit.resetsAt)
  const when = resetsAt > 0 ? `，${new Date(resetsAt * 1000).toLocaleString('zh-CN', { hour12: false })} 重置` : ''
  return `⛔ Claude 订阅额度已用满（${window}${when}）。`
}

/* --------------------------------------------------------- 会话记录（持久） */

function storeFile(config) {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return config.storeFile || join(home, 'claude-pilot', 'sessions.json')
}

export function loadStore(state, config) {
  if (state.store) return state.store
  const file = storeFile(config)
  let data = { version: 1, sessions: {} }
  try {
    if (existsSync(file)) data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    console.warn(`[claude-pilot] 会话记录读取失败，重新开始：${error.message}`)
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
    console.warn(`[claude-pilot] 会话记录保存失败：${error.message}`)
  }
}

/** Claude 已经通过 task_wait 看过结果的子任务（每个父会话一份，仅内存）。 */
function consumedSet(state, sessionId) {
  state.consumed ||= new Map()
  if (!state.consumed.has(sessionId)) state.consumed.set(sessionId, new Set())
  return state.consumed.get(sessionId)
}

/* ------------------------------------------- 模型芯片说实话：claude-code 提供者 */

const GENERATION = (() => {
  try {
    return String(statSync(fileURLToPath(import.meta.url)).mtimeMs)
  } catch {
    return 'unknown'
  }
})()

const CC_EFFORTS = [
  { id: 'low', name: '低' },
  { id: 'medium', name: '中' },
  { id: 'high', name: '高' },
  { id: 'xhigh', name: '很高' },
  { id: 'max', name: '最大' },
]

const CC_MODEL_CATALOG = [
  { id: CC_MODEL_ID, name: '跟随 Claude Code 默认', description: '不指定模型，用 Claude Code 自己的默认' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5', description: 'claude-opus-5-5' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', description: 'claude-sonnet-5-5' },
  { id: 'claude-fable-5-1', name: 'Fable 5.1', description: 'claude-fable-5-1' },
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5', description: 'claude-haiku-5-5' },
]

/** Hub 中转站模式：模型列表由 Hub 管理员配置（setup.hubConfig），否则用内置的 Claude 模型表 */
function modelCatalog(config) {
  const hub = setup.lastHubConfig(config)
  if (!hub?.models?.length) return CC_MODEL_CATALOG
  const fallback = hub.defaultModel ? `跟随 Hub 默认（${hub.defaultModel}）` : '跟随 Hub 默认'
  return [
    { id: CC_MODEL_ID, name: fallback, description: '不指定模型，用 DSH Hub 管理员设的默认模型' },
    ...hub.models.map((m) => ({ id: m.id, name: m.displayName || m.id, description: m.id })),
  ]
}

function ccModelMeta(provider, model, config) {
  const catalog = modelCatalog(config)
  const entry = catalog.find((item) => item.id === model) || catalog[0]
  return {
    provider,
    id: model || entry.id,
    name: entry.name,
    description: entry.description,
    inputModalities: ['text', 'image'],
    reasoning: { efforts: CC_EFFORTS, defaultEffort: 'high' },
  }
}

function claudeCodeAdapter(config) {
  return {
    providerInfo: (provider) => ({ id: provider, name: 'Claude Code' }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    async listModels(provider) {
      await setup.hubConfig(config).catch(() => null)
      return modelCatalog(config).map((entry) => ccModelMeta(provider, entry.id, config))
    },
    async resolveModel(provider, model) {
      return ccModelMeta(provider, model || CC_MODEL_ID, config)
    },
    async prepareCall(provider, model) {
      return { model: ccModelMeta(provider, model || CC_MODEL_ID, config), stream: (options) => this.stream(options) }
    },
    async *stream() {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: '这个对话由 Claude Code 驱动，DSH 的模型不会被调用。看到这条说明桥没生效（查 /claude-pilot 诊断）。', code: 'CLAUDE_PILOT_MODE' },
        },
      }
    },
  }
}

export function ensureModelAdapter(ctx, state, config) {
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
    state.adapterHandle = llm.registerAdapter([CC_PROVIDER], claudeCodeAdapter(config))
  } catch (error) {
    if (!/DUPLICATE_ADAPTER/.test(`${error?.code} ${error?.message}`)) {
      console.warn(`[claude-pilot] 注册 claude-code 提供者失败：${error.message}`)
      return false
    }
  }
  state.adapterRegistered = true
  state.adapterGeneration = GENERATION
  return true
}

/** 会话最后一条 model/selection（只认 claude-code 提供者）。 */
export function readSelection(session) {
  const events = session?.snapshotEvents?.() || []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'model/selection') continue
    const data = event.data || {}
    if (data.provider !== CC_PROVIDER) return null
    return { model: data.model, reasoningEffort: data.reasoningEffort }
  }
  return null
}

/** 第一次进模式时把会话的模型切到 claude-code（已有 claude-code 选择就不动 —— 那是用户选的）。 */
async function ensureSelection(ctx, config, state, session) {
  if (readSelection(session)) return
  state.selected ||= new Set()
  if (state.selected.has(session.id)) return
  const controller = ctx.get('sessionController')
  if (!controller?.selectModel) return
  try {
    await controller.selectModel({
      sessionId: session.id,
      provider: CC_PROVIDER,
      model: config.defaultModel || CC_MODEL_ID,
      ...(config.defaultEffort ? { reasoningEffort: config.defaultEffort } : {}),
    })
    state.selected.add(session.id)
    protectSoon(ctx, config, state)
  } catch (error) {
    console.warn(`[claude-pilot] 切换会话模型失败（不影响这一轮）：${error.message}`)
  }
}

/**
 * DSH 的 sessionController.selectModel 会顺手把选择存成「全局默认模型」（session-controller 里
 * selectModel → agentDefaultModel.saveSelection）。Claude 会话一选 claude-code，标准对话的默认模型
 * 就被带成 claude-code —— 新开的普通对话直接报错。这里守住：默认模型一旦变成 claude-code，
 * 就恢复成上一个正常值（没有记录就用 taskModel）。
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
  if (current?.provider !== CC_PROVIDER) return // codex 归 Codex 模式的插件管
  const fallback = config.taskModel?.provider && !PSEUDO_PROVIDERS.has(config.taskModel.provider) ? { ...config.taskModel } : null
  const good = state.goodDefault || fallback
  if (!good) return
  Promise.resolve(service.saveSelection(good))
    .then(() => log(config, `默认模型被带成 claude-code，已恢复为 ${good.provider}/${good.model}`))
    .catch((error) => console.warn(`[claude-pilot] 恢复默认模型失败：${error.message}`))
}

/** 等 session-controller 那边异步的 saveSelection 落定，再检查一次默认模型。 */
function protectSoon(ctx, config, state) {
  for (const delay of [400, 1500]) setTimeout(() => protectDefaultModel(ctx, config, state), delay).unref?.()
}

/**
 * 会话预设与模型对齐：切到 Claude Code → 模型设为「Claude Code 默认」（已选过 claude-code 模型就不动）；
 * 从 Claude Code 切回别的预设 → 模型恢复成正常默认（否则标准对话会带着 claude-code 模型报错）。
 * 只在空白会话里发生（DSH 只允许空白会话换预设）。
 */
export async function syncModelWithPreset(ctx, config, state, sessionId) {
  const session = ctx.get('sessions')?.get?.(sessionId)
  const agent = ctx.get('agents')?.get?.(sessionId)
  if (!session || !agent || isSubagentSession(session)) return
  ensureModelAdapter(ctx, state, config)
  if (pilotMode(ctx, session, agent)) {
    state.marked ||= new Set()
    state.marked.add(sessionId)
    await ensureSelection(ctx, config, state, session)
    return
  }
  state.marked?.delete(sessionId)
  state.selected?.delete(sessionId)
  const events = session.snapshotEvents?.() || []
  const last = [...events].reverse().find((event) => event.type === 'model/selection')
  if (last?.data?.provider !== CC_PROVIDER) return
  protectDefaultModel(ctx, config, state)
  const good = state.goodDefault || (config.taskModel?.provider ? config.taskModel : null)
  if (!good) return
  try {
    await ctx.get('sessionController')?.selectModel?.({ sessionId, provider: good.provider, model: good.model, ...(good.reasoningEffort ? { reasoningEffort: good.reasoningEffort } : {}) })
  } catch (error) {
    console.warn(`[claude-pilot] 切回预设时恢复模型失败：${error.message}`)
  }
}

/** 启动即挂上的监听：预设/模型对齐、默认模型保护、新建的 Claude Code 会话立刻切模型。 */
export function ensureWatchers(ctx, config, state) {
  ensureModelAdapter(ctx, state, config)
  ensureSelectionGuard(ctx, config, state)
  ensureTaskTracker(ctx, state)
  if (state.createdWatcher) return
  // 带着 agentPreset 直接创建的会话（header 里就是 claude-pilot）没有 agent-preset/selected 事件
  state.createdWatcher = ctx.on('agent/created', (payload) => {
    const id = payload?.agent?.id
    if (id) setTimeout(() => void syncModelWithPreset(ctx, config, state, id), 300)
  })
}

/** 模式会话里有人把模型切到别的提供者 → 切回来（客户端没有按会话过滤模型目录的钩子）。 */
function ensureSelectionGuard(ctx, config, state) {
  if (state.selectionGuard) return
  state.lastCcSelection ||= {}
  state.selectionGuard = ctx.on('session/event', (session, event) => {
    if (event?.type === 'agent-preset/selected' && session?.id) {
      // 空白会话里切了预设（Hero 页的预设下拉）：模型跟着切，芯片立刻显示对
      setTimeout(() => void syncModelWithPreset(ctx, config, state, session.id), 50)
      return
    }
    if (event?.type !== 'model/selection' || !session?.id) return
    const data = event.data || {}
    if (data.provider === CC_PROVIDER) {
      state.lastCcSelection[session.id] = { provider: CC_PROVIDER, model: data.model, reasoningEffort: data.reasoningEffort }
      protectSoon(ctx, config, state)
      return
    }
    // 用户在普通对话里换了模型：这是新的正常默认值
    protectSoon(ctx, config, state)
    const agent = ctx.get('agents')?.get?.(session.id)
    if (!agent || isSubagentSession(session) || !pilotMode(ctx, session, agent)) return
    const wanted = state.lastCcSelection[session.id] || { provider: CC_PROVIDER, model: CC_MODEL_ID }
    Promise.resolve()
      .then(() => ctx.get('sessionController')?.selectModel?.({ sessionId: session.id, ...wanted }))
      .catch((error) => console.warn(`[claude-pilot] 切回 Claude 模型失败：${error.message}`))
  })
}

/* ---------------------------------------------------------------- 逐字直播 */

/**
 * DSH 的逐字显示走 agent/assistant-stream（进程内事件，会话控制器转发给浏览器）。
 * 接收端要求同一 agent 的帧 revision 连续（start 帧 revision=1 会重置）。模式会话里 DSH 自己的
 * loop 从不调模型、不发帧，所以这里按 agent 对象独占一个计数器。
 */
function liveEmitter(ctx, state, sessionId) {
  const agent = ctx.get('agents')?.get?.(sessionId)
  if (!agent || typeof ctx.emit !== 'function') return null
  state.streamRevisions ||= new WeakMap()
  let attemptId = null
  return (frame) => {
    if (frame.type === 'start') attemptId = `${sessionId}:pilot-${randomUUID().slice(0, 8)}`
    if (!attemptId) return
    const revision = (state.streamRevisions.get(agent) || 0) + 1
    state.streamRevisions.set(agent, revision)
    try {
      ctx.emit('agent/assistant-stream', { agent, frame: { ...frame, attemptId, revision } })
    } catch (error) {
      if (!state.streamWarned) console.warn(`[claude-pilot] 逐字直播失败（不影响结果）：${error.message}`)
      state.streamWarned = true
    }
    if (frame.type === 'end') attemptId = null
  }
}

/* ------------------------------------------------------------- 一轮 Claude */

/**
 * 跑一轮 Claude Code，事件写进 session。返回 { ok, aborted, error, summary, result }。
 * 调用方负责 turn/start、turn/end（pre-step 路径由 loop 写）。
 */
/** 用户在运行中「插话发送」的消息（DSH 放在收件箱 next-step；任务通知也走那里，但不算插话）。 */
function pendingSteers(agent) {
  try {
    return (agent?.inbox?.nextStep || []).filter((message) => message?.source?.kind === 'user')
  } catch {
    return []
  }
}

export async function runClaudeTurn(ctx, config, state, { session, turn, prompt, signal, agent = null, stepBase = 0 }) {
  const sessionId = session.id
  const rec = record(state, config, sessionId)
  const cwd = cwdOf(session, config)
  const selection = readSelection(session)
  await setup.hubConfig(config).catch(() => null)
  const hubModels = setup.lastHubConfig(config)?.models
  let model = selection?.model && selection.model !== CC_MODEL_ID ? selection.model : config.defaultModel || undefined
  // Hub 模式下选着的模型已经不在 Hub 的列表里（被管理员下掉 / 切到 Hub 之前选的）：用 Hub 的默认
  if (hubModels?.length && model && !hubModels.some((m) => m.id === model)) model = undefined
  const effort = selection?.reasoningEffort || config.defaultEffort || undefined
  const claudePath = resolveClaude(config)

  const translator = createTranslator({
    turn,
    append: (type, data, intent) => append(session, type, data, intent),
    live: config.stream === false ? null : liveEmitter(ctx, state, sessionId),
    maxToolResultChars: Number(config.maxToolResultChars) > 0 ? Number(config.maxToolResultChars) : 30000,
    model: model || null,
    stepBase,
    onWrote: (touched) => presentNow([touched]),
  })
  // 交付物当场写 deliverables/presented（DSH 只显示收尾回复之前的交付）；同一轮里同一个文件只交付一次
  const presentedPaths = new Set()
  const presentNow = (items) => appendDeliverables(session, turn, items, cwd, presentedPaths)

  const abort = new AbortController()
  let aborted = false
  const onAbort = () => {
    aborted = true
    // 先礼后兵：interrupt 让 Claude 自己收尾，几秒后还没结束就硬停
    Promise.resolve(state.activeQueries?.get(sessionId)?.interrupt?.()).catch(() => {})
    setTimeout(() => abort.abort(), Number(config.abortGraceMs) || 4000).unref?.()
  }
  if (signal?.aborted) onAbort()
  else signal?.addEventListener?.('abort', onAbort, { once: true })

  // 插话：运行中用户点了「插话发送」→ 把这些消息从收件箱里取走，打断这一段 Claude，
  // 由调用方（handlePreStep）在同一个 DSH turn 里带着它们接着跑下一段（同一个 Claude 会话）。
  let steered = null
  const steerTimer = agent
    ? setInterval(() => {
        if (steered || aborted) return
        const messages = pendingSteers(agent)
        if (!messages.length) return
        const taken = []
        for (const message of messages) {
          try {
            if (agent.inbox.remove(message.id)) taken.push(message)
          } catch (error) {
            console.warn(`[claude-pilot] 取插话消息失败：${error.message}`)
          }
        }
        if (!taken.length) return
        steered = taken
        log(config, `steer: ${taken.length} 条插话，打断当前这一段`)
        Promise.resolve(state.activeQueries?.get(sessionId)?.interrupt?.()).catch(() => {})
        setTimeout(() => abort.abort(), Number(config.abortGraceMs) || 4000).unref?.()
      }, 400)
    : null

  const stderr = []
  const consumed = consumedSet(state, sessionId)
  const authEnvForTurn = await setup.authEnv(ctx, config, childEnv())
  // 本机登录（~/.claude）被多个 Claude Code 进程共用：access token 过期时大家同时拿同一个 refresh token 去刷新，
  // 输的一方报 authentication_failed（「OAuth session expired and could not be refreshed」），而赢的一方已经把新 token
  // 写回文件。所以这一轮还什么都没产出就登录失败时，过几秒换个新进程重试一次（新进程会读到新 token），报错不进对话。
  const machineAuth = setup.loadAuth(config).mode === 'machine'
  let authRetried = false
  let authFailed = false
  const attempt = async (resume) => {
    authFailed = false
    let memory = null
    try {
      memory = await ctx.get('memoryPilot')?.prepare(agent || { session, options: {} }, resume ? rec.memoryState : {})
    } catch (error) {
      console.warn(`[claude-pilot] 记忆索引读取失败：${error.message}`)
    }
    const options = {
      cwd,
      abortController: abort,
      includePartialMessages: config.stream !== false,
      env: authEnvForTurn,
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
      ...(resume ? { resume } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: PILOT_PROMPT },
      mcpServers: { dsh: createTaskServer(ctx, config, state, { sessionId, signal: abort.signal, consumed, cwd, present: presentNow }) },
      // AskUserQuestion 需要交互式回答，DSH 这边还没接审批/问答卡：先让 Claude 在正文里问
      disallowedTools: ['AskUserQuestion', ...(Array.isArray(config.disallowedTools) ? config.disallowedTools : [])],
      stderr: (chunk) => {
        if (stderr.length < 200) stderr.push(String(chunk))
      },
    }
    const permission = config.permissionMode || 'bypassPermissions'
    options.permissionMode = permission
    if (permission === 'bypassPermissions') options.allowDangerouslySkipPermissions = true
    // Supply memory through the external agent, never through DSH's empty enter.
    const memoryText = memory?.text?.replace(/\b(memory_(?:read|topic|search|write|archive|verify|note))\b/g, 'mcp__dsh__$1')
    const q = query({ prompt: [memoryText, prompt].filter(Boolean).join('\n\n'), options })
    state.activeQueries ||= new Map()
    state.activeQueries.set(sessionId, q)
    try {
      for await (const message of q) {
        const counts = translator.summary
        if (
          machineAuth && !authRetried && !counts.texts && !counts.toolCalls &&
          message?.type === 'assistant' && message.is_api_error_message && message.error === 'authentication_failed'
        ) {
          authFailed = true
          continue
        }
        if (authFailed && message?.type === 'result') continue
        translator.push(message)
        if (memory && message?.type === 'assistant' && !message.is_api_error_message) {
          patchRecord(state, config, sessionId, { memoryState: memory.state })
          memory = null
        }
      }
    } finally {
      state.activeQueries.delete(sessionId)
    }
  }

  const attemptWithAuthRetry = async (resume) => {
    try {
      await attempt(resume)
    } catch (failed) {
      if (!authFailed || aborted || steered) throw failed
    }
    if (!authFailed) return
    authRetried = true
    log(config, 'Claude 登录失败（可能是多个 Claude Code 进程抢着刷新 token），3 秒后换新进程重试一次')
    await new Promise((resolve) => setTimeout(resolve, 3000))
    if (aborted || steered) return
    await attempt(resume)
  }

  let error = null
  try {
    try {
      await attemptWithAuthRetry(rec.ccSessionId)
    } catch (first) {
      // 记录里的 Claude 会话找不到了（被清理/换机器）：开新会话重来一次
      const text = `${first?.message || first} ${stderr.join('')}`
      if (rec.ccSessionId && !translator.ccSessionId && !aborted && /no conversation found|session.*not found/i.test(text)) {
        log(config, `Claude 会话 ${rec.ccSessionId} 已不存在，开新会话`)
        patchRecord(state, config, sessionId, { ccSessionId: null })
        await attemptWithAuthRetry(undefined)
      } else {
        throw first
      }
    }
  } catch (caught) {
    if (!aborted && !steered) error = caught
  } finally {
    signal?.removeEventListener?.('abort', onAbort)
    if (steerTimer) clearInterval(steerTimer)
  }

  translator.finish(aborted ? '已被用户停止：这个工具调用没有等到结果' : steered ? '被插话打断：这个工具调用没有等到结果' : '这个工具调用没有返回结果')
  let notes = 0
  const summary = translator.summary
  if (summary.rateLimit) state.lastRateLimit = { ...summary.rateLimit, at: Date.now() }
  const result = translator.result

  // 没有正文的轮次（/compact 这类本地命令）也要让用户看到发生了什么
  if (!aborted && !steered && !error && !summary.texts) {
    if (summary.compacted) {
      const before = Number(summary.compacted.pre_tokens) || 0
      appendNote(session, turn, translator.step + ++notes, `🗜 Claude 的上下文已压缩${before ? `（压缩前约 ${Math.round(before / 1000)}k tokens）` : ''}。`)
    } else if (result && !result.is_error && typeof result.result === 'string' && result.result.trim()) {
      appendNote(session, turn, translator.step + ++notes, result.result.trim())
    }
  }
  if (steered) {
    appendNote(session, turn, translator.step + ++notes, '↪ 收到插话，已打断这一段，接着处理你的新消息。')
  } else if (aborted) {
    appendNote(session, turn, translator.step + ++notes, '⏹ 已停止。下一句话会接着同一个 Claude 会话继续。')
  } else if (error || (result && result.is_error)) {
    const reason = error ? String(error?.message || error) : `Claude 报错（${result.subtype}）${result.result ? `：${result.result}` : ''}`
    const limit = describeLimit(summary.rateLimit)
    const detail = stderr.length ? `\n\n\`\`\`\n${truncate(stderr.join('').trim(), 1500)}\n\`\`\`` : ''
    const authLike = /not logged in|log ?in|invalid api key|authentication|unauthori[sz]ed|\b401\b|oauth token|x-api-key|could not be refreshed/i.test(`${reason} ${stderr.join('')}`)
    const authHint = !authLike
      ? ''
      : machineAuth
        ? '\n\n🔑 看起来是 Claude 登录/凭据的问题（已自动重试过一次）。用的是本机 ~/.claude 的登录：多个终端同时跑 Claude Code 时，refresh token 会被互相顶掉。' +
          '建议点输入框上方的「设置」（或输入 /claude-setup）改用「用 Claude 订阅登录」——那是 claude setup-token 的一年期 token，不需要刷新，不受终端影响。'
        : '\n\n🔑 看起来是 Claude 登录/凭据的问题：点输入框上方的「设置」，或输入 /claude-setup 完成初始化。'
    if (authLike) state.authReady = { at: 0, ready: false }
    appendNote(session, turn, translator.step + ++notes, `❌ Claude Code 这一轮没跑完：${reason}${limit ? `\n\n${limit}` : ''}${authHint}${detail}`)
  }

  const usage = result?.usage || summary.usage || {}
  const prev = rec.stats || {}
  patchRecord(state, config, sessionId, {
    ...(summary.ccSessionId ? { ccSessionId: summary.ccSessionId } : {}),
    cwd,
    stats: {
      turns: (prev.turns || 0) + 1,
      abortedTurns: (prev.abortedTurns || 0) + (aborted ? 1 : 0),
      steeredTurns: (prev.steeredTurns || 0) + (steered ? 1 : 0),
      input: (prev.input || 0) + (Number(usage.input_tokens) || 0),
      output: (prev.output || 0) + (Number(usage.output_tokens) || 0),
      cacheRead: (prev.cacheRead || 0) + (Number(usage.cache_read_input_tokens) || 0),
      cacheWrite: (prev.cacheWrite || 0) + (Number(usage.cache_creation_input_tokens) || 0),
      costUsd: (prev.costUsd || 0) + (Number(result?.total_cost_usd) || 0),
      lastContext: (Number(usage.input_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0) + (Number(usage.cache_creation_input_tokens) || 0),
      model: summary.model || prev.model || null,
    },
  })
  try {
    await ctx.get('sessions')?.flush?.(session)
  } catch {
    /* 落盘失败不影响可见结果 */
  }
  log(config, `turn=${turn} model=${summary.model} steps=${summary.steps} tools=${summary.toolCalls} aborted=${aborted} error=${error?.message || ''}`)
  return { ok: !error && !aborted && !result?.is_error, aborted, steered, error, summary, result, lastStep: translator.step + notes }
}

/* ------------------------------------------------------------ 把消息变成提示 */

function noticeKind(message) {
  const kind = message?.source?.kind
  return kind === 'subagent-settled' || kind === 'agent-message' ? kind : null
}

/**
 * 认领的消息 → 给 Claude 的提示。用户消息原样（附件落盘后在前面注明）；
 * DSH 任务通知包成「[DSH 任务通知]」。Claude 已经用 task_wait 看过的任务，其结算通知不再叫醒它。
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
  const parts = attachmentPartsOf(userMessages)
  if (parts.length) {
    try {
      const inbound = await materializeAttachments(ctx, cwdOf(session, config), parts)
      preamble = attachmentPreamble(inbound.notes, inbound.skipped)
    } catch (error) {
      preamble = attachmentPreamble([], parts.map((part) => ({ name: part?.attachment?.name || '附件', reason: error.message })))
    }
  }
  const sections = []
  if (preamble || userTexts.length) sections.push(`${preamble}${userTexts.join('\n\n')}`.trim())
  if (notices.length) sections.push(`[DSH 任务通知]\n${notices.join('\n\n')}`)
  return sections.join('\n\n')
}

/**
 * 兜底：任务在 Claude 这一轮进行中结束时，DSH 的结算通知以 steer 进收件箱，
 * 而我们的 turn 不再有下一个 step 去认领它 —— 通知可能就此丢失。
 * 这一轮结束后检查：本轮期间结束、Claude 还没看到结果的任务，补发一条通知唤醒新一轮。
 */
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
      console.warn(`[claude-pilot] 补发任务通知失败：${error.message}`)
    }
  }, 1500).unref?.()
}

/* ------------------------------------------------------------ pre-step 接管 */

/**
 * 我们在 pre-step 里跑完整个 Claude 回合后返回「空 enter」，agent loop 走的是 `phase.step === 0` 的
 * 直接 return false —— 跳过了回合末尾的「收件箱里还有没有消息」检查。于是运行中排队的消息
 * （以及没被认领的插话）会一直躺在收件箱里，要等下一次有人叫醒它。这里在回合结束、agent 回到 idle 后补一次唤醒。
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
      console.warn(`[claude-pilot] 唤醒排队消息失败：${error.message}`)
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
      // 一段 Claude 跑完；期间用户「插话发送」了 → 带着插话在同一个 DSH turn 里接着跑下一段
      for (let round = 0; round < 50; round += 1) {
        // 走 enter 空消息时 loop 不写 user/message：自己写，用户才看得到自己的话（任务通知也照原样写）
        for (const message of claimed) {
          if (!message || typeof message !== 'object') continue
          if (!textOfMessage(message) && !attachmentPartsOf([message]).length) continue
          append(session, 'user/message', { ...message, role: 'user' }, { surfaceOp: 'append' })
        }
        const prompt = await buildPrompt(ctx, config, state, session, claimed)
        if (!prompt) break
        const outcome = await runClaudeTurn(ctx, config, state, { session, turn: payload.turn, prompt, signal: payload.signal, agent, stepBase })
        if (!outcome?.steered?.length || payload.signal?.aborted) break
        claimed = outcome.steered
        stepBase = outcome.lastStep
      }
      scheduleMissedNotices(ctx, state, agentId, turnStartedAt)
    } catch (error) {
      console.warn(`[claude-pilot] 这一轮出错：${error?.stack || error}`)
      try {
        appendNote(session, payload.turn, 99, `❌ Claude Code 桥出错：${error?.message || error}`)
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
    console.warn(`[claude-pilot] pre-step 异常：${error?.stack || error}`)
    return { kind: 'enter', messages: [] }
  } finally {
    wakeForLeftovers(agent)
    state.handled.set(key, true)
    if (state.handled.size > 400) for (const old of [...state.handled.keys()].slice(0, 200)) state.handled.delete(old)
    state.inflight.delete(key)
  }
}

/* ------------------------------------------------------- Claude Code 斜杠命令 */

// DSH 命令名只允许小写字母、数字、_、-；这些在 Web 界面里没意义或会出问题
// model：DSH 前端自带同名的客户端命令（撞名会让整个斜杠菜单报错），切模型用输入框的模型芯片
const COMMAND_SKIP = new Set(['model', 'color', 'focus', 'heapdump', 'agents', 'extra-usage', 'auto-mode-setup', 'import', 'reload-plugins', 'workflow-launch-exec', 'team-onboarding', 'design', 'design-sync', 'design-consent', 'design-revoke'])
const COMMAND_FALLBACK = [
  { name: 'compact', description: 'Free up context by summarizing the conversation so far', hint: '<optional custom summarization instructions>' },
  { name: 'context', description: 'Show current context usage' },
  { name: 'usage', description: 'Show session cost, plan usage, and what\'s contributing to your limits' },
  { name: 'clear', description: 'Start a new Claude session with empty context' },
  { name: 'effort', description: 'Set effort level for model usage', hint: '<low|medium|high|xhigh|max>' },
  { name: 'init', description: 'Initialize a new CLAUDE.md file with codebase documentation' },
  { name: 'code-review', description: 'Review the current diff', hint: '[level] [target]' },
  { name: 'security-review', description: 'Complete a security review of the pending changes' },
]

function commandsFile(config) {
  return join(dirname(storeFile(config)), 'commands.json')
}

/** 命令目录：内存 > 缓存文件 > 内置的几条（第一次启动、还没探测过时用）。 */
export function commandList(state, config) {
  if (state.commands?.length) return state.commands
  try {
    const cached = JSON.parse(readFileSync(commandsFile(config), 'utf8'))
    if (Array.isArray(cached) && cached.length) return (state.commands = cached)
  } catch {
    /* 没有缓存 */
  }
  return COMMAND_FALLBACK
}

/** 向 Claude Code 要一份当前可用的斜杠命令（含用户自定义命令与 skills），写进缓存。 */
export async function refreshCommands(state, config, ctx) {
  const claudePath = resolveClaude(config)
  const env = ctx ? await setup.authEnv(ctx, config, childEnv()) : childEnv()
  const q = query({
    prompt: (async function* () {})(),
    options: { cwd: config.fallbackCwd || homedir(), env, ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}) },
  })
  try {
    const raw = await q.supportedCommands()
    const list = raw
      .filter((cmd) => /^[a-z0-9][a-z0-9_-]*$/.test(cmd.name || '') && !COMMAND_SKIP.has(cmd.name) && !/^\(removed\)|^Renamed/.test(cmd.description || ''))
      .map((cmd) => ({ name: cmd.name, description: truncate(String(cmd.description || '').split('\n')[0], 120), ...(cmd.argumentHint ? { hint: String(cmd.argumentHint).slice(0, 80) } : {}) }))
    if (!list.some((cmd) => cmd.name === 'clear')) list.push(COMMAND_FALLBACK.find((cmd) => cmd.name === 'clear'))
    state.commands = list
    for (const listener of state.commandListeners || []) {
      try {
        listener(list)
      } catch (error) {
        console.warn(`[claude-pilot] 重新注册命令失败：${error.message}`)
      }
    }
    mkdirSync(dirname(commandsFile(config)), { recursive: true })
    writeFileSync(commandsFile(config), JSON.stringify(list, null, 2))
    return list
  } finally {
    q.interrupt?.().catch(() => {})
    q.return?.().catch?.(() => {})
  }
}

/**
 * 执行一条 Claude Code 命令（DSH 命令处理器调过来）：
 *   /clear  → 下一轮开新的 Claude 会话；
 *   /model、/effort → 改 DSH 会话的模型选择（模型芯片和实际一致，下一轮生效）；
 *   其余 → 把 "/name 参数" 作为一轮输入交给 Claude（SDK 会按斜杠命令执行），过程照常显示在对话里。
 */
export async function runCommand(ctx, config, state, name, { agent, rawInput }) {
  const sessionId = agent?.id
  const session = ctx.get('sessions')?.get?.(sessionId)
  if (!session || !pilotMode(ctx, session, agent)) return { kind: 'error', text: '这个对话不是 Claude Code 模式' }
  const arg = String(rawInput || '').trim()
  if (name === 'clear') {
    patchRecord(state, config, sessionId, { ccSessionId: null })
    return { kind: 'success', text: '下一句话会开一个新的 Claude 会话（之前的会话还在磁盘上）。' }
  }
  if (name === 'model' || name === 'effort') {
    ensureModelAdapter(ctx, state, config)
    const current = readSelection(session) || {}
    await setup.hubConfig(config).catch(() => null)
    const catalog = modelCatalog(config)
    const hubbed = catalog !== CC_MODEL_CATALOG
    const aliases = hubbed ? { default: CC_MODEL_ID } : { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1', default: CC_MODEL_ID }
    const pick = name === 'model' ? aliases[arg.toLowerCase()] || arg : current.model || CC_MODEL_ID
    if (name === 'model' && !catalog.some((entry) => entry.id === pick)) {
      return { kind: 'error', text: `可选模型：${catalog.map((entry) => entry.id).join('、')}（${hubbed ? '也可以写 default' : '也可以写 opus / sonnet / haiku / fable / default'}）` }
    }
    const effort = name === 'effort' ? arg.toLowerCase() : current.reasoningEffort
    if (name === 'effort' && !CC_EFFORTS.some((entry) => entry.id === effort)) return { kind: 'error', text: '可选：low / medium / high / xhigh / max' }
    await ctx.get('sessionController')?.selectModel?.({ sessionId, provider: CC_PROVIDER, model: pick, ...(effort ? { reasoningEffort: effort } : {}) })
    return { kind: 'success', text: `已切换：${pick}${effort ? ` / ${effort}` : ''}（下一轮生效）` }
  }
  agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: `/${name}${arg ? ` ${arg}` : ''}` }], source: { kind: 'user' } })
  return { kind: 'success', text: '' }
}

/* ------------------------------------------------------------------ 初始化 */

/** 设置接口（connection 受保护路由调过来）。设置变了就让就绪缓存失效。 */
export async function handleSetupRequest(ctx, config, state, body) {
  // 输入框下方的用量条：订阅额度（缓存 60 秒）+ 这个会话的累计 + 最近一次 SDK 报的限流状态
  if (body?.action === 'usage') {
    const plan = await setup.planUsage(ctx, config, state, childEnv(), { force: Boolean(body.force) })
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const stats = sessionId ? loadStore(state, config).data.sessions[sessionId]?.stats || null : null
    return { ok: true, plan, session: stats, rateLimit: state.lastRateLimit || null }
  }
  const result = await setup.handleSetup(ctx, config, state, body, childEnv())
  if (body?.action && body.action !== 'state' && body.action !== 'test') state.authReady = { at: 0, ready: false }
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
  if (status.authMethod === 'hub' && !status.loggedIn) return status.error || null
  return null
}

/** 是否已有可用凭据（claude auth status，缓存 30 秒；过期就在后台刷新，先回旧值）。 */
function authReady(ctx, config, state) {
  const cached = state.authReady
  // 终端里切了账号（凭据文件变了）就立刻重查，不等 30 秒
  const fingerprint = setup.credentialFingerprint(config, childEnv())
  if (!cached || Date.now() - cached.at > 30000 || (cached.fingerprint && cached.fingerprint !== fingerprint)) {
    if (!state.authChecking) {
      state.authChecking = setup
        .authStatus(ctx, config, childEnv())
        .then((status) => {
          // 程序没找到 / Hub 模式下没开放或没模型的原因给提示条显示（都不含账号信息）
          state.authReady = { at: Date.now(), ready: Boolean(status.loggedIn), fingerprint, note: setupNoteOf(status) }
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

/** GET /claude-pilot：状态 + 最近派出的任务（客户端据此在右侧栏自动打开子会话）。 */
export function status(ctx, config, state, { since = 0 } = {}) {
  const store = loadStore(state, config)
  return {
    ok: true,
    claude: resolveClaude(config) || 'Agent SDK 自带',
    memoryTools: ctx.get('memoryPilot')?.specs.length || 0,
    // 跑过 Claude 的会话（客户端据此给侧栏会话行挂标记）
    pilotSessions: [...new Set([...Object.keys(store.data.sessions), ...(state.marked || [])])],
    spawns: (state.spawns || []).filter((item) => item.at > Number(since || 0)),
    tasks: [...(state.tasks?.values() || [])].map((rec) => ({
      id: rec.childId,
      parent: rec.parentId,
      label: rec.label,
      status: rec.status,
      reason: rec.reason || null,
      model: rec.model,
    })),
    sessions: Object.keys(store.data.sessions).length,
    // 只给布尔值（这个 GET 不经过 DSH 登录，不能泄露账号信息）；null = 还没检测完
    setupReady: authReady(ctx, config, state),
    setupNote: state.authReady?.note || null,
    // Windows 上没有 Git Bash：Claude Code 会用 PowerShell 工具，横幅提示一次（前端只显示一次，不每轮刷）
    setupHint: setup.gitBashHint(),
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
    if (event.type === 'assistant/message') brief.content = (data.message?.content || []).map((b) => (b.type === 'text' ? truncate(b.text, 300) : b.type === 'tool-call' ? `[call ${b.name}]` : `[${b.type}]`))
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
 * POST /claude-pilot {prompt|prompts, cwd?, keep?, waitTasks?, timeoutMs?}
 * 不用浏览器的端到端测试：新建一个 claude-pilot 会话，按真实提交路径（agent.followup）发消息，
 * 等它空闲；waitTasks=true 时继续等派出的任务结束、结算通知叫醒 Claude 的那一轮也跑完。
 */
export async function lab(ctx, config, state, body = {}) {
  // 归档测试会话（界面"归档"用的同一个方法）
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
  const prompts = Array.isArray(body.prompts) && body.prompts.length ? body.prompts : [body.prompt || '只回复：桥已就绪']
  const timeoutMs = Number(body.timeoutMs) || 300000
  const sessions = ctx.get('sessions')
  const agentLoop = ctx.get('agentLoop')
  if (!agentLoop?.create || !sessions?.get) return { ok: false, error: 'SERVICE_MISSING' }
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.() || {}
  const sessionId = body.sessionId || `session-pilot-lab-${randomUUID().slice(0, 8)}`
  let agent = ctx.get('agents')?.get?.(sessionId)
  if (!agent) {
    agent = await agentLoop.create(sessionId, { provider: selection.provider, model: selection.model }, { cwd: body.cwd || config.fallbackCwd || homedir() })
    await ctx.get('agentPresets')?.select?.(agent, body.preset || PILOT_PRESET)
  }
  const session = sessions.get(sessionId)
  const info = { sessionId, composedPreset: ctx.get('agentPresets')?.composedPreset?.(agent.ctx) ?? null }
  // 旁听这个会话的直播帧（和会话控制器同一个事件），验证逐字显示的帧序列
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
  // 命令走真实的 DSH 命令路径（和界面输入框提交 /xxx 一样）：commands.execute(agent, line)
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
    // 模拟界面上的停止按钮（dsh-api-session-controller 里同一句）
    if (Number(body.abortAfterMs) > 0) setTimeout(() => agent.cancel({ kind: 'user' }, { keepInbox: true }), Number(body.abortAfterMs)).unref?.()
    // 模拟运行中「插话发送」（会话控制器 mode=steer 同一句）和运行中排队（mode=queue）
    if (Number(body.steerAfterMs) > 0)
      setTimeout(() => agent.steer({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: String(body.steerText || '停，改成只回复：插话收到') }], source: { kind: 'user' } }), Number(body.steerAfterMs)).unref?.()
    if (Number(body.queueAfterMs) > 0)
      setTimeout(() => agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: String(body.queueText || '只回复：排队消息收到') }], source: { kind: 'user' } }), Number(body.queueAfterMs)).unref?.()
    await new Promise((ok) => setTimeout(ok, 300))
    info.settled = await idle()
    // 插话/排队的消息要等它们那一轮也跑完（或确认它们卡在收件箱里）
    if (Number(body.steerAfterMs) > 0 || Number(body.queueAfterMs) > 0) {
      await new Promise((ok) => setTimeout(ok, Number(body.settleExtraMs) || 4000))
      info.settled = await idle()
      info.inboxLeft = { nextStep: agent.inbox?.nextStep?.length ?? null, nextTurn: agent.inbox?.nextTurn?.length ?? null }
    }
    if (!info.settled) break
  }
  if (body.waitTasks) {
    // 派出的任务全部结束 + 结算通知触发的那一轮也跑完
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
 * POST 能以完全权限跑 Claude，而插件路由不经过 DSH 的登录校验（3080 还经隧道对外发布），
 * 所以 POST 必须带本机文件里的密钥：x-pilot-token = ~/.dsh/claude-pilot/lab-token（0600，首次自动生成）。
 */
export function labTokenOk(config, header) {
  const file = join(dirname(storeFile(config)), 'lab-token')
  let token = ''
  try {
    token = readFileSync(file, 'utf8').trim()
  } catch {
    mkdirSync(dirname(file), { recursive: true })
    token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
    // mode 只对 POSIX 有效；Windows 上文件权限由目录 ACL 决定（%USERPROFILE%\.dsh 默认只有本人可读）
    writeFileSync(file, `${token}\n`, { mode: 0o600 })
  }
  return Boolean(token) && typeof header === 'string' && header.trim() === token
}

/** 查任意会话的事件（调试子会话用）。 */
export function dump(ctx, sessionId, limit) {
  const session = ctx.get('sessions')?.get?.(sessionId)
  if (!session) return { ok: false, error: 'SESSION_NOT_LOADED' }
  let composedPreset = null
  try {
    const agent = ctx.get('agents')?.get?.(sessionId)
    composedPreset = agent ? ctx.get('agentPresets')?.composedPreset?.(agent.ctx) ?? 'unbound' : 'no-agent'
  } catch (error) {
    composedPreset = `error: ${error.message}`
  }
  return { ok: true, header: session.header, composedPreset, events: eventsOf(session, Number(limit) || 200) }
}
