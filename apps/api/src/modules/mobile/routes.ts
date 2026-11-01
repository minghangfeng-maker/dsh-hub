import { z } from 'zod'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import {
  MOBILE_ASR_MAX_BYTES,
  MOBILE_COCKPIT_EXCHANGE_PATH,
  CockpitHandoffExchangeRequestSchema,
  MobileLoginRequestSchema,
  MobileRefreshRequestSchema,
  MobileTtsRequestSchema,
  type MobileAsrResponse,
  type MobileBootstrapResponse,
  type MobileLoginResponse,
  type MobileNodesResponse,
  type MobileRefreshResponse,
  type MobileTicketResponse,
  type MobileWakeResponse,
} from '@dsh-hub/shared'
import { HubError } from '../../lib/errors.js'
import { requestMeta, requireUser } from '../../app.js'
import type { AppDeps } from '../../context.js'
import { requestOrigin } from '../../server/public-request.js'
import { ASR_DEFAULT_LANGUAGE, ASR_LANGUAGES, type AsrLanguage } from './asr.js'
import {
  MOBILE_TTS_STREAM_ROUTE,
  TTS_CACHE_CONTROL,
  TTS_CONTENT_TYPE,
  TTS_STREAM_CACHE_CONTROL,
  TTS_STREAM_FORMAT,
  ttsStreamContentType,
} from './tts.js'

/**
 * 跨域下 App 需要读到的响应头（WP50 整段朗读 + WP51 流式朗读；见插件里的 onSend 钩子）。
 * 流式响应多两个：`x-tts-format`（pcm16le）与 `x-tts-cached`（1|0）。
 */
export const CORS_EXPOSED_HEADERS = 'x-tts-sample-rate, x-tts-voice, x-tts-format, x-tts-cached'

/**
 * 手机 App 的 HTTP 入口（M1 + WP40a）。
 *
 * 鉴权三条路径，互不干扰：
 * 1. `Authorization: Bearer dshm_at_…`（v2 App，设备令牌）——由 `app.ts` 的会话钩子解析，
 *    只对 `/api/mobile/*` 生效；
 * 2. `hub_sid` cookie（0.2.0 老 APK）——行为与 M1 完全一致；
 * 3. 免登录：`/auth/login`、`/auth/refresh`。
 *
 * CORS：App 是 `https://localhost` / `capacitor://localhost` 的跨域 WebView，
 * 所以本前缀单独放行配置里的来源并允许 `Authorization` 头；**不影响**网页端与 `/api/desktop/*`。
 * WS 通道与桌面中继在 `createMobileService().attachUpgrade()` 里挂到 `server.on('upgrade')`
 * （upgrade 不经过 Fastify 的 preHandler）。
 */
