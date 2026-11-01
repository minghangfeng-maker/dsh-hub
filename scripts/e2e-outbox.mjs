#!/usr/bin/env node
/**
 * 发送队列（Outbox）持久化端到端探针：
 *
 *   **唤醒期间输入两条 → 杀掉页面重开 → 两条仍在、并在连上后按序发出**
 *
 * 这是 WP46 第一阶段 A（Outbox 下沉到 core 并持久化）的验收脚本：
 *  - 队列条目落 IndexedDB（按 accountKey + backendId 隔离），App 被杀也不丢；
 *  - 冷启动恢复后仍然显示成「待发气泡」（不需要先连上通道）；
 *  - 连上之后由 core 自己「先建会话、再按序发首条」，幂等键 = 队列 id（clientMessageId）。
 *
 * 用法（**hub 需要更长的唤醒窗口**：默认 WAKE_MS=1200 太短，来不及在「唤醒中」打两条）：
 *
 *   TICK_MS=12 WAKE_MS=6000 PORT=5249 node apps/mock-hub/server.mjs
 *   cd packages/mobile-ui && VITE_HUB_ORIGIN=http://127.0.0.1:5249 ./node_modules/.bin/vite --port 5250
 *   ~/.local/bin/google-chrome --headless=new --remote-debugging-port=9249 \
 *     --user-data-dir=/tmp/e2e-profile-outbox about:blank      # 必须是全新 profile
 *   node scripts/e2e-outbox.mjs --app http://127.0.0.1:5250 --hub http://127.0.0.1:5249 --cdp 9249
 */

import fs from 'node:fs/promises'
import path from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]])
    return acc
  }, []),
)

const CDP_PORT = Number(args.cdp ?? 9249)
const APP_URL = args.app ?? 'http://127.0.0.1:5250'
const HUB_URL = args.hub ?? 'http://127.0.0.1:5249'
const OUT = args.out ?? 'e2e-outbox-output'
const VIEWPORT = { width: 412, height: 915, dpr: 2.625 }

const FIRST = '第一条：唤醒期间打的'
const SECOND = '第二条：也还没发出去'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 0
    this.pending = new Map()
    this.listeners = new Map()
  }
  static async attach(port) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = targets.find((t) => t.type === 'page')
    if (!page) throw new Error('没有可用的 page target')
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    const cdp = new Cdp(ws)
    ws.addEventListener('message', (ev) => cdp.onMessage(JSON.parse(ev.data)))
    return cdp
  }
  onMessage(msg) {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
      return
    }
    const cbs = this.listeners.get(msg.method)
    if (cbs) for (const cb of cbs) cb(msg.params)
  }
  send(method, params = {}) {
    const id = ++this.nextId
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (res.exceptionDetails) {
      throw new Error(`eval 失败: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`)
    }
    return res.result?.value
  }
  async shot(name) {
    const res = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const file = path.join(OUT, `${name}.png`)
    await fs.writeFile(file, Buffer.from(res.data, 'base64'))
    return file
  }
}

const checks = []
function expect(name, ok, detail) {
  checks.push({ name, ok, detail })
  console.log(
    `${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`,
  )
}

async function waitFor(cdp, expr, { timeout = 20000, label = expr } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await cdp.eval(`!!(${expr})`)) return true
    await sleep(100)
  }
  throw new Error(`等待超时：${label}`)
}

/** 页面上有登录表单就登录（Web 开发环境没有 SecureStorage，整页重载后令牌不跨页）。 */
async function ensureLoggedIn(cdp) {
  await sleep(400)
  const hasLogin = await cdp.eval(`!!document.querySelector('.login')`)
  if (hasLogin) {
    await cdp.eval(`(() => {
      const set = (sel, v) => { const el = document.querySelector(sel); if (!el) return; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
      set('input[name=username]', 'demo')
      set('input[name=password]', 'demo1234')
      return true
    })()`)
    await sleep(100)
    await cdp.eval(`document.querySelector('.login__submit').click()`)
  }
  await waitFor(cdp, `window.__dshHub?.auth.phase === 'authenticated'`, { label: '登录成功', timeout: 30000 })
}

async function hubStatus(user = 'demo') {
  const res = await fetch(`${HUB_URL}/__test/status?user=${user}`)
  return res.json()
}

