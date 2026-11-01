import { createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_COOKIE_TTL_MS,
  MAX_COOKIE_TTL_MS,
  b64url,
  createDshCookieMinter,
  mintDshCookie,
  readBrowserSessionSecret,
} from '../src/modules/instances/dsh-cookie.js'

/**
 * cookie 签发必须与夹具里的参考实现 `fixtures/dsh-browser-auth.mjs`
 * （以及 `@deepseek-ai/dsh-client-connection` 的 BrowserAuth）**逐字节一致**——
 * 差一个字符实例就会 401，而且是那种「看起来都对」的故障。
 */
const spike = (await import(new URL('./fixtures/dsh-browser-auth.mjs', import.meta.url).href)) as {
  mintCookie(input: { authority: string; secret: Buffer; now?: number; ttlMs?: number }): string
  readBrowserSessionSecret(dshHome: string): Buffer
}

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshhub-cookie-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('DSH cookie 签发（05 §5）', () => {
  it('与 mint-cookie.mjs 逐字节一致（固定向量）', () => {
    const secret = Buffer.alloc(32, 7)
    const now = 1_760_000_000_000
    const authority = '127.0.0.1:3000'
    const ours = mintDshCookie({ authority, secret, now })
    const theirs = spike.mintCookie({ authority, secret, now })
    expect(`${ours.name}=${ours.value}`).toBe(theirs)
  })

  it('随机 20 组 authority/secret/TTL 也逐字节一致', () => {
    for (let index = 0; index < 20; index += 1) {
      const secret = randomBytes(32)
      const authority = index % 2 === 0 ? '127.0.0.1:3000' : `dshhub-${b64url(randomBytes(6))}:3000`
      const now = 1_700_000_000_000 + index * 1234
      const ttlMs = index % 3 === 0 ? DEFAULT_COOKIE_TTL_MS : 60_000 + index
      const ours = mintDshCookie({ authority, secret, now, ttlMs })
      const theirs = spike.mintCookie({ authority, secret, now, ttlMs })
      expect(`${ours.name}=${ours.value}`).toBe(theirs)
    }
  })

  it('cookie 名 = dsh-auth-<base64url(sha256(authority))>，值形如 v1.<body>.<sig>', () => {
    const secret = Buffer.alloc(32, 1)
    const authority = '127.0.0.1:3000'
    const { name, value } = mintDshCookie({ authority, secret, now: 1 })
    expect(name).toBe(`dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`)
    const [version, body, signature] = value.split('.')
    expect(version).toBe('v1')
    const payload = JSON.parse(Buffer.from(body!, 'base64').toString('utf8')) as {
      version: number
      authority: string
      issuedAt: number
      expiresAt: number
    }
    expect(payload).toEqual({
      version: 1,
      authority,
      issuedAt: 1,
      expiresAt: 1 + DEFAULT_COOKIE_TTL_MS,
    })
    expect(signature).toBe(b64url(createHmac('sha256', secret).update(body!).digest()))
  })

  it('跨度超过 25 天直接抛错（签了也会被实例拒）', () => {
    const secret = Buffer.alloc(32, 2)
    expect(() =>
      mintDshCookie({ authority: '127.0.0.1:3000', secret, now: 0, ttlMs: MAX_COOKIE_TTL_MS }),
    ).not.toThrow()
    expect(() =>
      mintDshCookie({ authority: '127.0.0.1:3000', secret, now: 0, ttlMs: MAX_COOKIE_TTL_MS + 1 }),
    ).toThrow(/上限/)
  })

  it('secret 必须是 32 字节、authority 不能为空', () => {
    expect(() => mintDshCookie({ authority: '127.0.0.1:3000', secret: Buffer.alloc(16), now: 0 })).toThrow(
      /32 字节/,
    )
    expect(() => mintDshCookie({ authority: '', secret: Buffer.alloc(32), now: 0 })).toThrow(/authority/)
  })
})

describe('browser-session 密钥读取（05 §5）', () => {
  it('用正则读出 43 字符 base64url 密钥，且与 spike 实现同值', () => {
    const dir = tempDir()
    const secret = randomBytes(32)
    const secretB64 = b64url(secret)
    writeFileSync(
      join(dir, '.credentials.yaml'),
      [
        'version: 1',
        'records:',
        '  client-connection/browser-session:',
        '    payload:',
        `      secret: ${secretB64}`,
        '',
      ].join('\n'),
    )
    const parsed = readBrowserSessionSecret(dir)
    expect(parsed.secret.equals(secret)).toBe(true)
    expect(parsed.mtimeMs).toBeGreaterThan(0)
    expect(spike.readBrowserSessionSecret(dir).equals(secret)).toBe(true)
  })

  it('文件缺失或结构不对时报 INSTANCE_START_FAILED', () => {
    const dir = tempDir()
    expect(() => readBrowserSessionSecret(dir)).toThrow(/browser-session 密钥/)
    writeFileSync(join(dir, '.credentials.yaml'), 'records: {}\n')
    expect(() => readBrowserSessionSecret(dir)).toThrow(/browser-session 密钥未出现/)
  })
})

describe('签发器缓存（05 §5：mtime 缓存 + cookie 缓存 50 分钟）', () => {
  it('缓存命中复用同一枚 cookie；invalidate 后重签', () => {
    const dir = tempDir()
    const secret = randomBytes(32)
    writeFileSync(
      join(dir, '.credentials.yaml'),
      `records:\n  client-connection/browser-session:\n    payload:\n      secret: ${b64url(secret)}\n`,
    )
    let nowMs = 1_000_000
    const minter = createDshCookieMinter({
      dshHome: dir,
      clock: { now: () => new Date(nowMs), nowIso: () => new Date(nowMs).toISOString() },
    })
    const first = minter.cookie('127.0.0.1:3000')
    const second = minter.cookie('127.0.0.1:3000')
    expect(second).toEqual(first)

    nowMs += 3_000_001
    const third = minter.cookie('127.0.0.1:3000')
    expect(third.value).not.toBe(first.value)
    expect(third.name).toBe(first.name)

    minter.invalidate()
    expect(minter.secretReady()).toBe(true)
    expect(minter.cookie('127.0.0.1:3000').name).toBe(first.name)
  })

  it('secretReady 在密钥还没落盘时是 false（就绪判据 ③）', () => {
    const dir = tempDir()
    const minter = createDshCookieMinter({ dshHome: dir })
    expect(minter.secretReady()).toBe(false)
    expect(() => minter.cookie('127.0.0.1:3000')).toThrow()
  })
})
