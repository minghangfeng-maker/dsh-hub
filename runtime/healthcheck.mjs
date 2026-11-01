#!/usr/bin/env node
/**
 * 容器内就绪探针：等价于 05 §6 就绪判据的第 ③④ 步。
 *
 *   node /opt/hub/healthcheck.mjs [authority]
 *
 * 步骤：读 $DSH_HOME/.credentials.yaml 的 browser-session 密钥 → 现签 cookie →
 * 用 `Host: <authority>` 请求本机 `dsh web` 首页 → 断言 200 且响应含
 * `__DSH_BOOT__`。退出码 0 = 就绪，1 = 未就绪（stderr 说明原因）。
 *
 * 之所以自带一份签发实现而不 import：本文件要能被 `podman healthcheck` 与
 * Hub 的 `driver.exec(容器, ['node','/opt/hub/healthcheck.mjs'])` 直接运行，
 * 镜像内没有 Hub 的 scripts/ 目录；Hub 侧的同名实现见 scripts/spike/mint-cookie.mjs。
 */
import { readFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'
import { request } from 'node:http'

const DSH_HOME = process.env.DSH_HOME ?? '/home/dsh/.dsh'
const PORT = Number(process.env.DSH_PORT ?? 3000)
const AUTHORITY = process.argv[2] ?? process.env.DSH_AUTHORITY
const TIMEOUT_MS = Number(process.env.DSH_HEALTHCHECK_TIMEOUT_MS ?? 5000)

/** base64url，无填充（与 DSH BrowserAuth 一致）。 */
function b64url(value) {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/**
 * 从 .credentials.yaml 里取 browser-session 密钥。
 * 不引入 YAML 依赖：只看 `records` 下该记录块的 `secret:` 一行（DSH 生成的文件结构稳定）。
 * @returns {Buffer} 32 字节密钥
 */
function readSecret() {
  const text = readFileSync(`${DSH_HOME}/.credentials.yaml`, 'utf8')
  const match = /client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]{43})/u.exec(text)
  if (!match) throw new Error(`browser-session secret not found in ${DSH_HOME}/.credentials.yaml`)
  const secret = Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/') + '=', 'base64')
  if (secret.byteLength !== 32) throw new Error('browser-session secret is not 32 bytes')
  return secret
}

/**
 * 现签一枚 DSH 浏览器 cookie。
 * @param authority - 上游将看到的 Host（宿主里的真实回环端口不影响它）
 * @param secret - 32 字节密钥
 * @param ttlMs - 有效期跨度，必须 ≤ DSH 的 cookieMaxAgeDays（默认 30 天）
 * @returns `name=value` 形式的 cookie
 */
function mintCookie(authority, secret, ttlMs = 3_600_000) {
  const issuedAt = Date.now()
  const body = b64url(
    Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + ttlMs }), 'utf8'),
  )
  const value = `v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`
  const name = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`
  return `${name}=${value}`
}

/**
 * 请求首页，判断是否就绪。
 * @returns 就绪返回 true；否则 false 并打印原因
 */
function probe() {
  if (AUTHORITY === undefined || AUTHORITY === '') {
    throw new Error('authority is required: pass it as argv[2] or set DSH_AUTHORITY')
  }
  const cookie = mintCookie(AUTHORITY, readSecret())
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/',
        method: 'GET',
        headers: { host: AUTHORITY, cookie, accept: 'text/html' },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode !== 200) {
            console.error(`healthcheck: GET / -> ${String(res.statusCode)} (expect 200)`)
            resolve(false)
            return
          }
          if (!text.includes('__DSH_BOOT__')) {
            console.error('healthcheck: 200 but the document carries no __DSH_BOOT__')
            resolve(false)
            return
          }
          resolve(true)
        })
      },
    )
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')))
    req.on('error', (error) => {
      console.error(`healthcheck: ${error.message}`)
      resolve(false)
    })
    req.end()
  })
}

probe()
  .then((ok) => {
    if (ok) console.log('healthcheck: ready')
    process.exitCode = ok ? 0 : 1
  })
  .catch((error) => {
    console.error(`healthcheck: ${error.message}`)
    process.exitCode = 1
  })