/** 输入卡里打一行字并点发送（与真机同一条路径：Composer 的 input + send-btn）。 */
async function typeAndSend(cdp, text) {
  await cdp.eval(`(() => {
    const el = document.querySelector('.composer__input')
    if (!el) return false
    el.value = ${JSON.stringify(text)}
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(120)
  const clicked = await cdp.eval(`(() => {
    const btn = document.querySelector('.send-btn')
    if (!btn) return false
    btn.click()
    return true
  })()`)
  if (!clicked) throw new Error('找不到发送按钮（.send-btn）')
  await sleep(150)
}

async function clearStorage(cdp) {
  // 队列/会话缓存都在 IndexedDB 里：跨脚本复跑时必须清干净，否则「首次走网络」之类的断言没意义。
  return await cdp.eval(`(async () => {
    try { localStorage.clear() } catch {}
    try {
      const dbs = await indexedDB.databases()
      for (const db of dbs) if (db.name) indexedDB.deleteDatabase(db.name)
    } catch {}
    return true
  })()`)
}

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  const cdp = await Cdp.attach(CDP_PORT)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: VIEWPORT.dpr,
    mobile: true,
  })
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })

  const consoleErrors = []
  cdp.listeners.set('Runtime.consoleAPICalled', new Set())
  cdp.listeners.get('Runtime.consoleAPICalled').add((p) => {
    if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.description ?? a.value).join(' '))
  })

  // ---- 0. 干净登录
  await fetch(`${HUB_URL}/__test/reset`, { method: 'POST' })
  await cdp.send('Page.navigate', { url: 'about:blank' })
  await sleep(300)
  await cdp.send('Page.navigate', { url: `${APP_URL}/#/login` })
  await sleep(700)
  await clearStorage(cdp)
  await cdp.send('Page.reload')
  await sleep(900)
  await waitFor(cdp, `document.querySelector('.login')`, { label: '登录页' })
  await cdp.eval(`(() => {
    const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
    set('input[name=username]', 'demo')
    set('input[name=password]', 'demo1234')
    return true
  })()`)
  await sleep(100)
  await cdp.eval(`document.querySelector('.login__submit').click()`)
  await waitFor(cdp, `window.__dshHub?.auth.phase === 'authenticated'`, { label: '登录成功' })

  // ---- 1. 唤醒窗口里打两条（此刻后端不可连接、通道还没起）
  const waking = await cdp.eval(`(() => {
    const h = window.__dshHub
    return { wake: h.backend?.wakeState, link: h.chat?.link, connectable: h.backend?.selectedBackend?.connectable }
  })()`)
  expect(
    '先确认处在「唤醒中 / 未连接」窗口（需要 WAKE_MS 调大，见脚本头）',
    waking.wake === 'waking' || waking.link !== 'connected' || waking.connectable === false,
    waking,
  )

  await typeAndSend(cdp, FIRST)
  // 首页发完会跳到 /c/new：第二条在对话页输入卡里打。
  await sleep(400)
  await typeAndSend(cdp, SECOND)

  const queued = await cdp.eval(`(() => {
    const h = window.__dshHub
    return {
      texts: h.chat.outbox.map((entry) => entry.text),
      pendingSendCount: h.chat.pendingSendCount,
      link: h.chat.link,
      bubbles: Array.from(document.querySelectorAll('.msg-user')).map((el) => el.innerText.trim()),
    }
  })()`)
  expect(
    '唤醒期间两条都进了发送队列（还没有会话、一条都没发）',
    queued.texts.length === 2 && queued.texts[0] === FIRST && queued.texts[1] === SECOND && queued.pendingSendCount === 0,
    queued.texts,
  )
  expect('队列气泡已经显示在对话页（待发）', queued.bubbles.some((text) => text.includes(FIRST)), queued.bubbles)
  const beforeKill = await hubStatus()
  const sessionIdsBeforeKill = new Set(beforeKill.sessions.map((row) => row.sessionId))
  await cdp.shot('01-waiting-queue')

  // ---- 2. 杀掉页面（换一个空白页 = JS 上下文全丢，IndexedDB 保留）
  await cdp.send('Page.navigate', { url: 'about:blank' })
  await sleep(400)
  // 顺手把 mock Hub 的实例/令牌也重置：重开后又是一个「唤醒中」的窗口，
  // 这样能明确断言「**连上之前**，恢复的条目已经显示成待发气泡」。
  // （Web 开发环境没有 SecureStorage，令牌本来就不跨页持久，重开必须重新登录。）
  await fetch(`${HUB_URL}/__test/reset`, { method: 'POST' })

  // ---- 3. 重开：冷启动先恢复队列（此时通道还没连上，也要能看到待发气泡）
  await cdp.send('Page.navigate', { url: `${APP_URL}/#/login` })
  await sleep(900)
  await ensureLoggedIn(cdp)
  await waitFor(cdp, `window.__dshHub?.chat?.outbox?.length === 2`, { label: '冷启动恢复队列', timeout: 20000 })
  // 队列气泡在对话页：现在还在唤醒中（通道没连上），导航过去看「待发气泡」。
  await cdp.eval(`(() => { location.hash = '#/c/new'; return true })()`)
  await sleep(500)
  const restored = await cdp.eval(`(() => {
    const h = window.__dshHub
    return {
      texts: h.chat.outbox.map((entry) => entry.text),
      link: h.chat.link,
      bubbles: Array.from(document.querySelectorAll('.msg-user')).map((el) => el.innerText.trim()),
    }
  })()`)
  expect(
    '杀掉页面重开后两条仍在（顺序不变）',
    restored.texts.length === 2 && restored.texts[0] === FIRST && restored.texts[1] === SECOND,
    restored.texts,
  )
  expect(
    '恢复的条目已经显示成待发气泡（连上之前）',
    restored.link !== 'connected' &&
      restored.bubbles.some((text) => text.includes(FIRST)) &&
      restored.bubbles.some((text) => text.includes(SECOND)),
    { link: restored.link, bubbles: restored.bubbles },
  )
  await cdp.shot('02-restored-before-connect')

  // ---- 4. 连上之后：core 自己建会话 + 按序发出
  await waitFor(cdp, `window.__dshHub?.chat.link === 'connected'`, { label: '通道连接', timeout: 40000 })
  await waitFor(cdp, `window.__dshHub.chat.outbox.length === 0`, { label: '队列清空（两条都发出）', timeout: 30000 })
  await waitFor(cdp, `(window.__dshHub.chat.state?.messages ?? []).filter((m) => m.role === 'user').length >= 2`, {
    label: '两条 canonical 消息回到会话',
    timeout: 30000,
  })
  const after = await cdp.eval(`(() => {
    const h = window.__dshHub
    const users = (h.chat.state?.messages ?? []).filter((m) => m.role === 'user')
    return {
      texts: users.map((m) => m.text),
      seqs: users.map((m) => m.seq),
      activeId: h.chat.activeId,
      hash: location.hash,
      pendingLeft: h.chat.outbox.length,
    }
  })()`)
  expect(
    '连上后按入队顺序发出（服务端回显的 seq 递增、文本顺序一致）',
    after.texts[0] === FIRST && after.texts[1] === SECOND && after.seqs[1] > after.seqs[0],
    { texts: after.texts, seqs: after.seqs },
  )
  expect('为了发首条自动建了会话并打开（/c/<id>）', !!after.activeId && after.hash === `#/c/${after.activeId}`, {
    activeId: after.activeId,
    hash: after.hash,
  })

  const statusAfter = await hubStatus()
  const created = statusAfter.sessions.filter((row) => !sessionIdsBeforeKill.has(row.sessionId))
  expect(
    'Hub 侧只多了一个会话（两条消息进了同一个会话，没有重复建会话）',
    statusAfter.sessions.length === sessionIdsBeforeKill.size + 1 && created.length === 1,
    { before: sessionIdsBeforeKill.size, after: statusAfter.sessions.length, created: created.map((row) => row.title) },
  )
  expect(
    'Hub 收到的会话标题 = 第一条消息（说明第一条先到）',
    created.length === 1 && String(created[0].title ?? '').startsWith(FIRST.slice(0, 12)),
    created.map((row) => row.title),
  )
  await cdp.shot('03-sent-after-reconnect')

  // ---- 5. 队列已清空：再重开不会重发（幂等语义）
  await cdp.send('Page.navigate', { url: 'about:blank' })
  await sleep(300)
  await cdp.send('Page.navigate', { url: `${APP_URL}/#/` })
  await sleep(800)
  await ensureLoggedIn(cdp)
  await sleep(1500)
  const replay = await cdp.eval(`(() => {
    const h = window.__dshHub
    return { outbox: h.chat.outbox.length, users: (h.chat.state?.messages ?? []).filter((m) => m.role === 'user').length }
  })()`)
  expect('已经发出去的条目不会再排队重发（杀掉重开队列为空）', replay.outbox === 0, replay)

  expect('控制台无错误', consoleErrors.length === 0, consoleErrors.slice(0, 5))

  const passed = checks.filter((c) => c.ok).length
  const report = {
    at: new Date().toISOString(),
    app: APP_URL,
    hub: HUB_URL,
    checks,
    passed,
    total: checks.length,
  }
  await fs.writeFile(path.join(OUT, 'outbox-e2e.json'), JSON.stringify(report, null, 2))
  console.log(`\n结果：${passed}/${checks.length} 通过，报告 ${path.join(OUT, 'outbox-e2e.json')}`)
  if (passed !== checks.length) process.exitCode = 1
  cdp.ws.close()
}

main().catch(async (error) => {
  console.error('e2e 失败：', error)
  process.exitCode = 1
})
