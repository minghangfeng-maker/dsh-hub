import { spawnSync } from 'node:child_process'
import { X509Certificate, createPrivateKey } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname, join } from 'node:path'
import type { FastifyBaseLogger } from 'fastify'
import { HubError } from '../lib/errors.js'

/**
 * TLS 证书（01 §6、08 §4）。
 *
 * 正式证书由本机的 acme.sh（DNS-01）写到 `HUB_DATA_DIR/secrets/tls/{fullchain,privkey}.pem`；
 * 没有正式证书时用系统 openssl 现生成 30 天的临时自签证书，只为「先能起来、能本机自测」。
 * 私钥只在本地，前台只有加密字节（02 T9）。
 *
 * 热更新：每 60 秒看一次 `fullchain.pem` 的 mtime，进程收到 SIGHUP 时也重读；
 * 校验通过才 `setSecureContext()` 换掉 https server 的证书，**不重启、不断已有连接**；
 * key/cert 不匹配时保留旧证书并记 error。
 */

/** 数据目录下的证书文件（名单固定，脚本与 Hub 共用这一套路径） */
export interface TlsPaths {
  dir: string
  fullchain: string
  privkey: string
  selfSignedCert: string
  selfSignedKey: string
}

export function tlsPaths(dataDir: string): TlsPaths {
  const dir = join(dataDir, 'secrets', 'tls')
  return {
    dir,
    fullchain: join(dir, 'fullchain.pem'),
    privkey: join(dir, 'privkey.pem'),
    selfSignedCert: join(dir, 'selfsigned.crt'),
    selfSignedKey: join(dir, 'selfsigned.key'),
  }
}

export interface CertificateInfo {
  /** `CN=hub.example.com, O=…`（多行主体压成一行，方便 CLI/日志） */
  subject: string
  issuer: string
  validFrom: string | null
  validTo: string | null
  /** 距到期还有多少天（向下取整；已过期为负） */
  daysRemaining: number | null
  /** SAN 列表（`DNS:…` / `IP:…` 前缀保留） */
  san: string[]
  /** SHA-256 指纹（`AA:BB:…`） */
  fingerprintSha256: string
  serialNumber: string
  isCa: boolean
}

/** 解析 PEM 证书成人类可读信息（`tls:info` 与启动日志共用） */
export function inspectCertificate(pem: string, now: Date = new Date()): CertificateInfo {
  const cert = new X509Certificate(pem)
  const validToMs = Date.parse(cert.validTo)
  const validFromMs = Date.parse(cert.validFrom)
  return {
    subject: flattenDn(cert.subject),
    issuer: flattenDn(cert.issuer),
    validFrom: Number.isNaN(validFromMs) ? null : new Date(validFromMs).toISOString(),
    validTo: Number.isNaN(validToMs) ? null : new Date(validToMs).toISOString(),
    daysRemaining: Number.isNaN(validToMs) ? null : Math.floor((validToMs - now.getTime()) / 86_400_000),
    san: splitSan(cert.subjectAltName),
    fingerprintSha256: cert.fingerprint256,
    serialNumber: cert.serialNumber,
    isCa: cert.ca,
  }
}

/** X509 的主体/签发者是多行 `KEY=VALUE`，压成一行便于日志与 CLI 输出 */
function flattenDn(value: string): string {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(', ')
}

function splitSan(value: string | undefined): string[] {
  if (!value) return []
  return (
    value
      .split(/,\s*/u)
      // Node 给的 SAN 里 IPv4/6 是 `IP Address:1.2.3.4`，统一成 `IP:` 便于输出与断言
      .map((item) => item.trim().replace(/^IP Address:/u, 'IP:'))
      .filter((item) => item.length > 0)
  )
}

export interface TlsMaterial {
  source: 'acme' | 'self-signed'
  key: string
  cert: string
  certPath: string
  keyPath: string
  info: CertificateInfo
  loadedAt: string
}

export interface SelfSignedOptions {
  certPath: string
  keyPath: string
  /** `HUB_PUBLIC_ORIGIN` 的主机名（IP 就用 `IP:` 形式的 SAN） */
  host: string
  days?: number
}

/** 自签证书的 SAN：`HUB_PUBLIC_ORIGIN` 的主机 + `localhost` + `IP:127.0.0.1` */
export function selfSignedSubjectAltNames(host: string): string[] {
  const entries: string[] = []
  const hostKind = isIP(host)
  entries.push(hostKind === 0 ? `DNS:${host}` : `IP:${host}`)
  if (host !== 'localhost') entries.push('DNS:localhost')
  if (host !== '127.0.0.1') entries.push('IP:127.0.0.1')
  return entries
}

/**
 * 用系统 openssl 生成临时自签证书。
 * 先在 0700 的临时目录里生成、chmod 0600 后再 rename 到位，避免私钥有一瞬间是 0644。
 */
