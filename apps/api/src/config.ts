import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

/**
 * 应用版本号：`GET /api/health` 与 `cli version` 用它。
 * 与 package.json 的 version 手工保持一致（构建期读取 package.json 会破坏 rootDir 约束）。
 */
export const HUB_VERSION = '0.1.0'

/** 开发默认数据目录：`<repo>/.data`（01 §6）。src/ 与 dist/ 到仓库根都是三层 */
export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../../.data', import.meta.url))

/**
 * 手机网页版的默认产物目录：**单仓构建产物** `packages/mobile-ui/dist-web`。
 *
 * 这和 `apps/web/dist`（管理台）是同一套思路：仓库根跑一次 `pnpm build` 就同时产出管理台与
 * 手机网页版，Hub 默认直接从产物目录托管 `/m/`，不需要任何额外发布步骤。
 *
 * 生产部署如果想把「构建」和「上线」分开（构建机出产物、发布脚本原子切换版本），
 * 就把 `HUB_MOBILE_WEB_DIR` 指到自己的发布目录（例如 `<数据目录>/mobile-web/current` 这种
 * 会被原子切换的符号链接，Hub 每次请求都会重新 realpath）。
 */
export const DEFAULT_MOBILE_WEB_DIST_DIR = fileURLToPath(
  new URL('../../../packages/mobile-ui/dist-web', import.meta.url),
)

export function defaultMobileWebDir(): string {
  return DEFAULT_MOBILE_WEB_DIST_DIR
}

const portSchema = z.coerce.number().int().min(0).max(65_535)

/** `true/false/1/0` → boolean（环境变量都是字符串） */
const booleanFromEnv = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no', ''])])
    .default(defaultValue)
    .transform((v) => {
      if (typeof v === 'boolean') return v
      if (v === '') return defaultValue
      return v === 'true' || v === '1' || v === 'yes'
    })

