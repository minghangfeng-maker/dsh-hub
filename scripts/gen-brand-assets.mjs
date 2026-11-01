#!/usr/bin/env node
/**
 * 品牌图标生成：把 `scripts/assets/brand/` 里的定稿素材铺到各端要的位置。
 *
 * 素材来源（`brand-design` 定稿的「星座鲸」）：夜空底上一头由星点与细线连成的鲸鱼，
 * 眼睛是一颗四角闪星。**没有任何 DeepSeek 官方图形**，母版是位图（AI 生成后抠图重排），
 * 小尺寸另有矢量加粗版。
 *
 * 分工（128 px 及以上用母版、64 px 及以下用矢量加粗版）：
 *
 *   ── 原样拷贝（定稿素材已经有这个尺寸，不再二次缩放）────────────────────────
 *   packages/mobile-ui/public/icon-192.png           ← brand/icon-192.png      PWA any
 *   packages/mobile-ui/public/icon-512.png           ← brand/icon-512.png      PWA any
 *   packages/mobile-ui/public/apple-touch-icon-180.png ← brand/icon-180.png    iOS 桌面图标
 *   apps/web/public/apple-touch-icon.png             ← brand/icon-180.png      网站 apple-touch-icon
 *   apps/web/public/favicon.ico                      ← brand/favicon.ico       16/32/48 多尺寸
 *   apps/web/public/favicon.svg                      ← brand/icon-32.svg       矢量加粗版（自带底板）
 *   apps/mobile/…/mipmap-{d}/ic_launcher_foreground.png ← brand/android-foreground-{d}.png
 *                                                    （自适应图标前景，鲸鱼已在 66% 安全区）
 *
 *   ── 需要现画（裁圆角 / 加渐变底 / 缩放）──────────────────────────────────
 *   packages/mobile-ui/public/icon-maskable-512.png  渐变底 + 标记（透明底那层）居中，落进安全圆
 *   apps/mobile/…/mipmap-{d}/ic_launcher.png         圆角方形（48 用矢量加粗版，其余用母版）
 *   apps/mobile/…/mipmap-{d}/ic_launcher_round.png   圆形（同上）
 *   apps/mobile/…/drawable/ 与 drawable-{port,land}-{d}/   11 张启动图：渐变底 + 居中圆角图标
 *
 * 为什么还在用 Chrome：这台机器只有 Chrome for Testing，仓库不想为几张图引入 sharp/canvas
 * 这种带原生依赖的包。Chrome 按精确视口截一张 PNG 就够，连圆角/渐变都能交给 CSS。
 * 注意别用 `chrome --headless --screenshot`（在这台机器上会挂住不退出），走 CDP 是稳的
 * （和 `scripts/e2e-*.mjs` 同一套做法）。
 *
 * 用法：
 *   node scripts/gen-brand-assets.mjs                    # 生成全部并覆盖
 *   node scripts/gen-brand-assets.mjs --root /tmp/x      # 写到别处（自测用，目录需已存在）
 *   node scripts/gen-brand-assets.mjs --only pwa,android  # 只跑一部分（pwa / android / web）
 *   CHROME_BIN=... node scripts/gen-brand-assets.mjs
 */

import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const SRC = join(HERE, 'assets', 'brand')
const CHROME = process.env.CHROME_BIN ?? `${process.env.HOME}/.local/bin/google-chrome`

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const ROOT = resolve(argOf('root', REPO))
const ONLY = new Set(
  argOf('only', 'pwa,android,web')
    .split(',')
    .map((item) => item.trim()),
)

const MOBILE_PUBLIC = join(ROOT, 'packages', 'mobile-ui', 'public')
const WEB_PUBLIC = join(ROOT, 'apps', 'web', 'public')
const ANDROID_RES = join(ROOT, 'apps', 'mobile', 'android', 'app', 'src', 'main', 'res')

/** 品牌配色（见 brand/README.md）：夜空底左 `#080E3D`、右 `#2A1460`，前景纯白。 */
const BG_FROM = '#080E3D'
const BG_TO = '#2A1460'
const BG_GRADIENT = `linear-gradient(to bottom right, ${BG_FROM} 0%, ${BG_TO} 100%)`

/**
 * 启动图用**纯色** `#141A4E`（品牌深靛，README 允许的另一种底板）而不是渐变：
 * 11 张启动图铺满整屏，渐变在 PNG 里几乎压不动（合计 3.7 MB），纯色只要 ~5 KB。
 * 渐变留给图标本身（自适应图标背景是矢量 drawable，不占体积）。
 */
const SPLASH_BG = '#141A4E'

// ── 输出清单 ────────────────────────────────────────────────────────────────

/** 原样拷贝的几张（素材已是最终尺寸）。 */
const COPIES = [
  ['pwa', join(SRC, 'icon-192.png'), join(MOBILE_PUBLIC, 'icon-192.png')],
  ['pwa', join(SRC, 'icon-512.png'), join(MOBILE_PUBLIC, 'icon-512.png')],
  ['pwa', join(SRC, 'icon-180.png'), join(MOBILE_PUBLIC, 'apple-touch-icon-180.png')],
  ['web', join(SRC, 'icon-180.png'), join(WEB_PUBLIC, 'apple-touch-icon.png')],
  ['web', join(SRC, 'favicon.ico'), join(WEB_PUBLIC, 'favicon.ico')],
  ['web', join(SRC, 'icon-32.svg'), join(WEB_PUBLIC, 'favicon.svg')],
]