export function generateSelfSignedCertificate(options: SelfSignedOptions): void {
  const days = options.days ?? 30
  const dir = dirname(options.certPath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmpDir = join(dir, `.selfsigned-${String(process.pid)}-${String(Date.now())}`)
  const tmpKey = join(tmpDir, 'key.pem')
  const tmpCert = join(tmpDir, 'cert.pem')
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 })
  try {
    const result = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-sha256',
        '-days',
        String(days),
        '-nodes',
        '-keyout',
        tmpKey,
        '-out',
        tmpCert,
        '-subj',
        `/CN=${options.host}`,
        '-addext',
        `subjectAltName=${selfSignedSubjectAltNames(options.host).join(',')}`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] },
    )
    if (result.error) {
      throw new HubError('INTERNAL', `生成自签证书需要系统 openssl：${result.error.message}`)
    }
    if (result.status !== 0) {
      throw new HubError('INTERNAL', `openssl 生成自签证书失败：${(result.stderr ?? '').trim()}`)
    }
    chmodSync(tmpKey, 0o600)
    chmodSync(tmpCert, 0o644)
    renameSync(tmpKey, options.keyPath)
    renameSync(tmpCert, options.certPath)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

export interface TlsManagerOptions {
  dataDir: string
  /** `HUB_PUBLIC_ORIGIN`（自签证书的 CN/SAN 与日志用） */
  publicOrigin: string
  log: FastifyBaseLogger
  now?: () => Date
  /** 定时检查间隔（默认 60 秒） */
  checkIntervalMs?: number
  /** 剩余天数低于它时每天 warn 一次（默认 14 天） */
  warnDays?: number
  /** 自签证书有效期（天，默认 30） */
  selfSignedDays?: number
  /** 生成自签证书的实现（测试注入假实现，避免依赖 openssl） */
  generate?: (options: SelfSignedOptions) => void
}

export interface TlsManager {
  paths: TlsPaths
  host: string
  /** 首次加载：正式证书优先；没有（或自签过期）就生成自签 */
  load(): TlsMaterial
  current(): TlsMaterial | null
  /** 重读证书；成功则切换并广播，失败保留旧证书并返回 null */
  reload(reason: string): TlsMaterial | null
  start(): void
  stop(): void
  onChange(listener: (material: TlsMaterial) => void): void
}

