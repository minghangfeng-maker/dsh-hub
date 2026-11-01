import { existsSync, readFileSync, statSync } from 'node:fs'
import type { HubConfig } from './config.js'
import { inspectCertificate, checkKeyPair, tlsPaths, type CertificateInfo } from './server/tls.js'

/**
 * `deploy/hubctl tls:info`（任务书 §1.6）：证书来源、主体、SAN、签发者、到期时间、剩余天数、
 * SHA-256 指纹，外加「私钥是否配对」「文件权限」。
 *
 * **只读**：没有证书时不会顺手生成自签证书（那是启动 TLS 网关的副作用）。
 */

export interface TlsInfoReport {
  dataDir: string
  source: 'acme' | 'self-signed' | 'none'
  certPath: string | null
  keyPath: string | null
  info: CertificateInfo | null
  keyMatches: boolean | null
  keyMode: string | null
  error: string | null
}

export interface CollectTlsInfoOptions {
  now?: Date
}

export function collectTlsInfo(config: HubConfig, options: CollectTlsInfoOptions = {}): TlsInfoReport {
  const paths = tlsPaths(config.dataDir)
  const candidates: { source: 'acme' | 'self-signed'; certPath: string; keyPath: string }[] = [
    { source: 'acme', certPath: paths.fullchain, keyPath: paths.privkey },
    { source: 'self-signed', certPath: paths.selfSignedCert, keyPath: paths.selfSignedKey },
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate.certPath) && !existsSync(candidate.keyPath)) continue
    if (!existsSync(candidate.certPath) || !existsSync(candidate.keyPath)) {
      return {
        dataDir: config.dataDir,
        source: candidate.source,
        certPath: candidate.certPath,
        keyPath: candidate.keyPath,
        info: null,
        keyMatches: null,
        keyMode: null,
        error: `证书与私钥必须成对存在：缺 ${existsSync(candidate.certPath) ? candidate.keyPath : candidate.certPath}`,
      }
    }
    try {
      const cert = readFileSync(candidate.certPath, 'utf8')
      const key = readFileSync(candidate.keyPath, 'utf8')
      return {
        dataDir: config.dataDir,
        source: candidate.source,
        certPath: candidate.certPath,
        keyPath: candidate.keyPath,
        info: inspectCertificate(cert, options.now ?? new Date()),
        keyMatches: checkKeyPair(key, cert),
        keyMode: fileMode(candidate.keyPath),
        error: null,
      }
    } catch (error) {
      return {
        dataDir: config.dataDir,
        source: candidate.source,
        certPath: candidate.certPath,
        keyPath: candidate.keyPath,
        info: null,
        keyMatches: null,
        keyMode: null,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
  return {
    dataDir: config.dataDir,
    source: 'none',
    certPath: null,
    keyPath: null,
    info: null,
    keyMatches: null,
    keyMode: null,
    error: null,
  }
}

function fileMode(path: string): string | null {
  try {
    return `0${(statSync(path).mode & 0o777).toString(8).padStart(3, '0')}`
  } catch {
    return null
  }
}

/** 渲染成人类可读的多行文本；返回退出码（0 = 有可用证书，1 = 没有/有问题） */
export function renderTlsInfo(report: TlsInfoReport, out: (text: string) => void): number {
  const lines: string[] = []
  lines.push(`数据目录      ${report.dataDir}`)
  if (report.error) {
    lines.push(`证书来源      ${sourceLabel(report.source)}`)
    lines.push(`证书文件      ${report.certPath ?? '—'}`)
    lines.push(`私钥文件      ${report.keyPath ?? '—'}`)
    lines.push(`错误          ${report.error}`)
    out(`${lines.join('\n')}\n`)
    return 1
  }
  if (!report.info) {
    lines.push('证书来源      未找到（正式证书与自签证书都不存在）')
    lines.push('说明          TLS 网关关闭时正常；开启 7443 后 Hub 会生成临时自签证书')
    out(`${lines.join('\n')}\n`)
    return 1
  }
  const info = report.info
  lines.push(`证书来源      ${sourceLabel(report.source)}`)
  lines.push(`证书文件      ${report.certPath ?? '—'}`)
  lines.push(`私钥文件      ${report.keyPath ?? '—'}（权限 ${report.keyMode ?? '—'}）`)
  lines.push(`主体          ${info.subject}`)
  lines.push(`SAN           ${info.san.length > 0 ? info.san.join(', ') : '—'}`)
  lines.push(`签发者        ${info.issuer}`)
  lines.push(`有效期        ${info.validFrom ?? '—'} → ${info.validTo ?? '—'}`)
  lines.push(`剩余天数      ${info.daysRemaining === null ? '—' : String(info.daysRemaining)}`)
  lines.push(`SHA-256 指纹  ${info.fingerprintSha256}`)
  lines.push(`序列号        ${info.serialNumber}`)
  lines.push(
    `私钥匹配      ${report.keyMatches === true ? '是' : report.keyMatches === false ? '否（key/cert 不匹配！）' : '—'}`,
  )
  out(`${lines.join('\n')}\n`)
  if (report.keyMatches === false) return 1
  if (info.daysRemaining !== null && info.daysRemaining < 14) {
    out(`警告：证书还有 ${String(info.daysRemaining)} 天到期，确认 acme.sh 续期定时器在跑\n`)
  }
  return 0
}

function sourceLabel(source: TlsInfoReport['source']): string {
  if (source === 'acme') return "Let's Encrypt（acme.sh 装的正式证书）"
  if (source === 'self-signed') return '临时自签证书（openssl 生成，仅供本机自测）'
  return '无'
}