const originSchema = z
  .string()
  .default('http://127.0.0.1:7700')
  .transform((v) => v.replace(/\/+$/, ''))
  .refine((v) => {
    try {
      const url = new URL(v)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }, 'HUB_PUBLIC_ORIGIN 必须是 http(s) 开头的 URL')

/**
 * 可选的 http(s) 基址（WP52）：空 = 未配置；非空必须是合法 URL，末尾斜杠去掉便于直接拼路径。
 * 用来解析 `HUB_EDGE_ORIGIN` / `HUB_EDGE_ASSETS_ORIGIN`，错误信息带变量名。
 */
const optionalBaseUrlSchema = (name: string) =>
  z
    .string()
    .default('')
    .transform((v) => v.trim().replace(/\/+$/u, ''))
    .refine((v) => {
      if (v === '') return true
      try {
        const url = new URL(v)
        return url.protocol === 'http:' || url.protocol === 'https:'
      } catch {
        return false
      }
    }, `${name} 必须是 http(s) 开头的 URL`)

/** 本机语音识别服务地址（WP49）；与 `HUB_PUBLIC_ORIGIN` 一样去掉末尾斜杠 */
const asrUrlSchema = z
  .string()
  .default('http://127.0.0.1:9890')
  .transform((v) => v.replace(/\/+$/, ''))
  .refine((v) => {
    try {
      const url = new URL(v)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }, 'HUB_ASR_URL 必须是 http(s) 开头的 URL')

/**
 * 本机语音合成服务地址（WP50 朗读，星汐 seki `seki-voice`）；与 `HUB_PUBLIC_ORIGIN` 一样去掉末尾斜杠
 */
const ttsUrlSchema = z
  .string()
  .default('http://127.0.0.1:9880')
  .transform((v) => v.replace(/\/+$/, ''))
  .refine((v) => {
    try {
      const url = new URL(v)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }, 'HUB_TTS_URL 必须是 http(s) 开头的 URL')

export const configSchema = z.object({
  HUB_DATA_DIR: z.string().min(1).default(DEFAULT_DATA_DIR),
  HUB_HTTP_PORT: portSchema.default(7700),
  /**
   * 明文监听器绑定的地址（默认回环，生产不变）。
   *
   * 为什么需要这个开关：手机联调想让局域网里的真机直连集成 Hub，而 Fastify 的明文监听器
   * 过去硬编码 `127.0.0.1`，同一端口没法既绑回环又绑 `0.0.0.0`（EADDRINUSE）。
   * 只接受两个值，其它地址（如容器 IP）一律拒绝启动——不给出「绑到某个具体网卡」的口子。
   */
  HUB_HTTP_HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  /** 阶段一为 0（关闭 TLS 网关），阶段二 7443（01 §6） */
  HUB_TLS_PORT: portSchema.default(0),
  /** 阶段一为 0（关闭 HTTP→HTTPS 跳转），阶段二 7080 */
  HUB_REDIRECT_PORT: portSchema.default(0),
  /**
   * 七层边缘入口（WP52）：由前置的反向代理（nginx 等）终结 TLS 后明文转发到本端口，
   * 真实 IP 由代理写进 `X-Real-IP`。**只绑 127.0.0.1**；0 = 关闭（默认）。
   */
  HUB_EDGE_PORT: portSchema.default(0),
  /** 边缘入口对外 origin（`HUB_EDGE_PORT≠0` 时必填，且必须是 https；例如 `https://edge.example.com`） */
  HUB_EDGE_ORIGIN: optionalBaseUrlSchema('HUB_EDGE_ORIGIN'),
  /** 边缘入口的下载资产基址；空 = 相对站根（由 Hub 自己提供，例如 `https://edge.example.com/downloads`） */
  HUB_EDGE_ASSETS_ORIGIN: optionalBaseUrlSchema('HUB_EDGE_ASSETS_ORIGIN'),
  HUB_PROXY_PROTOCOL: booleanFromEnv(true),
  HUB_PUBLIC_ORIGIN: originSchema,
  /**
   * 公开下载资产的独立基址（可选）。设置后主页上的桌面安装包 / 免安装 zip / 安卓 APK
   * 下载链接改指这里（例如用前台的反向代理静态托管 `https://hub.example.com/downloads`），
   * 不由 Hub 自己提供。为空 = 相对站根、由 Hub 自己提供。
   */
  HUB_PUBLIC_ASSETS_ORIGIN: z
    .string()
    .default('')
    .transform((v) => v.trim().replace(/\/+$/u, '')),
  HUB_COOKIE_SECURE: booleanFromEnv(false),
  /** HSTS 的 max-age（秒）；0 = 不发。只对经 7443 的公网响应生效（01 §6、02 §5） */
  HUB_HSTS_MAX_AGE: z.coerce.number().int().min(0).default(86_400),
  DOCKER_HOST: z.string().min(1).default('unix:///var/run/docker.sock'),
  HUB_CONTAINER_DRIVER: z.enum(['docker', 'fake']).default('docker'),
  /**
   * 容器名前缀（默认 `dshhub-`，容器名 = 前缀 + slug）。
   * 开发/测试与生产共用同一个 Docker 守护进程，靠前缀 + `HUB_ENV_ID` 双重隔离（11 §2）。
   */
  HUB_CONTAINER_PREFIX: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]*$/u, 'HUB_CONTAINER_PREFIX 只能用小写字母/数字/._-，且以字母数字开头')
    .default('dshhub-'),
  /** 环境标识：写进每个容器的 `dshhub.env` 标签；对账/回收/stop-all 只处理本环境 */
  HUB_ENV_ID: z
    .string()
    .max(32)
    .regex(/^[a-z0-9][a-z0-9._-]*$/u, 'HUB_ENV_ID 只能用小写字母/数字/._-，且以字母数字开头')
    .default('prod'),
  HUB_USERS_NETWORK: z.string().min(1).default('dshhub-users'),
  HUB_USERS_SUBNET: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/, 'HUB_USERS_SUBNET 必须是 CIDR，如 10.213.0.0/20')
    .default('10.213.0.0/20'),
  HUB_NPM_REGISTRY: z.string().min(1).default('https://registry.npmmirror.com'),
  /**
   * 中转站内部监听器（12 §3）：宿主的用户网桥网关 IP + 一个端口，供用户容器访问 `/v1/*`。
   * `HUB_RELAY_INTERNAL_HOST` 空 = 启动时向 Docker 查 `HUB_USERS_NETWORK` 的网关；`PORT=0` = 不开。
   */
  HUB_RELAY_INTERNAL_HOST: z.string().default(''),
  HUB_RELAY_INTERNAL_PORT: portSchema.default(7710),
  /**
   * 手机 App 的来源白名单（CORS 预检与 `/api/mobile/*` 的 Origin 放行，逗号分隔）。
   * 默认 `https://localhost`（Capacitor Android 的 `androidScheme=https`）与
   * `capacitor://localhost`（iOS 默认 scheme）；开发模式另外放行 `http://localhost`。
   * 只影响 `/api/mobile/*`，不改变网页端与 `/api/desktop/*` 的 Origin 规则。
   */
  HUB_MOBILE_ORIGINS: z.string().default('https://localhost,capacitor://localhost'),
  /**
   * 手机网页版产物目录（WP54 / 契约 C5）：`/m/` 下托管的 App 网页构建。
   * 空 = 默认单仓构建产物 `packages/mobile-ui/dist-web`（`pnpm build` 就会产出）。
   * 生产部署可以指到自己的发布目录（例如 `<数据目录>/mobile-web/current` 这种会被原子切换的
   * 符号链接）：Hub 每次请求都会重新 realpath，发网页版不需要重启 Hub。
   */
  HUB_MOBILE_WEB_DIR: z.string().default(''),
  /**
   * 服务端语音识别（WP49）：Hub 把 `POST /api/mobile/asr` 的 WAV 转发到本机 `dsh-asr`
   * （SenseVoice，默认 127.0.0.1:9890）。`HUB_ASR_ENABLED=false` 时 bootstrap.voice.asr=false、
   * 端点回 502；限流与超时按下面的默认值，测试/调优可用环境变量改。
   */
  HUB_ASR_URL: asrUrlSchema,
  HUB_ASR_ENABLED: booleanFromEnv(true),
  /** 转发超时（毫秒）：dsh-asr 自己单次上限 20 秒，Hub 留 5 秒余量 */
  HUB_ASR_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(25_000),
  /** 每用户限流：每分钟 / 每天（契约 429 `RATE_LIMITED`） */
  HUB_ASR_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  HUB_ASR_PER_DAY: z.coerce.number().int().min(1).default(600),
  /**
   * 朗读（WP50）：Hub 把 `POST /api/mobile/tts` 的文字转发到本机星汐语音服务 `seki-voice`
   * （breeze 后端，默认 127.0.0.1:9880）。`HUB_TTS_ENABLED=false` 时 bootstrap.voice.tts.enabled=false、
   * 端点回 502；限流、缓存上限与超时按下面的默认值，调优可用环境变量改。
   * **队列长度与单用户在途数是常量**（GPU 只有一把锁）：全局 1 在途 + 6 排队、单用户 2。
   */
  HUB_TTS_URL: ttsUrlSchema,
  HUB_TTS_ENABLED: booleanFromEnv(true),
  /**
   * 流式朗读（WP51）：`POST /api/mobile/tts/stream`，转发上游 `/tts/stream` 边合成边下发。
   * 关掉后 `bootstrap.voice.tts.stream=false`、流式端点回 502；整段 `/tts` 不受影响。
   */
  HUB_TTS_STREAM_ENABLED: booleanFromEnv(true),
  /**
   * 流式朗读的**整段**超时（毫秒）：200 字 ≈ 36 秒音频，边合成边下发与音频时长同量级，
   * 整段留余量到 60 秒。超时 = 上游失败：断开客户端连接、不发结束块、不写缓存。
   */
  HUB_TTS_STREAM_TIMEOUT_MS: z.coerce.number().int().min(100).max(180_000).default(60_000),
  /** 流式朗读**两块之间**的空闲超时（毫秒）：这么久没有新音频就认为上游卡住/断链 */
  HUB_TTS_STREAM_IDLE_TIMEOUT_MS: z.coerce.number().int().min(50).max(60_000).default(10_000),
  /** 转发超时（毫秒）：一句 200 字 ≈ 36 秒音频，合成与音频时长同量级，留余量到 45 秒 */
  HUB_TTS_TIMEOUT_MS: z.coerce.number().int().min(100).max(180_000).default(45_000),
  /** 每用户限流：每分钟 / 每天（契约 429 `RATE_LIMITED`） */
  HUB_TTS_PER_MINUTE: z.coerce.number().int().min(1).default(30),
  HUB_TTS_PER_DAY: z.coerce.number().int().min(1).default(3000),
  /** 内存 LRU 的音频总量上限（字节，默认 64MB；0 = 关掉缓存） */
  HUB_TTS_CACHE_BYTES: z.coerce
    .number()
    .int()
    .min(0)
    .default(64 * 1024 * 1024),
  HUB_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
})

