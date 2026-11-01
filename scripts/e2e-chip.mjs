#!/usr/bin/env node
/**
 * 芯片（模型段 + 强度段）交互探针：真 HTTP + 真 CDP touch 事件，不是只在 DOM 里调函数。
 *
 * 覆盖（对应 UI 改造验收）：
 *   1. 对话页芯片显示「模型短名 + 强度英文短名」，两段各自可点；
 *   2. 点模型段 → 模型选择弹层（顶部「后端」段 + 模型列表，不出现 provider/服务器地址）；
 *   3. 点另一个模型 → 芯片模型名立即变化，set-model 作用到当前会话；
 *   4. 点强度段 → 拖动条弹层（role=slider + aria-valuemin/max/now），四档刻度齐全；
 *   5. 真实触摸拖动到「超高 / Max」→ 档位与芯片文案立即变化；点刻度标签也能直达；
 *   6. 系统字体放大 130% 时芯片单行、不溢出、不裁字。
 *
 * 用法（mock Hub 与 preview 先起好，Chrome 开 CDP 端口）：
 *   node scripts/e2e-chip.mjs --app http://127.0.0.1:5242 --hub http://127.0.0.1:5245 \
 *        --cdp 9241 --out ../mobile-plan/v2/artifacts/ui-chip
 */

import fs from 'node:fs/promises'
import path from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]])
    return acc
  }, []),
)

const CDP_PORT = Number(args.cdp ?? 9241)
const APP_URL = args.app ?? 'http://127.0.0.1:5242'
const HUB_URL = args.hub ?? 'http://127.0.0.1:5245'
const OUT = args.out ?? 'e2e-chip-output'
const VIEWPORT = { width: 393, height: 852, dpr: 3 }

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
  async eval(expression, { awaitPromise = false } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    })
    if (res.exceptionDetails) {
      throw new Error(
        `eval 失败: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`,
      )
    }
    return res.result?.value
  }
  async shot(name) {
    const res = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    })
    const file = path.join(OUT, `${name}.png`)
    await fs.writeFile(file, Buffer.from(res.data, 'base64'))
    return file
  }
}

const checks = []
function expect(name, ok, detail) {
  checks.push({ name, ok, detail })
  const shown = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  console.log(`${ok ? '✓' : '✗'} ${name}${shown}`)
}

async function waitFor(cdp, expr, { timeout = 20000, label = expr } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await cdp.eval(`!!(${expr})`)) return true
    await sleep(100)
  }
  throw new Error(`等待超时：${label}`)
}

async function touchStart(cdp, x, y) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
}
async function touchMove(cdp, x, y) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] })
}
async function touchEnd(cdp) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

