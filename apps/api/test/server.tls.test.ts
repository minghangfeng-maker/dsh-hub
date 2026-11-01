import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyBaseLogger } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkKeyPair,
  createTlsManager,
  generateSelfSignedCertificate,
  inspectCertificate,
  selfSignedSubjectAltNames,
  tlsPaths,
} from '../src/server/tls.js'
import { generateTestCertificate } from './tls-helpers.js'

/**
 * 证书管理（任务书「测试」节）：无正式证书时生成自签并能握手、替换 fullchain.pem 后热切换、
 * key/cert 不匹配时保留旧证书；附带 `tls:info` 要用的信息提取。
 */

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshhub-test-wp7b-tls-'))
  dirs.push(dir)
  return dir
}

interface LogRecord {
  level: 'info' | 'warn' | 'error' | 'debug'
  message: string
}

function fakeLog(records: LogRecord[] = []): FastifyBaseLogger {
  const push = (level: LogRecord['level']) => (first: unknown, second?: unknown) => {
    records.push({ level, message: typeof first === 'string' ? first : String(second ?? first) })
  }
  return {
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    fatal: push('error'),
    trace: push('debug'),
    silent: () => undefined,
    child: () => fakeLog(records),
    level: 'info',
  } as unknown as FastifyBaseLogger
}

describe('自签证书', () => {
  it('SAN = HUB_PUBLIC_ORIGIN 的主机 + localhost + 127.0.0.1；IP 主机用 IP: 形式', () => {
    expect(selfSignedSubjectAltNames('hub.example.com')).toEqual([
      'DNS:hub.example.com',
      'DNS:localhost',
      'IP:127.0.0.1',
    ])
    expect(selfSignedSubjectAltNames('203.0.113.10')).toEqual([
      'IP:203.0.113.10',
      'DNS:localhost',
      'IP:127.0.0.1',
    ])
  })

  it('生成 30 天的自签证书，私钥 0600，主体/SAN 能读出来', () => {
    const dir = tempDir()
    const paths = tlsPaths(dir)
    generateSelfSignedCertificate({
      certPath: paths.selfSignedCert,
      keyPath: paths.selfSignedKey,
      host: 'hub.example.com',
      days: 30,
    })
    const cert = readFileSync(paths.selfSignedCert, 'utf8')
    const info = inspectCertificate(cert)
    expect(info.subject).toContain('CN=hub.example.com')
    expect(info.san).toContain('DNS:hub.example.com')
    expect(info.san).toContain('IP:127.0.0.1')
    expect(info.daysRemaining).toBeGreaterThanOrEqual(29)
    expect(info.daysRemaining).toBeLessThanOrEqual(30)
    expect(info.fingerprintSha256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/u)
    expect(checkKeyPair(readFileSync(paths.selfSignedKey, 'utf8'), cert)).toBe(true)
    expect(statSync(paths.selfSignedKey).mode & 0o777).toBe(0o600)
  })

  it('key 与 cert 不配对时 checkKeyPair 为 false', () => {
    const dir = tempDir()
    const a = generateTestCertificate({ dir, name: 'a', host: 'a.example' })
    const b = generateTestCertificate({ dir, name: 'b', host: 'b.example' })
    expect(checkKeyPair(a.key, a.cert)).toBe(true)
    expect(checkKeyPair(b.key, a.cert)).toBe(false)
  })
})

