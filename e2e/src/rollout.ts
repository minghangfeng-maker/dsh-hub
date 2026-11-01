import type { Page } from 'playwright-core'
import type { ApiClient } from './api.js'
import { describeApi } from './api.js'
import { ADMIN_PASSWORD, PUBLIC_ORIGIN } from './config.js'
import { JourneyFailure, type JourneyContext } from './context.js'
import { waitFor } from './harness.js'

/**
 * 下发任务（rollout）相关的公共片段：reauth、发起下发、轮询到终态。
 * 04 §4.8：`POST /api/admin/rollouts` 需要 reauth；金丝雀 1 个先跑，失败会 paused。
 */

export interface JobTask {
  id: number
  userId: number | null
  username: string | null
  status: string
  attempt: number
  error: string | null
}

export interface JobDetail {
  job: { id: number; type: string; status: string; title: string; error: string | null; done: number; total: number }
  tasks: JobTask[]
}

const TERMINAL = new Set(['succeeded', 'failed', 'partial', 'canceled', 'paused'])

/** 敏感操作二次验证（04 §2）：窗口内的后续调用都算已 reauth */
export async function reauth(api: ApiClient, password = ADMIN_PASSWORD): Promise<void> {
  const response = await api.post('/api/auth/reauth', { password })
  if (!response.ok) throw new JourneyFailure(`reauth 失败：${describeApi(response)}`)
}

/** 轮询 `GET /api/admin/jobs/:id` 到终态（paused 也算终态，交给调用方判定） */
export async function waitJob(
  api: ApiClient,
  jobId: number,
  ctx: JourneyContext,
  timeoutMs = 6 * 60 * 1000,
): Promise<JobDetail> {
  let last: JobDetail | null = null
  const started = Date.now()
  const done = await waitFor(
    async () => {
      const response = await api.get<JobDetail>(`/api/admin/jobs/${String(jobId)}`)
      if (!response.ok) return false
      last = response.body
      const status = response.body.job.status
      if (TERMINAL.has(status)) return true
      const running = response.body.tasks.find((task) => task.status === 'running')
      ctx.log(
        `任务 #${String(jobId)} ${status} ${String(response.body.job.done)}/${String(response.body.job.total)}` +
          (running ? `（正在处理 ${running.username ?? '—'}）` : '') +
          `（${((Date.now() - started) / 1000).toFixed(0)}s）`,
      )
      return false
    },
    timeoutMs,
    3000,
  )
  if (!done || last === null) {
    throw new JourneyFailure(
      `任务 #${String(jobId)} 在 ${String(Math.round(timeoutMs / 1000))}s 内没有到终态` +
        (last ? `（最后状态：${jobSummary(last)}）` : ''),
    )
  }
  return last
}

export function jobSummary(detail: JobDetail): string {
  return (
    `job #${String(detail.job.id)} ${detail.job.type} → ${detail.job.status}` +
    (detail.job.error ? `（${detail.job.error}）` : '') +
    `；task：${detail.tasks
      .map((task) => `${task.username ?? '—'}=${task.status}${task.error ? `(${task.error})` : ''}`)
      .join('、')}`
  )
}

/**
 * 关掉 DSH 的首访弹窗（0.2.0-rc.2 实测会遇到两个）：
 * ① 「预览版说明」→ 继续；② 「添加一个 API Key 开始使用」→ 稍后配置。
 * 它们都带遮罩，不关掉后面所有点击都会被拦（Playwright 报 mask intercepts pointer events）。
 */
export async function dismissDshOnboarding(page: Page): Promise<string[]> {
  const labels = ['继续', 'Continue', '稍后配置', 'Skip', '跳过', '知道了', 'Got it']
  const clickedLabels: string[] = []
  for (let round = 0; round < 4; round += 1) {
    let clicked = false
    for (const label of labels) {
      // 必须**精确**匹配按钮文案：`button:has-text("继续")` 会同时命中「保存并继续」（WP8a 实测踩到过）
      const button = page.getByRole('button', { name: label, exact: true }).first()
      if ((await button.count()) === 0) continue
      if (!(await button.isVisible().catch(() => false))) continue
      // 弹窗自带遮罩，真实鼠标点击偶尔被拦（WP8a 实测）；失败就退回 DOM click（Vue 监听器照常触发）
      await button.click({ timeout: 4000 }).catch(async () => {
        await button.evaluate((element) => (element as HTMLElement).click()).catch(() => undefined)
      })
      await page.waitForTimeout(500)
      clicked = true
      clickedLabels.push(label)
      break
    }
    if (!clicked) break
  }
  return clickedLabels
}