export function mobilePlugin(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    const appOrigins = new Set(deps.config.mobileAppOrigins)

    // WP49：`POST /api/mobile/asr` 的 body 是 WAV 字节，不是 JSON。解析器限定在本插件作用域，
    // 不影响其它路由；大小在路由上再按 `MOBILE_ASR_MAX_BYTES` 卡一次（Fastify 超限回 413）。
    // 只注册 `audio/wav`：别的 Content-Type 由 Fastify 直接回 415（契约 `UNSUPPORTED_MEDIA`）。
    app.addContentTypeParser('audio/wav', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body)
    })

    /** 请求来源是不是配置里的 App 来源（去掉末尾斜杠后比较） */
    function isAppOrigin(origin: string | undefined): boolean {
      if (origin === undefined || origin.length === 0) return false
      return appOrigins.has(origin.replace(/\/+$/u, ''))
    }

    /**
     * 实际响应（含错误响应）带 CORS 头：WebView 才能在跨域下读到 body。
     *
     * `access-control-expose-headers`（WP50）：朗读响应是 `audio/wav`，采样率与音色只在响应头里
     * （`x-tts-sample-rate` / `x-tts-voice`）。跨域下**不加这个头，App 的 JS 读不到**，只能猜 24k。
     */
    app.addHook('onSend', async (req, reply, payload) => {
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
      if (isAppOrigin(origin)) {
        reply.header('access-control-allow-origin', origin!)
        reply.header('vary', 'Origin')
        reply.header('access-control-expose-headers', CORS_EXPOSED_HEADERS)
      }
      return payload
    })

    // 预检：只认配置里的来源；允许 Authorization（设备令牌）与 JSON 请求体
    app.options('/*', async (req, reply) => {
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
      if (!isAppOrigin(origin)) {
        return reply.code(403).send({ error: { code: 'FORBIDDEN', message: '请求来源不被信任' } })
      }
      const requested = req.headers['access-control-request-headers']
      return reply
        .header('access-control-allow-origin', origin!)
        .header('vary', 'Origin')
        .header('access-control-allow-methods', 'GET,POST,OPTIONS')
        .header(
          'access-control-allow-headers',
          typeof requested === 'string' && requested.length > 0 ? requested : 'authorization,content-type',
        )
        .header('access-control-max-age', '600')
        .code(204)
        .send()
    })

    // ── 设备令牌（WP40a） ──────────────────────────────────────────────────

    app.post('/auth/login', async (req): Promise<MobileLoginResponse> => {
      const input = MobileLoginRequestSchema.parse(req.body ?? {})
      try {
        return deps.services.mobileAuth.login(input, requestMeta(req))
      } catch (error) {
        throw mapLoginError(error)
      }
    })

    /**
     * 座舱 iframe 换令牌（WP56b / docs/24 §3.3）：**免登录** —— 一次性交接码本身就是凭据
     * （父页面 `POST /api/admin/cockpit/handoff` 签发，60 秒、绑定当前管理员）。
     *
     * 返回值与网页版登录同形，额外 `scope: 'cockpit'`；令牌不占手机设备名额、
     * 12 小时绝对过期，管理员登出/降级/删除即作废。
     */
    app.post(MOBILE_COCKPIT_EXCHANGE_PATH.replace('/api/mobile', ''), async (req): Promise<MobileLoginResponse> => {
      const input = CockpitHandoffExchangeRequestSchema.parse(req.body ?? {})
      return deps.services.cockpitAuth.exchange(input.code, requestMeta(req))
    })

    /**
     * 座舱令牌只做「看会话 + 说话 + 朗读」，其余手机接口一律 403（docs/24 §3.3）。
     * 允许的接口：`/nodes`、`/nodes/:id/ticket`、`/bootstrap`、`/auth/{refresh,cockpit-exchange,logout}`、
     * `/asr`、`/tts{,/stream}`（语音是嵌入模式保留的能力）。
     */
    function rejectCockpitScope(req: FastifyRequest): void {
      if (req.mobile?.scope === 'cockpit') {
        throw new HubError('FORBIDDEN', '座舱令牌不能调用这个接口')
      }
    }

    app.post('/auth/refresh', async (req): Promise<MobileRefreshResponse> => {
      const input = MobileRefreshRequestSchema.parse(req.body ?? {})
      return deps.services.mobileAuth.refresh(input, requestMeta(req))
    })

    /**
     * 合并本机历史重复设备（0.2.9）：App 升级后启动/登录时调一次。
     * 只吊销同名同平台的其它手机设备，不碰桌面端；返回吊销条数。
     */
    app.post('/auth/consolidate', { preHandler: requireUser }, async (req): Promise<{ removed: number }> => {
      rejectCockpitScope(req)
      const device = req.mobile
      if (device === null) {
        throw new HubError('DEVICE_TOKEN_INVALID', '请用设备令牌调用设备合并')
      }
      return {
        removed: deps.services.mobileAuth.consolidate(
          { user: req.user!, deviceId: device.deviceId, tokenId: device.tokenId, scope: device.scope ?? 'mobile' },
          requestMeta(req),
        ),
      }
    })

    app.post('/auth/logout', { preHandler: requireUser }, async (req, reply): Promise<FastifyReply> => {
      const device = req.mobile
      if (device === null) {
        // 老 APK 用 cookie，不走这个端点；没有设备身份时明确拒绝，别假装成功
        throw new HubError('DEVICE_TOKEN_INVALID', '请用设备令牌调用退出登录')
      }
      deps.services.mobileAuth.logout(
        { user: req.user!, deviceId: device.deviceId, tokenId: device.tokenId, scope: device.scope ?? 'mobile' },
        requestMeta(req),
      )
      return reply.code(204).send()
    })

    // ── 首屏与唤醒（v2 §4.2） ──────────────────────────────────────────────

    app.get('/bootstrap', { preHandler: requireUser }, async (req): Promise<MobileBootstrapResponse> => {
      // WP52：按请求入口取下载地址（公网入口 / 边缘入口）
      // WP54a：带上设备身份 —— 手机网页版（platform='web'）不下发 APK 更新与强更地板
      return deps.services.mobile.bootstrap(req.user!, requestOrigin(req, deps.config), req.mobile)
    })

    // ── 服务端语音识别（WP49） ────────────────────────────────────────────

    /**
     * 按住说话的识别入口：`audio/wav`（16k/单声道/16bit）→ 本机 dsh-asr → `{text,durationMs}`。
     *
     * 顺序有意如此：先按契约查 Content-Type 与原始大小（不依赖上游），再交给 service 做
     * 每用户限流与转发；音频**不落库、不进日志**，审计只有字节数/时长/耗时。
     * `bodyLimit` 与显式长度检查双保险：Fastify 在解析阶段就会对超限 body 回 413。
     */
    app.post(
      '/asr',
      { preHandler: requireUser, bodyLimit: MOBILE_ASR_MAX_BYTES },
      async (req): Promise<MobileAsrResponse> => {
        const rawType = req.headers['content-type']
        const mediaType = (typeof rawType === 'string' ? rawType : '').split(';')[0]!.trim().toLowerCase()
        if (mediaType !== 'audio/wav') {
          throw new HubError('UNSUPPORTED_MEDIA', '只支持 Content-Type: audio/wav')
        }
        const body = req.body
        if (!Buffer.isBuffer(body) || body.length === 0) {
          throw new HubError('VALIDATION_FAILED', '音频为空')
        }
        if (body.length > MOBILE_ASR_MAX_BYTES) {
          throw new HubError('PAYLOAD_TOO_LARGE', '录音太长')
        }
        const lang = parseAsrLang((req.query as Record<string, unknown> | undefined)?.['lang'])
        return deps.services.mobileAsr.transcribe({
          user: req.user!,
          audio: body,
          lang,
          meta: requestMeta(req),
        })
      },
    )

    // ── 朗读合成（WP50） ──────────────────────────────────────────────────

    /**
     * 朗读入口：JSON `{text, voice?}` → `audio/wav`（24kHz 单声道）。
     *
     * 成功时透传 WAV 并写 `x-tts-sample-rate` / `x-tts-voice` / `Cache-Control`（App 侧可缓存一天）；
     * 文字**不落库、不进日志**，审计只有字数与耗时（`action='mobile.tts'`）。
     * 上游降级（piper 冒充星汐）在 service 里按 502 处理，这里不做任何「降级也返回」的兜底。
     */
    app.post('/tts', { preHandler: requireUser }, async (req, reply): Promise<FastifyReply> => {
      const input = MobileTtsRequestSchema.parse(req.body ?? {})
      const audio = await deps.services.mobileTts.synthesize({
        user: req.user!,
        text: input.text,
        voice: input.voice,
        meta: requestMeta(req),
      })
      return reply
        .code(200)
        .header('content-type', TTS_CONTENT_TYPE)
        .header('x-tts-sample-rate', String(audio.sampleRate))
        .header('x-tts-voice', audio.voice)
        .header('cache-control', TTS_CACHE_CONTROL)
        .send(audio.wav)
    })

    /**
     * 流式朗读（WP51）：JSON `{text, voice?}` → `audio/L16` 原始 PCM16LE，**边合成边下发**。
     *
     * 排队/限流/缓存/审计与 `/tts` 共用（一个流式请求在整个上游流期间占一个全局槽位）。
     * - 开始下发**之前**的错误照常是 JSON（400 / 429 / 502）；
     * - 开始下发**之后**上游失败：只把流以 error 结束 —— Fastify 会销毁这条响应连接
     *   （**不发分块结束标记**），客户端据此判定这一段不完整；不写缓存；
     * - 正常结束：分块正常收尾，整段音频已按 `(音色, 文字)` 写进与 `/tts` 共用的缓存。
     *
     * 响应头：`x-tts-sample-rate` / `x-tts-voice` / `x-tts-format: pcm16le` / `x-tts-cached: 1|0`；
     * `cache-control: no-store`（流式不缓存）、`x-accel-buffering: no`（反代别攒）、
     * 不压缩（本服务没有注册压缩插件，这里只保证不主动加 content-encoding）。
     */
    app.post(
      MOBILE_TTS_STREAM_ROUTE,
      { preHandler: requireUser },
      async (req, reply): Promise<FastifyReply> => {
        const input = MobileTtsRequestSchema.parse(req.body ?? {})
        const stream = await deps.services.mobileTts.stream({
          user: req.user!,
          text: input.text,
          voice: input.voice,
          meta: requestMeta(req),
        })
        // 上游中途失败：流以 error 结束 → 断开连接（已发头时 Fastify 也会 destroy，这里再兜一次，
        // 保证任何时候都不会补一个「正常结束」的分块结束标记）
        stream.body.once('error', () => {
          if (reply.raw.headersSent) reply.raw.destroy()
        })
        return reply
          .code(200)
          .header('content-type', ttsStreamContentType(stream.sampleRate))
          .header('x-tts-sample-rate', String(stream.sampleRate))
          .header('x-tts-voice', stream.voice)
          .header('x-tts-format', TTS_STREAM_FORMAT)
          .header('x-tts-cached', stream.cached ? '1' : '0')
          .header('cache-control', TTS_STREAM_CACHE_CONTROL)
          .header('x-accel-buffering', 'no')
          .send(stream.body)
      },
    )

    app.post(
      '/instance/wake',
      { preHandler: requireUser },
      async (req, reply): Promise<MobileWakeResponse> => {
        rejectCockpitScope(req)
        const result = await deps.services.mobile.wake(req.user!)
        void reply.code(202)
        return result
      },
    )

    // ── 通道 ticket（v2 §3） ───────────────────────────────────────────────

    app.post('/nodes/:id/ticket', { preHandler: requireUser }, async (req): Promise<MobileTicketResponse> => {
      const { id } = z.object({ id: z.string().min(1).max(128) }).parse(req.params ?? {})
      return deps.services.mobile.issueTicket(req.user!, id, req.mobile)
    })

    // ── 节点列表（v1，cookie 与 Bearer 都能用） ────────────────────────────

    app.get('/nodes', { preHandler: requireUser }, async (req): Promise<MobileNodesResponse> => {
      return deps.services.mobile.listNodes(req.user!, { device: req.mobile })
    })

    // WS 升级不走 Fastify 钩子：挂到 server 上，按路径前缀分派（与反代互不干扰）
    deps.services.mobile.attachUpgrade(app.server)
  }
}

