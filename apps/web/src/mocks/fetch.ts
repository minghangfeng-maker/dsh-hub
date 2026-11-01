import type { ExportItem, ExportPart, MyPluginItem } from '@dsh-hub/shared'

import { handleAdmin, isAdminScenario, resetAdminTrashMock } from './admin'
import { handleCockpit, isCockpitScenario, resetCockpitMock } from './cockpit'
import { handleAdminAgentModes, isAgentModeRequest, resetAgentModeMock } from './agent-modes'
import { handleAdminCompute, handleComputeStart, handleUserCompute } from './compute'
import { desktopOverviewCounts, handleDesktop, resetDesktopMock } from './desktop'
import { handleDeliveries, resetDeliveriesMock } from './deliveries'
import { handleDesktopDelivery, resetDesktopDeliveryMock } from './desktop-delivery'
import { handlePluginInstallStats } from './plugin-install-stats'
import { handleAdminRelay, handleUserRelay } from './relay'
import { handleAdminTools, handleUserTools } from './tools'
import {
  MOCK_SITE,
  beginStart,
  beginStop,
  getMockState,
  mockInstanceSummary,
  setMockScenario,
  type MockScenario,
} from './state'

/**
 * 假接口（**仅开发环境**，`?mock=1`）：拦截 `window.fetch` 上命中 `/api/**` 的请求。
 *
 * 只覆盖 WP5b 页面用到的接口（04 §2/§3 的个人域）；没命中的请求原样透传给真后端，
 * 这样「已合并的 WP1/WP4 接口走真服务、未合并的 WP2/WP3 走假数据」可以混着用。
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS })
}

function noContent(): Response {
  return new Response(null, { status: 204 })
}

function apiError(
  code: string,
  status: number,
  message: string,
  details: Record<string, unknown> = {},
): Response {
  return json({ error: { code, message, details } }, status)
}

/** 估算表：每项的假大小与文件数（`GET /api/me/exports/estimate`）。 */
const MIB = 1024 ** 2
const GIB = 1024 ** 3
const ESTIMATE: Record<string, { bytes: number; files: number }> = {
  workspace: { bytes: Math.round(6.1 * GIB), files: 2841 },
  sessions: { bytes: 268 * MIB, files: 214 },
  settings: { bytes: Math.round(2.4 * MIB), files: 36 },
  'profile-plugins': { bytes: 48 * 1024, files: 2 },
}

/** 上传头像后用一张内联 SVG 代替（截图里能看到头像换掉了）。 */
const MOCK_AVATAR =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%23E6F8F2'/%3E%3Ctext x='32' y='44' font-size='34' text-anchor='middle'%3E%F0%9F%8D%91%3C/text%3E%3C/svg%3E"

