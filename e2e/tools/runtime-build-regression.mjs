// 真实构建回归（10 的「验证 2」）：
// 隔离环境（HUB_ENV_ID=wp8b / 前缀 dshhub-test-wp8b- / 网络 dshhub-test-wp8b-net / 子网 10.219.21.0/24
// / 端口 7792 / 全新数据目录 / **不预先建网络**）→ 经管理接口构建一个 DSH 版本 →
// 任务 succeeded、版本 ready、冒烟通过 → 经接口删除该版本、镜像被移除。
//
// 用法（先 `pnpm -r build`）：
//   node e2e/tools/runtime-build-regression.mjs
//   HUB_REGRESSION_VERSION=0.2.1-alpha.2 node e2e/tools/runtime-build-regression.mjs
//
// 隔离参数可用 E2E_* 覆盖（与 src/config.ts 同口径）。结束会清理自己创建的容器/网络/目标镜像，
// 并核对 dshhub/runtime:0.2.0-rc.2 仍在（绝不删别的镜像）。
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const DATA_DIR = process.env['E2E_REGRESSION_DATA_DIR'] ?? join(REPO, 'e2e', '.data', 'wp8b-regression')
const PORT = Number(process.env['E2E_HTTP_PORT'] ?? 7792)
const BASE = `http://127.0.0.1:${String(PORT)}`
const TARGET = process.env['HUB_REGRESSION_VERSION'] ?? '0.2.1-alpha.2'
const IMAGE = `dshhub/runtime:${TARGET}`
const KEEP_IMAGE = 'dshhub/runtime:0.2.0-rc.2'
const NETWORK = process.env['E2E_USERS_NETWORK'] ?? 'dshhub-test-wp8b-net'
const SUBNET = process.env['E2E_USERS_SUBNET'] ?? '10.219.21.0/24'
const ENV_ID = process.env['E2E_ENV_ID'] ?? 'wp8b'
const PREFIX = `dshhub-test-${ENV_ID}-`
const ADMIN_USER = 'hubadmin'
const ADMIN_PASSWORD = 'Wp8b-Regression-2026'

const baseEnv = {
  ...process.env,
  HUB_DATA_DIR: DATA_DIR,
  HUB_HTTP_PORT: String(PORT),
  HUB_TLS_PORT: '0',
  HUB_REDIRECT_PORT: '0',
  HUB_PUBLIC_ORIGIN: BASE,
  HUB_COOKIE_SECURE: 'false',
  HUB_CONTAINER_DRIVER: 'docker',
  HUB_USERS_NETWORK: NETWORK,
  HUB_USERS_SUBNET: SUBNET,
  HUB_ENV_ID: ENV_ID,
  HUB_CONTAINER_PREFIX: PREFIX,
  HUB_DEFAULT_DSH_VERSION: '0.2.0-rc.2',
  HUB_LOG_LEVEL: 'info',
  NODE_ENV: 'production',
  http_proxy: '',
  https_proxy: '',
  HTTP_PROXY: '',
  HTTPS_PROXY: '',
  ALL_PROXY: '',
  all_proxy: '',
  NODE_USE_ENV_PROXY: '',
}

const log = (msg) => process.stdout.write(`[regression] ${msg}\n`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function docker(args) {
  const res = spawnSync('docker', args, { encoding: 'utf8' })
  return { code: res.status ?? -1, out: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() }
}

async function waitHealth(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) {
        const body = await res.json()
        if (body.ok) return body
      }
    } catch {
      // 还没起来
    }
    if (Date.now() > deadline) throw new Error('Hub 60s 内未就绪')
    await sleep(500)
  }
}

let cookie = ''
async function api(method, path, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  })
  const text = await res.text()
  let body
  try {
    body = text.length > 0 ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body, headers: res.headers }
}

const hub = spawn('node', [join(REPO, 'apps/api/dist/main.js')], {
  cwd: REPO,
  env: baseEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
})
const hubLog = []
for (const stream of [hub.stdout, hub.stderr]) {
  stream.on('data', (chunk) => {
    hubLog.push(chunk.toString('utf8'))
    if (hubLog.length > 2000) hubLog.splice(0, hubLog.length - 2000)
  })
}

