/**
 * 初始化：Codex 程序在哪、用哪份凭据、登没登录、能不能连通，以及在界面里完成登录。
 *
 * 几种方式（$DSH_HOME/codex-pilot/auth.json 的 mode，外面还可能套一层 Hub 下发）：
 *   - machine  用运行 DSH 的系统用户自己的 Codex（~/.codex 的登录与 config.toml，含自定义提供者/中转站）。默认。
 *   - chatgpt  插件自己的 CODEX_HOME（codex-pilot/home-chatgpt），在界面里用 ChatGPT 账号设备码登录，不动 ~/.codex。
 *   - apiKey   插件自己的 CODEX_HOME（codex-pilot/home-apikey），写一个自定义提供者（可填 Base URL 接中转站）；
 *              key 存 DSH 凭据库 CODEX_PILOT_API_KEY，启动 app-server 时以同名环境变量注入。
 *
 * 设置接口挂在 connection 的受保护路由 /api/codex-pilot.setup 上（只有已登录 DSH 的浏览器能调），绝不返回密钥值。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
// 和其它 runtime 模块一样带上版本号再 import：改 platform.js 也能热加载（ESM 按 URL 缓存）
const { HIDE, IS_WIN, baseChildEnv, envDelete, envGet, envSet, spawnSpecFor, whichFile } = await import(`./platform.js${new URL(import.meta.url).search}`)

const V = new URL(import.meta.url).search
const rpc = await import(`./appserver.js${V}`)

export const API_KEY_REF = 'CODEX_PILOT_API_KEY'
const KEY_ENV = 'CODEX_PILOT_API_KEY'

/**
 * DSH Hub 下发的账号（管理员在 Hub 控制台配置，经容器环境变量注入）：
 *   HUB_CODEX_KEY（有它就说明 Hub 下发了账号）、HUB_CODEX_BASE_URL（默认 OpenAI）、
 *   HUB_CODEX_WIRE_API = responses | chat、HUB_CODEX_MODEL（可选）、HUB_CODEX_LABEL（显示名）
 * 默认用下发的账号；用户在设置页改成自己的配置后 auth.json 里记住 hubOverride: true，下发就不再生效
 * （随时可以「改回 Hub 下发」，自己保存的凭据不删）。
 */
/**
 * 桌面端的 Hub 配置由 hub-connector 提供（设备令牌 → /v1/hub/agent-mode），不再依赖容器注入的
 * HUB_CODEX_*。index.r1.js 启动时把服务挂进来：setHubProvider(() => service.credentials('codex'))；
 * 返回 { key, baseUrl, wireApi, model, label } | null。容器里没有这个服务，还是走环境变量。
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
  const key = String(raw.key || '').trim()
  if (!key) return null
  return {
    key,
    baseUrl: String(raw.baseUrl || '').trim().replace(/\/+$/, '') || 'https://api.openai.com/v1',
    wireApi: String(raw.wireApi || '').trim() === 'chat' ? 'chat' : 'responses',
    model: String(raw.model || '').trim(),
    label: String(raw.label || '').trim() || 'DSH Hub',
    // 可选：hub-connector 缓存的模型列表（上游接口没有这一项，属可选扩展）。
    // 模型列表的正常来源仍是 GET {base}/hub/agent-mode（与容器完全同一条链），这里只在拉取失败时兜底。
    models: Array.isArray(raw.models) ? raw.models.filter((model) => model && model.id) : null,
  }
}

export function hubAuth(env = process.env) {
  const fromService = hubFromService()
  if (fromService) return fromService
  // Windows 的环境变量键名大小写不固定：按大小写不敏感读
  const key = String(envGet(env, 'HUB_CODEX_KEY') || '').trim()
  if (!key) return null
  return {
    key,
    baseUrl: String(envGet(env, 'HUB_CODEX_BASE_URL') || '').trim().replace(/\/+$/, '') || 'https://api.openai.com/v1',
    wireApi: String(envGet(env, 'HUB_CODEX_WIRE_API') || '').trim() === 'chat' ? 'chat' : 'responses',
    model: String(envGet(env, 'HUB_CODEX_MODEL') || '').trim(),
    label: String(envGet(env, 'HUB_CODEX_LABEL') || '').trim() || 'DSH Hub',
  }
}

/**
 * Hub 模式下模型列表、默认模型由 Hub 管理员在管理台配置，插件向 Hub 拉：GET {base}/hub/agent-mode
 * （base 已带 /v1；docs/18 §3.4），缓存 30 秒，改了下一轮就生效，不重启 app-server。
 * 404 = 老 Hub 没有这个接口：照旧只用 env 里的 HUB_CODEX_MODEL。网络失败时沿用上次成功的结果。
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

function hubErrorMessage(data, status) {
  const message = data?.error?.message || data?.message
  if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 200)
  return status === 401 ? 'DSH Hub 不认这把密钥，请联系管理员' : `DSH Hub 返回 ${status}`
}

export async function hubConfig({ force = false } = {}) {
  const hub = hubAuth()
  if (!hub) return null
  const key = `${hub.baseUrl}|${hub.key.slice(-8)}`
  const cached = hubConfigCache?.key === key ? hubConfigCache : null
  if (!force && cached && Date.now() - cached.at < HUB_CONFIG_TTL_MS) return cached.result
  if (hubConfigInflight?.key === key) return hubConfigInflight.promise
  const promise = (async () => {
    let result
    try {
      const response = await fetch(`${hub.baseUrl}/hub/agent-mode`, { headers: { accept: 'application/json', authorization: `Bearer ${hub.key}` }, signal: AbortSignal.timeout(10000) })
      const data = await response.json().catch(() => null)
      if (response.ok && data && Array.isArray(data.models)) result = { ok: true, config: data }
      else if (response.status === 404) result = { ok: true, config: null }
      else result = { ok: false, status: response.status, error: hubErrorMessage(data, response.status) }
    } catch (error) {
      if (cached?.result?.ok) return cached.result
      // TypeError 只是 fetch 对「连不上」的包装，给用户看的原因别是 TypeError
      const reason = error?.cause?.code || (error?.name === 'TypeError' ? '网络不通' : error?.name) || error?.message || error
      result = { ok: false, status: 0, error: `连不上 DSH Hub（${String(reason).slice(0, 60)}）` }
    }
    hubConfigCache = { key, at: Date.now(), result }
    return result
  })().finally(() => {
    if (hubConfigInflight?.promise === promise) hubConfigInflight = null
  })
  hubConfigInflight = { key, promise }
  return promise
}

/** 最近一次拉到的 Hub 模式配置（同步读，给模型列表用）；没有 = null */
export function lastHubConfig() {
  const hub = hubAuth()
  if (!hub) return null
  const cached = hubConfigCache?.key === `${hub.baseUrl}|${hub.key.slice(-8)}` ? hubConfigCache.result : null
  if (cached?.ok) return cached.config
  // 桌面端：hub-connector 可能已经把模型列表缓存好了；拉取没成功时用它兜底（只影响模型选择器）
  if (hub.models?.length) return { label: hub.label, models: hub.models, defaultModel: hub.model || null }
  return null
}