/** 安卓 5 档密度：mipmap 目录名 → 传统图标边长（dp 48/72/96/144/192）。 */
const DENSITIES = [
  { dir: 'mdpi', legacy: 48, foreground: 108, splash: [320, 480] },
  { dir: 'hdpi', legacy: 72, foreground: 162, splash: [480, 800] },
  { dir: 'xhdpi', legacy: 96, foreground: 216, splash: [720, 1280] },
  { dir: 'xxhdpi', legacy: 144, foreground: 324, splash: [960, 1600] },
  { dir: 'xxxhdpi', legacy: 192, foreground: 432, splash: [1280, 1920] },
]

/** 启动图：`drawable/splash.png` 按横屏 480×320，其余按密度分横竖两套。 */
const SPLASHES = [
  { file: join(ANDROID_RES, 'drawable', 'splash.png'), width: 480, height: 320 },
  ...DENSITIES.flatMap(({ dir, splash: [w, h] }) => [
    { file: join(ANDROID_RES, `drawable-port-${dir}`, 'splash.png'), width: w, height: h },
    { file: join(ANDROID_RES, `drawable-land-${dir}`, 'splash.png'), width: h, height: w },
  ]),
]

/** 启动图里那块圆角图标占短边的比例（沿用旧启动图的 26.25%）。 */
const SPLASH_TILE_RATIO = 0.2625

// ── 页面模板 ────────────────────────────────────────────────────────────────

const escape = (path) => pathToFileURL(path).href

/** 透明底 + 圆角/圆形裁切的单张图（安卓传统图标）。 */
const iconPage = (srcFile, size, radius) => `<!doctype html>
<html><head><meta charset="utf-8"><title>icon</title><style>
  html, body { margin: 0; padding: 0; width: ${size}px; height: ${size}px; overflow: hidden; background: transparent; }
  img { display: block; width: ${size}px; height: ${size}px; border-radius: ${radius}; }
</style></head>
<body><img src="${escape(srcFile)}" alt=""></body></html>
`

/**
 * maskable：渐变底板铺满，透明底标记层（`icon-foreground-1024.png`）铺满整个图标并居中。
 * 那张图四周有 18% 留白，所以标记本体只占 62%，最远点离中心 0.352（安全圆半径 0.40）——
 * 圆形/水滴/方形掩模裁下去都不会伤到图案。
 */
const maskablePage = (markFile, size) => `<!doctype html>
<html><head><meta charset="utf-8"><title>icon</title><style>
  html, body { margin: 0; padding: 0; width: ${size}px; height: ${size}px; overflow: hidden; }
  body { position: relative; background: ${BG_GRADIENT}; }
  img { position: absolute; top: 50%; left: 50%; width: 100%; height: auto;
        transform: translate(-50%, -50%); }
</style></head>
<body><img src="${escape(markFile)}" alt=""></body></html>
`