export type HubConfig = {
  dataDir: string
  httpPort: number
  /** 明文监听器绑定的地址（`127.0.0.1` 默认；`0.0.0.0` 只给局域网联调） */
  httpHost: '127.0.0.1' | '0.0.0.0'
  tlsPort: number
  redirectPort: number
  /**
   * 七层边缘入口端口（WP52）：0 = 关闭；非 0 时在 127.0.0.1 上开一个明文监听器，
   * 只认 nginx 写的 `X-Real-IP`（08 §3）。
   */
  edgePort: number
  /** 边缘入口对外 origin（`edgePort=0` 时可为 null；非 0 时由 loadConfig 保证非 null 且是 https） */
  edgeOrigin: string | null
  /** 边缘入口的下载资产基址；null = 相对边缘入口站根 */
  edgeAssetsOrigin: string | null
  proxyProtocol: boolean
  publicOrigin: string
  /** 公开下载资产的独立基址；null = 沿用旧行为（Hub 自己提供 /desktop/bin） */
  publicAssetsOrigin: string | null
  /**
   * `HUB_COOKIE_SECURE` 的解析结果：显式设置时是那个值，未设置时按 `HUB_PUBLIC_ORIGIN` 的协议推断。
   * **只在 `cookieSecureExplicit` 为真时才直接使用**；否则按「请求从哪个监听器进来」决定（02 §5）。
   */
  cookieSecure: boolean
  /** `HUB_COOKIE_SECURE` 是否被显式设置（显式设置时对两个监听器一律以它为准） */
  cookieSecureExplicit: boolean
  /** HSTS max-age（秒）；0 = 不发。只对公网（7443）响应生效 */
  hstsMaxAge: number
  dockerHost: string
  containerDriver: 'docker' | 'fake'
  /** 容器名前缀（`dshhub-` / 测试用 `dshhub-test-wp2-`） */
  containerPrefix: string
  /** 本环境标识（容器标签 `dshhub.env`） */
  envId: string
  usersNetwork: string
  usersSubnet: string
  npmRegistry: string
  /** 中转站内部监听地址覆盖；null = 用用户网络的网关 IP（12 §3） */
  relayInternalHost: string | null
  /** 中转站内部监听端口；0 = 关闭 */
  relayInternalPort: number
  /** 手机 App 的 CORS / Origin 白名单（已去重、已去掉末尾斜杠；开发模式自动含 `http://localhost`） */
  mobileAppOrigins: string[]
  /**
   * 手机网页版产物目录（WP54 / 契约 C5）：Hub 在 `/m/` 下托管它。默认
   * `packages/mobile-ui/dist-web`（单仓构建产物）；显式配置时可以是会被原子切换的符号链接。
   */
  mobileWebDir: string
  /** 本机语音识别服务地址（WP49）：`POST /api/mobile/asr` 转发目标，默认 `http://127.0.0.1:9890` */
  asrUrl: string
  asrEnabled: boolean
  /** 转发超时（毫秒，默认 25000） */
  asrTimeoutMs: number
  /** 每用户每分钟识别次数（默认 20） */
  asrPerMinute: number
  /** 每用户每天识别次数（默认 600） */
  asrPerDay: number
  /** 本机语音合成服务地址（WP50 朗读）：`POST /api/mobile/tts` 转发目标，默认 `http://127.0.0.1:9880` */
  ttsUrl: string
  ttsEnabled: boolean
  /** 流式朗读是否可用（WP51；`bootstrap.voice.tts.stream`） */
  ttsStreamEnabled: boolean
  /** 流式朗读整段超时（毫秒，默认 60000） */
  ttsStreamTimeoutMs: number
  /** 流式朗读两块之间的空闲超时（毫秒，默认 10000） */
  ttsStreamIdleTimeoutMs: number
  /** 转发超时（毫秒，默认 45000） */
  ttsTimeoutMs: number
  /** 每用户每分钟朗读段数（默认 30） */
  ttsPerMinute: number
  /** 每用户每天朗读段数（默认 3000） */
  ttsPerDay: number
  /** 内存音频 LRU 上限（字节，默认 64MB；0 = 关闭） */
  ttsCacheBytes: number
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'
  /** 是否生产模式（影响日志美化与 cookie Secure 兜底） */
  isProduction: boolean
}