/** 元素中心点（用于真实触摸命中测试）。 */
async function centerOf(cdp, selector) {
  const rect = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
  })()`)
  if (!rect) throw new Error(`找不到元素：${selector}`)
  return rect
}

/** 真触摸点按（不是 DOM click）：能覆盖按钮的命中区域与 WebView 的默认行为。 */
async function tap(cdp, selector) {
  const point = await centerOf(cdp, selector)
  await touchStart(cdp, point.x, point.y)
  await sleep(60)
  await touchEnd(cdp)
  await sleep(220)
}

/** 在滑块轨道上从 fromRatio 拖到 toRatio（0..1），中途给足点，模拟真人拖动。 */
async function dragSlider(cdp, fromRatio, toRatio) {
  const rail = await centerOf(cdp, '.effort__rail')
  const slider = await centerOf(cdp, '.effort__slider')
  const y = slider.y
  const xAt = (ratio) => rail.left + rail.width * ratio
  await touchStart(cdp, xAt(fromRatio), y)
  await sleep(40)
  const steps = 10
  for (let i = 1; i <= steps; i++) {
    await touchMove(cdp, xAt(fromRatio + ((toRatio - fromRatio) * i) / steps), y)
    await sleep(18)
  }
  await touchMove(cdp, xAt(toRatio), y)
  await touchEnd(cdp)
  await sleep(400)
}

/** 读芯片在 130% 字号下的排版状态：单行、无溢出、文本不被裁。 */
async function measureChipZoom(cdp) {
  return cdp.eval(`(() => {
    const chip = document.querySelector('.chip')
    const card = document.querySelector('.composer__card')
    const model = document.querySelector('.chip__model-text')
    const effort = document.querySelector('.chip__effort-text')
    const chipRect = chip.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    return {
      fontSize: getComputedStyle(model).fontSize,
      chipText: chip.innerText.replace(/\\s+/g, ' ').trim(),
      whiteSpace: getComputedStyle(chip).whiteSpace,
      chipLines: model.getClientRects().length,
      docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      chipRight: Math.round(chipRect.right),
      cardRight: Math.round(cardRect.right),
      chipWithinCard: chipRect.right <= cardRect.right + 1,
      modelClipped: model.scrollWidth - model.clientWidth,
      effortClipped: effort.scrollWidth - effort.clientWidth,
      rects: { chip: chipRect.width, card: cardRect.width },
    }
  })()`)
}

function chipSnapshotExpr() {
  return `(() => {
    const chip = document.querySelector('.chip')
    const model = document.querySelector('.chip__part--model')
    const effort = document.querySelector('.chip__part--effort')
    return {
      chipText: (chip?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
      model: (model?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
      effort: (effort?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
      modelAria: model?.getAttribute('aria-label') ?? null,
      effortAria: effort?.getAttribute('aria-label') ?? null,
      legacyChip: !!document.querySelector('.chip--legacy'),
    }
  })()`
}

// 模拟 Android「系统字体放大 1.3 倍」：一次性把所有元素按**原始**字号乘 1.3。
// 必须先取全部 base 再写入，否则父元素改完、子元素 getComputedStyle 会继承新值，
// 逐层放大成 1.3^深度（旧 layout 脚本就是这么把字号放大到 2 倍以上的）。
const SCALE_TEXT = (zoom) => `(() => {
  const els = [document.body, ...document.body.querySelectorAll('*')]
  const bases = els.map((el) => parseFloat(getComputedStyle(el).fontSize))
  let applied = 0
  els.forEach((el, i) => {
    const base = bases[i]
    if (!Number.isFinite(base)) return
    el.style.fontSize = (base * ${zoom}).toFixed(2) + 'px'
    applied++
  })
  return applied
})()`

const RESET_TEXT = `(() => {
  for (const el of document.querySelectorAll('[style]')) {
    if (el.style && el.style.fontSize) el.style.fontSize = ''
  }
  return true
})()`

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

  // ── 0. 干净状态 + 登录 ──────────────────────────────────────────────────
  await fetch(`${HUB_URL}/__test/reset`, { method: 'POST' })
  await cdp.send('Page.navigate', { url: 'about:blank' })
  await sleep(300)
  await cdp.send('Page.navigate', { url: `${APP_URL}/#/login` })
  await sleep(800)
  await cdp.eval(`(() => { try { localStorage.clear() } catch {} ; return true })()`)
  await cdp.send('Page.reload', { ignoreCache: false })
  await sleep(900)
  await waitFor(cdp, `document.querySelector('.login')`, { label: '登录页' })
  const origin = await cdp.eval(`window.__dshHub?.auth.origin ?? null`)
  expect(`构建产物指向本机 mock Hub（${origin}）`, origin === HUB_URL, origin)

  await cdp.eval(`(() => {
    const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
    set('input[name=username]', 'demo'); set('input[name=password]', 'demo1234')
    return true
  })()`)
  await sleep(150)
  await cdp.eval(`document.querySelector('.login__submit').click()`)
  await waitFor(cdp, `window.__dshHub?.auth.phase === 'authenticated'`, { label: '登录成功' })
  await waitFor(cdp, `window.__dshHub.chat.link === 'connected'`, { timeout: 15000, label: '通道连上' })
  await waitFor(cdp, `window.__dshHub.chat.sessions.length >= 2`, { timeout: 15000, label: '会话列表' })
  await waitFor(cdp, `window.__dshHub.models.features.includes('models')`, {
    timeout: 15000,
    label: 'models 能力',
  })
  await cdp.eval(`window.__dshHub.router.push('/c/s_mock_plan')`)
  await sleep(600)
  await waitFor(cdp, `document.querySelector('.chip')`, { label: '芯片' })
  await sleep(400)

  // ── 1. 对话页芯片：模型名 + 强度 ────────────────────────────────────────
  const chip = await cdp.eval(chipSnapshotExpr())
  const selection = await cdp.eval(`(() => {
    const a = window.__dshHub.models
    return { model: a.selection?.model ?? null, tier: a.selection?.effortTier ?? null, shortModel: a.chipModelShort, shortEffort: a.chipEffortShort }
  })()`)
  expect('芯片不是旧样式（两段式）', chip.legacyChip === false, chip)
  expect('芯片模型段 = catalog 短名 DeepSeek Flash', chip.model === 'DeepSeek Flash', chip.model)
  expect('芯片强度段 = 英文短名 High', chip.effort.includes('High'), chip.effort)
  expect('芯片文案整体 = 模型 + 强度', chip.chipText === 'DeepSeek Flash High', chip.chipText)
  expect('两段各有 aria-label', !!chip.modelAria && !!chip.effortAria, {
    modelAria: chip.modelAria,
    effortAria: chip.effortAria,
  })
  expect('当前选择 High', selection.tier === 'high', selection)
  await cdp.shot('01-conversation-chip')

  // ── 1b. 系统字体 130%：芯片单行、不溢出、不裁字（默认模型状态最难的是全名） ──
  await cdp.eval(SCALE_TEXT(1.3))
  await sleep(500)
  const zoom = await measureChipZoom(cdp)
  expect('130% 字号下芯片单行不换行', zoom.whiteSpace === 'nowrap' && zoom.chipLines === 1, zoom)
  expect('130% 字号下芯片不超出输入卡', zoom.chipWithinCard === true, {
    chipRight: zoom.chipRight,
    cardRight: zoom.cardRight,
  })
  expect('130% 字号下页面无横向溢出', zoom.docOverflowX <= 0, zoom.docOverflowX)
  expect('130% 字号下模型名完整（不用省略号）', zoom.modelClipped <= 1, zoom.modelClipped)
  expect('130% 字号下强度段完整可见', zoom.effortClipped <= 1, zoom.effortClipped)
  expect('130% 字号下芯片文案仍是 模型 + 强度', zoom.chipText === 'DeepSeek Flash High', zoom.chipText)
  await cdp.shot('04-chip-font-130')
  await cdp.eval(RESET_TEXT)
  await sleep(300)

  // ── 2. 点模型段 → 模型选择弹层 ─────────────────────────────────────────
  await tap(cdp, '.chip__part--model')
  await waitFor(cdp, `document.querySelector('.sheet')`, { label: '模型弹层' })
  await sleep(350)
  const modelSheet = await cdp.eval(`(() => {
    const sheet = document.querySelector('.sheet')
    const titles = [...sheet.querySelectorAll('.sheet__title')].map((e) => e.innerText.trim())
    const backends = [...sheet.querySelectorAll('.sheet__item.backend')].map((e) => ({
      text: e.innerText.replace(/\\s+/g, ' ').trim(),
      disabled: e.classList.contains('is-disabled'),
    }))
    const models = [...sheet.querySelectorAll('.sheet__item.model')].map((e) => ({
      name: e.querySelector('.model__name')?.innerText.trim() ?? '',
      channel: e.querySelector('.model__channel')?.innerText.trim() ?? '',
      multiplier: e.querySelector('.model__multiplier')?.innerText.trim() ?? '',
      meta: e.querySelector('.model__meta')?.innerText.trim() ?? '',
      selected: e.classList.contains('is-selected'),
      aria: e.getAttribute('aria-label'),
    }))
    return {
      text: sheet.innerText.replace(/\\s+/g, ' ').trim(),
      titles,
      backends,
      models,
      hasProvider: /deepseek-official|provider|https?:\\/\\//i.test(sheet.innerText),
    }
  })()`)
  expect('模型弹层只有「后端 / 模型」两段', JSON.stringify(modelSheet.titles) === JSON.stringify(['后端', '模型']), modelSheet.titles)
  // 真机反馈：下线的桌面端不再占位置，只展示可用的后端（mock 里另一台桌面端是离线的）
  expect(
    '后端段只展示可用的（云服务器，离线桌面端不出现）',
    modelSheet.backends.length === 1 && !modelSheet.backends[0].disabled && modelSheet.backends[0].text.includes('云服务器'),
    modelSheet.backends,
  )
  expect('模型列表用短名（不出现版本号）', modelSheet.models.map((m) => m.name).join(' / ') === 'DeepSeek Flash / DeepSeek Pro', modelSheet.models)
  // 真机反馈：同名模型要能看出渠道（upstream-b / upstream-c），列表不再出现两条一模一样的行
  expect(
    '模型行显示渠道（upstream-b / upstream-c）',
    modelSheet.models.map((m) => m.channel).join(' / ') === 'upstream-b / upstream-c',
    modelSheet.models,
  )
  expect(
    '渠道进 meta 与 aria-label',
    modelSheet.models[0].meta.includes('upstream-b') &&
      modelSheet.models[0].aria.includes('渠道 upstream-b'),
    modelSheet.models,
  )
  // 真机 2026-10-26：模型名后面显示渠道倍率（X0.1 / X0.3），并进 aria-label
  expect(
    '模型名后显示渠道倍率（X0.3 / X0.1）',
    modelSheet.models.map((m) => m.multiplier).join(' / ') === 'X0.3 / X0.1' &&
      modelSheet.models[0].aria.includes('倍率 X0.3'),
    modelSheet.models,
  )
  // 手机端隐藏 Claude Code / Codex 两个渠道（mock 目录里带了这两组模型）
  expect(
    'Claude Code / Codex 渠道的模型不展示',
    !/gpt|claude/i.test(modelSheet.models.map((m) => `${m.name} ${m.channel}`).join(' ')),
    modelSheet.models,
  )
  expect('当前模型有选中态', modelSheet.models.filter((m) => m.selected).length === 1, modelSheet.models)
  expect('弹层里不显示 provider / 服务器地址', !modelSheet.hasProvider, modelSheet.text.slice(0, 160))
  await cdp.shot('02-model-sheet')

  // ── 3. 选另一个模型（同一后端）→ 芯片立即变化 ─────────────────────────
  const proRect = await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('.sheet__item.model')].find((e) => e.innerText.includes('DeepSeek Pro'))
    if (!row) return null
    const r = row.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  if (!proRect) throw new Error('找不到 DeepSeek Pro 行')
  await touchStart(cdp, proRect.x, proRect.y)
  await sleep(60)
  await touchEnd(cdp)
  await waitFor(cdp, `!document.querySelector('.sheet')`, { label: '模型弹层关闭' })
  await waitFor(cdp, `window.__dshHub.models.selection?.model === 'deepseek-v4-pro'`, { label: '模型切到 Pro' })
  await sleep(300)
  const chipAfterModel = await cdp.eval(chipSnapshotExpr())
  expect('切模型后芯片模型段变为 DeepSeek Pro', chipAfterModel.model === 'DeepSeek Pro', chipAfterModel)
  expect('切模型后强度保留 High', chipAfterModel.effort.includes('High'), chipAfterModel.effort)

  // ── 4. 点强度段 → 拖动条弹层 ───────────────────────────────────────────
  await tap(cdp, '.chip__part--effort')
  await waitFor(cdp, `document.querySelector('.effort__slider')`, { label: '强度弹层' })
  await sleep(350)
  const slider = await cdp.eval(`(() => {
    const el = document.querySelector('.effort__slider')
    const labels = [...document.querySelectorAll('.effort__label')].map((e) => ({
      cn: e.querySelector('.effort__label-cn')?.innerText.trim(),
      en: e.querySelector('.effort__label-en')?.innerText.trim(),
      disabled: e.disabled,
      tier: e.dataset.tier,
    }))
    return {
      role: el.getAttribute('role'),
      min: el.getAttribute('aria-valuemin'),
      max: el.getAttribute('aria-valuemax'),
      now: el.getAttribute('aria-valuenow'),
      text: el.getAttribute('aria-valuetext'),
      labels,
      note: document.querySelector('.sheet__note')?.innerText.trim() ?? '',
    }
  })()`)
  expect('拖动条 role=slider 且有 min/max/now', slider.role === 'slider' && slider.min === '1' && slider.max === '4' && slider.now === '3', slider)
  expect('四个刻度标签齐全（中文 + 英文短名）', slider.labels.map((l) => `${l.cn}/${l.en}`).join(' ') === '低/Low 中等/Medium 高/High 超高/Max', slider.labels)
  expect('slider aria-valuetext 说明当前档', String(slider.text).includes('高') && String(slider.text).includes('High'), slider.text)

  // ── 5. 真触摸拖动到「超高 / Max」→ 立即生效 ────────────────────────────
  await dragSlider(cdp, 2 / 3, 1)
  const afterDrag = await cdp.eval(`(() => {
    const a = window.__dshHub.models
    const el = document.querySelector('.effort__slider')
    return { tier: a.selection?.effortTier ?? null, now: el.getAttribute('aria-valuenow'), text: el.getAttribute('aria-valuetext') }
  })()`)
  expect('拖到最右后档位 = 超高（ultra）', afterDrag.tier === 'ultra', afterDrag)
  expect('拖动后 aria-valuenow = 4', afterDrag.now === '4', afterDrag)
  const chipAfterDrag = await cdp.eval(chipSnapshotExpr())
  expect('拖动后芯片强度段变为 Max', chipAfterDrag.effort.includes('Max'), chipAfterDrag)
  await cdp.shot('03-effort-sheet-max')

  // ── 6. 点刻度标签直达「低」再回「超高」 ───────────────────────────────
  const labelCenter = await cdp.eval(`(() => {
    const el = document.querySelector('.effort__label[data-tier="low"]')
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  await touchStart(cdp, labelCenter.x, labelCenter.y)
  await sleep(60)
  await touchEnd(cdp)
  await sleep(500)
  const afterTapLabel = await cdp.eval(`(() => {
    const a = window.__dshHub.models
    return { tier: a.selection?.effortTier ?? null, chip: document.querySelector('.chip__part--effort')?.innerText.replace(/\\s+/g, ' ').trim() ?? '' }
  })()`)
  expect('点刻度「低」直达 Low', afterTapLabel.tier === 'low' && afterTapLabel.chip.includes('Low'), afterTapLabel)
  // 回到 Max 并关弹层（截图 ③ 已经是 Max 状态，这里只恢复最终状态）
  await dragSlider(cdp, 0, 1)
  await waitFor(cdp, `window.__dshHub.models.selection?.effortTier === 'ultra'`, { label: '回到 Max' })
  await tap(cdp, '.sheet-mask')
  await waitFor(cdp, `!document.querySelector('.sheet')`, { label: '强度弹层关闭' })

  // ── 7. 再验一次 130% 字号（换模型 + 拖到 Max 之后的最宽组合） ──────────
  await cdp.eval(SCALE_TEXT(1.3))
  await sleep(500)
  const zoom2 = await measureChipZoom(cdp)
  expect('130% 字号下（Pro / Max）模型名完整', zoom2.modelClipped <= 1, zoom2.modelClipped)
  expect('130% 字号下（Pro / Max）强度段完整可见', zoom2.effortClipped <= 1, zoom2.effortClipped)
  expect('130% 字号下（Pro / Max）不超出输入卡', zoom2.chipWithinCard === true, zoom2)
  await cdp.eval(RESET_TEXT)
  await sleep(300)

  // ── 7b. features 没有 models 时降级成旧芯片，不报错 ────────────────────
  const degrade = await cdp.eval(`(async () => {
    const a = window.__dshHub.models
    const saved = [...a.features]
    a.applyFeatures([])
    await new Promise((r) => setTimeout(r, 250))
    const legacyText = document.querySelector('.chip')?.innerText.replace(/\\s+/g, ' ').trim() ?? ''
    const legacy = !!document.querySelector('.chip--legacy') && !document.querySelector('.chip__part--model')
    a.applyFeatures(saved)
    await new Promise((r) => setTimeout(r, 250))
    const restored = document.querySelector('.chip__part--model')?.innerText ?? ''
    return { legacyText, legacy, restored }
  })()`, { awaitPromise: true })
  expect('没有 models 能力时芯片退回旧样式「思考程度 …」', degrade.legacy && degrade.legacyText.startsWith('思考程度'), degrade)
  expect('恢复 models 能力后芯片回到两段式', degrade.restored.includes('DeepSeek'), degrade)

  // ── 8. 收尾：无控制台错误 ─────────────────────────────────────────────
  expect('无控制台 error', consoleErrors.length === 0, consoleErrors.slice(0, 5))

  const report = {
    app: APP_URL,
    hub: HUB_URL,
    viewport: VIEWPORT,
    checks,
    failed: checks.filter((c) => !c.ok),
    consoleErrors,
    selection: await cdp.eval(`(() => {
      const a = window.__dshHub.models
      return { backend: window.__dshHub.backend.selectedBackendId, model: a.selection?.model, tier: a.selection?.effortTier }
    })()`),
  }
  await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`\n${checks.length - report.failed.length}/${checks.length} 通过；截图与 report.json 在 ${OUT}`)
  cdp.ws.close()
  process.exit(report.failed.length > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
