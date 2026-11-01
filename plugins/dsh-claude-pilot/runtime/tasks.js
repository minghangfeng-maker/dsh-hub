/**
 * Claude 派 DSH 任务：一组进程内 MCP 工具（mcp__dsh__task_*）。
 *
 * 每个任务 = 当前对话（父）下的一个真 DSH 子会话，经 ctx.subagents.startActivation 创建：
 *   - DSH 自己的模型（默认模型或 config.taskModel）+ 标准预设的全套工具在跑；
 *   - 子会话挂进父会话的 subagentCatalog，所以页头的子代理目录、右侧栏的子会话 tab 都是原生的；
 *   - delivery:'parent'：任务结束时 DSH 给父会话发结算通知，父会话醒来 → 桥再叫 Claude 一轮。
 *
 * 任务状态靠监听子会话的事件（turn/start、assistant/message、turn/end）维护，
 * 所以初始任务和 task_send 追加的后续轮次用同一套逻辑。
 */
import { statSync } from 'node:fs'
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
// 带版本号 import：改 platform.js 也能热加载（ESM 按 URL 缓存）
const { isAbsolutePath, toHostPath } = await import(`./platform.js${new URL(import.meta.url).search}`)

const { truncate } = await import(`./translate.js${new URL(import.meta.url).search}`)

const RESULT_CHARS = 12000

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && block.text)
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function elapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

/** 子任务用哪个模型：config.taskModel > DSH 当前默认模型（绝不继承父会话的 claude-code 选择）。 */
export function taskAgentOptions(ctx, config) {
  const pick = (value) => {
    if (!value || typeof value !== 'object' || !value.provider || !value.model) return undefined
    if (value.provider === 'claude-code' || value.provider === 'codex') return undefined
    return {
      provider: value.provider,
      model: value.model,
      ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}),
    }
  }
  return pick(config.taskModel) || pick(ctx.get('agentDefaultModel')?.currentSelection?.())
}

/** 全局一次：跟踪所有任务子会话的事件。 */
export function ensureTaskTracker(ctx, state) {
  if (state.taskTracker) return
  state.tasks ||= new Map()
  state.taskTracker = ctx.on('session/event', (session, event) => {
    const rec = state.tasks.get(session?.id)
    if (!rec || !event) return
    const data = event.data || {}
    switch (event.type) {
      case 'turn/start':
        rec.status = 'running'
        rec.turnStartedAt = Date.now()
        rec.lastText = ''
        return
      case 'assistant/message': {
        const text = textOf(data.message?.content)
        if (text) rec.lastText = text
        return
      }
      case 'turn/end': {
        const kind = data.reason?.kind || 'completed'
        rec.status = kind === 'completed' ? 'finished' : kind === 'aborted' ? 'stopped' : 'failed'
        rec.reason = kind
        rec.endedAt = Date.now()
        rec.rounds = (rec.rounds || 0) + 1
        rec.finalText = rec.lastText
        for (const wake of [...rec.waiters]) wake()
        return
      }
      default:
    }
  })
}

function describe(rec, { withText = true } = {}) {
  const now = Date.now()
  const span = rec.status === 'running' ? now - (rec.turnStartedAt || rec.startedAt) : (rec.endedAt || now) - (rec.turnStartedAt || rec.startedAt)
  const head = `[${rec.childId}] ${rec.label || '(无标题)'} — ${rec.status}${rec.reason && rec.status !== 'running' ? `(${rec.reason})` : ''}，${elapsed(span)}`
  if (!withText) return head
  if (rec.status === 'running') return `${head}\n  仍在运行。`
  const text = rec.finalText ? truncate(rec.finalText, RESULT_CHARS) : '（它没有留下结束语）'
  return `${head}\n--- 结束语 ---\n${text}`
}

/**
 * 每个 Claude 轮次建一个 MCP server：闭包里带着父会话 id 和这一轮的取消信号。
 * consumed：Claude 已经通过 task_wait 看过结果的子会话（之后到达的结算通知不再单独叫醒 Claude）。
 */
