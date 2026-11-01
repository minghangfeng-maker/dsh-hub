/**
 * 初始化：Claude Code 程序在哪、用哪种凭据、登没登录、能不能连通，以及在界面里完成登录。
 *
 * 三种凭据方式（auth.json 的 mode）：
 *   - machine     用运行 DSH 的系统用户自己的 Claude 登录（~/.claude）或进程环境里已有的 key（默认）；
 *   - apiKey      界面里填的 API Key（+ 可选 Base URL，可接中转站）。Key 存 DSH 凭据库 CLAUDE_PILOT_API_KEY，
 *                 跑 Claude 时注入 ANTHROPIC_API_KEY（keyHeader=bearer 时注入 ANTHROPIC_AUTH_TOKEN）+ ANTHROPIC_BASE_URL；
 *   - oauthToken  Claude 订阅的长期 token（claude setup-token 产出，1 年），存 CLAUDE_PILOT_OAUTH_TOKEN，
 *                 注入 CLAUDE_CODE_OAUTH_TOKEN。可以在界面里走完整个登录（插件在伪终端里跑 setup-token），也可以手动粘贴。
 *
 * 设置接口挂在 connection 的受保护路由 /api/claude-pilot.setup 上（只有已登录 DSH 的浏览器能调），绝不返回密钥值。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { query } from '@anthropic-ai/claude-agent-sdk'
// 和其它 runtime 模块一样带上版本号再 import：改 platform.js 也能热加载（ESM 按 URL 缓存）
const { HIDE, IS_WIN, detectGitBash, envGet, envSet, gitBashPaths, isShellShim, spawnSpecFor, whichFile } = await import(`./platform.js${new URL(import.meta.url).search}`)

export const API_KEY_REF = 'CLAUDE_PILOT_API_KEY'
export const OAUTH_REF = 'CLAUDE_PILOT_OAUTH_TOKEN'
// 我们注入的凭据环境变量：选定一种方式时，其余的从子进程环境里清掉，免得互相抢
const AUTH_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN']

/**
 * DSH Hub 下发的账号（管理员在 Hub 控制台配置，经容器环境变量注入）：
 *   HUB_CLAUDE_AUTH = apiKey | authToken | oauthToken（有它就是 Hub 管理模式）
 *   HUB_CLAUDE_KEY、HUB_CLAUDE_BASE_URL（可选）、HUB_CLAUDE_MODEL（可选）、HUB_CLAUDE_LABEL（显示名）
 * 有 Hub 下发时默认用它（mode: 'hub'），但用户可以在设置页里改用自己的配置：
 * auth.json 的 hubOverride = true 表示「用自己的」，false / 缺省表示「用 Hub 下发的」。改回 use-hub 即可。
 */
const HUB_AUTHS = new Set(['apiKey', 'authToken', 'oauthToken'])

/**
 * 桌面端的 Hub 配置由 hub-connector 提供（它拿设备令牌去换 /v1/hub/agent-mode），
 * 不再靠容器注入的 HUB_CLAUDE_* 环境变量。index.r1.js 启动时把服务挂进来：
 *   setHubProvider(() => service.credentials('claude-code'))
 * 返回 { auth, key, baseUrl, model, label } | null。容器里没有这个服务，还是走环境变量。
 */
let hubProvider = null
export function setHubProvider(fn) {
  hubProvider = typeof fn === 'function' ? fn : null
}

function hubFromService() {
  if (!hubProvider) return null
  let raw
  try {
    raw = hubProvider()
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const auth = String(raw.auth || '').trim()
  const key = String(raw.key || '').trim()
  if (!HUB_AUTHS.has(auth) || !key) return null
  return {
    auth,
    key,
    baseUrl: String(raw.baseUrl || '').trim().replace(/\/+$/, ''),
    model: String(raw.model || '').trim(),
    label: String(raw.label || '').trim() || 'DSH Hub',
    // 可选：hub-connector 缓存的模型列表（上游接口没有这一项，属可选扩展）。
    // 模型列表的正常来源仍是 GET /v1/hub/agent-mode（与容器完全同一条链），这里只在拉取失败时兜底。
    models: Array.isArray(raw.models) ? raw.models.filter((model) => model && model.id) : null,
  }
}

export function hubAuth(env = process.env) {
  const fromService = hubFromService()
  if (fromService) return fromService
  // Windows 的环境变量键名大小写不固定：按大小写不敏感读
  const auth = String(envGet(env, 'HUB_CLAUDE_AUTH') || '').trim()
  const key = String(envGet(env, 'HUB_CLAUDE_KEY') || '').trim()
  if (!HUB_AUTHS.has(auth) || !key) return null
  return {
    auth,
    key,
    baseUrl: String(envGet(env, 'HUB_CLAUDE_BASE_URL') || '').trim().replace(/\/+$/, ''),
    model: String(envGet(env, 'HUB_CLAUDE_MODEL') || '').trim(),
    label: String(envGet(env, 'HUB_CLAUDE_LABEL') || '').trim() || 'DSH Hub',
  }
}

/**
 * Hub 中转站模式（apiKey / authToken 且有 Base URL）下，模型列表、默认模型、后台小模型由 Hub 管理员在管理台配置，
 * 插件向 Hub 拉：GET {base}/v1/hub/agent-mode（docs/18 §3.4），缓存 30 秒；改了下一轮就生效，不用重启 DSH。
 * 404 = 老 Hub 没有这个接口：照旧只用 env 里的 HUB_CLAUDE_MODEL。网络失败时沿用上次成功的结果。
 */
const HUB_CONFIG_TTL_MS = 30000
let hubConfigCache = null
let hubConfigInflight = null

/**
 * Hub 侧的配置换了（登录/登出、管理员改模型/改地址、被移出 targets、设备密钥轮换）：
 * 清掉拉取缓存，下一轮重新拉。给 `hubAgentModes.onChange` 用 —— 与「设置页改了配置」走同一条刷新路径。
 */
export function invalidateHubConfig() {
  hubConfigCache = null
  hubConfigInflight = null
}

function hubRelay(hub) {
  return hub && hub.auth !== 'oauthToken' && hub.baseUrl ? hub : null
}

function hubErrorMessage(data, status) {
  const message = data?.error?.message || data?.message
  if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 200)
  return status === 401 ? 'DSH Hub 不认这把密钥，请联系管理员' : `DSH Hub 返回 ${status}`
}