let failed = false
try {
  rmSync(DATA_DIR, { recursive: true, force: true })
  mkdirSync(DATA_DIR, { recursive: true })

  const netBefore = docker(['network', 'ls', '--filter', `name=^${NETWORK}$`, '--format', '{{.Name}}'])
  log(`构建前网络 ${NETWORK}：${netBefore.out === '' ? '不存在（符合预期）' : netBefore.out}`)
  if (netBefore.out !== '') throw new Error('回归要求「不预先创建网络」，请先删掉它')

  const health = await waitHealth()
  log(`Hub 就绪：${JSON.stringify(health)}`)

  const admin = spawnSync(
    'node',
    [join(REPO, 'apps/api/dist/cli.js'), 'create-admin', '--username', ADMIN_USER, '--password-stdin'],
    { cwd: REPO, env: baseEnv, input: `${ADMIN_PASSWORD}\n`, encoding: 'utf8' },
  )
  log(`create-admin exit=${String(admin.status)}：${(admin.stdout ?? '').trim()}`)
  if (admin.status !== 0) throw new Error('create-admin 失败')

  const login = await api('POST', '/api/auth/login', { username: ADMIN_USER, password: ADMIN_PASSWORD })
  cookie = (login.headers.getSetCookie?.() ?? []).map((item) => item.split(';')[0]).join('; ')
  log(`登录：HTTP ${String(login.status)}，cookie ${cookie.length > 0 ? '已拿到' : '缺失'}`)
  if (login.status !== 200 || cookie.length === 0) {
    throw new Error(`登录失败：${JSON.stringify(login.body)}`)
  }

  const created = await api('POST', '/api/admin/runtimes', { dshVersion: TARGET })
  log(`POST /api/admin/runtimes → HTTP ${String(created.status)} ${JSON.stringify(created.body)}`)
  if (created.status !== 202) throw new Error('创建构建任务失败')
  const runtimeId = created.body.runtime.id
  const jobId = created.body.jobId

  const startedAt = Date.now()
  let job = null
  for (;;) {
    const res = await api('GET', `/api/admin/jobs/${String(jobId)}`)
    job = res.body.job
    const tasks = res.body.tasks.map((t) => `${t.status}${t.error ? `(${t.error})` : ''}`).join(',')
    log(`  ${((Date.now() - startedAt) / 1000).toFixed(0)}s job=${job.status} tasks=[${tasks}]`)
    if (['succeeded', 'failed', 'partial', 'canceled'].includes(job.status)) break
    if (Date.now() - startedAt > 20 * 60_000) throw new Error('构建任务 20 分钟未结束')
    await sleep(5000)
  }
  const detail = await api('GET', `/api/admin/jobs/${String(jobId)}`)
  const taskId = detail.body.tasks[0].id
  const taskLog = await api('GET', `/api/admin/jobs/${String(jobId)}/tasks/${String(taskId)}/log`)
  const logText = taskLog.body.text ?? ''
  log(`构建任务终态：${job.status}（${((Date.now() - startedAt) / 1000).toFixed(0)}s）`)
  log(`任务日志末尾：\n${logText.split('\n').slice(-12).join('\n')}`)
  if (job.status !== 'succeeded') throw new Error(`构建任务不是 succeeded：${job.status}`)

  const list = await api('GET', '/api/admin/runtimes')
  const row = list.body.find((item) => item.id === runtimeId)
  log(`runtime 行：${JSON.stringify(row)}`)
  if (row?.status !== 'ready') throw new Error(`版本不是 ready：${JSON.stringify(row)}`)
  const img = docker(['image', 'inspect', IMAGE, '--format', '{{.Id}} {{.Size}}'])
  log(`镜像存在：${img.code === 0 ? img.out : '否'}`)
  if (img.code !== 0) throw new Error('镜像不存在')

  const removed = await api('DELETE', `/api/admin/runtimes/${String(runtimeId)}`)
  log(`DELETE /api/admin/runtimes/${String(runtimeId)} → HTTP ${String(removed.status)}`)
  if (removed.status !== 204) throw new Error(`删除失败：${String(removed.status)}`)
  const imgAfter = docker(['image', 'inspect', IMAGE])
  log(`删除后镜像存在：${imgAfter.code === 0 ? '是（异常）' : '否（已移除）'}`)
  if (imgAfter.code === 0) throw new Error('镜像没有被移除')
  const listAfter = await api('GET', '/api/admin/runtimes')
  log(`删除后版本行数：${String(listAfter.body.length)}`)

  const containers = docker([
    'ps',
    '-a',
    '--filter',
    `label=dshhub.env=${ENV_ID}`,
    '--format',
    '{{.Names}} {{.Image}} {{.Status}}',
  ])
  log(`本环境遗留容器：${containers.out === '' ? '无' : containers.out}`)
  const keep = docker(['image', 'inspect', KEEP_IMAGE, '--format', '{{.Id}}'])
  log(`${KEEP_IMAGE} 仍在：${keep.code === 0 ? '是' : '否（异常！）'}`)
  if (keep.code !== 0) throw new Error(`误删了 ${KEEP_IMAGE}`)
  log('✅ 真实构建回归通过')
} catch (error) {
  failed = true
  log(`❌ 回归失败：${error instanceof Error ? error.message : String(error)}`)
  log(`Hub 日志尾巴：\n${hubLog.join('').split('\n').slice(-40).join('\n')}`)
} finally {
  hub.kill('SIGTERM')
  await sleep(3000)
  if (hub.exitCode === null) hub.kill('SIGKILL')
  const leftovers = docker([
    'ps',
    '-a',
    '--filter',
    `network=${NETWORK}`,
    '--filter',
    'label=dshhub.managed=1',
    '--format',
    '{{.Names}}',
  ])
  for (const name of leftovers.out.split('\n').map((s) => s.trim()).filter(Boolean)) {
    log(`清理容器 ${name}：${docker(['rm', '-f', name]).code === 0 ? 'ok' : '失败'}`)
  }
  const net = docker(['network', 'rm', NETWORK])
  log(`清理网络 ${NETWORK}：${net.code === 0 ? '已删除' : '本就不存在（说明全程没建过用户网络）'}`)
  const leftoverImage = docker(['images', '--format', '{{.Repository}}:{{.Tag}}', IMAGE])
  if (leftoverImage.out.includes(IMAGE)) {
    log(`清理镜像 ${IMAGE}：${docker(['rmi', IMAGE]).code === 0 ? 'ok' : '失败'}`)
  }
  log(`数据目录保留：${DATA_DIR}（dirname 见 e2e/.data/）`)
}
process.exitCode = failed ? 1 : 0