function readJsonBody(init?: RequestInit): Record<string, unknown> {
  const raw = init?.body
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 用户点插件开关后：先 pending，几秒后 synced（模拟真实下发）。 */
function schedulePluginSync(pluginId: number, installed: boolean): void {
  setTimeout(
    () => {
      const item = getMockState().plugins.find((row) => row.plugin.id === pluginId)
      if (!item) return
      item.installed = installed
      item.state = 'synced'
      if (installed) item.version = item.plugin.latestVersion
      else item.version = null
    },
    6000 + Math.random() * 2000,
  )
}

async function handle(
  pathname: string,
  method: string,
  url: URL,
  init?: RequestInit,
): Promise<Response | null> {
  const state = getMockState()

  // ── 公共 / 认证 ──
  if (pathname === '/api/public/site' && method === 'GET') return json(MOCK_SITE)
  // WP36 公开主页：给一条正式版安装包，`?mock=guest` 下能看到「下载安装包」而不是禁用态
  if (pathname === '/api/public/desktop/download' && method === 'GET') {
    return json({
      windows: {
        version: '0.2.1',
        channel: 'latest',
        prerelease: false,
        fileName: 'DSH-Hub-Setup-0.2.1.exe',
        bytes: 376_438_784,
        url: '/desktop/bin/win-x64/DSH-Hub-Setup-0.2.1.exe',
        publishedAt: '2026-10-23T01:02:03.000Z',
        portable: {
          fileName: 'DSH-Hub-0.2.1-win-x64-portable.zip',
          bytes: 497_040_528,
          url: '/desktop/bin/win-x64/DSH-Hub-0.2.1-win-x64-portable.zip',
        },
      },
      android: null,
    })
  }

  if (pathname === '/api/auth/me' && method === 'GET') {
    // WP19b：登录页截图用；其它场景保持「永远已登录」，方便 ?mock=1 直接进工作台
    if (state.scenario === 'guest') return apiError('UNAUTHORIZED', 401, '请先登录')
    return json({ user: state.user, instance: mockInstanceSummary() })
  }
  if ((pathname === '/api/auth/logout' || pathname === '/api/auth/reauth') && method === 'POST')
    return noContent()

  // ── 个人资料 ──
  if (pathname === '/api/me' && method === 'PATCH') {
    const body = readJsonBody(init)
    if (typeof body.username === 'string') state.user.username = body.username
    if (typeof body.displayName === 'string') state.user.displayName = body.displayName
    if (typeof body.bio === 'string') state.user.bio = body.bio
    return json({ user: state.user })
  }

  if (pathname === '/api/me/avatar' && method === 'POST') {
    state.user.avatarUrl = MOCK_AVATAR
    return json({ user: state.user })
  }
  if (pathname === '/api/me/avatar' && method === 'DELETE') {
    state.user.avatarUrl = null
    return json({ user: state.user })
  }

  if (pathname === '/api/me/password' && method === 'POST') {
    const body = readJsonBody(init)
    if (body.currentPassword === 'wrong-password') {
      return apiError('WRONG_PASSWORD', 400, '当前密码不正确')
    }
    return noContent()
  }

  // ── 登录设备 ──
  if (pathname === '/api/me/sessions' && method === 'GET') return json({ items: state.sessions })
  if (pathname === '/api/me/sessions/revoke-others' && method === 'POST') {
    const revoked = state.sessions.filter((row) => !row.current).length
    state.sessions = state.sessions.filter((row) => row.current)
    return json({ revoked })
  }
  if (pathname.startsWith('/api/me/sessions/') && method === 'DELETE') {
    const id = decodeURIComponent(pathname.slice('/api/me/sessions/'.length))
    state.sessions = state.sessions.filter((row) => row.id !== id)
    return noContent()
  }

  // ── 我的 DSH ──
  if (pathname === '/api/me/instance' && method === 'GET') {
    return json({
      instance: mockInstanceSummary(),
      quota: state.quota,
      stats: state.status === 'running' ? state.stats : null,
      modelSummary: {
        policy: 'managed',
        preset: 'Hub 中转站',
        defaultModel: 'deepseek-v4.1-flash',
        providers: ['DSH Hub'],
      },
    })
  }

  if (pathname === '/api/me/instance/start' && method === 'POST') {
    // 算力租赁准入（13 §3）：带 planId 时同时记住规格；余额不够一块 402
    const denied = handleComputeStart(readJsonBody(init))
    if (denied) return denied
    if (state.capacityFullOnStart) {
      return apiError('CAPACITY_FULL', 503, '同时在运行的实例已达上限，请稍后再试', { running: 12, max: 12 })
    }
    if (state.status !== 'running' && state.status !== 'starting') beginStart()
    return json({ instance: mockInstanceSummary() }, state.status === 'running' ? 200 : 202)
  }

  if (pathname === '/api/me/instance/stop' && method === 'POST') {
    if (state.status === 'running') beginStop()
    return json({ instance: mockInstanceSummary() }, 202)
  }

  if (pathname === '/api/me/instance/restart' && method === 'POST') {
    beginStart()
    return json({ instance: mockInstanceSummary() }, 202)
  }

  // ── 我的插件 ──
  if (pathname === '/api/me/plugins' && method === 'GET') return json({ items: state.plugins })

  const pluginAction = /^\/api\/me\/plugins\/(\d+)\/(install|uninstall)$/.exec(pathname)
  if (pluginAction && method === 'POST') {
    const pluginId = Number(pluginAction[1])
    const installed = pluginAction[2] === 'install'
    const item = state.plugins.find((row: MyPluginItem) => row.plugin.id === pluginId)
    if (!item) return apiError('NOT_FOUND', 404, '插件不存在')
    if (!item.canToggle) return apiError('FORBIDDEN', 403, '该插件由管理员统一管理')
    item.state = 'pending'
    schedulePluginSync(pluginId, installed)
    return json({ jobId: 900 + pluginId }, 202)
  }

  // ── 数据导出 ──
  if (pathname === '/api/me/exports/estimate' && method === 'GET') {
    const parts = (url.searchParams.get('parts') ?? '').split(',').filter(Boolean)
    const result: Record<string, { bytes: number; files: number }> = {}
    let totalBytes = 0
    for (const part of parts) {
      const entry = ESTIMATE[part] ?? { bytes: 0, files: 0 }
      result[part] = entry
      totalBytes += entry.bytes
    }
    return json({ parts: result, totalBytes })
  }

  if (pathname === '/api/me/exports' && method === 'GET') return json({ items: state.exports })

  if (pathname === '/api/me/exports' && method === 'POST') {
    const body = readJsonBody(init)
    const parts = (Array.isArray(body.parts) ? body.parts : ['workspace']) as ExportPart[]
    const item: ExportItem = {
      id: state.nextExportId++,
      parts,
      format: body.format === 'tar.gz' ? 'tar.gz' : 'zip',
      status: 'running',
      fileName: null,
      sizeBytes: null,
      sha256: null,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      downloaded: false,
      error: null,
      progress: { bytesWritten: 0, filesDone: 0, filesTotal: 3120 },
    }
    state.exports.unshift(item)
    return json({ export: item }, 202)
  }

  if (/^\/api\/me\/exports\/\d+$/.test(pathname) && method === 'DELETE') {
    const id = Number(pathname.split('/').pop())
    state.exports = state.exports.filter((row) => row.id !== id)
    return noContent()
  }

  // ── 统一下发（WP28b）：`/api/admin/deliveries*` + 人数 + 整包清单；在桌面下发与桌面端之前 ──
  const unified = handleDeliveries(pathname, method, url, init)
  if (unified) return unified

  // ── 桌面下发（WP25d）：`/api/admin/desktop/*` 与发布日志（审计）；在桌面端之前，
  //    因为 admin-desktop* 场景要用自己的设备台账造「全部失败」──
  const delivery = handleDesktopDelivery(pathname, method, url, init)
  if (delivery) return delivery

  // ── 桌面端（WP25c）：授权页 / 我的设备 / 管理端台账都在一个文件里 ──
  // 放在管理端兜底之前：`/api/admin/desktop-devices` 不能被通用的 `/api/admin/*` 先吃掉
  const desktop = handleDesktop(pathname, method, url, init)
  if (desktop) return desktop

  // ── 算力租赁（WP17b，13 §7）：用户端接口在任何场景都有（计费关闭时返回 billingEnabled:false）──
  const compute = handleUserCompute(pathname, method, url, init)
  if (compute) return compute

  // ── 中转站（WP10b，12 §9）：用户端任何场景都有，管理端只在 ?mock=admin ──
  const relay = await handleUserRelay(pathname, method, url, init)
  if (relay) return relay

  if (isAdminScenario(state.scenario)) {
    // 18：两个模式的设置 / 下发，以及它们自己的渠道与模型（先于 dsh 的中转站假接口）。
    // 先用同步判断挡一层：不属于这两个模式的请求不要多一次 await（会改变 dsh 假接口的时序）。
    if (isAgentModeRequest(pathname, method, url, init)) {
      const agentModes = await handleAdminAgentModes(pathname, method, url, init)
      if (agentModes) return agentModes
    }
    const adminRelay = await handleAdminRelay(pathname, method, url, init)
    if (adminRelay) return adminRelay
    const adminCompute = handleAdminCompute(pathname, method, url, init)
    if (adminCompute) return adminCompute
    const adminTools = await handleAdminTools(pathname, method, url, init)
    if (adminTools) return adminTools
  }

  // ── 搜索池（WP18b，14 §3）：用户端任何场景都有 ──
  const tools = await handleUserTools(pathname, method, url)
  if (tools) return tools

  // ── 管理座舱（WP56c，24 §3.2）：先于管理端兜底，`/api/admin/cockpit/**` 有自己的假状态机 ──
  if (isCockpitScenario(state.scenario)) {
    const cockpit = handleCockpit(pathname, method, url, init)
    if (cockpit) return cockpit
  }

  // ── 管理端（WP6，04 §4）：只在管理端场景（?mock=admin / admin-empty）接管 ──
  if (pathname.startsWith('/api/admin/') && isAdminScenario(state.scenario)) {
    // 插件安装统计（WP28c）：插件库「已安装」列；自己的文件，先于管理端兜底
    const installStats = handlePluginInstallStats(pathname, method)
    if (installStats) return installStats
    // desktop 计数由桌面端假数据算（admin ↔ desktop 的循环 import 用一个函数注入绕开）
    return handleAdmin(pathname, method, init, url.searchParams, { desktop: desktopOverviewCounts })
  }

  return null
}

let restore: (() => void) | null = null

/** 安装假接口（幂等）。返回还原函数。 */
export function installMockFetch(scenario: MockScenario): () => void {
  setMockScenario(scenario)
  // 每次（重新）安装都把会变的假数据（回收站）重置回初始，避免测试之间互相影响
  resetAdminTrashMock()
  resetAgentModeMock()
  resetDesktopMock()
  resetDesktopDeliveryMock()
  resetDeliveriesMock()
  if (isCockpitScenario(scenario)) resetCockpitMock(scenario)
  if (restore) return restore

  const original = globalThis.fetch.bind(globalThis)
  const patched: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : null
    const rawUrl = typeof input === 'string' ? input : request ? request.url : String(input)
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()

    const url = new URL(rawUrl, window.location.origin)
    if (!url.pathname.startsWith('/api/')) return original(input, init)

    const response = await handle(
      url.pathname,
      method,
      url,
      init ?? (request ? { body: undefined } : undefined),
    )
    if (!response) return original(input, init)

    // 假一点网络延迟：能让骨架屏/加载态在走查时看得见
    await new Promise((resolve) => setTimeout(resolve, 90))
    return response
  }

  globalThis.fetch = patched
  restore = () => {
    globalThis.fetch = original
    restore = null
  }
  return restore
}