/** 启动图：渐变底 + 居中圆角图标。 */
const splashPage = (tileFile, width, height) => {
  const tile = Math.round(Math.min(width, height) * SPLASH_TILE_RATIO)
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>splash</title><style>
  html, body { margin: 0; padding: 0; width: ${width}px; height: ${height}px; overflow: hidden; }
  body { display: flex; align-items: center; justify-content: center; background: ${SPLASH_BG}; }
  img { display: block; width: ${tile}px; height: ${tile}px; border-radius: 22.5%; }
</style></head>
<body><img src="${escape(tileFile)}" alt=""></body></html>
`
}

// ── 极简 CDP 驱动（只用到 Page/Runtime/Emulation）────────────────────────────

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id === undefined) return
      const slot = this.pending.get(msg.id)
      if (!slot) return
      this.pending.delete(msg.id)
      if (msg.error) slot.reject(new Error(`${slot.method}: ${msg.error.message}`))
      else slot.resolve(msg.result)
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve_, reject) => this.pending.set(id, { resolve: resolve_, reject, method }))
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (res.exceptionDetails)
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
    return res.result?.value
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 起一个 headless Chrome，进程组 + profile 目录都由调用方收干净。 */
async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-brand-'))
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--allow-file-access-from-files',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'], detached: true },
  )
  const close = async () => {
    try {
      process.kill(-chrome.pid, 'SIGKILL')
    } catch {
      try {
        chrome.kill('SIGKILL')
      } catch {
        // 进程组和进程都没了：没什么可收的
      }
    }
    await sleep(100)
    rmSync(profile, { recursive: true, force: true })
  }
  try {
    // 调试端口由 Chrome 自己挑，再从 DevToolsActivePort 读回来（自己挑端口会撞 TIME_WAIT）
    let port = 0
    for (let i = 0; i < 200 && !port; i += 1) {
      try {
        const text = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8')
        const parsed = Number.parseInt(text.split('\n')[0], 10)
        if (Number.isInteger(parsed) && parsed > 0) port = parsed
      } catch {
        // 文件还没写出来：下一轮再读
      }
      if (!port) await sleep(100)
    }
    if (!port) throw new Error('chrome never wrote DevToolsActivePort')
    let wsUrl = ''
    for (let i = 0; i < 200 && !wsUrl; i += 1) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        wsUrl = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? ''
      } catch {
        // CDP 端点还没就绪：下一轮再问
      }
      if (!wsUrl) await sleep(150)
    }
    if (!wsUrl) throw new Error('chrome devtools endpoint never came up')
    const ws = new WebSocket(wsUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', rej, { once: true })
    })
    const cdp = new Cdp(ws)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    return { cdp, close: async () => (ws.close(), await close()) }
  } catch (error) {
    await close()
    throw error
  }
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

/** PNG 的宽高在 IHDR 里（偏移 16..24），顺手校验尺寸没被改。 */
function pngSize(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)]
}

function writePng(file, buffer, want) {
  const [w, h] = pngSize(buffer)
  if (w !== want.width || h !== want.height) {
    throw new Error(`${file}: got ${w}x${h}, want ${want.width}x${want.height}`)
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, buffer)
  const rel = file.startsWith(ROOT) ? file.slice(ROOT.length + 1) : file
  console.log(`${rel.padEnd(72)} ${w}x${h}  ${String(buffer.byteLength).padStart(7)} bytes`)
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), 'dsh-brand-html-'))
  let page = 0
  const { cdp, close } = await launchChrome()
  try {
    /** 按精确视口渲染一段 HTML，返回 PNG（transparent=true 时四角可真透明）。 */
    const render = async (html, width, height, transparent) => {
      page += 1
      const file = join(work, `${page}.html`)
      writeFileSync(file, html)
      await cdp.send('Emulation.setDefaultBackgroundColorOverride', {
        color: transparent ? { r: 0, g: 0, b: 0, a: 0 } : { r: 255, g: 255, b: 255, a: 1 },
      })
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await cdp.send('Page.navigate', { url: escape(file) })
      // 图是本地小文件：等 onload 之后再给一帧，避免截到还没解码的空白
      let ready = false
      for (let i = 0; i < 100 && !ready; i += 1) {
        await sleep(50)
        ready =
          (await cdp.eval(`document.images.length > 0 && [...document.images].every((i) => i.complete)`)) ===
          true
      }
      if (!ready) throw new Error(`页面里的图没加载完：${file}`)
      await sleep(120)
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      })
      return Buffer.from(data, 'base64')
    }

    if (ONLY.has('pwa') || ONLY.has('web')) {
      for (const [group, from, to] of COPIES) {
        if (!ONLY.has(group)) continue
        mkdirSync(dirname(to), { recursive: true })
        copyFileSync(from, to)
        const rel = to.startsWith(ROOT) ? to.slice(ROOT.length + 1) : to
        console.log(`${rel.padEnd(72)} copy ← ${from.slice(SRC.length + 1)}`)
      }
    }

    if (ONLY.has('pwa')) {
      const buffer = await render(maskablePage(join(SRC, 'icon-foreground-1024.png'), 512), 512, 512, false)
      writePng(join(MOBILE_PUBLIC, 'icon-maskable-512.png'), buffer, { width: 512, height: 512 })
    }

    if (ONLY.has('android')) {
      for (const { dir, legacy } of DENSITIES) {
        // 自适应图标前景：定稿素材就是这个尺寸，直接拷
        const fgFrom = join(SRC, `android-foreground-${dir}.png`)
        const fgTo = join(ANDROID_RES, `mipmap-${dir}`, 'ic_launcher_foreground.png')
        mkdirSync(dirname(fgTo), { recursive: true })
        copyFileSync(fgFrom, fgTo)
        const fgRel = fgTo.slice(ROOT.length + 1)
        console.log(`${fgRel.padEnd(72)} copy ← android-foreground-${dir}.png`)

        // 传统图标：≤64 px 用矢量加粗版（母版缩到 48 会糊），其余用母版
        const tile = legacy <= 64 ? join(SRC, 'icon-48.png') : join(SRC, 'icon-1024.png')
        for (const [file, radius] of [
          ['ic_launcher.png', '22%'],
          ['ic_launcher_round.png', '50%'],
        ]) {
          const buffer = await render(iconPage(tile, legacy, radius), legacy, legacy, true)
          writePng(join(ANDROID_RES, `mipmap-${dir}`, file), buffer, { width: legacy, height: legacy })
        }
      }

      for (const { file, width, height } of SPLASHES) {
        const buffer = await render(
          splashPage(join(SRC, 'icon-1024.png'), width, height),
          width,
          height,
          false,
        )
        writePng(file, buffer, { width, height })
      }
    }
  } finally {
    await close()
    rmSync(work, { recursive: true, force: true })
  }
  console.log(`\n品牌素材已写入 ${ROOT}`)
}

main().catch((error) => {
  console.error('生成品牌素材失败：', error)
  process.exit(1)
})
