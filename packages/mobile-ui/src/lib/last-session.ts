/**
 * 「上次打开的会话」（0.2.9）。
 *
 * 手机端冷启动时默认接着展示上一次对话：App 启动 → 恢复登录（或自动登录）→ 读这条记录 →
 * 路由到 `/c/<sessionId>`。会话被归档/删除或换了后端时清掉，退回首页。
 *
 * 只存会话 id / 后端 id / 时间，不含任何消息正文；走普通偏好（Preferences / localStorage），
 * 与令牌（SecureStorage）严格分开。
 */

import type { KeyValueStore } from '@dsh-hub/mobile-core'

export const LAST_SESSION_KEY = 'dsh-hub:last-session:v1'
const SESSION_ID_MAX = 200
const BACKEND_ID_MAX = 200

export interface LastSessionRecord {
  sessionId: string
  backendId: string | null
  at: number
}

function validId(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

/** 解析存储里的 JSON：形状不对/垃圾数据一律当没有。 */
export function parseLastSession(raw: string | null | undefined): LastSessionRecord | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const sessionId = value['sessionId']
    if (!validId(sessionId, SESSION_ID_MAX)) return null
    const backendRaw = value['backendId']
    const backendId = validId(backendRaw, BACKEND_ID_MAX) ? backendRaw : null
    const atRaw = value['at']
    const at = typeof atRaw === 'number' && Number.isFinite(atRaw) ? atRaw : 0
    return { sessionId, backendId, at }
  } catch {
    return null
  }
}

export async function loadLastSession(store: KeyValueStore): Promise<LastSessionRecord | null> {
  try {
    return parseLastSession(await store.get(LAST_SESSION_KEY))
  } catch {
    return null
  }
}

export async function saveLastSession(
  store: KeyValueStore,
  record: LastSessionRecord,
): Promise<void> {
  if (!validId(record.sessionId, SESSION_ID_MAX)) return
  try {
    await store.set(
      LAST_SESSION_KEY,
      JSON.stringify({
        sessionId: record.sessionId,
        backendId: validId(record.backendId, BACKEND_ID_MAX) ? record.backendId : null,
        at: Number.isFinite(record.at) ? record.at : Date.now(),
      }),
    )
  } catch {
    /* 偏好写失败不影响使用：下次顶多回到首页 */
  }
}

export async function clearLastSession(store: KeyValueStore): Promise<void> {
  try {
    await store.remove(LAST_SESSION_KEY)
  } catch {
    /* ignore */
  }
}

// ── 冷启动恢复上次会话（0.2.14 修复） ───────────────────────────────────────
//
// 0.2.9/0.2.11 的实现有两个坑，真机上表现为「杀掉 App 再开回到首页，没有回到上次对话」：
//   1) 只等会话列表 4 秒，而且放弃后 `restoredLastConversation` 已置位，本次运行不再重试；
//      云容器冷启动唤醒 ~11s，会话列表必然晚于 4s 到达 → 一直回首页。
//   2) 只在「认证状态变 true」时触发一次；如果那一刻路由还在登录页/还没 resolve，
//      就直接 return（不置位也不重试），之后没人再触发。
//
// 现在把「什么时候能恢复、能不能重试」抽成纯函数 + 一个小状态机，App 只负责接线：
//   - 会话列表/唤醒/回前台/路由回首页都可以再触发；
//   - 总等待窗口 60s（覆盖容器冷启动）；
//   - 用户手动导航走了就取消；成功后本次运行不再重复打开。

/** 等会话列表出现/唤醒完成的总窗口（云容器冷启动唤醒约 11s，留足余量）。 */
export const LAST_SESSION_RESTORE_WINDOW_MS = 60_000
/** 轮询间隔。 */
export const LAST_SESSION_POLL_MS = 250

export type LastSessionRestoreOutcome =
  | 'restored'
  | 'none'
  | 'archived'
  | 'backend-mismatch'
  | 'canceled'
  | 'auth-lost'
  | 'timeout'

export interface RestoreSessionCandidate {
  sessionId: string
  archived?: boolean
}

export interface RestoreLastSessionDeps {
  loadRecord: () => Promise<LastSessionRecord | null>
  clearRecord: () => Promise<void>
  isAuthenticated: () => boolean
  /** 当前路由名；启动初期可能还是 undefined/null/''。 */
  routeName: () => string | null | undefined
  selectedBackendId: () => string | null
  /** 会话列表（含本地缓存）里的这一条；没有返回 null。 */
  findSession: (sessionId: string) => RestoreSessionCandidate | null
  /** 通道控制器是否已经能接受 openSession（后端已选、控制器已建）。 */
  canOpenSession: () => boolean
  openSession: (sessionId: string) => Promise<void>
  navigate: (sessionId: string) => Promise<void>
  isCanceled: () => boolean
  now: () => number
  sleep: (ms: number) => Promise<void>
  onEvent?: (name: string, detail?: string) => void
  timeoutMs?: number
  pollMs?: number
}