describe('createTlsManager', () => {
  it('没有正式证书 → 自签（并 warn 提示）', () => {
    const dir = tempDir()
    const logs: LogRecord[] = []
    const manager = createTlsManager({
      dataDir: dir,
      publicOrigin: 'https://hub.example.com:8443',
      log: fakeLog(logs),
    })
    const material = manager.load()
    expect(material.source).toBe('self-signed')
    expect(material.info.subject).toContain('CN=hub.example.com')
    expect(manager.host).toBe('hub.example.com')
    expect(manager.current()?.certPath).toBe(tlsPaths(dir).selfSignedCert)
  })

  it('有正式证书 → 用 acme 证书；删掉后 reload 回落到自签', () => {
    const dir = tempDir()
    const paths = tlsPaths(dir)
    const generated = generateTestCertificate({ dir: paths.dir, name: 'fullchain', host: 'hub.example.com' })
    writeFileSync(paths.fullchain, generated.cert)
    writeFileSync(paths.privkey, generated.key, { mode: 0o600 })
    const manager = createTlsManager({
      dataDir: dir,
      publicOrigin: 'https://hub.example.com:8443',
      log: fakeLog(),
    })
    expect(manager.load().source).toBe('acme')

    rmSync(paths.fullchain)
    rmSync(paths.privkey)
    const after = manager.reload('删掉正式证书')
    expect(after?.source).toBe('self-signed')
  })

  it('替换 fullchain.pem 后 reload 换证书，并广播 onChange', () => {
    const dir = tempDir()
    const paths = tlsPaths(dir)
    const first = generateTestCertificate({ dir: paths.dir, name: 'first', host: 'old.example.com' })
    writeFileSync(paths.fullchain, first.cert)
    writeFileSync(paths.privkey, first.key)
    const manager = createTlsManager({
      dataDir: dir,
      publicOrigin: 'https://hub.example.com:8443',
      log: fakeLog(),
    })
    manager.load()
    const seen: string[] = []
    manager.onChange((material) => seen.push(material.info.subject))

    const second = generateTestCertificate({ dir: paths.dir, name: 'second', host: 'new.example.com' })
    writeFileSync(paths.fullchain, second.cert)
    writeFileSync(paths.privkey, second.key)
    const material = manager.reload('测试')
    expect(material?.info.subject).toContain('CN=new.example.com')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('CN=new.example.com')
    // 没变化时不再切换（省掉无意义的 setSecureContext）
    expect(manager.reload('再查一次')?.info.subject).toContain('CN=new.example.com')
    expect(seen).toHaveLength(1)
  })

  it('key/cert 不匹配 → 拒绝切换、保留旧证书、记 error', () => {
    const dir = tempDir()
    const paths = tlsPaths(dir)
    const good = generateTestCertificate({ dir: paths.dir, name: 'good', host: 'good.example.com' })
    writeFileSync(paths.fullchain, good.cert)
    writeFileSync(paths.privkey, good.key)
    const logs: LogRecord[] = []
    const manager = createTlsManager({
      dataDir: dir,
      publicOrigin: 'https://hub.example.com:8443',
      log: fakeLog(logs),
    })
    manager.load()

    const other = generateTestCertificate({ dir: paths.dir, name: 'other', host: 'other.example.com' })
    // 换证书但私钥不换：必须保留旧证书
    writeFileSync(paths.fullchain, other.cert)
    expect(manager.reload('坏证书')).toBeNull()
    expect(manager.current()?.info.subject).toContain('CN=good.example.com')
    expect(logs.some((record) => record.level === 'error')).toBe(true)
    expect(checkKeyPair(good.key, other.cert)).toBe(false)

    // 换成配对的：这次成功
    writeFileSync(paths.privkey, other.key)
    expect(manager.reload('好证书')?.info.subject).toContain('CN=other.example.com')
  })

  it('自签证书过期时重新生成（时间推到 40 天后）', () => {
    const dir = tempDir()
    const paths = tlsPaths(dir)
    generateSelfSignedCertificate({
      certPath: paths.selfSignedCert,
      keyPath: paths.selfSignedKey,
      host: 'hub.example.com',
      days: 30,
    })
    const expiredAt = new Date(Date.now() + 40 * 86_400_000)
    let generated = 0
    const manager = createTlsManager({
      dataDir: dir,
      publicOrigin: 'https://hub.example.com:8443',
      log: fakeLog(),
      now: () => expiredAt,
      generate: (options) => {
        generated += 1
        generateSelfSignedCertificate(options)
      },
    })
    const material = manager.load()
    expect(generated).toBe(1)
    expect(material.source).toBe('self-signed')
    expect(material.info.daysRemaining).toBeGreaterThan(20)
  })

  it('剩余不足 14 天时每天 warn 一次', () => {
    const dir = tempDir()
    const paths = tlsPaths(dir)
    const short = generateTestCertificate({ dir: paths.dir, name: 'short', host: 'hub.example.com', days: 5 })
    writeFileSync(paths.fullchain, short.cert)
    writeFileSync(paths.privkey, short.key)
    const logs: LogRecord[] = []
    let today = new Date()
    const manager = createTlsManager({
      dataDir: dir,
      publicOrigin: 'https://hub.example.com:8443',
      log: fakeLog(logs),
      now: () => today,
    })
    const expiring = (): number =>
      logs.filter((record) => record.level === 'warn' && record.message.includes('天到期')).length
    manager.load()
    expect(expiring()).toBe(1)
    // 同一天再查：不重复提示
    manager.reload('同一天')
    expect(expiring()).toBe(1)
    // 第二天：再提示一次
    today = new Date(today.getTime() + 86_400_000)
    manager.reload('第二天')
    expect(expiring()).toBe(2)
  })
})
