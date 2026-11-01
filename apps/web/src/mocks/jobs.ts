import type {
  JobDetailResponse,
  JobStatus,
  JobSummary,
  JobTaskSummary,
} from '@dsh-hub/shared'

/**
 * 假任务（**仅开发环境**）：给「下发到 DSH」做一条几秒内真的会跑完的任务，
 * 任务中心 / 任务详情 / 任务 SSE 的假数据也从这里出（12 §10「状态卡显示任务进度」）。
 *
 * 为什么不复用 `mocks/admin.ts` 里的 `ADMIN_JOBS`：那是写死的静态夹具，进度永远不变；
 * 这里的状态机会按 {@link PROGRESS_STEPS} 推进并广播 `job` / `task` 事件，
 * 让假 `EventSource`（`mocks/eventsource.ts`）与轮询都能看到「进行中 → 完成」。
 */

/** 下发目标（任务表里的用户列） */
export interface MockJobTarget {
  userId: number | null
  username: string | null
}

export interface MockJobState {
  job: JobSummary
  tasks: JobTaskSummary[]
}

export type MockJobEvent =
  | { type: 'job'; payload: { job: JobSummary } }
  | { type: 'task'; payload: { task: JobTaskSummary } }

type MockJobListener = (event: MockJobEvent) => void

const MINUTE = 60_000

/** 动态任务从 1043 起编号（1037–1042 是 `ADMIN_JOBS` 的静态夹具） */
const FIRST_DYNAMIC_JOB_ID = 1043

let jobs = new Map<number, MockJobState>()
let listeners = new Map<number, Set<MockJobListener>>()
const timers = new Set<ReturnType<typeof setTimeout>>()
let nextJobId = FIRST_DYNAMIC_JOB_ID
let nextTaskId = 9100

const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString()

const TERMINAL: readonly JobStatus[] = ['succeeded', 'failed', 'partial', 'canceled']

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL.includes(status)
}

function clearTimers(): void {
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
}

function later(fn: () => void, delayMs: number): void {
  const timer = setTimeout(() => {
    timers.delete(timer)
    fn()
  }, delayMs)
  timers.add(timer)
}

function emit(id: number, event: MockJobEvent): void {
  for (const listener of [...(listeners.get(id) ?? [])]) listener(event)
}

function emitJob(id: number): void {
  const entry = jobs.get(id)
  if (entry) emit(id, { type: 'job', payload: { job: { ...entry.job } } })
}

function emitTask(id: number, task: JobTaskSummary): void {
  emit(id, { type: 'task', payload: { task: { ...task } } })
}

/** 「上次下发」用的成功旧任务（与 `ADMIN_JOBS` 同一批假数据） */
function seedFixtureJob(): void {
  const createdAt = iso(-45 * MINUTE)
  const job: JobSummary = {
    id: 1041,
    type: 'rollout.models',
    title: '模型配置下发 → 5 位用户',
    status: 'succeeded',
    total: 5,
    done: 5,
    failed: 0,
    createdBy: 1,
    createdByUsername: 'admin',
    createdAt,
    startedAt: createdAt,
    finishedAt: iso(-44 * MINUTE),
    error: null,
  }
  jobs.set(job.id, { job, tasks: [] })
}

/** 测试与场景切换用：清掉动态任务，回到只有夹具任务的状态。 */
export function resetMockJobs(): void {
  clearTimers()
  jobs = new Map()
  listeners = new Map()
  nextJobId = FIRST_DYNAMIC_JOB_ID
  nextTaskId = 9100
  seedFixtureJob()
}

/**
 * 建一条「几秒内跑完」的模型下发任务：先 queued，再 running 逐个用户成功，最后 succeeded。
 * 返回创建好的任务摘要（`POST /api/admin/rollouts` 的 `{ jobId }` 取它的 id）。
 */