export function createTaskServer(ctx, config, state, { sessionId, signal, consumed, cwd = process.cwd(), present = null }) {
  ensureTaskTracker(ctx, state)
  const ok = (text) => ({ content: [{ type: 'text', text }] })
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true })
  const parentAgent = () => {
    const agent = ctx.get('agents')?.get?.(sessionId)
    if (!agent) throw new Error('当前对话的 DSH agent 不在线（对话被关闭或宿主重启了）')
    return agent
  }
  const subagents = () => {
    const service = ctx.get('subagents')
    if (!service?.startActivation) throw new Error('DSH 的 subagents 服务不可用（检查 profile 是否挂载了 dsh-subagent）')
    return service
  }
  const mine = () => [...state.tasks.values()].filter((rec) => rec.parentId === sessionId)
  const resolveIds = (ids) => {
    const list = Array.isArray(ids) && ids.length ? ids : mine().filter((rec) => rec.status === 'running').map((rec) => rec.childId)
    return list.map((id) => state.tasks.get(id)).filter((rec) => rec && rec.parentId === sessionId)
  }

  const taskStart = tool(
    'task_start',
    [
      '在 DSH 里派一个后台任务：新建一个 DSH 子会话，由 DSH 自己的模型（DeepSeek 等）带完整工具去执行，用户能在右侧栏实时看到它的过程。',
      '立即返回任务 id（形如 session-…），不等它完成。任务结束后你会在下一轮收到结算通知；也可以用 task_wait 主动等结果。',
      'task 必须是自包含的完整指令（子会话看不到你和用户的对话）：写清目标、相关文件路径、约束和验收标准，并要求它在结束语里汇报做了什么、改了哪些文件。',
      '适合：可以并行的独立子任务、耗时的执行类工作（跑实验、批量修改、调研）。需要你自己判断或和用户来回确认的事不要派出去。',
    ].join('\n'),
    {
      task: z.string().describe('自包含的完整任务说明'),
      label: z.string().describe('2–8 个字的短标题，显示在任务列表和右侧栏'),
      cwd: z.string().optional().describe('任务的工作目录，默认继承当前对话的目录'),
    },
    async (args) => {
      try {
        const service = subagents()
        const parent = parentAgent()
        const agentOptions = taskAgentOptions(ctx, config)
        // 不给模型就会继承父会话的 claude-code 选择，子会话一跑就报错：直接拒绝，说清楚怎么配
        if (!agentOptions) return fail('派任务失败：没有可用的任务模型（DSH 默认模型是 claude-code）。请在插件配置里设置 taskModel。')
        const maxDepth = service.resolveMaxDepth?.(undefined)
        const activation = await service.startActivation({
          provider: config.taskProvider || 'spawn',
          label: args.label,
          request: {
            prompt: [{ type: 'text', text: args.task }],
            parent,
            agentPreset: config.taskPreset || 'standard',
            ...(args.cwd ? { cwd: args.cwd } : {}),
            ...(agentOptions ? { agentOptions } : {}),
            ...(maxDepth !== undefined ? { maxDepth } : {}),
          },
          // 只管发布前的取消；任务本身要活过 Claude 这一轮，所以不挂这一轮的 signal
          signal: new AbortController().signal,
          delivery: 'parent',
        })
        const childId = activation.childId
        const now = Date.now()
        const rec = state.tasks.get(childId) || { waiters: new Set() }
        Object.assign(rec, {
          childId,
          parentId: sessionId,
          label: args.label,
          task: args.task,
          status: rec.status === 'finished' ? 'finished' : 'running',
          startedAt: now,
          turnStartedAt: rec.turnStartedAt || now,
          model: agentOptions ? `${agentOptions.provider}/${agentOptions.model}` : '(DSH 默认)',
          activation,
        })
        state.tasks.set(childId, rec)
        // activation.result 兜底：万一事件没跟上（比如子会话在出错前就没写 turn/end）
        activation.result
          .then((result) => {
            if (rec.status === 'running' && !rec.rounds) {
              rec.status = result?.stopReason === 'completed' ? 'finished' : result?.stopReason === 'aborted' ? 'stopped' : 'failed'
              rec.reason = result?.stopReason
              rec.endedAt = Date.now()
              rec.finalText ||= textOf(result?.output)
              for (const wake of [...rec.waiters]) wake()
            }
          })
          .catch((error) => {
            if (rec.status === 'running') {
              rec.status = 'failed'
              rec.reason = String(error?.message || error)
              rec.endedAt = Date.now()
              for (const wake of [...rec.waiters]) wake()
            }
          })
        state.spawns ||= []
        state.spawns.push({ parent: sessionId, child: childId, mode: 'continuable', label: args.label, at: now })
        if (state.spawns.length > 200) state.spawns.splice(0, state.spawns.length - 200)
        // 结果文本必须正好是这一行：DSH 原生 subagent 工具卡按这个格式解析出子会话 id
        return ok(`started subagent ${childId}`)
      } catch (error) {
        return fail(`派任务失败：${error?.message || error}`)
      }
    },
    { alwaysLoad: true },
  )

  const taskWait = tool(
    'task_wait',
    '等待 DSH 任务结束并取回结束语。ids 省略 = 本对话所有运行中的任务。mode=all 等全部结束，any 等任意一个。超时会返回当前状态（任务继续在跑）。用户按停止会中断等待，但不会停掉任务。',
    {
      ids: z.array(z.string()).optional().describe('任务 id 列表'),
      mode: z.enum(['all', 'any']).optional().describe('默认 all'),
      timeout_sec: z.number().optional().describe('最长等待秒数，默认 900，上限 3600'),
    },
    async (args) => {
      const recs = resolveIds(args.ids)
      if (!recs.length) return ok('没有可等待的任务（本对话没有运行中的任务，或 id 不属于本对话）。用 task_list 查看全部。')
      const timeoutMs = Math.min(3600, Math.max(1, Number(args.timeout_sec) || 900)) * 1000
      const done = () => (args.mode === 'any' ? recs.some((r) => r.status !== 'running') : recs.every((r) => r.status !== 'running'))
      if (!done()) {
        await new Promise((resolveWait) => {
          let timer
          const wake = () => {
            if (!done() && !signal?.aborted) return
            cleanup()
            resolveWait()
          }
          const cleanup = () => {
            clearTimeout(timer)
            for (const r of recs) r.waiters.delete(wake)
            signal?.removeEventListener?.('abort', wake)
          }
          timer = setTimeout(() => {
            cleanup()
            resolveWait()
          }, timeoutMs)
          for (const r of recs) r.waiters.add(wake)
          signal?.addEventListener?.('abort', wake, { once: true })
        })
      }
      for (const r of recs) if (r.status !== 'running') consumed.add(r.childId)
      const lines = recs.map((r) => describe(r))
      const pending = recs.filter((r) => r.status === 'running').length
      return ok(`${pending ? `仍有 ${pending} 个任务在运行。\n\n` : ''}${lines.join('\n\n')}`)
    },
    { alwaysLoad: true },
  )

  const taskSend = tool(
    'task_send',
    '给一个 DSH 任务发追加指令（纠正方向、补充信息、让它返工）。任务在跑时会在最近的步骤边界收到；已结束的任务会被唤醒开始新一轮。之后用 task_wait 等它这一轮结束。',
    {
      id: z.string().describe('任务 id'),
      message: z.string().describe('追加指令'),
    },
    async (args) => {
      try {
        const rec = state.tasks.get(args.id)
        if (!rec || rec.parentId !== sessionId) return fail('这个 id 不是本对话派出的任务')
        await subagents().sendMessage(parentAgent(), args.id, [{ type: 'text', text: args.message }], { signal: new AbortController().signal })
        consumed.delete(args.id)
        if (rec.status !== 'running') {
          rec.status = 'running'
          rec.turnStartedAt = Date.now()
          rec.endedAt = undefined
        }
        return ok(`已发送给 ${args.id}`)
      } catch (error) {
        return fail(`发送失败：${error?.message || error}`)
      }
    },
    { alwaysLoad: true },
  )

  const taskList = tool(
    'task_list',
    '列出本对话派出的全部 DSH 任务及状态。',
    {},
    async () => {
      const recs = mine()
      if (!recs.length) return ok('本对话还没有派出任务。')
      return ok(recs.map((r) => `${describe(r, { withText: false })}\n  模型：${r.model}`).join('\n'))
    },
    { alwaysLoad: true },
  )

  const taskStop = tool(
    'task_stop',
    '停止一个正在运行的 DSH 任务（它已产生的结果保留，之后仍可用 task_send 让它继续）。',
    { id: z.string().describe('任务 id') },
    async (args) => {
      try {
        const rec = state.tasks.get(args.id)
        if (!rec || rec.parentId !== sessionId) return fail('这个 id 不是本对话派出的任务')
        subagents().interrupt(args.id, { kind: 'ancestor', agent: parentAgent() })
        return ok(`已请求停止 ${args.id}`)
      } catch (error) {
        return fail(`停止失败：${error?.message || error}`)
      }
    },
    { alwaysLoad: true },
  )

  // 交付物：Write/Edit 写的文件本轮结束时自动交付；脚本生成的、二进制的（tgz/zip/pdf/图片）或已有的文件靠这个工具
  const deliverFiles = tool(
    'deliver_files',
    [
      '把文件作为 DSH 交付物交给用户：在这一轮的回复下面显示成可预览、可打开的文件卡。',
      '用 Write/Edit 写过的文件会自动交付，不用再调；脚本/命令生成的文件、二进制文件（tgz、zip、pdf、图片等）或本来就有的文件，要交给用户时调用这个工具。',
      '路径可以是绝对路径，或相对当前工作目录；目录不行，要交付整个目录就先打包。',
    ].join('\n'),
    {
      files: z
        .array(z.object({ path: z.string().describe('文件路径'), description: z.string().optional().describe('一句话说明，显示在文件卡上') }))
        .min(1)
        .max(10)
        .describe('要交付的文件'),
    },
    async (args) => {
      if (!present) return fail('当前环境不支持交付物')
      const okList = []
      const bad = []
      const items = []
      for (const item of args.files || []) {
        const raw = String(item?.path || '').trim()
        // Claude 在 Windows 的 Git Bash 里给的是 /c/Users/... 这种路径；/x 在 win32 上算「绝对」但指错盘
        const abs = isAbsolutePath(raw) ? raw : toHostPath(raw, cwd)
        try {
          const info = statSync(abs)
          if (!info.isFile()) throw new Error('不是文件')
          items.push({ path: abs, kind: 'delivered', description: String(item.description || '').trim().slice(0, 80) })
          okList.push(`${abs}（${info.size} 字节）`)
        } catch (error) {
          bad.push(`${raw}：${error.code === 'ENOENT' ? '文件不存在' : error.message}`)
        }
      }
      if (items.length) {
        try {
          present(items)
        } catch (error) {
          return fail(`交付失败：${error?.message || error}`)
        }
      }
      const lines = []
      if (okList.length) lines.push(`已交付给用户（显示在这一轮回复下面）：\n${okList.map((line) => `- ${line}`).join('\n')}`)
      if (bad.length) lines.push(`没能交付：\n${bad.map((line) => `- ${line}`).join('\n')}`)
      return okList.length ? ok(lines.join('\n\n')) : fail(lines.join('\n\n'))
    },
    { alwaysLoad: true },
  )

  const memory = ctx.get('memoryPilot')
  const memoryTools = (memory?.specs || []).map((spec) => tool(
    spec.name,
    spec.description,
    z.fromJSONSchema(spec.inputSchema).shape,
    async (args) => {
      const result = await memory.execute(spec.name, args, { agent: parentAgent(), signal })
      return { content: [{ type: 'text', text: result.text }], ...(result.isError ? { isError: true } : {}) }
    },
    { alwaysLoad: true },
  ))
  return createSdkMcpServer({ name: 'dsh', version: '0.1.0', tools: [taskStart, taskWait, taskSend, taskList, taskStop, deliverFiles, ...memoryTools] })
}