/**
 * `?lang=` 解析：缺省 `zh`（契约），只接受契约里的 6 个值；其它一律 400，
 * **不静默回退**（否则 App 会以为指定语言生效了）。
 */
export function parseAsrLang(raw: unknown): AsrLanguage {
  if (raw === undefined) return ASR_DEFAULT_LANGUAGE
  if (typeof raw === 'string' && (ASR_LANGUAGES as readonly string[]).includes(raw)) {
    return raw as AsrLanguage
  }
  throw new HubError('VALIDATION_FAILED', `lang 只能是 ${ASR_LANGUAGES.join('/')}`)
}

/**
 * 登录错误码 → App 契约（`契约草案-认证与bootstrap.md` §1）。
 *
 * 三个条件在 Hub 内部各自有码（`ACCOUNT_DISABLED` / `ACCOUNT_PENDING` / `ACCOUNT_LOCKED`），
 * App 端按契约只认 `USER_DISABLED` / `USER_PENDING` / `RATE_LIMITED`；
 * 这里做一层**纯映射**，判定逻辑仍在 `auth.authenticate` 里只有一份。
 */
function mapLoginError(error: unknown): unknown {
  if (!HubError.is(error)) return error
  if (error.code === 'ACCOUNT_DISABLED') return new HubError('USER_DISABLED', error.message)
  if (error.code === 'ACCOUNT_PENDING') return new HubError('USER_PENDING', error.message)
  // 按用户名失败锁定对 App 就是限流（App 只处理 429 + retryAfterSec）
  if (error.code === 'ACCOUNT_LOCKED') {
    return new HubError('RATE_LIMITED', '输错次数太多，请稍后再试', error.details)
  }
  return error
}