function routeAllowsRestore(name: string | null | undefined): boolean {
  // 启动初期路由还没 resolve：先等（不能当成「用户已经走了」）。
  if (name === undefined || name === null || name === '') return true
  return name === 'home'
}

/** 这些结论本次运行不再重试；timeout/auth-lost 允许后续触发再试。 */
function isTerminalRestoreOutcome(outcome: LastSessionRestoreOutcome): boolean {
  return outcome !== 'timeout' && outcome !== 'auth-lost'
}

/**
 * 恢复一次「上次打开的会话」。
 *
 * 只有会话行真正出现在列表里（缓存的也算）且控制器就绪才 openSession：过早打开时，
 * 服务端返回的 sessions 帧会把 openSessionId 清成 null（core 的 onSessions 逻辑）。
 */
export async function runRestoreLastSession(
  deps: RestoreLastSessionDeps,
): Promise<LastSessionRestoreOutcome> {
  const timeoutMs = Math.max(0, deps.timeoutMs ?? LAST_SESSION_RESTORE_WINDOW_MS)
  const pollMs = Math.max(1, deps.pollMs ?? LAST_SESSION_POLL_MS)
  const emit = (name: string, detail?: string): void => {
    deps.onEvent?.(name, detail)
  }

  if (deps.isCanceled()) return 'canceled'
  const record = await deps.loadRecord()
  if (!record) return 'none'
  if (!deps.isAuthenticated()) return 'auth-lost'
  const backend = deps.selectedBackendId()
  if (record.backendId && backend && record.backendId !== backend) {
    // App 因「记住的后端离线」自动回退过：不恢复也不清记录，等用户回到那个后端还能续上。
    emit('restore:skip', `backend:${record.backendId}`)
    return 'backend-mismatch'
  }

  const deadline = deps.now() + timeoutMs
  for (;;) {
    if (deps.isCanceled()) return 'canceled'
    if (!deps.isAuthenticated()) return 'auth-lost'
    const route = deps.routeName()
    if (!routeAllowsRestore(route)) return 'canceled'

    const row = deps.findSession(record.sessionId)
    if (row !== null) {
      if (row.archived === true) {
        await deps.clearRecord()
        emit('restore:archived', record.sessionId)
        return 'archived'
      }
      // 路由必须已经落到首页才打开：启动初期路由还没 resolve 时打开会话，
      // App 的 navigate 会因为没有 home 而跳过，结果会话开了却没跳过去。
      if (route === 'home' && deps.canOpenSession()) {
        await deps.openSession(record.sessionId)
        // 打开期间用户可能已经自己跳走了：导航前再确认一次还在首页。
        if (routeAllowsRestore(deps.routeName())) {
          await deps.navigate(record.sessionId)
        }
        emit('restore:ok', record.sessionId)
        return 'restored'
      }
    }
    if (deps.now() >= deadline) {
      emit('restore:timeout', row === null ? 'no-sessions' : 'controller-not-ready')
      return 'timeout'
    }
    await deps.sleep(pollMs)
  }
}

/**
 * App 每次启动持有一个：内部记住结果，避免重复打开会话；手动导航后调用 cancel()。
 */
export class LastSessionRestorer {
  private outcome: LastSessionRestoreOutcome | null = null
  private canceled = false
  private inflight: Promise<LastSessionRestoreOutcome> | null = null

  constructor(private readonly deps: RestoreLastSessionDeps) {}

  /** 已有结论（成功 / 没有记录 / 取消 / 换过后端）：本次运行不再尝试。 */
  get settled(): boolean {
    return this.outcome !== null
  }

  get result(): LastSessionRestoreOutcome | null {
    return this.outcome
  }

  /** 正在等会话列表/唤醒：后续触发会复用同一个 Promise，不必重复记诊断。 */
  get busy(): boolean {
    return this.inflight !== null
  }

  /** 用户手动导航 / 退出登录：取消进行中的恢复，本次运行不再自动恢复。 */
  cancel(): void {
    this.canceled = true
  }

  /**
   * 触发一次恢复（可多次调用：进行中复用同一个 Promise，成功/取消后直接返回结论）。
   * timeout / auth-lost 不落结论，后续触发（会话列表更新、回前台）会再试。
   */
  async restore(): Promise<LastSessionRestoreOutcome> {
    if (this.outcome !== null) return this.outcome
    if (this.canceled) return 'canceled'
    if (this.inflight !== null) return this.inflight
    const running = runRestoreLastSession({
      ...this.deps,
      isCanceled: () => this.canceled || this.deps.isCanceled(),
    })
      .catch((error: unknown) => {
        this.deps.onEvent?.(
          'restore:error',
          error instanceof Error ? error.message.slice(0, 60) : 'failed',
        )
        return 'timeout' as LastSessionRestoreOutcome
      })
      .then((outcome) => {
        if (isTerminalRestoreOutcome(outcome)) this.outcome = outcome
        this.inflight = null
        return outcome
      })
    this.inflight = running
    return running
  }
}
