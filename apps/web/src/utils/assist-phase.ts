/**
 * AI 助手的「启动与连接」阶段合成（WP58，docs/26 §4）。
 *
 * Hub 把自己的容器状态和 App 报来的 `cockpit.status`（docs/26 §5）合成**一个**阶段：
 * 状态胶囊、加载卡、按钮都只看它，不再出现「Hub 说运行中、App 说正在连接」的两套说法。
 *
 * | 阶段 | 判据 |
 * |---|---|
 * | `idle` | 容器 stopped / missing |
 * | `starting` | 点了启动，或 Hub `instance=starting` |
 * | `booting` | Hub `running`，App 还没报 `auth/connecting/ready`（含 `waking`） |
 * | `connecting` | App 报 `auth` / `connecting` |
 * | `ready` | App 报 `ready`；老 App（`cockpit.ready` 里没有 `caps`）收到 ready 就算 |
 * | `offline` | ready 之后 App 报 `offline`（重连中，不盖加载卡） |
 * | `failed` | 启动接口报错 / Hub `instance=error` / 点启动起 180 秒还没 ready |
 *
 * 纯函数：时间从参数进来（`now` / `startedAt`），好在单测里把 180 秒超时拨到跟前。
 */

import type { OpsInstanceState } from '@/api/admin-cockpit'

/** 合成后的阶段（状态胶囊 / 加载卡 / 按钮都只看这个值）。 */
export type AssistPhase = 'idle' | 'starting' | 'booting' | 'connecting' | 'ready' | 'offline' | 'failed'

/** App 报的阶段（`cockpit.status.phase`，docs/26 §5）。 */
export const COCKPIT_APP_PHASES = ['auth', 'waking', 'connecting', 'ready', 'offline', 'blocked'] as const
export type CockpitAppPhase = (typeof COCKPIT_APP_PHASES)[number]

export function isCockpitAppPhase(value: unknown): value is CockpitAppPhase {
  return typeof value === 'string' && (COCKPIT_APP_PHASES as readonly string[]).includes(value)
}

/** 加载卡上的三步（与 docs/26 §4.1 的「加载卡上的步骤」一致）。 */
export const ASSIST_STEP_KEYS = ['container', 'dsh', 'chat'] as const
export type AssistStepKey = (typeof ASSIST_STEP_KEYS)[number]

/** 步骤文案（竖排步骤条） */
export const ASSIST_STEP_LABELS: Record<AssistStepKey, string> = {
  container: '启动容器',
  dsh: '等 DSH 就绪',
  chat: '连接对话',
}

export type AssistStepState = 'done' | 'active' | 'todo' | 'failed'

export interface CockpitAppStatus {
  phase: CockpitAppPhase
  /** App 给的一句中文（不含令牌等敏感信息） */
  message?: string
}

/** 从点「启动 / 重启」起算，超过这个时间还没 ready 就算失败（docs/26 §4.1） */
export const ASSIST_READY_TIMEOUT_MS = 180_000

/** 加载卡下方的预期耗时文案（先按设计文档的「通常 30–90 秒」；实测后再调） */
export const ASSIST_EXPECTED_HINT = '通常 30–90 秒；首次或镜像更新后会久一些'

export interface AssistPhaseInput {
  /** Hub 的座舱容器状态；`null` = 还没读到 `/state` */
  instance: OpsInstanceState | null
  /** 点了「启动 / 重启」（请求发出后一直为 true，直到 ready 或失败） */
  startRequested: boolean
  /** 启动 / 重启接口报的错（人看的一句中文）；没有错误为 null */
  startError: string | null
  /** App 在 `cockpit.ready` 里报的 caps；`null` = 老 App（不发 caps，按 today's 行为兜底） */
  caps: readonly string[] | null
  /** App 最新一条 `cockpit.status`；`null` = 还没收到 */
  appStatus: CockpitAppStatus | null
  /** 是否收到过 `cockpit.ready` */
  readyReceived: boolean
  /** ready 之后 App 又断开过（重连中）——由调用方维护成「本轮曾经 ready」 */
  everReady: boolean
  /** 点启动 / 重启的时刻（毫秒）；没点过为 null */
  startedAt: number | null
  /** 当前时刻（毫秒）；由调用方每秒推进 */
  now: number
}