export function pilotHome(config = {}) {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return config?.storeFile ? dirname(config.storeFile) : join(home, 'codex-pilot')
}

function authFile(config) {
  return join(pilotHome(config), 'auth.json')
}

/** auth.json 里自己存的那份（不掺 Hub 下发）；写回时用它做底，避免把 Hub 配置写进文件。 */
export function savedAuth(config = {}) {
  try {
    const data = JSON.parse(readFileSync(authFile(config), 'utf8'))
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

/**
 * 当前用哪份凭据。有 Hub 下发（HUB_CODEX_KEY）且用户没有明确改用自己配置（hubOverride === true）时用 Hub；
 * 否则按 auth.json 里的方式走，返回值里带 hubAvailable 表示「环境里有 Hub 下发可用」。
 */
export function loadAuth(config = {}) {
  const hub = hubAuth()
  const saved = savedAuth(config)
  const hubInfo = hub ? { baseUrl: hub.baseUrl, wireApi: hub.wireApi, model: hub.model, label: hub.label } : null
  if (hub && saved.hubOverride !== true) {
    return { ...saved, mode: 'hub', baseUrl: hub.baseUrl, wireApi: hub.wireApi, model: hub.model, hub: hubInfo, hubAvailable: true }
  }
  return { ...saved, mode: saved.mode || 'machine', ...(hubInfo ? { hub: hubInfo } : {}), hubAvailable: Boolean(hub) }
}

/** 现在是不是真的在用 Hub 下发（有 Hub 环境变量还不够：用户可能已经改用自己的配置）。 */
export function hubMode(config = {}) {
  return loadAuth(config).mode === 'hub'
}

function saveAuth(config, auth) {
  const file = authFile(config)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(auth, null, 2))
  renameSync(tmp, file)
}

function managedHome(config, mode) {
  return join(pilotHome(config), { apiKey: 'home-apikey', hub: 'home-hub' }[mode] || 'home-chatgpt')
}

/* ------------------------------------------------------------ Codex 程序 */

/**
 * 给 Codex 子进程的环境。Windows 上的差别（PATH 用 `;`、键名可能是 `Path`、要补 %APPDATA%\npm、
 * HOME 可能没设）都在 platform.js 里；`dirname(process.execPath)` 在桌面端是 Electron 所在目录。
 */
export function childEnv() {
  return baseChildEnv([dirname(process.execPath)])
}

/** 按 PATH + PATHEXT 找可执行文件（Windows 上要认 .exe/.cmd/.bat，原来只看无扩展名的 `codex`）。 */
function which(name, env) {
  return whichFile(name, env)
}

const TRIPLE = IS_WIN
  ? (process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc')
  : (process.arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl')

function vendorBinary(packageJsonPath) {
  const exe = join(dirname(packageJsonPath), 'vendor', TRIPLE, 'bin', IS_WIN ? 'codex.exe' : 'codex')
  return existsSync(exe) ? exe : null
}

/**
 * 插件依赖里带的 @openai/codex。优先直接用平台包里的原生程序：
 *   - 不再套一层 `node bin/codex.js`（Windows 上 kill 只会杀掉 node 壳，codex.exe 会变孤儿进程）；
 *   - 平台包是 **@openai/codex 的** optionalDependencies（`npm:@openai/codex@<ver>-<platform>-<arch>` 别名装的），
 *     vendor 布局与 bin/codex.js 里找的一致。
 *   - npm 的扁平布局从插件这边就能 resolve；pnpm 的隔离布局（桌面端插件管理器用 pnpm）里平台包只挂在
 *     @openai/codex 自己的 node_modules，必须从它那里再 resolve 一次。两种位置都试。
 */
export function bundledCodex() {
  const require = createRequire(import.meta.url)
  try {
    const script = require.resolve('@openai/codex/bin/codex.js')
    if (!existsSync(script)) return null
    const resolvers = [createRequire(script), require]
    for (const resolve of resolvers) {
      try {
        const pkg = resolve.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`)
        const exe = vendorBinary(pkg)
        if (exe) return { command: exe, args: [], path: exe, native: true }
      } catch {
        /* 换个位置再试；都不行就退回用 node 跑 bin/codex.js */
      }
    }
    return { command: process.execPath, args: [script], path: script, native: false }
  } catch {
    return null
  }
}

/**
 * 用哪个 codex：配置 > PATH 里装的 > 插件自带。codexPath: bundled 强制用自带的。
 * 返回的 command/args 已经处理过 `.cmd` 壳（Windows 上要经 cmd.exe，否则 Node 18.20.2+ 报 EINVAL）。
 */
export function resolveBinary(config, env = childEnv()) {
  if (config.codexPath && config.codexPath !== 'bundled' && existsSync(config.codexPath)) {
    const spec = spawnSpecFor(config.codexPath, [])
    return { path: config.codexPath, source: 'config', command: spec.command, args: spec.args, verbatim: spec.windowsVerbatimArguments }
  }
  if (config.codexPath !== 'bundled') {
    const pinned = String(envGet(process.env, 'CODEX_BIN') || '').trim()
    const found = pinned && existsSync(pinned) ? pinned : which('codex', env)
    if (found) {
      const spec = spawnSpecFor(found, [])
      return { path: found, source: 'system', command: spec.command, args: spec.args, verbatim: spec.windowsVerbatimArguments }
    }
  }
  const bundled = bundledCodex()
  if (bundled) return { path: bundled.path, source: 'bundled', command: bundled.command, args: bundled.args, verbatim: false }
  return { path: null, source: 'missing', command: null, args: [] }
}

/* ------------------------------------------------------------ 启动参数 */

async function resolveSecret(ctx, ref) {
  try {
    const hit = await ctx.get('credentials')?.resolve?.(ref)
    return hit?.value || ''
  } catch {
    return ''
  }
}

function tomlString(value) {
  return JSON.stringify(String(value))
}

/** apiKey 方式：在插件自己的 CODEX_HOME 里写 config.toml（自定义提供者，key 走环境变量）。 */
function writeApiKeyHome(config, auth, which = 'apiKey') {
  const home = managedHome(config, which)
  mkdirSync(home, { recursive: true })
  const lines = [
    `# 由 dsh-codex-pilot 生成（${which === 'hub' ? 'DSH Hub 下发的账号' : '界面里的「API Key」方式'}）；改设置会重写本文件`,
    'model_provider = "dsh_pilot"',
    ...(auth.model ? [`model = ${tomlString(auth.model)}`] : []),
    '',
    '[model_providers.dsh_pilot]',
    `name = ${tomlString(which === 'hub' ? auth.label || 'DSH Hub' : 'DSH Codex API Key')}`,
    `base_url = ${tomlString(auth.baseUrl || 'https://api.openai.com/v1')}`,
    `env_key = "${KEY_ENV}"`,
    `wire_api = ${tomlString(auth.wireApi === 'chat' ? 'chat' : 'responses')}`,
    '',
  ]
  // mode 只在 POSIX 上有效；Windows 上权限由目录 ACL 决定（%USERPROFILE%\.dsh 默认只有本人可读）
  writeFileSync(join(home, 'config.toml'), lines.join('\n'), { mode: 0o600 })
  return home
}

/**
 * 按当前方式算出 app-server 的启动参数。secretDigest 只用来判断「凭据换了要重启」，不可逆。
 * mode 参数可以覆盖当前方式（登录流程要用 chatgpt 方式单独起一个进程）。
 */
export async function launchSpec(ctx, config, { mode } = {}) {
  const env = childEnv()
  const binary = resolveBinary(config, env)
  if (!binary.command) throw new Error('找不到 Codex 程序（PATH 里没有 codex，插件自带的 @openai/codex 平台包也没装上；重装插件会按平台重新下载）')
  const auth = loadAuth(config)
  const use = mode || auth.mode
  let codexHome = null
  let secretDigest = ''
  envDelete(env, KEY_ENV)
  // Hub 下发的原始变量不往 Codex 进程里传（hub 方式下换成 CODEX_PILOT_API_KEY）
  const hub = use === 'hub' ? hubAuth(env) : null
  envDelete(env, 'HUB_CODEX_KEY')
  envDelete(env, 'HUB_CLAUDE_KEY')
  if (hub) {
    codexHome = writeApiKeyHome(config, hub, 'hub')
    envSet(env, KEY_ENV, hub.key)
    secretDigest = createHash('sha256').update(`hub\n${hub.key}\n${hub.baseUrl}\n${hub.wireApi}\n${hub.model}`).digest('hex')
  } else if (use === 'chatgpt') {
    codexHome = managedHome(config, 'chatgpt')
    mkdirSync(codexHome, { recursive: true })
  } else if (use === 'apiKey') {
    codexHome = writeApiKeyHome(config, auth)
    const key = await resolveSecret(ctx, API_KEY_REF)
    if (key) envSet(env, KEY_ENV, key)
    secretDigest = createHash('sha256').update(`${key}\n${auth.baseUrl || ''}\n${auth.wireApi || ''}\n${auth.model || ''}`).digest('hex')
  }
  else if (use === 'machine') secretDigest = machineFingerprint(env)
  if (codexHome) envSet(env, 'CODEX_HOME', codexHome)
  // windowsHide：不隐藏窗口时，长驻的 app-server 会带出一个黑窗口
  return { command: binary.command, args: binary.args, env, codexHome, secretDigest, binary, mode: use, cwd: tmpdir(), ...HIDE, verbatim: Boolean(binary.verbatim) }
}

/**
 * 本机方式：~/.codex（或 CODEX_HOME）里的 auth.json + config.toml 的指纹。
 * 用户在终端里 `codex login` 切账号、改 config.toml 换提供者后指纹会变，app-server 随之重启
 * （Codex 进程启动时把凭据读进内存，不重启就一直用旧的）。不可逆，只用来比较。
 */
function machineFingerprint(env) {
  const dir = envGet(env, 'CODEX_HOME') || join(envGet(env, 'HOME') || homedir(), '.codex')
  const hash = createHash('sha256')
  for (const name of ['auth.json', 'config.toml']) {
    try {
      hash.update(name).update(readFileSync(join(dir, name)))
    } catch {
      hash.update(`${name}:missing`)
    }
  }
  return hash.digest('hex')
}

/* ------------------------------------------- 本机已有配置（只读检测，给设置页） */

/**
 * 只看「有没有」和「是什么类型」：~/.codex/auth.json 一个字段值都不往外报，
 * config.toml 只报 provider 名字和 base_url（URL 里可能被拼进 token，所以要洗过）。
 * 读不到 / 格式不对一律当成「没检测到」，绝不让 state 报错。
 */
function authTypeOf(data) {
  if (!data || typeof data !== 'object') return null
  const mode = typeof data.auth_mode === 'string' ? data.auth_mode.trim().toLowerCase() : ''
  if (mode === 'chatgpt') return 'chatgpt'
  if (mode === 'apikey' || mode === 'api_key' || mode === 'api-key') return 'apiKey'
  const tokens = data.tokens
  if (tokens && typeof tokens === 'object' && (tokens.access_token || tokens.refresh_token || tokens.id_token)) return 'chatgpt'
  if (typeof data.OPENAI_API_KEY === 'string' && data.OPENAI_API_KEY.trim()) return 'apiKey'
  return mode ? 'unknown' : null
}

/** 只留协议 + 主机 + 路径：去掉 userinfo / query / hash（有的中转站会把 key 拼在 URL 里），解析不了就不报。 */
function safeBaseUrl(value) {
  const text = String(value || '').trim()
  if (!text) return null
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`.slice(0, 300)
  } catch {
    return null
  }
}

function tomlValue(raw) {
  const text = String(raw || '').trim()
  if (!text) return null
  const quote = text[0]
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, 1)
    if (end < 0) return null
    const body = text.slice(1, end)
    return quote === '"' ? body.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : body
  }
  const bare = text.replace(/\s+#.*$/, '').trim()
  if (bare === 'true') return true
  if (bare === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(bare)) return Number(bare)
  return null
}

/** 极简 TOML 读取：够取顶层标量和 [model_providers.x] 下面的标量；复杂结构直接忽略。 */
function parseTomlLite(text) {
  const root = {}
  let current = root
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const header = /^\[\[?(.+?)\]\]?$/.exec(line)
    if (header) {
      current = root
      for (const part of header[1].split('.')) {
        const key = part.trim().replace(/^["']|["']$/g, '')
        if (!key) continue
        if (!current[key] || typeof current[key] !== 'object') current[key] = {}
        current = current[key]
      }
      continue
    }
    const pair = /^("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line)
    if (!pair) continue
    current[pair[1].replace(/^["']|["']$/g, '')] = tomlValue(pair[2])
  }
  return root
}

/**
 * 本机 Codex 的既有配置（~/.codex，或 $CODEX_HOME）。只读、只含非敏感信息：
 *   codexHome        检测的目录（路径）
 *   authFile         { present, type: 'chatgpt' | 'apiKey' | 'unknown' | null }   只看类型，不看值
 *   configFile       { present, modelProvider, model, providerName, baseUrl, wireApi, envKeyConfigured }
 *                    baseUrl 已去掉 userinfo / query；env_key 只报「对应环境变量存不存在」
 *   env              { openaiApiKey, codexHome }  进程环境里有没有这两个变量（布尔）
 */
export function detectMachineConfig(env = process.env) {
  const dir = String(envGet(env, 'CODEX_HOME') || '').trim() || join(String(envGet(env, 'HOME') || '').trim() || homedir(), '.codex')
  const detected = {
    codexHome: dir,
    authFile: { present: false, type: null },
    configFile: { present: false, modelProvider: null, model: null, providerName: null, baseUrl: null, wireApi: null, envKeyConfigured: false },
    env: { openaiApiKey: Boolean(String(envGet(env, 'OPENAI_API_KEY') || '').trim()), codexHome: Boolean(String(envGet(env, 'CODEX_HOME') || '').trim()) },
  }
  try {
    const data = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))
    detected.authFile.present = true
    detected.authFile.type = authTypeOf(data)
  } catch {
    /* 没有 / 不是 JSON：当没检测到 */
  }
  try {
    const text = readFileSync(join(dir, 'config.toml'), 'utf8')
    detected.configFile.present = true
    const table = parseTomlLite(text)
    const providerId = typeof table.model_provider === 'string' ? table.model_provider.trim() : ''
    detected.configFile.modelProvider = providerId || null
    detected.configFile.model = typeof table.model === 'string' ? table.model.trim() : null
    const entry = providerId && table.model_providers && typeof table.model_providers === 'object' ? table.model_providers[providerId] : null
    if (entry && typeof entry === 'object') {
      detected.configFile.providerName = typeof entry.name === 'string' ? entry.name.trim() : null
      detected.configFile.baseUrl = safeBaseUrl(entry.base_url)
      detected.configFile.wireApi = entry.wire_api === 'chat' ? 'chat' : entry.wire_api === 'responses' ? 'responses' : null
      const envKey = typeof entry.env_key === 'string' ? entry.env_key.trim() : ''
      detected.configFile.envKeyConfigured = Boolean(envKey && String(env[envKey] || '').trim())
    }
  } catch {
    /* 没有 / 解析失败：当没检测到 */
  }
  return detected
}

/* ------------------------------------------------------------- 状态与测试 */

/** account/read：本地凭据在不在（不调模型、不花钱）。 */
export async function authStatus(ctx, config, state) {
  const auth = loadAuth(config)
  // Hub 模式：能不能用由 Hub 说了算（开没开通、开没开放给我）
  if (auth.mode === 'hub') {
    const remote = await hubConfig({ force: true })
    const binary = resolveBinary(config)
    const models = remote?.config?.models?.length ?? null
    if (remote?.ok && models === 0) return { binary, loggedIn: false, authType: 'hub', error: 'DSH Hub 里还没有可用的 Codex 模型，请联系管理员' }
    return { binary, loggedIn: Boolean(remote?.ok), authType: 'hub', models, ...(remote?.ok ? {} : { error: remote?.error || '连不上 DSH Hub' }) }
  }
  let launch
  try {
    launch = await launchSpec(ctx, config)
  } catch (error) {
    return { binary: resolveBinary(config), loggedIn: false, error: error.message }
  }
  if (auth.mode === 'apiKey' && !launch.secretDigest) return { binary: launch.binary, loggedIn: false, error: '还没有保存 API Key' }
  try {
    const server = await rpc.ensureServer(state, launch)
    const info = await rpc.request(server, 'account/read', { refreshToken: false }, 20000)
    const account = info?.account || null
    const loggedIn = Boolean(account) || info?.requiresOpenaiAuth === false
    return {
      binary: launch.binary,
      loggedIn,
      authType: account?.type || (loggedIn ? 'provider' : null),
      email: account?.email || null,
      planType: account?.planType || null,
      ...(loggedIn ? {} : { error: '没有登录（Codex 需要 ChatGPT 账号或 API Key）' }),
    }
  } catch (error) {
    return { binary: launch.binary, loggedIn: false, error: String(error?.message || error).slice(0, 400) }
  }
}

/** 真跑一个极小的回合（临时 thread，不落历史），确认凭据 / Base URL / 模型都可用。 */
export async function testConnection(ctx, config, state) {
  const started = Date.now()
  const launch = await launchSpec(ctx, config)
  const server = await rpc.ensureServer(state, launch)
  const { thread } = await rpc.request(server, 'thread/start', { cwd: tmpdir(), approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true }, 60000)
  let text = ''
  const errors = []
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ status: 'timeout' }), 90000)
    server.threads.set(thread.id, {
      onNotification(message) {
        const params = message.params || {}
        if (message.method === 'item/completed' && params.item?.type === 'agentMessage') text += params.item.text || ''
        if (message.method === 'error' && !params.willRetry) errors.push(params.error?.message)
        if (message.method === 'server/exited') errors.push(params.message)
        if (message.method === 'turn/completed' || message.method === 'server/exited') {
          clearTimeout(timer)
          resolve(params.turn || { status: 'failed' })
        }
      },
      onRequest: () => ({ decision: 'decline' }),
    })
  })
  try {
    await rpc.request(server, 'turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Reply with exactly: ok', text_elements: [] }] }, 30000)
    const turn = await done
    if (turn.status !== 'completed') return { ok: false, error: errors.filter(Boolean).join('；') || turn.error?.message || `没有完成（${turn.status}）` }
    return { ok: true, reply: text.trim().slice(0, 80), model: thread.model || '(Codex 默认)', ms: Date.now() - started }
  } finally {
    server.threads.delete(thread.id)
  }
}

/* ------------------------------------------------- ChatGPT 账号登录（设备码） */

/** 起一个用 chatgpt 方式 CODEX_HOME 的 app-server，申请设备码；用户在任意浏览器打开链接输入代码即可。 */
export async function startLogin(ctx, config, state) {
  cancelLogin(state)
  const launch = await launchSpec(ctx, config, { mode: 'chatgpt' })
  const holder = {}
  const server = await rpc.ensureServer(holder, launch)
  const result = await rpc.request(server, 'account/login/start', { type: 'chatgptDeviceCode' }, 60000)
  if (result?.type !== 'chatgptDeviceCode') {
    rpc.shutdown(server, '登录方式不对')
    return { ok: false, error: '这个版本的 Codex 不支持设备码登录' }
  }
  const login = { id: result.loginId, server, url: result.verificationUrl, code: result.userCode, done: false, success: false, error: null, startedAt: Date.now() }
  login.off = rpc.listen(server, (message) => {
    if (message.method !== 'account/login/completed') return
    const params = message.params || {}
    if (params.loginId && params.loginId !== login.id) return
    login.done = true
    login.success = params.success === true
    login.error = params.error || null
    if (login.success) saveAuth(config, { ...savedAuth(config), mode: 'chatgpt', hubOverride: Boolean(hubAuth()) })
    setTimeout(() => rpc.shutdown(server, '登录结束'), 1000).unref?.()
  })
  const timer = setTimeout(() => cancelLogin(state, login), 15 * 60 * 1000)
  timer.unref?.()
  state.login = login
  return { ok: true, loginId: login.id, url: login.url, code: login.code }
}

export function loginStatus(state, loginId) {
  const login = state.login
  if (!login || login.id !== loginId) return { ok: false, error: '登录会话已失效，请重新开始' }
  return { ok: true, done: login.done, success: login.success, error: login.error }
}

export function cancelLogin(state, which) {
  const login = which || state.login
  if (!login) return
  if (!login.done) {
    rpc.request(login.server, 'account/login/cancel', { loginId: login.id }, 5000).catch(() => {})
    setTimeout(() => rpc.shutdown(login.server, '取消登录'), 500).unref?.()
  }
  login.off?.()
  if (state.login === login) state.login = null
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

export async function setupState(ctx, config, state, { check = true } = {}) {
  const auth = loadAuth(config)
  const hub = hubAuth()
  const hubRemote = hub ? lastHubConfig() : null
  const status = check ? await authStatus(ctx, config, state) : null
  return {
    ok: true,
    mode: auth.mode,
    // 环境里有 Hub 下发就一直返回它的信息（不论当前是不是在用），前端据此决定显不显示「Hub 下发」选项
    hubAvailable: Boolean(hub),
    hubOverride: Boolean(hub) && auth.mode !== 'hub',
    hub: hub
      ? {
          baseUrl: hub.baseUrl,
          wireApi: hub.wireApi,
          label: hubRemote?.label || hub.label,
          defaultModel: hubRemote?.defaultModel || hub.model || null,
          models: (hubRemote?.models || []).map((m) => m.id),
        }
      : null,
    baseUrl: auth.baseUrl || '',
    wireApi: auth.wireApi || 'responses',
    model: auth.model || '',
    apiKey: await describeRef(ctx, API_KEY_REF),
    chatgptSaved: existsSync(join(managedHome(config, 'chatgpt'), 'auth.json')),
    binary: (({ path, source }) => ({ path, source }))(resolveBinary(config)),
    // 本机既有配置（只读、非敏感）：设置页打开时直接显示，不用用户再点一下
    detected: detectMachineConfig(),
    status,
    ready: Boolean(status?.loggedIn),
  }
}

/**
 * POST /api/codex-pilot.setup 的动作：
 *   {action:'state'} | {action:'test'} | {action:'use-machine'} | {action:'use-chatgpt'} | {action:'use-hub'}
 *   {action:'save-api-key', apiKey?, baseUrl?, wireApi?, model?}   apiKey 省略 = 只改其它字段
 *   {action:'login-start'} | {action:'login-status', loginId} | {action:'login-cancel'}
 *   {action:'clear'}   清掉本插件存的凭据（API Key、插件自己的 ChatGPT 登录），回到本机方式（有 Hub 就是回到 Hub）
 *
 * 有 Hub 下发时默认用它；用户一旦保存自己的配置 / 登录成功 / 选本机，auth.json 里记 hubOverride: true，
 * 下发就不再生效（use-hub 写回 false）。写回一律以 auth.json 原文为底，别把 Hub 的值写进文件。
 */
export async function handleSetup(ctx, config, state, body) {
  const credentials = ctx.get('credentials')
  const hub = hubAuth()
  const overrideHub = () => ({ ...savedAuth(config), hubOverride: Boolean(hub) })
  switch (body?.action) {
    case undefined:
    case 'state':
      return setupState(ctx, config, state)
    case 'test': {
      const status = await authStatus(ctx, config, state)
      if (!status.loggedIn) return { ok: false, error: status.error || '还没有可用的凭据', status }
      try {
        return await testConnection(ctx, config, state)
      } catch (error) {
        return { ok: false, error: String(error?.message || error).slice(0, 600) }
      }
    }
    case 'use-machine':
      saveAuth(config, { ...overrideHub(), mode: 'machine' })
      return setupState(ctx, config, state)
    case 'use-chatgpt':
      if (!existsSync(join(managedHome(config, 'chatgpt'), 'auth.json'))) return { ok: false, error: '插件还没有登录过 ChatGPT 账号，请先点「开始登录」' }
      saveAuth(config, { ...overrideHub(), mode: 'chatgpt' })
      return setupState(ctx, config, state)
    case 'use-hub':
      if (!hub) return { ok: false, error: '没有 DSH Hub 下发的配置，不能切到 Hub 下发' }
      cancelLogin(state)
      saveAuth(config, { ...savedAuth(config), hubOverride: false })
      return setupState(ctx, config, state)
    case 'save-api-key': {
      const key = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
      const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim().replace(/\/+$/, '') : ''
      const model = typeof body.model === 'string' ? body.model.trim() : ''
      if (baseUrl && !/^https?:\/\/[^\s]+$/i.test(baseUrl)) return { ok: false, error: 'Base URL 要以 http:// 或 https:// 开头' }
      if (model && !/^[\w.:/-]{1,80}$/.test(model)) return { ok: false, error: '模型名只能包含字母、数字和 . _ - : /' }
      if (key) {
        if (!credentials?.set) return { ok: false, error: 'DSH 凭据库不可用' }
        await credentials.set(API_KEY_REF, key)
      } else if (!(await describeRef(ctx, API_KEY_REF)).configured) {
        return { ok: false, error: '请填写 API Key' }
      }
      saveAuth(config, { ...overrideHub(), mode: 'apiKey', baseUrl, wireApi: body.wireApi === 'chat' ? 'chat' : 'responses', model })
      return setupState(ctx, config, state)
    }
    case 'login-start':
      try {
        return await startLogin(ctx, config, state)
      } catch (error) {
        return { ok: false, error: String(error?.message || error).slice(0, 400) }
      }
    case 'login-status': {
      const result = loginStatus(state, body.loginId)
      if (result.ok && result.done && result.success) return { ...(await setupState(ctx, config, state)), done: true, success: true }
      return result
    }
    case 'login-cancel':
      cancelLogin(state)
      return { ok: true }
    case 'clear':
      cancelLogin(state)
      await credentials?.unset?.(API_KEY_REF)
      for (const mode of ['chatgpt', 'apiKey']) {
        try {
          rmSync(managedHome(config, mode), { recursive: true, force: true })
        } catch {
          /* 没有就算了 */
        }
      }
      saveAuth(config, { mode: 'machine', hubOverride: false })
      return setupState(ctx, config, state)
    default:
      return { ok: false, error: `未知动作 ${body?.action}` }
  }
}

/* ------------------------------------------------------- 套餐额度（ChatGPT 账号） */

const USAGE_TTL_MS = 60000

const windowName = (mins) => {
  if (!mins) return { short: '额度', long: '额度窗口' }
  if (mins === 300) return { short: '5h', long: '当前 5 小时窗口' }
  if (mins === 10080) return { short: '周', long: '本周' }
  if (mins % 1440 === 0) return { short: `${mins / 1440}天`, long: `${mins / 1440} 天窗口` }
  if (mins % 60 === 0) return { short: `${mins / 60}h`, long: `${mins / 60} 小时窗口` }
  return { short: `${mins}m`, long: `${mins} 分钟窗口` }
}

/** RateLimitSnapshot（primary / secondary 两个窗口）→ 扁平的 limits 列表；主桶（codex）排前面。 */
export function toLimits(result) {
  const buckets = result?.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length ? result.rateLimitsByLimitId : { codex: result?.rateLimits || {} }
  const entries = Object.entries(buckets).sort(([a], [b]) => (a === 'codex' ? -1 : b === 'codex' ? 1 : a.localeCompare(b)))
  const limits = []
  for (const [bucketId, snapshot] of entries) {
    if (!snapshot) continue
    const main = bucketId === 'codex' || entries.length === 1
    const bucketName = main ? '' : snapshot.limitName || bucketId
    for (const slot of ['primary', 'secondary']) {
      const win = snapshot[slot]
      if (!win || typeof win.usedPercent !== 'number') continue
      const name = windowName(Number(win.windowDurationMins) || 0)
      limits.push({
        id: `${bucketId}:${slot}`,
        main,
        short: bucketName ? `${bucketName} ${name.short}` : name.short,
        long: bucketName ? `${bucketName} · ${name.long}` : name.long,
        percent: Math.max(0, Math.min(100, Math.round(win.usedPercent))),
        resetsAt: win.resetsAt ? Number(win.resetsAt) * 1000 : null,
        windowMins: Number(win.windowDurationMins) || null,
        // rateLimitReachedType 是整个桶的；只把真用满的那个窗口标红
        reached: Boolean(snapshot.rateLimitReachedType) && win.usedPercent >= 100,
      })
    }
  }
  return limits
}

/**
 * 用量面板的「套餐额度」部分。只有用 ChatGPT 账号登录时才有额度窗口；
 * API Key / 中转站 / 其它提供者返回 { kind: 'apiKey' | 'provider' }，界面只显示本会话用量。
 * 缓存 60 秒，同时只发一个请求；读失败时回上一次的数据并标记 stale。
 */
export async function planUsage(ctx, config, state, { force = false } = {}) {
  if (state.usageMock) return { ...state.usageMock, fetchedAt: state.usageMock.fetchedAt || Date.now() }
  const cached = state.planUsage
  let launch
  try {
    launch = await launchSpec(ctx, config)
  } catch (error) {
    return { kind: 'none', error: error.message, fetchedAt: Date.now() }
  }
  const key = `${launch.mode}|${launch.secretDigest}`
  if (!force && cached?.key === key && Date.now() - cached.at < USAGE_TTL_MS) return cached.data
  if (state.planUsageLoading) return state.planUsageLoading
  state.planUsageLoading = (async () => {
    try {
      const server = await rpc.ensureServer(state, launch)
      const info = await rpc.request(server, 'account/read', { refreshToken: false }, 20000)
      const account = info?.account || null
      let data
      if (account?.type === 'chatgpt') {
        const result = await rpc.request(server, 'account/rateLimits/read', { excludeResetCreditDetails: true }, 20000)
        const credits = result?.rateLimits?.credits || null
        data = {
          kind: 'plan',
          plan: account.planType || result?.rateLimits?.planType || null,
          limits: toLimits(result),
          credits: credits && (credits.hasCredits || credits.unlimited) ? { balance: credits.balance ?? null, unlimited: Boolean(credits.unlimited) } : null,
          blocked: result?.ordinaryUsageAllowed === false || Boolean(result?.rateLimits?.rateLimitReachedType),
          fetchedAt: Date.now(),
        }
      } else if (account?.type === 'apiKey') {
        data = { kind: 'apiKey', fetchedAt: Date.now() }
      } else {
        data = { kind: account || info?.requiresOpenaiAuth === false ? 'provider' : 'none', fetchedAt: Date.now() }
      }
      state.planUsage = { key, at: Date.now(), data }
      return data
    } catch (error) {
      const reason = String(error?.message || error).slice(0, 200)
      if (cached?.key === key && cached.data?.kind === 'plan') return { ...cached.data, stale: true, error: reason }
      return { kind: 'none', error: reason, fetchedAt: Date.now() }
    } finally {
      state.planUsageLoading = null
    }
  })()
  return state.planUsageLoading
}
