import type { Page } from 'playwright-core'
import { PUBLIC_ORIGIN } from './config.js'

/**
 * 界面操作的公共片段（登录、注册、等待站内跳转）。
 * 选择器尽量用可访问名（aria-label / 按钮文案），跟产品文案一起演进。
 */

export async function gotoPath(page: Page, path: string): Promise<void> {
  await page.goto(`${PUBLIC_ORIGIN}${path}`, { waitUntil: 'domcontentloaded' })
}

/** 界面登录：填用户名/密码 → 提交 → 等落到 /home（或调用方的目标） */
export async function loginViaUi(page: Page, username: string, password: string): Promise<void> {
  await page.locator('input[aria-label="用户名"]').fill(username)
  await page.locator('input[aria-label="密码"]').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
}

/** 注册表单（字段与 07 §5.2 一致） */
export interface RegisterForm {
  username: string
  password: string
  displayName?: string
  inviteCode?: string
}

export async function fillRegisterForm(page: Page, form: RegisterForm): Promise<void> {
  if (form.inviteCode !== undefined) {
    await page.locator('input[aria-label="邀请码"]').fill(form.inviteCode)
  }
  await page.locator('input[aria-label="用户名"]').fill(form.username)
  if (form.displayName !== undefined) {
    await page.locator('input[aria-label="昵称"]').fill(form.displayName)
  }
  await page.locator('input[aria-label="密码"]').fill(form.password)
  await page.locator('input[aria-label="确认密码"]').fill(form.password)
}

export async function submitRegister(page: Page): Promise<void> {
  await page.getByRole('button', { name: '注册', exact: true }).click()
}

/** 注册页顶部的错误提示条（NAlert） */
export async function registerAlertText(page: Page): Promise<string> {
  const alert = page.locator('.n-alert').first()
  if ((await alert.count()) === 0) return ''
  return (await alert.innerText()).trim()
}

/** 页面里的一段文本是否存在（任选其一） */
export async function hasText(page: Page, text: string, timeoutMs = 10_000): Promise<boolean> {
  try {
    await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}

/** 工作台主卡片的状态行（`data-testid=instance-status-line`） */
export const STATUS_LINE = '[data-testid="instance-status-line"]'

/**
 * 等状态行落到某个状态再读。
 *
 * 主卡片在 `/api/me/instance` 返回前渲染的是默认值（status=absent → 「还没有创建」），
 * 直接读会拿到假状态（WP8a 实测踩到过）。
 */
export async function waitForStatusLine(page: Page, pattern: RegExp, timeoutMs = 30_000): Promise<string> {
  await page
    .waitForFunction(
      (source) => new RegExp(source).test(document.querySelector('[data-testid="instance-status-line"]')?.textContent ?? ''),
      pattern.source,
      { timeout: timeoutMs },
    )
    .catch(() => undefined)
  return textOf(page, STATUS_LINE)
}

/** 元素的可见文本（元素不存在返回空串） */
export async function textOf(page: Page, selector: string): Promise<string> {
  const locator = page.locator(selector).first()
  if ((await locator.count()) === 0) return ''
  return ((await locator.textContent()) ?? '').trim()
}

/** 等某个文案出现（默认 30s，容器冷启动都在里面） */
export async function waitForText(page: Page, text: string, timeoutMs = 30_000): Promise<void> {
  await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: timeoutMs })
}

/**
 * 关掉「欢迎加入，先看三步」引导（07 §5.2）。
 *
 * HomeView 在 `!localStorage['hub.welcome.done']` 时会在挂载后弹它——所以**每个全新的浏览器上下文**
 * 第一次进 `/home` 都会看到；它带遮罩，会挡住主卡片的「打开 DSH」按钮（Playwright 点击会被拦截）。
 * J2 用它验证引导出现后再关掉；其它旅程进 `/home` 前先无条件关一次。
 */
export async function dismissWelcomeIfAny(page: Page): Promise<boolean> {
  const modal = page.locator('.welcome-guide')
  if ((await modal.count()) === 0) return false
  const visible = await modal.first().isVisible().catch(() => false)
  if (!visible) return false
  for (let index = 0; index < 4; index += 1) {
    if (!(await modal.first().isVisible().catch(() => false))) break
    const next = page.getByRole('button', { name: /下一步|开始使用|知道了|跳过/ }).first()
    if ((await next.count()) === 0) break
    // 短超时：最后一步点完弹窗就没了，默认 30s 会在这里白等（WP8a 实测）
    await next.click({ timeout: 3000 }).catch(() => undefined)
    await page.waitForTimeout(150)
  }
  return true
}

/** 从页面上下文里带 cookie 调接口（验证「浏览器的会话」而不是测试进程的） */
export async function pageFetch<T>(
  page: Page,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ([target, method, body]) => {
      const response = await fetch(target as string, {
        method: (method as string) ?? 'GET',
        credentials: 'same-origin',
        headers: body === null ? {} : { 'content-type': 'application/json' },
        body: body === null ? undefined : JSON.stringify(body),
      })
      const text = await response.text()
      let parsed: unknown = null
      try {
        parsed = JSON.parse(text) as unknown
      } catch {
        parsed = text
      }
      return { status: response.status, body: parsed as never }
    },
    [path, init.method ?? 'GET', init.body ?? null] as const,
  ) as Promise<{ status: number; body: T }>
}
