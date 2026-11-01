/**
 * 直接驱动座舱容器里的 DSH（**评测与冒烟的「真链路」那一半**）。
 *
 * 用的是 Hub 生产代码同一条适配器：`@dsh-hub/dsh-node-remote` 的 `createNodeRemote()` ——
 * `modules/mobile/service.ts` 的 `cloudNodeOptions()` 就是这么连 `cloud:self` 容器的。
 * 所以这里发出去的帧（hello / create / send / subscribe）与手机 App 走 Hub 通道时**同形**，
 * 只是省掉了 Hub 的 WS 包装（那一段由 J11 的浏览器 e2e 覆盖）。
 *
 * 记录的「真实工具调用」取自适配器推上来的 `tool` 帧（`phase: start/end`、`name`、
 * `inputPreview`、`outputPreview`、`status`、`durationMs`）—— 这是座舱 DSH 真的调了插件
 * 工具的证据，不是 Hub 侧的推断。
 */
import {
  createNodeRemote,
  type MobileClientFrame,
  type MobileServerFrame,
  type NodeRemote,
  type ToolKind,
} from '@dsh-hub/dsh-node-remote'

/**
 * 一次工具调用（由 `tool` 帧的 **start + end 两帧合并**）。
 *
 * 为什么必须合并：适配器只在 `start` 帧带 `inputPreview`（模型给的参数），
 * `end` 帧只有 `outputPreview` / `status` / `durationMs`（见 `v2/handler.ts` 的
 * `onEvent`）。合并后一条记录就能同时回答「模型选了哪个能力、给了什么参数、
 * Hub 返回了什么」。
 */
export interface ToolCallRecord {
  callId: string
  name: string
  kind: ToolKind
  /** 只有 end 帧到达才算 `finished` */
  finished: boolean
  status?: 'running' | 'ok' | 'error'
  /** 工具入参（`inputPreview`；截断过就是截断的） */
  inputPreview?: string
  /** 工具输出（`outputPreview`） */
  outputPreview?: string
  title: string
  turn: number
  step: number
  durationMs?: number
  error?: { name: string; code: string; reason?: string }
  /** 开始帧相对「发送那一刻」的毫秒数 */
  startedAtMs: number
  /** 结束帧相对「发送那一刻」的毫秒数（没结束就没有） */
  endedAtMs?: number
}

export interface TurnResult {
  sessionId: string
  prompt: string
  /** 座舱 DSH 说给管理员的话（助手文本拼起来） */
  assistantText: string
  /** 本回合的全部工具调用（end 帧为准；start 帧也留着排障） */
  tools: ToolCallRecord[]
  /** 回合是否正常结束（收到 `turn.phase=end`） */
  finished: boolean
  /** 发送 → 回合结束的毫秒数 */
  durationMs: number
  /** 发送 → 第一张画布卡（`canvas_show`/`canvas_update` 成功）的毫秒数 */
  firstCardMs: number | null
  /** 发送 → 第一个方案（`ops_call` 返回 kind=proposal）的毫秒数 */
  firstProposalMs: number | null
  /** 适配器/DSH 报的错误帧（有就说明这轮没跑通） */
  errors: { code: string; message: string }[]
  /** 原始帧（报告里只挑要知道的） */
  frames: MobileServerFrame[]
}

export interface CockpitDriverOptions {
  /** 容器内 DSH 的 HTTP 地址，例如 `http://10.219.63.5:3000` */
  origin: string
  /** 每次请求前取 header（与生产一致：`{cookie, host: '127.0.0.1:3000'}`） */
  headers: () => Promise<Record<string, string>> | Record<string, string>
  log?: (event: string, meta?: Record<string, unknown>) => void
}

/** 座舱 DSH 的适配器封装（一个进程一条就够；会话可以开多条） */
export class CockpitDriver {
  private readonly remote: NodeRemote
  private readonly options: CockpitDriverOptions
  private readonly frames: MobileServerFrame[] = []
  /** 与 `frames` 一一对应的到达时刻（毫秒时间戳；测「首卡时间」用） */
  private readonly arrivals: number[] = []
  private readonly listeners = new Set<() => void>()
  private counter = 0

  private constructor(remote: NodeRemote, options: CockpitDriverOptions) {
    this.remote = remote
    this.options = options
  }