export async function hubConfig(config, { force = false } = {}) {
  const hub = hubRelay(hubAuth())
  // 用户改用自己的配置后，就不再向 Hub 拉 /v1/hub/agent-mode（模型列表回内置那份）
  if (!hub || !config || loadAuth(config).mode !== 'hub') return null
  const key = `${hub.baseUrl}|${hub.key.slice(-8)}`
  const cached = hubConfigCache?.key === key ? hubConfigCache : null
  if (!force && cached && Date.now() - cached.at < HUB_CONFIG_TTL_MS) return cached.result
  if (hubConfigInflight?.key === key) return hubConfigInflight.promise
  const promise = (async () => {
    let result
    try {
      const headers = hub.auth === 'authToken' ? { authorization: `Bearer ${hub.key}` } : { 'x-api-key': hub.key }
      const response = await fetch(`${hub.baseUrl}/v1/hub/agent-mode`, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(10000) })
      const data = await response.json().catch(() => null)
      if (response.ok && data && Array.isArray(data.models)) result = { ok: true, config: data }
      else if (response.status === 404) result = { ok: true, config: null }
      else result = { ok: false, status: response.status, error: hubErrorMessage(data, response.status) }
    } catch (error) {
      // 连不上：有上次成功的结果就继续用它
      if (cached?.result?.ok) return cached.result
      result = { ok: false, status: 0, error: `连不上 DSH Hub（${String(error?.cause?.code || error?.name || error?.message || error).slice(0, 60)}）` }
    }
    hubConfigCache = { key, at: Date.now(), result }
    return result
  })().finally(() => {
    if (hubConfigInflight?.promise === promise) hubConfigInflight = null
  })
  hubConfigInflight = { key, promise }
  return promise
}

/**
 * 最近一次拉到的 Hub 模式配置（同步读，给模型列表用）；没有 / 当前不是 Hub 模式 = null。
 * 注意：所有调用都要带上 config —— 判据是 loadAuth().mode === 'hub'，不能只看 HUB_CLAUDE_* 在不在。
 */
export function lastHubConfig(config) {
  const hub = hubAuth()
  if (!hub || !config || loadAuth(config).mode !== 'hub') return null
  const cached = hubRelay(hub) && hubConfigCache?.key === `${hub.baseUrl}|${hub.key.slice(-8)}` ? hubConfigCache.result : null
  if (cached?.ok) return cached.config
  // 桌面端：hub-connector 可能已经把模型列表缓存好了；拉取没成功时用它兜底（只影响模型选择器）
  if (hub.models?.length) return { label: hub.label, models: hub.models, defaultModel: hub.model || null, smallModel: null }
  return null
}

/** 设置页显示用的 Hub 信息：不管当前用不用 Hub 都给（只读，纯展示，不发起请求）。 */
export function hubDisplay() {
  const hub = hubAuth()
  if (!hub) return null
  const cached = hubRelay(hub) && hubConfigCache?.key === `${hub.baseUrl}|${hub.key.slice(-8)}` ? hubConfigCache.result : null
  const config = cached?.ok ? cached.config : null
  return {
    auth: hub.auth,
    baseUrl: hub.baseUrl,
    label: config?.label || hub.label,
    defaultModel: config?.defaultModel || hub.model || null,
    models: (config?.models || []).map((m) => m.id),
  }
}

function pilotHome(config) {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return config.storeFile ? dirname(config.storeFile) : join(home, 'claude-pilot')
}

function authFile(config) {
  return join(pilotHome(config), 'auth.json')
}

export function loadAuth(config) {
  const hub = hubAuth()
  const saved = savedAuth(config)
  // 有 Hub 下发、且用户没改成「用自己的」→ Hub 模式；否则按 auth.json 里自己的方式走
  if (hub && saved.hubOverride !== true) return { mode: 'hub', baseUrl: hub.baseUrl, hub: { auth: hub.auth, baseUrl: hub.baseUrl, model: hub.model, label: hub.label }, hubAvailable: true, hubOverride: false }
  return { mode: 'machine', ...saved, ...(hub ? { hubAvailable: true, hubOverride: saved.hubOverride === true } : {}) }
}

