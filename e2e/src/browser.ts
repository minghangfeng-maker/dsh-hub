import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type ConsoleMessage, type Page } from 'playwright-core'
import { CHROME_PATH, VIEWPORT } from './config.js'

/**
 * playwright-core 封装：用系统 Chrome（**不下载浏览器**）、收集 console error、
 * 失败时保存截图 / 页面 HTML / Hub 日志尾巴。
 */

export interface ConsoleIssue {
  kind: 'console' | 'pageerror' | 'requestfailed' | 'http'
  text: string
  url?: string
  status?: number
}

/** Chromium 对 4xx/5xx 响应会打一条 `Failed to load resource…`，它不是 JS 异常 */
const HTTP_ERROR_PATTERN = /Failed to load resource: the server responded with a status of (\d{3})/

/** 一条页面会话的 console/pageerror/请求失败收集器 */
export class ConsoleCollector {
  readonly issues: ConsoleIssue[] = []

  attach(page: Page): void {
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() !== 'error') return
      const text = message.text()
      const location = message.location()
      const match = HTTP_ERROR_PATTERN.exec(text)
      if (match) {
        this.issues.push({
          kind: 'http',
          text,
          status: Number(match[1]),
          url: location.url ?? page.url(),
        })
        return
      }
      this.issues.push({ kind: 'console', text, url: location.url ?? page.url() })
    })
    page.on('pageerror', (error: Error) => {
      this.issues.push({ kind: 'pageerror', text: `${error.name}: ${error.message}`, url: page.url() })
    })
    page.on('requestfailed', (request) => {
      const failure = request.failure()
      this.issues.push({
        kind: 'requestfailed',
        text: `${request.method()} ${request.url()} → ${failure?.errorText ?? 'unknown'}`,
        url: page.url(),
      })
    })
  }

  clear(): void {
    this.issues.length = 0
  }

  /** JS 层错误：未捕获异常 + 真正的 console.error（10 §C1 要求的「0 个 error」指这些） */
  errors(): ConsoleIssue[] {
    return this.issues.filter((issue) => issue.kind === 'console' || issue.kind === 'pageerror')
  }

  /** 请求失败（关页面导致的 abort 也在内，需要调用方自己判断） */
  requestFailures(): ConsoleIssue[] {
    return this.issues.filter((issue) => issue.kind === 'requestfailed')
  }

  /** 4xx/5xx 响应（例如登录前探测 /api/auth/me 的 401，属预期） */
  httpErrors(): ConsoleIssue[] {
    return this.issues.filter((issue) => issue.kind === 'http')
  }

  /** 非预期的 4xx/5xx：把允许清单之外的挑出来 */
  unexpectedHttpErrors(allowed: { status: number; pathIncludes: string }[]): ConsoleIssue[] {
    return this.httpErrors().filter(
      (issue) =>
        !allowed.some(
          (rule) => rule.status === issue.status && (issue.url ?? '').includes(rule.pathIncludes),
        ),
    )
  }

  dump(): string {
    if (this.issues.length === 0) return '（无 console error / 未捕获异常 / 请求失败）'
    return this.issues
      .map((issue) => `[${issue.kind}] ${issue.text}${issue.url ? `\n    @ ${issue.url}` : ''}`)
      .join('\n')
  }
}

export interface BrowserSession {
  browser: Browser
  close(): Promise<void>
}

export async function launchBrowser(): Promise<BrowserSession> {
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    // playwright-core 走 `--remote-debugging-pipe`，不占 CDP 端口（9230 只是备用约定）；
    // 容器/沙箱环境下 Chrome 的 setuid sandbox 可能不可用，故显式关掉（本机是自有 WSL）
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      // 后台节流会把「页面被判为 background」的 App 连接逻辑带偏（J11：座舱嵌入页的
      // `pagehide`/`visibilitychange` 会让 App 主动断开通道）。headless 下也保持渲染/计时器活跃。
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
    ],
  })
  return {
    browser,
    close: async () => {
      await browser.close()
    },
  }
}

export interface NewContextOptions {
  /** 记录 WebSocket 生命周期（J3 断言「WS 已连接」用） */
  trackWebSockets?: boolean
  viewport?: { width: number; height: number }
}

/** 建一个浏览器上下文：zh-CN、1440×900、可选 WS 跟踪 */
export async function newContext(
  browser: Browser,
  options: NewContextOptions = {},
): Promise<{ context: BrowserContext; collector: ConsoleCollector }> {
  const context = await browser.newContext({
    viewport: options.viewport ?? VIEWPORT,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    deviceScaleFactor: 1,
  })
  const collector = new ConsoleCollector()
  context.on('page', (page) => collector.attach(page))
  if (options.trackWebSockets === true) await context.addInitScript(WS_TRACKER_SCRIPT)
  return { context, collector }
}

/** 页面里记录的 WebSocket 记录（`__E2E_WS`） */
export interface WsRecord {
  url: string
  opened: boolean
  closed: boolean
  frames: number
}

/**
 * 注入到页面的 WS 探针：包一层 `WebSocket` 构造器记录 open/message/close。
 * 用 Proxy 而不是替换实现，静态常量（OPEN/CLOSED…）与原型链都保持不变。
 */
const WS_TRACKER_SCRIPT = `(() => {
  const Orig = window.WebSocket;
  if (!Orig) return;
  window.__E2E_WS = [];
  window.WebSocket = new Proxy(Orig, {
    construct(target, args) {
      const socket = Reflect.construct(target, args);
      const record = { url: String(args[0]), opened: false, closed: false, frames: 0 };
      try {
        socket.addEventListener('open', () => { record.opened = true; });
        socket.addEventListener('message', () => { record.frames += 1; });
        socket.addEventListener('close', () => { record.closed = true; });
      } catch {}
      window.__E2E_WS.push(record);
      return socket;
    },
  });
})();`

export async function wsRecords(page: Page): Promise<WsRecord[]> {
  return page.evaluate(() => (window as unknown as { __E2E_WS?: WsRecord[] }).__E2E_WS ?? [])
}

/** 关键步骤截图（1440 宽，写到 e2e/.data/shots/） */
export async function screenshot(page: Page, dir: string, name: string, fullPage = false): Promise<string> {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.png`)
  await page.screenshot({ path: file, fullPage })
  return file
}

/** 失败产物：页面 HTML + console 汇总 + Hub 日志尾巴（放 .data，不进仓库） */
export async function saveFailureArtifacts(
  page: Page | null,
  dir: string,
  payload: { consoleText: string; hubTail: string; error: string },
): Promise<string[]> {
  mkdirSync(dir, { recursive: true })
  const written: string[] = []
  const write = (name: string, content: string): void => {
    const file = join(dir, name)
    writeFileSync(file, content, 'utf8')
    written.push(file)
  }
  write('error.txt', payload.error)
  write('console.txt', payload.consoleText)
  write('hub-tail.log', payload.hubTail)
  if (page) {
    try {
      write('page.html', await page.content())
      const file = join(dir, 'failure.png')
      await page.screenshot({ path: file })
      written.push(file)
    } catch {
      // 页面已经关了就跳过
    }
  }
  return written
}