export function createTlsManager(options: TlsManagerOptions): TlsManager {
  const paths = tlsPaths(options.dataDir)
  const now = options.now ?? (() => new Date())
  const host = new URL(options.publicOrigin).hostname
  const generate = options.generate ?? generateSelfSignedCertificate
  const checkIntervalMs = options.checkIntervalMs ?? 60_000
  const warnDays = options.warnDays ?? 14
  const selfSignedDays = options.selfSignedDays ?? 30
  const listeners: ((material: TlsMaterial) => void)[] = []
  let current: TlsMaterial | null = null
  /** 上次读到的正式证书签名（mtime + size）；用来跳过没必要的重读 */
  let acmeSignature: string | null = null
  let timer: NodeJS.Timeout | null = null
  let lastWarnDay: string | null = null

  function logWarnIfExpiring(material: TlsMaterial): void {
    const remaining = material.info.daysRemaining
    if (remaining === null || remaining >= warnDays) return
    const day = now().toISOString().slice(0, 10)
    if (lastWarnDay === day) return
    lastWarnDay = day
    options.log.warn(
      `TLS 证书还有 ${String(remaining)} 天到期（${material.source}，${material.certPath}）；` +
        `${material.source === 'acme' ? '确认 acme.sh 续期定时器在跑' : '重启或替换证书'}`,
    )
  }

  function readFormal(): TlsMaterial | null {
    if (!existsSync(paths.fullchain) || !existsSync(paths.privkey)) return null
    try {
      const key = readFileSync(paths.privkey, 'utf8')
      const cert = readFileSync(paths.fullchain, 'utf8')
      const info = validatePair(key, cert)
      return {
        source: 'acme',
        key,
        cert,
        certPath: paths.fullchain,
        keyPath: paths.privkey,
        info,
        loadedAt: now().toISOString(),
      }
    } catch (error) {
      options.log.error(
        { err: error },
        `TLS 证书读取失败，保留现有证书（${paths.fullchain} / ${paths.privkey}）`,
      )
      return null
    }
  }

  function formalSignature(): string | null {
    try {
      const stat = statSync(paths.fullchain)
      return `${String(stat.mtimeMs)}:${String(stat.size)}`
    } catch {
      return null
    }
  }

  /** 自签证书是否还能用：存在、可解析、且不是「已过期」 */
  function selfSignedUsable(): boolean {
    if (!existsSync(paths.selfSignedCert) || !existsSync(paths.selfSignedKey)) return false
    try {
      const info = inspectCertificate(readFileSync(paths.selfSignedCert, 'utf8'), now())
      if (info.daysRemaining === null || info.daysRemaining <= 0) return false
      readFormalKey(paths.selfSignedKey)
      return true
    } catch {
      return false
    }
  }

  function loadSelfSigned(): TlsMaterial | null {
    if (!selfSignedUsable()) {
      options.log.warn(`生成临时自签证书（CN=${host}，${String(selfSignedDays)} 天）`)
      generate({
        certPath: paths.selfSignedCert,
        keyPath: paths.selfSignedKey,
        host,
        days: selfSignedDays,
      })
    }
    try {
      const key = readFileSync(paths.selfSignedKey, 'utf8')
      const cert = readFileSync(paths.selfSignedCert, 'utf8')
      const info = validatePair(key, cert)
      return {
        source: 'self-signed',
        key,
        cert,
        certPath: paths.selfSignedCert,
        keyPath: paths.selfSignedKey,
        info,
        loadedAt: now().toISOString(),
      }
    } catch (error) {
      options.log.error({ err: error }, '自签证书不可用')
      return null
    }
  }

  function switchTo(material: TlsMaterial, reason: string): TlsMaterial {
    const previous = current
    current = material
    if (material.source === 'acme') acmeSignature = formalSignature()
    else acmeSignature = null
    if (previous) {
      options.log.info(
        `TLS 证书已切换（${reason}）：${previous.source} → ${material.source}，` +
          `到期 ${material.info.validTo ?? '—'}（剩余 ${String(material.info.daysRemaining ?? '—')} 天）`,
      )
    }
    logWarnIfExpiring(material)
    for (const listener of listeners) {
      try {
        listener(material)
      } catch (error) {
        options.log.error({ err: error }, 'TLS 证书切换回调抛错')
      }
    }
    return material
  }

  const manager: TlsManager = {
    paths,
    host,

    load(): TlsMaterial {
      const formal = readFormal()
      if (formal) {
        acmeSignature = formalSignature()
        current = formal
        logWarnIfExpiring(formal)
        return formal
      }
      const selfSigned = loadSelfSigned()
      if (!selfSigned) {
        throw new HubError(
          'INTERNAL',
          `TLS 网关启动失败：没有正式证书（${paths.fullchain}），自签证书也无法生成`,
        )
      }
      current = selfSigned
      return selfSigned
    },

    current(): TlsMaterial | null {
      return current
    },

    reload(reason: string): TlsMaterial | null {
      const signature = formalSignature()
      const hasFormal = signature !== null && existsSync(paths.privkey)
      if (hasFormal) {
        const unchanged = current?.source === 'acme' && signature === acmeSignature
        if (unchanged && current) {
          // 证书没变也要检查到期提醒（每天最多一条）
          logWarnIfExpiring(current)
          return current
        }
        const formal = readFormal()
        if (formal) return switchTo(formal, reason)
        // 读失败（例如 acme.sh 正在替换文件）：保留旧证书
        return null
      }
      // 没有正式证书：回落到自签（首次启动或删掉正式证书后）
      if (current?.source === 'self-signed' && selfSignedUsable()) {
        logWarnIfExpiring(current)
        return current
      }
      const selfSigned = loadSelfSigned()
      if (!selfSigned) return null
      return switchTo(selfSigned, reason)
    },

    start(): void {
      if (timer) return
      timer = setInterval(() => {
        try {
          manager.reload('定时检查')
        } catch (error) {
          options.log.error({ err: error }, 'TLS 证书定时检查失败')
        }
      }, checkIntervalMs)
      timer.unref?.()
    },

    stop(): void {
      if (timer) clearInterval(timer)
      timer = null
    },

    onChange(listener: (material: TlsMaterial) => void): void {
      listeners.push(listener)
    },
  }
  return manager
}

function readFormalKey(path: string): string {
  return readFileSync(path, 'utf8')
}

/** 私钥与证书是否配对（`tls:info` 与热更新校验共用） */
export function checkKeyPair(key: string, cert: string): boolean {
  try {
    return new X509Certificate(cert).checkPrivateKey(createPrivateKey(key))
  } catch {
    return false
  }
}

/** 校验 key/cert 能解析且配对；返回证书信息（不匹配时抛错，调用方保留旧证书） */
function validatePair(key: string, cert: string): CertificateInfo {
  const keyObject = createPrivateKey(key)
  const info = inspectCertificate(cert)
  const parsed = new X509Certificate(cert)
  if (!parsed.checkPrivateKey(keyObject)) {
    throw new HubError('INTERNAL', 'TLS 证书与私钥不匹配')
  }
  return info
}