/**
 * 环境变量 → 强类型配置（01 §6）。`HUB_COOKIE_SECURE` 未显式设置时按 `HUB_PUBLIC_ORIGIN` 的协议推断，
 * 但真正的 Secure 判定在 `setSessionCookie` 里按「请求来自 7443 还是 7700」做（02 §5）：
 * 阶段二切到 https 配置后，本机 7700 的登录不能被 Secure 打死。
 * 非法值直接抛错，避免带着坏配置启动。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const parsed = configSchema.parse(env)
  const originProtocol = new URL(parsed.HUB_PUBLIC_ORIGIN).protocol
  const cookieSecureExplicit = env.HUB_COOKIE_SECURE !== undefined && env.HUB_COOKIE_SECURE !== ''
  const cookieSecure = cookieSecureExplicit ? parsed.HUB_COOKIE_SECURE : originProtocol === 'https:'
  const edgeOrigin = parsed.HUB_EDGE_ORIGIN === '' ? null : parsed.HUB_EDGE_ORIGIN
  assertEdgeConfig({
    port: parsed.HUB_EDGE_PORT,
    origin: edgeOrigin,
    assetsOrigin: parsed.HUB_EDGE_ASSETS_ORIGIN === '' ? null : parsed.HUB_EDGE_ASSETS_ORIGIN,
  })
  return {
    dataDir: parsed.HUB_DATA_DIR,
    httpPort: parsed.HUB_HTTP_PORT,
    httpHost: parsed.HUB_HTTP_HOST,
    tlsPort: parsed.HUB_TLS_PORT,
    redirectPort: parsed.HUB_REDIRECT_PORT,
    edgePort: parsed.HUB_EDGE_PORT,
    edgeOrigin,
    edgeAssetsOrigin: parsed.HUB_EDGE_ASSETS_ORIGIN === '' ? null : parsed.HUB_EDGE_ASSETS_ORIGIN,
    proxyProtocol: parsed.HUB_PROXY_PROTOCOL,
    publicOrigin: parsed.HUB_PUBLIC_ORIGIN,
    publicAssetsOrigin:
      parsed.HUB_PUBLIC_ASSETS_ORIGIN === '' ? null : parsed.HUB_PUBLIC_ASSETS_ORIGIN,
    cookieSecure,
    cookieSecureExplicit,
    hstsMaxAge: parsed.HUB_HSTS_MAX_AGE,
    dockerHost: parsed.DOCKER_HOST,
    containerDriver: parsed.HUB_CONTAINER_DRIVER,
    containerPrefix: parsed.HUB_CONTAINER_PREFIX,
    envId: parsed.HUB_ENV_ID,
    usersNetwork: parsed.HUB_USERS_NETWORK,
    usersSubnet: parsed.HUB_USERS_SUBNET,
    npmRegistry: parsed.HUB_NPM_REGISTRY,
    relayInternalHost:
      parsed.HUB_RELAY_INTERNAL_HOST.trim() === '' ? null : parsed.HUB_RELAY_INTERNAL_HOST.trim(),
    relayInternalPort: parsed.HUB_RELAY_INTERNAL_PORT,
    mobileAppOrigins: mobileAppOriginsOf(parsed.HUB_MOBILE_ORIGINS, env.NODE_ENV === 'production'),
    mobileWebDir:
      parsed.HUB_MOBILE_WEB_DIR.trim() === ''
        ? defaultMobileWebDir()
        : resolve(parsed.HUB_MOBILE_WEB_DIR.trim()),
    asrUrl: parsed.HUB_ASR_URL,
    asrEnabled: parsed.HUB_ASR_ENABLED,
    asrTimeoutMs: parsed.HUB_ASR_TIMEOUT_MS,
    asrPerMinute: parsed.HUB_ASR_PER_MINUTE,
    asrPerDay: parsed.HUB_ASR_PER_DAY,
    ttsUrl: parsed.HUB_TTS_URL,
    ttsEnabled: parsed.HUB_TTS_ENABLED,
    ttsStreamEnabled: parsed.HUB_TTS_STREAM_ENABLED,
    ttsStreamTimeoutMs: parsed.HUB_TTS_STREAM_TIMEOUT_MS,
    ttsStreamIdleTimeoutMs: parsed.HUB_TTS_STREAM_IDLE_TIMEOUT_MS,
    ttsTimeoutMs: parsed.HUB_TTS_TIMEOUT_MS,
    ttsPerMinute: parsed.HUB_TTS_PER_MINUTE,
    ttsPerDay: parsed.HUB_TTS_PER_DAY,
    ttsCacheBytes: parsed.HUB_TTS_CACHE_BYTES,
    logLevel: parsed.HUB_LOG_LEVEL,
    isProduction: env.NODE_ENV === 'production',
  }
}

/**
 * 边缘入口配置的自洽校验（WP52 / 08 §3）：
 *
 * - `HUB_EDGE_PORT≠0` 时必须配 `HUB_EDGE_ORIGIN`（否则 CSRF 没有可信任的 Origin，等于把自己锁死）；
 * - 只要配了 `HUB_EDGE_ORIGIN` 就必须是 https —— 前置代理终结 TLS，边缘入口对外只有 https，
 *   而 Hub 会据此给会话 cookie 加 `Secure`、发 HSTS。
 *
 * 校验放在 loadConfig 里而不是 zod：它跨字段，且错误信息要说清「哪个变量缺了/错了」。
 */