  static async open(options: CockpitDriverOptions): Promise<CockpitDriver> {
    const remote = await createNodeRemote({
      origin: options.origin,
      headers: options.headers,
      node: { id: 'cloud:ops', kind: 'cloud', name: '座舱 DSH', status: 'running' },
      probeTimeoutMs: 8_000,
      cursorTimeoutMs: 15_000,
      ...(options.log === undefined ? {} : { log: options.log }),
    })
    const driver = new CockpitDriver(remote, options)
    await driver.hello()
    return driver
  }

  get features(): readonly string[] {
    return this.remote.features ?? []
  }

  async close(): Promise<void> {
    await this.remote.close()
  }

  /** 发一帧，收集适配器推回来的所有帧 */
  private async dispatch(frame: MobileClientFrame): Promise<void> {
    await this.remote.dispatch(frame, (out) => {
      this.frames.push(out)
      this.arrivals.push(Date.now())
      for (const listener of this.listeners) listener()
    })
  }

  private nextRequestId(): string {
    this.counter += 1
    return `eval-${String(this.counter)}`
  }

  /** 等一帧满足条件（超时返回 undefined；不抛错，方便断言「本不该出现」） */
  private async waitFrame<T extends MobileServerFrame>(
    predicate: (frame: MobileServerFrame) => frame is T | boolean,
    timeoutMs: number,
  ): Promise<MobileServerFrame | undefined> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = this.frames.find((frame) => predicate(frame) === true)
      if (hit !== undefined) return hit
      if (Date.now() >= deadline) return undefined
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.listeners.delete(wake)
          resolve()
        }, Math.max(10, Math.min(200, deadline - Date.now())))
        const wake = (): void => {
          clearTimeout(timer)
          this.listeners.delete(wake)
          resolve()
        }
        this.listeners.add(wake)
      })
    }
  }

  /** hello：协商 v2 特性（`tools` 一定要有，否则拿不到工具帧） */
  async hello(): Promise<void> {
    const requestId = this.nextRequestId()
    const before = this.frames.length
    await this.dispatch({
      v: 1,
      type: 'hello',
      requestId,
      client: { name: 'cockpit-eval', version: '1.0.0' },
      features: ['tools', 'models', 'usage', 'reasoning', 'rename', 'archive', 'session-state'],
    })
    const reply = await this.waitFrame(
      (frame) => frame.type === 'hello' || (frame.type === 'error' && frame.requestId === requestId),
      20_000,
    )
    if (reply === undefined) {
      const seen = this.frames.slice(before).map((frame) => frame.type)
      throw new Error(`座舱 DSH 没有回 hello（收到 ${seen.join('、') || '什么也没有'}）`)
    }
    if (reply.type === 'error') throw new Error(`座舱 DSH hello 失败：${reply.code} ${reply.message}`)
    const features = reply.features ?? []
    if (!features.includes('tools')) {
      this.options.log?.('driver.no-tools-feature', { features })
    }
  }

  /** 新建会话 */
  async createSession(title: string): Promise<string> {
    const requestId = this.nextRequestId()
    const before = this.frames.length
    await this.dispatch({ v: 1, type: 'create', requestId, title })
    const reply = await this.waitFrame(
      (frame) =>
        (frame.type === 'created' && frame.requestId === requestId) ||
        (frame.type === 'error' && frame.requestId === requestId),
      60_000,
    )
    if (reply === undefined) throw new Error('座舱 DSH 没有回 created')
    if (reply.type === 'error') throw new Error(`新建会话失败：${reply.code} ${reply.message}`)
    void before
    return reply.sessionId
  }

  /** 订阅会话（拿流式帧；订阅本身会补一份历史） */
  async subscribe(sessionId: string): Promise<void> {
    const requestId = this.nextRequestId()
    await this.dispatch({ v: 1, type: 'subscribe', requestId, sessionId })
    await this.waitFrame(
      (frame) =>
        (frame.type === 'history' && frame.requestId === requestId) ||
        (frame.type === 'error' && frame.requestId === requestId),
      30_000,
    )
  }

  /**
   * 跑一个回合：`send` → 等 `turn.phase=end`（或超时）。
   *
   * @param prompt - 管理员说的话
   * @param timeoutMs - 整轮超时（含模型+工具的时间）
   */
  async runTurn(prompt: string, timeoutMs = 180_000): Promise<TurnResult> {
    const sessionId = await this.createSession(prompt.slice(0, 30))
    await this.subscribe(sessionId)
    const sentAt = Date.now()
    const requestId = this.nextRequestId()
    const clientMessageId = `msg-${requestId}`
    await this.dispatch({ v: 1, type: 'send', requestId, sessionId, text: prompt, clientMessageId })

    const end = await this.waitFrame(
      (frame) =>
        (frame.type === 'turn' && frame.sessionId === sessionId && frame.phase === 'end') ||
        (frame.type === 'error' && frame.requestId === requestId),
      timeoutMs,
    )
    const endedAt = Date.now()
    // 本回合的帧 + 各自的到达时刻（相对发送那一刻）
    const owned: MobileServerFrame[] = []
    const ownedAt: number[] = []
    for (let index = 0; index < this.frames.length; index += 1) {
      if (this.arrivals[index] === undefined) continue
      if (this.arrivals[index]! < sentAt) continue
      owned.push(this.frames[index]!)
      ownedAt.push(this.arrivals[index]! - sentAt)
    }
    const assistantText = owned
      .filter(
        (frame): frame is Extract<MobileServerFrame, { type: 'message' }> =>
          frame.type === 'message' && frame.sessionId === sessionId && frame.role === 'assistant',
      )
      .map((frame) => frame.text)
      .join('\n')

    // start + end 两帧按 callId 合并（end 帧才有 outputPreview/status/durationMs）
    const merged = new Map<string, ToolCallRecord>()
    owned.forEach((frame, index) => {
      if (frame.type !== 'tool') return
      const atMs = ownedAt[index] ?? 0
      const existing = merged.get(frame.callId)
      if (frame.phase === 'start') {
        merged.set(frame.callId, {
          callId: frame.callId,
          name: frame.name,
          kind: frame.kind,
          finished: false,
          status: 'running',
          ...(frame.inputPreview === undefined ? {} : { inputPreview: frame.inputPreview }),
          title: frame.title,
          turn: frame.turn,
          step: frame.step,
          startedAtMs: atMs,
        })
        return
      }
      merged.set(frame.callId, {
        callId: frame.callId,
        name: existing?.name ?? frame.name,
        kind: existing?.kind ?? frame.kind,
        finished: true,
        ...(frame.status === undefined ? {} : { status: frame.status }),
        ...(existing?.inputPreview === undefined ? {} : { inputPreview: existing.inputPreview }),
        ...(frame.outputPreview === undefined ? {} : { outputPreview: frame.outputPreview }),
        title: existing?.title ?? frame.title,
        turn: existing?.turn ?? frame.turn,
        step: existing?.step ?? frame.step,
        ...(frame.durationMs === undefined ? {} : { durationMs: frame.durationMs }),
        ...(frame.error === undefined ? {} : { error: frame.error }),
        startedAtMs: existing?.startedAtMs ?? atMs,
        endedAtMs: atMs,
      })
    })
    const tools = [...merged.values()]

    const cardTool = tools.find(
      (tool) =>
        (tool.name === 'canvas_show' || tool.name === 'canvas_update') &&
        tool.status !== 'error' &&
        tool.endedAtMs !== undefined,
    )
    const proposalTool = tools.find(
      (tool) =>
        tool.name === 'ops_call' &&
        tool.endedAtMs !== undefined &&
        /"kind"\s*:\s*"proposal"/u.test(tool.outputPreview ?? ''),
    )
    const errors = owned
      .filter((frame): frame is Extract<MobileServerFrame, { type: 'error' }> => frame.type === 'error')
      .map((frame) => ({ code: frame.code, message: frame.message }))

    return {
      sessionId,
      prompt,
      assistantText,
      tools,
      finished: end !== undefined && end.type === 'turn',
      durationMs: endedAt - sentAt,
      firstCardMs: cardTool?.endedAtMs ?? null,
      firstProposalMs: proposalTool?.endedAtMs ?? null,
      errors,
      frames: owned,
    }
  }

  /** 关掉本驱动开的所有会话/流（容器不删） */
  async dispose(): Promise<void> {
    await this.close()
  }
}