function savedAuth(config) {
  try {
    const data = JSON.parse(readFileSync(authFile(config), 'utf8'))
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

function saveAuth(config, auth) {
  const file = authFile(config)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(auth, null, 2))
  renameSync(tmp, file)
}

/* ------------------------------------------------------------ Claude 程序 */

/**
 * Agent SDK 按平台带的 Claude Code 程序（装插件时 pnpm/npm 拉下来的可选依赖）。
 *
 * 平台包是 **SDK 的** optionalDependencies，不是插件的：
 *   - npm 的扁平布局：从插件这边也能 resolve 到；
 *   - pnpm 的隔离布局（桌面端插件管理器就是 pnpm，`node_modules/.pnpm/...`）：平台包只挂在 SDK 自己
 *     的 node_modules 里，必须从 SDK 的位置再 resolve 一次，否则永远找不到 claude.exe
 *     （真机用 pnpm install --config.supportedArchitectures 复现过）。
 * 所以两种位置都试。
 */
export function bundledClaude() {
  const require = createRequire(import.meta.url)
  const resolvers = []
  try {
    resolvers.push(createRequire(require.resolve('@anthropic-ai/claude-agent-sdk')))
  } catch {
    /* SDK 本身没装上：下面只用插件侧的位置试 */
  }
  resolvers.push(require)
  const musl = process.platform === 'linux' && !process.report?.getReport?.()?.header?.glibcVersionRuntime
  const base = `${process.platform}-${process.arch}`
  for (const resolve of resolvers) {
    for (const flavor of musl ? [`${base}-musl`, base] : [base, `${base}-musl`]) {
      try {
        const pkg = resolve.resolve(`@anthropic-ai/claude-agent-sdk-${flavor}/package.json`)
        const bin = join(dirname(pkg), process.platform === 'win32' ? 'claude.exe' : 'claude')
        if (existsSync(bin)) return bin
      } catch {
        /* 这个位置 / 这个平台包没装 */
      }
    }
  }
  return null
}

/**
 * 系统里可能装在哪：
 *   - CLAUDE_CODE_BIN（两个平台都认）；
 *   - Windows：官方 native 安装是 %USERPROFILE%\.local\bin\claude.exe（`claude doctor` 里也是这个路径），
 *     另外按 PATH+PATHEXT 找 claude.exe / claude.cmd（npm 全局安装的壳）；
 *   - POSIX：~/.local/bin/claude、/usr/local/bin、/usr/bin。
 */
export function systemCandidates(env = process.env) {
  if (IS_WIN) {
    const onPath = whichFile('claude', env)
    return [
      envGet(env, 'CLAUDE_CODE_BIN'),
      // 官方 native 安装在 %USERPROFILE%\.local\bin\claude.exe（`claude doctor` 里也是这个路径）
      join(homedir(), '.local', 'bin', 'claude.exe'),
      // npm 全局装的是 claude.cmd：Agent SDK 自己 spawn 进程，Windows 上直接 spawn .cmd 会 EINVAL
      // （CVE-2024-27980 之后），所以 .cmd/.bat 壳不能当 claude 程序用 —— 交给 SDK 自带的 claude.exe
      onPath && !isShellShim(onPath) ? onPath : null,
    ].filter(Boolean)
  }
  return [envGet(env, 'CLAUDE_CODE_BIN'), join(homedir(), '.local/bin/claude'), '/usr/local/bin/claude', '/usr/bin/claude'].filter(Boolean)
}

/** 用哪个 claude：配置 > 系统里已装的 > SDK 自带。claudePath: bundled 强制用自带的。 */
export function resolveBinary(config) {
  if (config.claudePath && config.claudePath !== 'bundled' && existsSync(config.claudePath)) {
    if (!isShellShim(config.claudePath)) return { path: config.claudePath, source: 'config' }
    // Windows 上 .cmd/.bat 壳子进程自己跑不起来（SDK 内部 spawn 会 EINVAL）：忽略，退回下一档
    console.warn('[claude-pilot] claudePath 指向 .cmd/.bat 壳，Windows 上不能直接 spawn，改用插件自带的 claude.exe')
  }
  if (config.claudePath !== 'bundled') {
    for (const candidate of systemCandidates()) {
      if (candidate && existsSync(candidate)) return { path: candidate, source: 'system' }
    }
  }
  const bundled = bundledClaude()
  return bundled ? { path: bundled, source: 'bundled' } : { path: null, source: 'missing' }
}

/* --------------------------------------------------------------- 凭据注入 */

async function resolveSecret(ctx, ref) {
  try {
    const hit = await ctx.get('credentials')?.resolve?.(ref)
    return hit?.value || ''
  } catch {
    return ''
  }
}

/**
 * 给 Claude 子进程的环境：在基础环境上按当前方式注入凭据。
 * machine 方式原样保留进程环境（用户可能本来就在 DSH 的环境里配了 ANTHROPIC_*）。
 */
export async function authEnv(ctx, config, base) {
  const env = { ...base }
  // Hub 下发的原始变量不往 Claude 进程里传（下面换成 Claude Code 认的那几个）
  envDelete(env, 'HUB_CLAUDE_KEY')
  envDelete(env, 'HUB_CODEX_KEY')
  const auth = loadAuth(config)
  const hub = auth.mode === 'hub' ? hubAuth() : null
  if (hub) {
    for (const name of AUTH_VARS) delete env[name]
    if (hub.auth === 'oauthToken') env.CLAUDE_CODE_OAUTH_TOKEN = hub.key
    else env[hub.auth === 'authToken' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY'] = hub.key
    if (hub.baseUrl) env.ANTHROPIC_BASE_URL = hub.baseUrl
    const remote = (await hubConfig(config))?.config || null
    const main = hub.model || remote?.defaultModel || ''
    if (main) {
      env.ANTHROPIC_MODEL = main
      // Claude Code 内部按 sonnet / opus / haiku 别名挑模型（子代理、标题、摘要），都指到 Hub 有的模型上
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = main
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = main
    }
    const small = remote?.smallModel || main
    if (small) {
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = small
      env.ANTHROPIC_SMALL_FAST_MODEL = small
    }
    if (hubRelay(hub)) env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  } else if (auth.mode === 'apiKey') {
    const key = await resolveSecret(ctx, API_KEY_REF)
    for (const name of AUTH_VARS) delete env[name]
    if (key) env[auth.keyHeader === 'bearer' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY'] = key
    if (auth.baseUrl) env.ANTHROPIC_BASE_URL = auth.baseUrl
  } else if (auth.mode === 'oauthToken') {
    const token = await resolveSecret(ctx, OAUTH_REF)
    for (const name of AUTH_VARS) delete env[name]
    if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token
  }
  // Windows：给 claude 子进程带上 Git Bash（或 PowerShell 工具）那条路
  return applyShellTool(env)
}

/* ------------------------------------------------------------ Git Bash */

/**
 * Claude Code 在 Windows 上要一个命令工具：Git for Windows 的 bash（`CLAUDE_CODE_GIT_BASH_PATH`）
 * 或者 PowerShell 工具（2.1.303 支持，已在真机验证）。这里只给 claude 子进程注入，
 * 不动宿主环境、也不把 Git 目录塞进 PATH（Git Bash 与 agent shell 无关）。
 * 探测要读注册表，缓存 60 秒，别让每次轮询都去 spawn reg.exe。
 */
const GIT_BASH_TTL_MS = 60000
let gitBashCache = null

function gitBashDetected() {
  if (!IS_WIN) return null
  if (gitBashCache && Date.now() - gitBashCache.at < GIT_BASH_TTL_MS) return gitBashCache.value
  const value = detectGitBash()
  gitBashCache = { at: Date.now(), value }
  return value
}

/** 设置页诊断用：找到没找到、是哪一个、还查过哪些位置。 */
export function gitBashInfo() {
  if (!IS_WIN) return null
  const detected = gitBashDetected()
  return { found: Boolean(detected), path: detected?.path || null, source: detected?.source || null, candidates: gitBashPaths() }
}

/** 没有 Git Bash 时给横幅的一句话（null = 不需要提示）。options 可注入平台/探测（单测用）。 */
export function gitBashHint(options = {}) {
  const win = options.win ?? IS_WIN
  const detect = options.detect || gitBashDetected
  if (!win || detect()) return null
  return '没找到 Git Bash（Git for Windows）：Claude Code 会用 PowerShell 工具跑命令。装好 Git for Windows 后会自动改用它。'
}

/**
 * 给 Claude 子进程的 shell 工具环境（Windows 才有意义）。只改传进来的 env 对象，
 * 不动 process.env、也不动 PATH —— 这就是「只给 claude 子进程注入」的落点。
 */
export function applyShellTool(env, options = {}) {
  const win = options.win ?? IS_WIN
  const detect = options.detect || gitBashDetected
  if (!win) return env
  const bash = detect()
  if (bash) {
    if (!envGet(env, 'CLAUDE_CODE_GIT_BASH_PATH')) envSet(env, 'CLAUDE_CODE_GIT_BASH_PATH', bash.path)
  } else if (!envGet(env, 'CLAUDE_CODE_USE_POWERSHELL_TOOL')) {
    // 没 Git Bash 就明确走 PowerShell 工具（默认就是开的，写出来免得被别处的 0 带偏）
    envSet(env, 'CLAUDE_CODE_USE_POWERSHELL_TOOL', '1')
  }
  return env
}

/* ------------------------------------------------------------- 状态与测试 */

/** claude auth status --json：只看本地凭据在不在，不调 API、不花钱。 */
export async function authStatus(ctx, config, baseEnv) {
  const binary = resolveBinary(config)
  if (!binary.path) return { binary, loggedIn: false, error: '找不到 Claude Code 程序（Agent SDK 的平台包 @anthropic-ai/claude-agent-sdk-<平台> 没装上；重装插件会按平台重新下载）' }
  // Hub 中转站模式：能不能用由 Hub 说了算（开没开通、开没开放给我），不问 claude auth status
  if (loadAuth(config).mode === 'hub' && hubRelay(hubAuth())) {
    const remote = await hubConfig(config, { force: true })
    const models = remote?.config?.models?.length ?? null
    if (remote?.ok && models === 0) return { binary, loggedIn: false, authMethod: 'hub', apiProvider: 'DSH Hub', error: 'DSH Hub 里还没有可用的 Claude Code 模型，请联系管理员' }
    return { binary, loggedIn: Boolean(remote?.ok), authMethod: 'hub', apiProvider: 'DSH Hub', models, ...(remote?.ok ? {} : { error: remote?.error || '连不上 DSH Hub' }) }
  }
  const env = await authEnv(ctx, config, baseEnv)
  // Windows 上 npm 装的是 claude.cmd：直接 spawn 会 EINVAL（Node 18.20.2+），要经 cmd.exe；顺带隐藏控制台窗口
  const spec = spawnSpecFor(binary.path, ['auth', 'status', '--json'])
  const run = spawnSync(spec.command, spec.args, {
    env,
    encoding: 'utf8',
    timeout: 20000,
    cwd: tmpdir(),
    ...HIDE,
    ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  })
  try {
    const status = JSON.parse(run.stdout)
    return {
      binary,
      loggedIn: status.loggedIn === true,
      authMethod: status.authMethod,
      apiProvider: status.apiProvider,
      email: status.email,
      subscriptionType: status.subscriptionType,
      apiKeySource: status.apiKeySource,
    }
  } catch {
    return { binary, loggedIn: false, error: String(run.stderr || run.error?.message || '读不到 claude auth status 的输出').slice(0, 400) }
  }
}

/** 真发一个极小的请求，确认凭据（以及 Base URL / 中转站）可用。 */
export async function testConnection(ctx, config, baseEnv) {
  const binary = resolveBinary(config)
  const env = await authEnv(ctx, config, baseEnv)
  const started = Date.now()
  const attempt = async (model) => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 90000)
    let text = ''
    let result = null
    try {
      const q = query({
        prompt: 'Reply with exactly: ok',
        options: {
          cwd: tmpdir(),
          env,
          abortController: abort,
          ...(binary.path ? { pathToClaudeCodeExecutable: binary.path } : {}),
          ...(model ? { model } : {}),
          settingSources: [],
          allowedTools: [],
          maxTurns: 1,
        },
      })
      for await (const message of q) {
        if (message.type === 'assistant') text += (message.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
        if (message.type === 'result') result = message
      }
    } finally {
      clearTimeout(timer)
    }
    if (!result || result.is_error) throw new Error(result?.result || result?.subtype || text || '没有返回结果')
    return { ok: true, reply: text.trim().slice(0, 80), model: model || '(Claude Code 默认)', ms: Date.now() - started, costUsd: result.total_cost_usd || 0 }
  }
  // Hub 中转站模式：用 Hub 指定的小模型（authEnv 里已设好），不猜模型名
  if (loadAuth(config).mode === 'hub' && hubRelay(hubAuth())) {
    try {
      return await attempt(env.ANTHROPIC_DEFAULT_HAIKU_MODEL || undefined)
    } catch (error) {
      return { ok: false, error: String(error?.message || error).slice(0, 600) }
    }
  }
  try {
    return await attempt('claude-haiku-5-5')
  } catch (first) {
    // 中转站可能没有这个模型名：退回 Claude Code 默认模型再试一次
    if (/model/i.test(String(first?.message))) {
      try {
        return await attempt(undefined)
      } catch (second) {
        return { ok: false, error: String(second?.message || second).slice(0, 600) }
      }
    }
    return { ok: false, error: String(first?.message || first).slice(0, 600) }
  }
}

/* ------------------------------------------------------- 订阅登录（setup-token） */

const ANSI = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[=>]/g

/**
 * 在伪终端里跑 claude setup-token（它是 TUI，要 TTY；用 util-linux 的 script 提供），
 * 从输出里取出授权链接交给界面；用户授权后把页面上的授权码贴回来，写进伪终端，等它吐出 token。
 */
export function startLogin(ctx, config, state, baseEnv) {
  const binary = resolveBinary(config)
  if (!binary.path) return Promise.resolve({ ok: false, error: '找不到 Claude Code 程序' })
  const script = ['/usr/bin/script', '/bin/script'].find((path) => existsSync(path))
  if (!script || process.platform !== 'linux') {
    // TODO(D5)：桌面端用 ctx.get('subprocess').spawnTerminal（Windows 上是 ConPTY）跑 setup-token，
    //          不再依赖 util-linux 的 script。在那之前 Windows 只能手动粘贴 token。
    const error = IS_WIN
      ? 'Windows 上还不能在这里自动跑 claude setup-token。请在终端运行 claude setup-token，把输出的一整串 token 粘贴到「手动粘贴 token」。'
      : '这台机器上不能自动登录（缺少 script 命令）。请在终端运行 claude setup-token，再把 token 粘贴到「手动粘贴 token」。'
    return Promise.resolve({ ok: false, error })
  }
  cancelLogin(state)
  const env = { ...baseEnv, TERM: 'xterm-256color', COLUMNS: '1000', LINES: '50' }
  for (const name of AUTH_VARS) delete env[name]
  const quoted = `'${binary.path.replace(/'/g, `'\\''`)}'`
  const child = spawn(script, ['-q', '-c', `stty cols 1000 rows 50 2>/dev/null; exec ${quoted} setup-token`, '/dev/null'], { env, cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] })
  const login = { id: randomUUID(), child, raw: '', url: null, token: null, exited: false, startedAt: Date.now(), waiters: new Set() }
  state.login = login
  const wake = () => {
    for (const fn of [...login.waiters]) fn()
  }
  const onData = (chunk) => {
    login.raw += chunk.toString('utf8')
    if (login.raw.length > 400000) login.raw = login.raw.slice(-200000)
    if (!login.url) {
      // 链接以 OSC 8 超链接给出：ESC ] 8 ; params ; URL (BEL | ESC \)
      const match = /\x1b\]8;[^;]*;(https:\/\/[^\x07\x1b\s]+)/.exec(login.raw) || /(https:\/\/claude\.(?:com|ai)\/[^\s\x07\x1b]+oauth\/authorize[^\s\x07\x1b]*)/.exec(login.raw)
      if (match) login.url = match[1]
    }
    if (!login.token) {
      // 不认死 token 格式（新版 Claude Code 不一定是 sk-ant-oat01- 开头）：取「Your OAuth token (valid for …):」和
      // 「Store this token…」之间的那一串；老格式兜底
      const flat = login.raw.replace(ANSI, '').replace(/[\r\n]/g, '')
      const labeled = /Your OAuth token[^:]*\):\s*([^\s]{20,}?)\s*Store this token/.exec(flat)
      const legacy = /sk-ant-oat\d*-[A-Za-z0-9_-]{40,}/.exec(flat)
      if (labeled || legacy) login.token = labeled ? labeled[1] : legacy[0]
    }
    wake()
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  child.on('exit', () => {
    login.exited = true
    wake()
  })
  const timer = setTimeout(() => cancelLogin(state, login), 10 * 60 * 1000)
  timer.unref?.()
  return waitFor(login, () => login.url || login.exited, 30000).then(() =>
    login.url ? { ok: true, loginId: login.id, url: login.url } : { ok: false, error: `没拿到授权链接：${login.raw.replace(ANSI, '').slice(-400)}` },
  )
}

function waitFor(login, done, timeoutMs) {
  return new Promise((resolve) => {
    if (done()) return resolve()
    const timer = setTimeout(finish, timeoutMs)
    function finish() {
      clearTimeout(timer)
      login.waiters.delete(check)
      resolve()
    }
    function check() {
      if (done()) finish()
    }
    login.waiters.add(check)
  })
}

export function cancelLogin(state, which) {
  const login = which || state.login
  if (!login) return
  try {
    if (!login.exited) login.child.kill('SIGTERM')
  } catch {
    /* 已经退出 */
  }
  if (state.login === login) state.login = null
}

/** 把授权码写进伪终端，等 token；拿到就存进凭据库并切到 oauthToken 方式。 */
export async function finishLogin(ctx, config, state, { loginId, code }) {
  const login = state.login
  if (!login || login.id !== loginId) return { ok: false, error: '登录会话已失效，请重新开始' }
  const clean = String(code || '').trim()
  if (!clean) return { ok: false, error: '请粘贴授权码' }
  login.child.stdin.write(`${clean}\r`)
  await waitFor(login, () => login.token || login.exited, 60000)
  const token = login.token
  cancelLogin(state, login)
  if (!token) return { ok: false, error: `没有拿到 token（授权码不对或已过期）：${login.raw.replace(ANSI, '').slice(-300)}` }
  await saveOauthToken(ctx, config, token)
  return { ok: true }
}

async function saveOauthToken(ctx, config, token) {
  const credentials = ctx.get('credentials')
  if (!credentials?.set) throw new Error('DSH 凭据库不可用')
  await credentials.set(OAUTH_REF, token)
  // 存自己的 token = 改用自己的配置（有 Hub 下发时不再走 Hub）
  saveAuth(config, { ...savedAuth(config), mode: 'oauthToken', ...(hubAuth() ? { hubOverride: true } : {}) })
}

/* ---------------------------------------------------------------- 设置接口 */

async function describeRef(ctx, ref) {
  try {
    const info = await ctx.get('credentials')?.describe?.(ref)
    return { configured: info?.configured === true, source: info?.source || null }
  } catch {
    return { configured: false, source: null }
  }
}

/* ------------------------------------------------- 本机已有配置（只读检测） */

/**
 * 这台机器上本来就有的 Claude Code 配置：~/.claude（CLAUDE_CONFIG_DIR 可改目录）里有没有登录凭据、
 * settings.json 的 env 配了什么，以及 DSH 进程环境里有没有 ANTHROPIC_*。
 *
 * 只报「存在 / 是什么类型」：密钥、token 的值一律不读、不返回（settings.json 的 env 里只看有没有 key）。
 * 文件读不出来、JSON 坏了都静默降级成「未检测到」，绝不让 state 报错。
 */
export function detectMachineConfig(baseEnv = process.env) {
  const home = homedir()
  const pretty = (path) => (path.startsWith(home) ? `~${path.slice(home.length)}` : path)
  const dir = String(baseEnv?.CLAUDE_CONFIG_DIR || '').trim() || join(home, '.claude')
  const credentialsFile = join(dir, '.credentials.json')
  const settingsFile = join(dir, 'settings.json')
  const present = (path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  }
  let settingsPresent = false
  let settingsBaseUrl = ''
  let settingsApiKey = false
  let settingsAuthToken = false
  try {
    if (present(settingsFile) && statSync(settingsFile).size <= 1024 * 1024) {
      settingsPresent = true
      const parsed = JSON.parse(readFileSync(settingsFile, 'utf8'))
      const env = parsed && typeof parsed === 'object' && parsed.env && typeof parsed.env === 'object' ? parsed.env : {}
      settingsBaseUrl = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL.trim() : ''
      settingsApiKey = Boolean(String(env.ANTHROPIC_API_KEY || '').trim())
      settingsAuthToken = Boolean(String(env.ANTHROPIC_AUTH_TOKEN || '').trim())
    }
  } catch {
    // 权限 / 格式不对：文件存在就算检测到，但不声称里面有 key
    settingsPresent = present(settingsFile)
    settingsBaseUrl = ''
    settingsApiKey = false
    settingsAuthToken = false
  }
  const envBaseUrl = String(baseEnv?.ANTHROPIC_BASE_URL || '').trim()
  const envApiKey = Boolean(String(baseEnv?.ANTHROPIC_API_KEY || '').trim())
  const envAuthToken = Boolean(String(baseEnv?.ANTHROPIC_AUTH_TOKEN || '').trim())
  return {
    configDir: pretty(dir),
    credentialsFile: { path: pretty(credentialsFile), present: present(credentialsFile) },
    settingsFile: { path: pretty(settingsFile), present: settingsPresent, baseUrl: settingsBaseUrl, hasApiKey: settingsApiKey, hasAuthToken: settingsAuthToken },
    env: { baseUrl: envBaseUrl, hasApiKey: envApiKey, hasAuthToken: envAuthToken },
    // 本机是否有一份看起来能用的配置（登录凭据、settings.json 的 key+URL、进程环境里的 key）
    usable: present(credentialsFile)
      || (settingsPresent && settingsApiKey)
      || (settingsPresent && settingsAuthToken)
      || (Boolean(envBaseUrl) && (envApiKey || envAuthToken))
      || envApiKey
      || envAuthToken,
  }
}

export async function setupState(ctx, config, baseEnv, { check = true } = {}) {
  const auth = loadAuth(config)
  const status = check ? await authStatus(ctx, config, baseEnv) : null
  // 本机已有配置：复用这次 claude auth status 的结果（machine 方式下它就是本机登录的状态，不多起进程）
  let detected
  try {
    detected = detectMachineConfig(baseEnv)
  } catch {
    detected = { configDir: '~/.claude', credentialsFile: { path: '~/.claude/.credentials.json', present: false }, settingsFile: { path: '~/.claude/settings.json', present: false, baseUrl: '', hasApiKey: false, hasAuthToken: false }, env: { baseUrl: '', hasApiKey: false, hasAuthToken: false }, usable: false }
  }
  if (auth.mode === 'machine' && status) {
    detected.auth = {
      loggedIn: Boolean(status.loggedIn),
      authMethod: status.authMethod || null,
      apiProvider: status.apiProvider || null,
      subscriptionType: status.subscriptionType || null,
      email: status.email || null,
      apiKeySource: status.apiKeySource || null,
    }
    if (status.loggedIn) detected.usable = true
  }
  return {
    ok: true,
    mode: auth.mode,
    // Hub 下发信息：有 Hub 配置就返回（不管当前用不用），前端据此显示「Hub 下发」选项
    hubAvailable: Boolean(hubAuth()),
    hubOverride: auth.mode !== 'hub' && Boolean(hubAuth()),
    hub: hubDisplay(),
    baseUrl: auth.baseUrl || '',
    keyHeader: auth.keyHeader || 'x-api-key',
    apiKey: await describeRef(ctx, API_KEY_REF),
    oauthToken: await describeRef(ctx, OAUTH_REF),
    binary: resolveBinary(config),
    // Windows 需要 ConPTY（spawnTerminal）才能自动登录；在那之前只有手动粘贴 token
    autoLogin: !IS_WIN && ['/usr/bin/script', '/bin/script'].some((path) => existsSync(path)),
    gitBash: gitBashInfo(),
    status,
    detected,
    ready: Boolean(status?.loggedIn),
  }
}

/**
 * POST /api/claude-pilot.setup 的动作：
 *   {action:'state'} | {action:'test'} | {action:'use-machine'}
 *   {action:'save-api-key', apiKey?, baseUrl?, keyHeader?}   apiKey 省略 = 只改 Base URL / 方式
 *   {action:'save-oauth-token', token} | {action:'login-start'} | {action:'login-code', loginId, code} | {action:'login-cancel'}
 *   {action:'use-hub'}   改回用 DSH Hub 下发的配置（自己保存的凭据保留）
 *   {action:'clear'}   清掉本插件存的凭据，回到本机登录（有 Hub 下发时也回到 Hub 下发）
 *
 * 有 Hub 下发（HUB_CLAUDE_*）时默认走 Hub；任何「保存自己的凭据 / 切到本机」的写操作都会把
 * auth.json 的 hubOverride 置为 true（改用自己的配置），use-hub / clear 置回 false。
 */
/* ------------------------------------------------------------ 订阅用量 */

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const USAGE_TTL_MS = 60000

/** machine 方式下 Claude Code 自己的登录（~/.claude/.credentials.json，CLAUDE_CONFIG_DIR 可改目录）。 */
/**
 * 本机凭据的指纹：~/.claude（或 CLAUDE_CONFIG_DIR）的 .credentials.json + settings.json 的修改时间和大小，
 * 加上插件自己的凭据方式。用户在终端里 `claude /login` 切账号、改 settings.json 的 env 后指纹会变，
 * 用量和登录状态的缓存随之作废（Claude Code 本身每轮都是新进程，下一轮自然用新凭据）。
 */
export function credentialFingerprint(config, baseEnv) {
  const dir = baseEnv?.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
  const parts = [loadAuth(config).mode]
  for (const name of ['.credentials.json', 'settings.json']) {
    try {
      const info = statSync(join(dir, name))
      parts.push(`${name}:${info.mtimeMs}:${info.size}`)
    } catch {
      parts.push(`${name}:missing`)
    }
  }
  return parts.join('|')
}

function machineOauth(baseEnv) {
  const dir = baseEnv?.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
  try {
    const data = JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8'))?.claudeAiOauth
    if (!data?.accessToken) return null
    return { token: data.accessToken, expiresAt: Number(data.expiresAt) || 0, plan: data.subscriptionType || null, tier: data.rateLimitTier || null }
  } catch {
    return null
  }
}

/** 当前凭据方式下用哪个 OAuth token 查订阅用量；API Key 方式没有订阅额度。 */
async function usageCredential(ctx, config, baseEnv) {
  const auth = loadAuth(config)
  if (auth.mode === 'hub') {
    const hub = hubAuth()
    return hub?.auth === 'oauthToken' ? { kind: 'oauth', token: hub.key, source: 'hub' } : { kind: 'apiKey' }
  }
  if (auth.mode === 'apiKey') return { kind: 'apiKey' }
  if (auth.mode === 'oauthToken') {
    const token = await resolveSecret(ctx, OAUTH_REF)
    return token ? { kind: 'oauth', token, source: 'setup-token' } : { kind: 'none' }
  }
  if (baseEnv?.CLAUDE_CODE_OAUTH_TOKEN) return { kind: 'oauth', token: baseEnv.CLAUDE_CODE_OAUTH_TOKEN, source: 'env' }
  const machine = machineOauth(baseEnv)
  if (machine) return { kind: 'oauth', ...machine, source: 'machine' }
  if (baseEnv?.ANTHROPIC_API_KEY || baseEnv?.ANTHROPIC_AUTH_TOKEN) return { kind: 'apiKey' }
  return { kind: 'none' }
}

const toLimit = (item) => ({
  kind: String(item.kind || ''),
  group: String(item.group || ''),
  percent: Math.max(0, Math.min(100, Number(item.percent) || 0)),
  severity: String(item.severity || 'normal'),
  resetsAt: item.resets_at ? Date.parse(item.resets_at) || null : null,
  active: Boolean(item.is_active),
})

/** 老格式（five_hour / seven_day…）兜底成 limits 列表。 */
function legacyLimits(data) {
  const out = []
  const push = (kind, group, window) => {
    if (!window || typeof window.utilization !== 'number') return
    out.push(toLimit({ kind, group, percent: Math.round(window.utilization), resets_at: window.resets_at }))
  }
  push('session', 'session', data.five_hour)
  push('weekly_all', 'weekly', data.seven_day)
  push('weekly_opus', 'weekly', data.seven_day_opus)
  push('weekly_sonnet', 'weekly', data.seven_day_sonnet)
  return out
}

/**
 * Claude 订阅额度（和 Claude Code 的 /usage 同一个接口）：5 小时窗口、每周窗口……
 * 结果缓存 60 秒（多个标签页一起轮询也只打一次）；失败时带上一次成功的数据。绝不返回 token。
 */
export async function planUsage(ctx, config, state, baseEnv, { force = false } = {}) {
  const now = Date.now()
  const cached = state.planUsage
  const fingerprint = credentialFingerprint(config, baseEnv)
  if (!force && cached && cached.fingerprint === fingerprint && now - cached.at < USAGE_TTL_MS) return cached.data
  if (state.planUsageInflight) return state.planUsageInflight
  const run = (async () => {
    const credential = await usageCredential(ctx, config, baseEnv)
    let data
    if (credential.kind !== 'oauth') {
      data = { kind: credential.kind, fetchedAt: now }
    } else if (credential.expiresAt && credential.expiresAt < now) {
      // Claude Code 下次运行时会自己刷新 token；这里只读不刷新，先给上一次的数据
      data = { ...(cached?.data?.kind === 'plan' ? cached.data : { kind: 'plan', limits: [] }), stale: true, error: '登录 token 已过期，Claude 下次运行时会自动刷新' }
    } else {
      try {
        const response = await fetch(USAGE_URL, {
          headers: { authorization: `Bearer ${credential.token}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' },
          signal: AbortSignal.timeout(10000),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}${response.status === 403 ? '（这个 token 没有查询用量的权限）' : ''}`)
        const raw = await response.json()
        const limits = Array.isArray(raw.limits) && raw.limits.length ? raw.limits.map(toLimit) : legacyLimits(raw)
        const extra = raw.extra_usage?.is_enabled
          ? { utilization: Number(raw.extra_usage.utilization) || 0, used: raw.extra_usage.used_credits ?? null, limit: raw.extra_usage.monthly_limit ?? null, currency: raw.extra_usage.currency || null }
          : null
        data = { kind: 'plan', plan: credential.plan || null, tier: credential.tier || null, source: credential.source, limits, extra, fetchedAt: now }
      } catch (error) {
        const reason = String(error?.message || error)
        data = { ...(cached?.data?.kind === 'plan' ? cached.data : { kind: 'plan', limits: [] }), stale: true, error: reason }
      }
    }
    state.planUsage = { at: now, fingerprint, data }
    return data
  })()
  state.planUsageInflight = run
  try {
    return await run
  } finally {
    state.planUsageInflight = null
  }
}

/** 粘贴进来的 token：容忍整行 `export CLAUDE_CODE_OAUTH_TOKEN=…`、引号和换行折断。不校验前缀（格式会变）。 */
function cleanToken(value) {
  let token = typeof value === 'string' ? value.trim() : ''
  token = token.replace(/^(?:export\s+)?CLAUDE_CODE_OAUTH_TOKEN\s*=\s*/, '').replace(/^(['"])(.*)\1$/s, '$2')
  return token.replace(/[\r\n]+/g, '').trim()
}

export async function handleSetup(ctx, config, state, body, baseEnv) {
  const credentials = ctx.get('credentials')
  // 有 Hub 下发时，写操作都等于「改用自己的配置」（hubOverride: true）；自己保存的凭据不删
  const saveOwn = (patch) => saveAuth(config, { ...savedAuth(config), ...patch, ...(hubAuth() ? { hubOverride: true } : {}) })
  switch (body?.action) {
    case undefined:
    case 'state':
      return setupState(ctx, config, baseEnv)
    case 'test': {
      const status = await authStatus(ctx, config, baseEnv)
      if (!status.loggedIn) return { ok: false, error: '还没有可用的凭据', status }
      return testConnection(ctx, config, baseEnv)
    }
    case 'use-machine':
      saveOwn({ mode: 'machine' })
      return setupState(ctx, config, baseEnv)
    case 'use-hub': {
      if (!hubAuth()) return { ok: false, error: '没有 DSH Hub 下发的配置' }
      saveAuth(config, { ...savedAuth(config), hubOverride: false })
      return setupState(ctx, config, baseEnv)
    }
    case 'save-api-key': {
      const key = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
      const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim().replace(/\/+$/, '') : ''
      if (baseUrl && !/^https?:\/\/[^\s]+$/i.test(baseUrl)) return { ok: false, error: 'Base URL 要以 http:// 或 https:// 开头' }
      if (key) {
        if (!credentials?.set) return { ok: false, error: 'DSH 凭据库不可用' }
        await credentials.set(API_KEY_REF, key)
      } else if (!(await describeRef(ctx, API_KEY_REF)).configured) {
        return { ok: false, error: '请填写 API Key' }
      }
      saveOwn({ mode: 'apiKey', baseUrl, keyHeader: body.keyHeader === 'bearer' ? 'bearer' : 'x-api-key' })
      return setupState(ctx, config, baseEnv)
    }
    case 'save-oauth-token': {
      const token = cleanToken(body.token)
      if (!token) return { ok: false, error: '请粘贴 claude setup-token 输出的 token' }
      if (/\s/.test(token) || token.length < 20) return { ok: false, error: '这不像 claude setup-token 产出的 token（应是一整串、不含空格）' }
      await saveOauthToken(ctx, config, token)
      return setupState(ctx, config, baseEnv)
    }
    case 'login-start':
      return startLogin(ctx, config, state, baseEnv)
    case 'login-code': {
      const result = await finishLogin(ctx, config, state, body)
      return result.ok ? setupState(ctx, config, baseEnv) : result
    }
    case 'login-cancel':
      cancelLogin(state)
      return { ok: true }
    case 'clear':
      await credentials?.unset?.(API_KEY_REF)
      await credentials?.unset?.(OAUTH_REF)
      saveAuth(config, { mode: 'machine', hubOverride: false })
      return setupState(ctx, config, baseEnv)
    default:
      return { ok: false, error: `未知动作 ${body?.action}` }
  }
}