export function createMockRolloutJob(input: {
  type: JobSummary['type']
  title: string
  targets: MockJobTarget[]
}): JobSummary {
  const now = new Date().toISOString()
  const id = nextJobId++
  const targets = input.targets.length > 0 ? input.targets : [{ userId: null, username: null }]

  const tasks: JobTaskSummary[] = targets.map((target, index) => ({
    id: nextTaskId++,
    seq: index + 1,
    userId: target.userId,
    username: target.username,
    status: 'pending',
    attempt: 1,
    startedAt: null,
    finishedAt: null,
    error: null,
  }))

  const job: JobSummary = {
    id,
    type: input.type,
    title: input.title,
    status: 'queued',
    total: targets.length,
    done: 0,
    failed: 0,
    createdBy: 1,
    createdByUsername: 'admin',
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    error: null,
  }
  jobs.set(id, { job, tasks })

  // 500ms 后开始跑；之后每 450ms 完成一位用户，最后一位完成时整个任务 succeeded
  later(() => {
    const entry = jobs.get(id)
    if (!entry || isTerminalJobStatus(entry.job.status)) return
    entry.job.status = 'running'
    entry.job.startedAt = new Date().toISOString()
    const first = entry.tasks[0]
    if (first) {
      first.status = 'running'
      first.startedAt = new Date().toISOString()
      emitTask(id, first)
    }
    emitJob(id)

    entry.tasks.forEach((task, index) => {
      later(
        () => {
          const current = jobs.get(id)
          if (!current || isTerminalJobStatus(current.job.status)) return
          task.status = 'succeeded'
          task.startedAt ??= new Date().toISOString()
          task.finishedAt = new Date().toISOString()
          current.job.done = index + 1
          emitTask(id, task)
          if (current.job.done >= current.job.total) {
            current.job.status = 'succeeded'
            current.job.finishedAt = new Date().toISOString()
            emitJob(id)
          }
        },
        (index + 1) * 450,
      )
    })
  }, 500)

  return { ...job }
}

/** 测试用：跳过等待，立刻把任务标记成成功（事件照发）。 */
export function settleMockJob(id: number): void {
  const entry = jobs.get(id)
  if (!entry) return
  entry.job.status = 'succeeded'
  entry.job.startedAt ??= entry.job.createdAt
  entry.job.finishedAt = new Date().toISOString()
  entry.job.done = entry.job.total
  entry.job.failed = 0
  for (const task of entry.tasks) {
    task.status = 'succeeded'
    task.startedAt ??= entry.job.createdAt
    task.finishedAt = entry.job.finishedAt
    emitTask(id, task)
  }
  emitJob(id)
}

export function findMockJob(id: number): MockJobState | null {
  const entry = jobs.get(id)
  return entry ? { job: { ...entry.job }, tasks: entry.tasks.map((task) => ({ ...task })) } : null
}

/** 任务详情（动态任务优先，未命中返回 null 交给 `ADMIN_JOBS` 夹具）。 */
export function mockJobDetail(id: number): JobDetailResponse | null {
  const entry = jobs.get(id)
  if (!entry) return null
  return { job: { ...entry.job }, tasks: entry.tasks.map((task) => ({ ...task })) }
}

/** 动态任务列表（新的在前）。 */
export function mockJobs(): JobSummary[] {
  return [...jobs.values()].map((entry) => ({ ...entry.job })).sort((a, b) => b.id - a.id)
}

/** 最近一次模型下发任务（「下发到 DSH」状态卡与 `pending` 判断）。 */
export function latestMockModelsRollout(): JobSummary | null {
  const models = [...jobs.values()]
    .map((entry) => entry.job)
    .filter((job) => job.type === 'rollout.models')
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  return models[0] ? { ...models[0] } : null
}

/** 订阅某个任务的 `job` / `task` 事件（假 EventSource 用）。 */
export function subscribeMockJob(id: number, listener: MockJobListener): () => void {
  const set = listeners.get(id) ?? new Set<MockJobListener>()
  set.add(listener)
  listeners.set(id, set)
  return () => set.delete(listener)
}

// 模块加载时就放好夹具任务（测试里 `resetMockJobs()` 仍可重来）
seedFixtureJob()
