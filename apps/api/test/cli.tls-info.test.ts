import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { generateTestCertificate } from './tls-helpers.js'

/**
 * `deploy/hubctl tls:info`（任务书 §1.6）：证书来源、主体、SAN、签发者、到期时间、剩余天数、
 * SHA-256 指纹、私钥是否配对。子进程真跑 `cli.ts`，验证命令接线与退出码。
 */
const API_DIR = fileURLToPath(new URL('..', import.meta.url))
const CLI_TS = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshhub-test-wp7b-cli-'))
  dirs.push(dir)
  return dir
}

function runCli(args: string[], env: Record<string, string> = {}): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, ['--import', 'tsx', CLI_TS, ...args], {
      cwd: API_DIR,
      env: { ...process.env, HUB_LOG_LEVEL: 'silent', ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, output }
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe('cli tls:info', () => {
  it('有正式证书：打印来源/主体/SAN/签发者/剩余天数/指纹/私钥匹配', () => {
    const dataDir = tempDataDir()
    const tlsDir = join(dataDir, 'secrets', 'tls')
    const cert = generateTestCertificate({ dir: tlsDir, name: 'acme', host: 'hub.example.com' })
    writeFileSync(join(tlsDir, 'fullchain.pem'), cert.cert)
    writeFileSync(join(tlsDir, 'privkey.pem'), cert.key, { mode: 0o600 })

    const result = runCli(['tls:info'], { HUB_DATA_DIR: dataDir })
    expect(result.code).toBe(0)
    expect(result.output).toContain("Let's Encrypt")
    expect(result.output).toContain('CN=hub.example.com')
    expect(result.output).toContain('DNS:hub.example.com')
    expect(result.output).toContain('剩余天数')
    expect(result.output).toMatch(/SHA-256 指纹\s+([0-9A-F]{2}:){31}[0-9A-F]{2}/u)
    expect(result.output).toContain('私钥匹配      是')
    expect(result.output).toContain('（权限 0600）')
  })

  it('只有自签证书：报告来源为临时自签', () => {
    const dataDir = tempDataDir()
    const tlsDir = join(dataDir, 'secrets', 'tls')
    mkdirSync(tlsDir, { recursive: true })
    const cert = generateTestCertificate({ dir: tlsDir, name: 'selfsigned', host: 'localhost', days: 5 })
    writeFileSync(join(tlsDir, 'selfsigned.crt'), cert.cert)
    writeFileSync(join(tlsDir, 'selfsigned.key'), cert.key, { mode: 0o600 })

    const result = runCli(['tls:info'], { HUB_DATA_DIR: dataDir })
    expect(result.code).toBe(0)
    expect(result.output).toContain('临时自签证书')
    expect(result.output).toMatch(/剩余天数\s+[45]/u)
  })

  it('没有证书：明确说没有，退出码 1（TLS 网关关闭时正常）', () => {
    const dataDir = tempDataDir()
    const result = runCli(['tls:info'], { HUB_DATA_DIR: dataDir })
    expect(result.code).toBe(1)
    expect(result.output).toContain('未找到')
  })

  it('key/cert 不配对：报「否」并退出码 1', () => {
    const dataDir = tempDataDir()
    const tlsDir = join(dataDir, 'secrets', 'tls')
    const cert = generateTestCertificate({ dir: tlsDir, name: 'acme', host: 'hub.example.com' })
    const other = generateTestCertificate({ dir: tlsDir, name: 'other', host: 'other.example.com' })
    writeFileSync(join(tlsDir, 'fullchain.pem'), cert.cert)
    writeFileSync(join(tlsDir, 'privkey.pem'), other.key, { mode: 0o600 })
    const result = runCli(['tls:info'], { HUB_DATA_DIR: dataDir })
    expect(result.code).toBe(1)
    expect(result.output).toContain('不匹配')
  })

  it('help 里列出 tls:info', () => {
    const result = runCli(['help'])
    expect(result.output).toContain('tls:info')
    // 顺带确认没把别人的命令挤掉
    expect(result.output).toContain('db:backup')
    expect(result.output).toContain('create-admin')
  })

  it('cli 不修改证书文件', () => {
    const dataDir = tempDataDir()
    const tlsDir = join(dataDir, 'secrets', 'tls')
    const cert = generateTestCertificate({ dir: tlsDir, name: 'acme', host: 'hub.example.com' })
    writeFileSync(join(tlsDir, 'fullchain.pem'), cert.cert)
    writeFileSync(join(tlsDir, 'privkey.pem'), cert.key, { mode: 0o600 })
    const before = readFileSync(join(tlsDir, 'fullchain.pem'), 'utf8')
    runCli(['tls:info'], { HUB_DATA_DIR: dataDir })
    expect(readFileSync(join(tlsDir, 'fullchain.pem'), 'utf8')).toBe(before)
  })
})