/** 给 Claude 的系统提示补充：它在什么环境里、怎么用 DSH 任务。 */
export const PILOT_PROMPT = [
  '# 运行环境：DSH 界面里的 Claude Code',
  '你在 DeepSeek Harness（DSH）的 Web 界面里和用户对话，界面只负责显示；你的工具、权限、上下文都是 Claude Code 自己的。',
  '你可以用 mcp__dsh__task_start 在 DSH 里派后台任务：每个任务是一个由 DSH 自己的模型执行的子会话，用户在右侧栏能实时看到它。',
  '- 适合把独立、耗时或可并行的执行类工作派出去，你负责拆分、写清任务说明、验收结果并向用户汇报。',
  '- 任务说明必须自包含（子会话看不到你们的对话）；要求它在结束语里汇报做了什么、改了哪些文件、怎么验证的。',
  '- 派出后可以继续和用户交流；任务结束时你会收到「[DSH 任务通知]」开头的消息，届时检查结果（必要时亲自核对文件），不合格就用 task_send 让它返工。',
  '- 需要等结果再继续时用 mcp__dsh__task_wait。不要为了等任务而反复轮询 task_list。',
  '- 用户问进度时用 task_list。',
  '要把文件交给用户（用户说「交付」「发给我」「打包给我」等）时：Write/Edit 写的文件本轮结束会自动成为交付物；命令生成的、二进制的（tgz/zip/pdf/图片）或已有的文件，用 mcp__dsh__deliver_files 交付，用户在对话里就能直接打开或下载。',
].join('\n')
