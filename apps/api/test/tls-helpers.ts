import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 测试用证书：用系统 openssl 现生成（任务书「测试」节：监听器集成测试用 openssl 现生成的证书）。
 * 不写死任何真实域名；CN/SAN 都是测试用的假主机名。
 */
export interface TestCertificate {
  certPath: string
  keyPath: string
  cert: string
  key: string
}

export interface GenerateTestCertOptions {
  dir: string
  /** 文件名前缀（同一目录要放多张证书时区分） */
  name?: string
  host?: string
  days?: number
}

export function generateTestCertificate(options: GenerateTestCertOptions): TestCertificate {
  const name = options.name ?? 'cert'
  const host = options.host ?? 'localhost'
  const days = options.days ?? 30
  mkdirSync(options.dir, { recursive: true, mode: 0o700 })
  const certPath = join(options.dir, `${name}.crt`)
  const keyPath = join(options.dir, `${name}.key`)
  execFileSync(
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
      keyPath,
      '-out',
      certPath,
      '-subj',
      `/CN=${host}`,
      '-addext',
      `subjectAltName=DNS:${host},DNS:localhost,IP:127.0.0.1`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  return {
    certPath,
    keyPath,
    cert: readFileSync(certPath, 'utf8'),
    key: readFileSync(keyPath, 'utf8'),
  }
}