export interface AssistPhaseResult {
  phase: AssistPhase
  /** 三步各自的状态（`failed` 时出错那步是 `failed`，后面的步骤保持 `todo`） */
  steps: Record<AssistStepKey, AssistStepState>
  /** 从点启动起已用的毫秒数（没点过启动为 0） */
  elapsedMs: number
  /** `failed` 时给人看的原因 */
  reason: string | null
  /** 是否老 App（`cockpit.ready` 里没有 `caps`）：只能靠 ready 兜底 */
  legacy: boolean
  /** App 报来的那句中文（`cockpit.status.message`），胶囊悬停 / 加载卡上显示 */
  message: string | null
}

function stepsOf(states: Record<AssistStepKey, AssistStepState>): Record<AssistStepKey, AssistStepState> {
  return states
}

const ALL_TODO = stepsOf({ container: 'todo', dsh: 'todo', chat: 'todo' })

/** 「已用 0:42」这种时长（分钟不进位，超过 60 分钟显示 `mm:ss` 的分钟数）。 */
export function formatAssistElapsed(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`
}

/**
 * 阶段合成。判定顺序（先到先得，越靠前越「硬」）：
 * 1. 启动接口报错 → `failed`（容器那步失败）；
 * 2. Hub `instance=error` → `failed`；
 * 3. 180 秒超时（还没 ready）→ `failed`（停在出错那步）；
 * 4. App 报 `ready` / 老 App 收到 ready → `ready`；
 * 5. 本轮 ready 过之后 App 报 `offline`（或又回到 auth/waking/connecting）→ `offline`；
 * 6. App 报 `blocked` → `failed`（对话那步）；
 * 7. Hub `starting` 或点了启动但还没 running → `starting`；
 * 8. 容器 stopped / missing（或还没读到）→ `idle`；
 * 9. 容器 running：App 报 auth/connecting → `connecting`；其余（waking / 还没报 / 老 App 等 ready）→ `booting`。
 */
export function synthAssistPhase(input: AssistPhaseInput): AssistPhaseResult {
  const legacy = input.caps === null
  const elapsedMs =
    input.startedAt === null ? 0 : Math.max(0, (Number.isFinite(input.now) ? input.now : 0) - input.startedAt)
  const appPhase = input.appStatus?.phase ?? null
  const message = input.appStatus?.message?.trim() ? input.appStatus.message.trim() : null

  const base = { elapsedMs, legacy, message }
  const stuck = (reason: string, steps: Record<AssistStepKey, AssistStepState>): AssistPhaseResult => ({
    phase: 'failed',
    steps,
    reason,
    ...base,
  })

  // 1 / 2：启动接口报错、Hub 自己报错 —— 容器那步就挂了
  if (input.startError) {
    return stuck(input.startError, { container: 'failed', dsh: 'todo', chat: 'todo' })
  }
  if (input.instance === 'error') {
    return stuck('启动失败：容器没能起来', { container: 'failed', dsh: 'todo', chat: 'todo' })
  }

  // 4 / 5：能发消息了（新 App 报 ready；老 App 只能看 ready 消息 + 容器 running）
  const appReady = appPhase === 'ready' && input.instance === 'running'
  const decided = appReady || (legacy && input.readyReceived && input.instance === 'running')
  if (decided) {
    return {
      phase: 'ready',
      steps: stepsOf({ container: 'done', dsh: 'done', chat: 'done' }),
      reason: null,
      ...base,
    }
  }

  // 3：超时。容器还没起来 → 容器那步；起来了但 App 没报连接 → 等 DSH；报了连接 → 对话那步
  if (input.startedAt !== null && elapsedMs >= ASSIST_READY_TIMEOUT_MS && !input.everReady) {
    const seconds = Math.round(ASSIST_READY_TIMEOUT_MS / 1000)
    if (input.instance === 'running') {
      if (appPhase === 'auth' || appPhase === 'connecting') {
        return stuck(`等了 ${String(seconds)} 秒还没连上对话，可以重试或重启容器`, {
          container: 'done',
          dsh: 'done',
          chat: 'failed',
        })
      }
      return stuck(`等了 ${String(seconds)} 秒 DSH 还没就绪，可以重试或重启容器`, {
        container: 'done',
        dsh: 'failed',
        chat: 'todo',
      })
    }
    return stuck(`等了 ${String(seconds)} 秒容器还没起来，可以重试或重启容器`, {
      container: 'failed',
      dsh: 'todo',
      chat: 'todo',
    })
  }

  // 5：ready 过之后又断开（App 自己会有一条「正在重连」的条幅，Hub 不再盖加载卡）
  if (
    input.everReady &&
    (appPhase === 'offline' || appPhase === 'auth' || appPhase === 'waking' || appPhase === 'connecting')
  ) {
    return {
      phase: 'offline',
      steps: stepsOf({ container: 'done', dsh: 'done', chat: 'done' }),
      reason: null,
      ...base,
    }
  }

  // 6：App 说这个管理员被挡住了（不是本页能恢复的，直接算失败）
  if (appPhase === 'blocked') {
    return stuck(message ?? '对话暂时不可用', { container: 'done', dsh: 'done', chat: 'failed' })
  }

  // 7：点启动 / 容器 starting
  if (input.instance === 'starting' || (input.startRequested && input.instance !== 'running')) {
    return {
      phase: 'starting',
      steps: stepsOf({ container: 'active', dsh: 'todo', chat: 'todo' }),
      reason: null,
      ...base,
    }
  }

  // 8：容器没起来
  if (input.instance !== 'running') {
    return { phase: 'idle', steps: ALL_TODO, reason: null, ...base }
  }

  // 9：容器起来了，看 App 报到哪一步
  if (appPhase === 'auth' || appPhase === 'connecting') {
    return {
      phase: 'connecting',
      steps: stepsOf({ container: 'done', dsh: 'done', chat: 'active' }),
      reason: null,
      ...base,
    }
  }
  return {
    phase: 'booting',
    steps: stepsOf({ container: 'done', dsh: 'active', chat: 'todo' }),
    reason: null,
    ...base,
  }
}

/** 加载卡要不要盖在对话区上（ready / offline / idle 不盖）。 */
export function assistShowsLoadCard(phase: AssistPhase): boolean {
  return phase === 'starting' || phase === 'booting' || phase === 'connecting' || phase === 'failed'
}

/** 胶囊文案与色调（success / sky / warn / muted / danger；warn 是琥珀色，重连中用） */
export type AssistTone = 'success' | 'sky' | 'warn' | 'muted' | 'danger'

export interface AssistStatusMeta {
  text: string
  tone: AssistTone
}

export const ASSIST_PHASE_META: Record<AssistPhase, AssistStatusMeta> = {
  idle: { text: '未启动', tone: 'muted' },
  starting: { text: '启动中', tone: 'sky' },
  booting: { text: '准备中', tone: 'sky' },
  connecting: { text: '连接中', tone: 'sky' },
  ready: { text: '就绪', tone: 'success' },
  offline: { text: '重连中', tone: 'warn' },
  failed: { text: '启动失败', tone: 'danger' },
}

/** 加载卡标题（失败时换成「启动失败」） */
export function assistLoadTitle(phase: AssistPhase): string {
  switch (phase) {
    case 'starting':
      return '正在启动 AI 助手'
    case 'booting':
      return '正在等 DSH 就绪'
    case 'connecting':
      return '正在连接对话'
    case 'failed':
      return '启动失败'
    default:
      return ''
  }
}
