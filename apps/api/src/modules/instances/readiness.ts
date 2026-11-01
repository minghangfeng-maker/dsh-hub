import { request } from 'node:http'
import { INSTANCE_READY_TIMEOUT_MS } from '@dsh-hub/shared'
import type { DshCookieMinter } from './dsh-cookie.js'
import type { ContainerDriver, UpstreamTarget } from './types.js'

/** 就绪轮询间隔（05 §6：100ms） */
export const READY_POLL_MS = 100
/** 单次 HTTP 探测超时 */
export const PROBE_TIMEOUT_MS = 3_000

export interface ReadyProbeInput {
  driver: ContainerDriver
  name: string
  upstream: UpstreamTarget | null
  authority: string
  minter: DshCookieMinter
  /** 计时来源（毫秒）。默认 `Date.now`：**刻意不接可控时钟**——测试时钟冻结时会造成死循环 */
  now?: () => number
  pollMs?: number
  timeoutMs?: number
  /** 单次探测超时 */
  probeTimeoutMs?: number
  /** 注入的睡眠（测试用；默认真实 setTimeout） */
  sleep?: (ms: number) => Promise<void>
}

export interface ReadySuccess {
  ok: true
  ip: string | null
  waitedMs: number
}

export interface ReadyFailure {
  ok: false
  reason: 'not-running' | 'timeout'
  message: string
  waitedMs: number
  logTail: string
}

export type ReadyResult = ReadySuccess | ReadyFailure

/**
 * 就绪判据（05 §6，WP0b S8 修正版）：
 *  ①容器 running（先看 inspect）→ ③ browser-session 密钥可读 → ④ 带现签 cookie 的 `GET /`
 *  返回 200 且含 `__DSH_BOOT__`。①② 会「早熟」（端口通了路由还没挂完就 404），所以
 *  HTTP 探测必须排在密钥之后；`ip` 只在容器 running 时才有意义。
 */
export async function waitForReady(input: ReadyProbeInput): Promise<ReadyResult> {
  const now = input.now ?? (() => Date.now())
  const pollMs = input.pollMs ?? READY_POLL_MS
  const timeoutMs = input.timeoutMs ?? INSTANCE_READY_TIMEOUT_MS
  const probeTimeoutMs = input.probeTimeoutMs ?? PROBE_TIMEOUT_MS
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const started = now()
  let lastMessage = '等待容器启动'

  while (now() - started < timeoutMs) {
    const info = await input.driver.inspect(input.name).catch(() => null)
    if (info && info.state === 'running') {
      if (input.minter.secretReady()) {
        const target = input.upstream ?? null
        if (target) {
          const cookie = input.minter.cookie(input.authority)
          const probe = await probeHttp(target, input.authority, cookie, probeTimeoutMs)
          if (probe.ok) {
            return { ok: true, ip: info.ip, waitedMs: now() - started }
          }
          lastMessage = probe.message
        } else {
          lastMessage = '没有可用的容器地址'
        }
      } else {
        lastMessage = '等待 DSH 写出 browser-session 密钥'
      }
    } else if (info) {
      lastMessage = `容器状态 ${info.state}`
    }
    await sleep(pollMs)
  }

  const logTail = await input.driver
    .logs(input.name, { tail: 50 })
    .then((text) => redactLogText(text))
    .catch(() => '')
  return {
    ok: false,
    reason: 'timeout',
    message: `等待就绪超时（${String(Math.round(timeoutMs / 1000))}s）：${lastMessage}`,
    waitedMs: now() - started,
    logTail,
  }
}

export interface ProbeResult {
  ok: boolean
  status?: number
  message: string
}

/** 单次 HTTP 探测：Host 用 authority，带上 Hub 现签的 DSH cookie（05 §6 判据 ④） */
export function probeHttp(
  target: UpstreamTarget,
  authority: string,
  cookie: { name: string; value: string },
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    let settled = false
    const finish = (result: ProbeResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const req = request(
      {
        host: target.host,
        port: target.port,
        path: '/',
        method: 'GET',
        headers: {
          host: authority,
          cookie: `${cookie.name}=${cookie.value}`,
          accept: 'text/html',
          // DSH 的 webserver 开了 gzip；判据只看正文里有没有 __DSH_BOOT__
          'accept-encoding': 'identity',
          connection: 'close',
        },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          // 首页 ~35KB，读到 marker 就够，避免无谓地读完
          if (body.length < 256 * 1024) body += chunk
        })
        res.on('end', () => {
          const status = res.statusCode ?? 0
          if (status !== 200) {
            finish({ ok: false, status, message: `首页返回 ${String(status)}（尚未就绪）` })
            return
          }
          if (!body.includes('__DSH_BOOT__')) {
            finish({ ok: false, status, message: '首页 200 但没有 __DSH_BOOT__' })
            return
          }
          finish({ ok: true, status, message: 'ready' })
        })
        res.on('error', (error: Error) => finish({ ok: false, message: `响应错误：${error.message}` }))
      },
    )
    const timer = setTimeout(() => {
      req.destroy()
      finish({ ok: false, message: `探测超时（${String(timeoutMs)}ms）` })
    }, timeoutMs)
    timer.unref?.()
    req.on('error', (error: Error) => {
      clearTimeout(timer)
      finish({ ok: false, message: `连接失败：${error.message}` })
    })
    req.on('close', () => clearTimeout(timer))
    req.end()
  })
}

// ── 日志脱敏（04 §4.3：日志里不能出现 token） ────────────────────────────────

/** 命中即替换的敏感片段 */
const REDACT_RULES: { pattern: RegExp; replace: string }[] = [
  // `?token=xxxx` / `token=xxxx`（DSH 启动横幅里就有）
  { pattern: /\btoken=([^\s&"']+)/giu, replace: 'token=***' },
  { pattern: /\bhub_sid=([^;\s"']+)/giu, replace: 'hub_sid=***' },
  { pattern: /\bdsh-auth-[A-Za-z0-9_-]+=v1\.[A-Za-z0-9_.-]+/gu, replace: 'dsh-auth-***=v1.***' },
  { pattern: /(authorization\s*[:=]\s*)(\S+)/giu, replace: '$1***' },
  { pattern: /(cookie\s*[:=]\s*)(.+)$/gimu, replace: '$1***' },
  { pattern: /(api[_-]?key\s*[:=]\s*)(\S+)/giu, replace: '$1***' },
  { pattern: /(password\s*[:=]\s*)(\S+)/giu, replace: '$1***' },
]

/** 单行脱敏（管理端日志接口逐行调用） */
export function redactLogLine(line: string): string {
  let out = line
  for (const rule of REDACT_RULES) out = out.replace(rule.pattern, rule.replace)
  return out
}

/** 多行脱敏 */
export function redactLogText(text: string): string {
  return text
    .split('\n')
    .map((line) => redactLogLine(line))
    .join('\n')
}