/**
 * 打开 `/dsh/<username>/` 的 DSH 设置页（不是 URL 路由，要点侧栏的设置按钮，WP0b/WP2 结论）。
 *
 * 首访弹窗（预览版说明 → 继续；添加一个 API Key → 稍后配置）出现时机不定、且都带遮罩，
 * 所以这里做成「关弹窗 → 点设置 → 再关弹窗 → 找目标」的重试循环；`until` 命中即提前返回。
 */
export async function openDshSettings(
  page: Page,
  username: string,
  until?: RegExp,
  log?: (line: string) => void,
  searchFor?: string,
): Promise<string> {
  await page.goto(`${PUBLIC_ORIGIN}/dsh/${username}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => typeof (globalThis as { __DSH_BOOT__?: unknown }).__DSH_BOOT__ !== 'undefined', {
    timeout: 60_000,
  })
  await page.waitForTimeout(2500)

  let text = ''
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const before = await dismissDshOnboarding(page)
    const settings = page.locator('button[aria-label="设置"], button[aria-label="Settings"]').first()
    let clicked = 'none'
    if ((await settings.count()) > 0) {
      clicked = await settings
        .click({ timeout: 6000 })
        .then(() => 'ok')
        .catch((error: unknown) => `fail:${error instanceof Error ? error.message.split('\n')[0]!.slice(0, 60) : '?'}`)
    } else {
      await page.getByText(/^设置$|^Settings$/).first().click({ timeout: 4000 }).catch(() => undefined)
      clicked = 'text-fallback'
    }
    await page.waitForTimeout(1800)
    const after = await dismissDshOnboarding(page)
    log?.(
      `第 ${String(attempt + 1)} 轮：关弹窗[${before.join('/') || '无'}] 点设置=${clicked} 再关[${after.join('/') || '无'}]`,
    )

    // 设置面板的分区是「内置插件 / 模型 / 通用设置 …」（0.2.0-rc.2 实测不是 role=tab，按文案点）
    for (const section of ['内置插件', '插件', 'Plugins']) {
      const entry = page.getByText(section, { exact: true }).first()
      if ((await entry.count()) === 0) continue
      if (!(await entry.isVisible().catch(() => false))) continue
      await entry.click({ timeout: 5000 }).catch(async () => {
        await entry.evaluate((element) => (element as HTMLElement).click()).catch(() => undefined)
      })
      await page.waitForTimeout(1200)
      // 插件列表有 29+ 项且可能被虚拟滚动截断：用面板里的搜索框过滤（用户也是这么找的）
      if (searchFor !== undefined) {
        const search = page
          .locator('input[placeholder*="搜索插件"], input[aria-label*="搜索插件"], input[placeholder*="Search plugin" i]')
          .first()
        if ((await search.count()) > 0) {
          await search.fill(searchFor).catch(() => undefined)
          await page.waitForTimeout(1200)
        }
      }
      break
    }
    text = (await page.locator('body').innerText()).replace(/\n+/g, ' / ')
    if (until === undefined || until.test(text)) break
  }
  return text
}

/** 读 DSH 的模型选择器（composer 上的 model seat）的可访问名，必要时展开菜单看条目 */
export async function readDshModelSelection(
  page: Page,
  username: string,
): Promise<{ seat: string; menu: string }> {
  await page.goto(`${PUBLIC_ORIGIN}/dsh/${username}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => typeof (globalThis as { __DSH_BOOT__?: unknown }).__DSH_BOOT__ !== 'undefined', {
    timeout: 60_000,
  })
  await page.waitForTimeout(3000)
  await dismissDshOnboarding(page)
  const seat = page.locator('button[aria-label*="选择模型"], button[aria-label*="model" i]').first()
  const seatLabel = (await seat.count()) > 0 ? ((await seat.getAttribute('aria-label')) ?? '') : ''
  let menu = ''
  if ((await seat.count()) > 0) {
    await seat.click({ timeout: 8000 }).catch(() => undefined)
    await page.waitForTimeout(1500)
    menu = (await page.locator('body').innerText()).replace(/\n+/g, ' / ')
    await page.keyboard.press('Escape').catch(() => undefined)
  }
  return { seat: seatLabel, menu }
}