function assertEdgeConfig(input: { port: number; origin: string | null; assetsOrigin: string | null }): void {
  if (input.origin !== null && new URL(input.origin).protocol !== 'https:') {
    throw new Error(`HUB_EDGE_ORIGIN 必须是 https 地址（当前 ${input.origin}）：边缘入口对外只提供 https`)
  }
  if (input.port === 0) return
  if (input.origin === null) {
    throw new Error('HUB_EDGE_PORT 非 0 时必须设置 HUB_EDGE_ORIGIN（例如 https://edge.example.com）')
  }
  if (input.assetsOrigin !== null && new URL(input.assetsOrigin).protocol !== 'https:') {
    throw new Error(`HUB_EDGE_ASSETS_ORIGIN 必须是 https 地址（当前 ${input.assetsOrigin}）`)
  }
}

/**
 * 手机 App 的来源白名单（v2 §4.1）。
 *
 * 默认两个（Capacitor Android 的 `https://localhost` + iOS 的 `capacitor://localhost`）；
 * **开发模式**另外放行 `http://localhost`（`契约草案` 里点名的那条：只给 dev 用），
 * 生产环境即使有人在环境变量里写了它也会被剔除 —— 少一个可被网页利用的 Origin。
 * 末尾斜杠在这里统一去掉，比较时才能字符串相等。
 */
export function mobileAppOriginsOf(raw: string, production: boolean): string[] {
  const allowed = new Set<string>()
  for (const item of raw.split(',')) {
    const origin = item.trim().replace(/\/+$/, '')
    if (origin.length === 0) continue
    if (production && origin === 'http://localhost') continue
    allowed.add(origin)
  }
  if (!production) allowed.add('http://localhost')
  return [...allowed]
}

/** 把配置里的 `DOCKER_HOST` 转成 dockerode 需要的选项（WP2 使用） */
export function dockerHostOptions(dockerHost: string): Record<string, string> {
  if (dockerHost.startsWith('unix://')) return { socketPath: dockerHost.slice('unix://'.length) }
  if (dockerHost.startsWith('tcp://') || dockerHost.startsWith('http://')) {
    const url = new URL(dockerHost.replace(/^tcp:\/\//, 'http://'))
    return { host: url.hostname, port: url.port || '2375' }
  }
  return { socketPath: dockerHost }
}
