/**
 * Claude Agent SDK 消息 → DSH 原生会话事件。
 *
 * 一个 DSH turn 内的事件顺序（照抄原生 loop 的黄金样本）：
 *   step/start{turn,step}
 *   assistant/message{turn,step,message:{role,content:[reasoning|text|tool-call],source,id},stream:[]}  ← surfaceOp:'append'
 *   tool/call{turn,step,callId,name,arguments}                ← arguments 是 JSON 字符串
 *   tool/result{turn,step,message:{role:'tool',source:{kind:'tool',callId},toolCallId,content,isError,id}}
 *   step/end{turn,step}
 * turn/start、turn/end 由 DSH 的 agent loop 自己写（我们在 pre-step 里返回 enter 空消息）。
 *
 * 工具名用 DSH 的 wire 名（bash/read/edit/…），客户端现成的工具卡就直接认。
 * 派 DSH 任务的 MCP 工具映射成原生 `subagent`，主对话里出现的就是原生子代理卡片。
 */
import { randomUUID } from 'node:crypto'

// Windows 上 Claude Code 的命令工具可能叫 PowerShell（见 CLAUDE_CODE_USE_POWERSHELL_TOOL），
// 也可能叫 Windows PowerShell 5.1 那条路径；它们都归到 DSH 的 bash 卡片（一条命令行）
const TOOL_NAME_MAP = {
  Bash: 'bash',
  BashOutput: 'bash',
  KillShell: 'bash',
  PowerShell: 'bash',
  PowerShellScript: 'bash',
  Read: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'write',
  Glob: 'glob',
  Grep: 'grep',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search',
  TodoWrite: 'todo_write',
  Skill: 'skill',
  Task: 'subagent',
  Agent: 'subagent',
  NotebookEdit: 'notebook_edit',
  ExitPlanMode: 'exit_plan_mode',
  'mcp__dsh__task_start': 'subagent',
  'mcp__dsh__task_send': 'send_message',
}

/** 这些调用对用户没有信息量（Claude 内部的工具检索），不写进 DSH 会话。 */
const HIDDEN_TOOLS = new Set(['ToolSearch'])

export function dshToolName(name) {
  const raw = String(name || 'tool')
  if (TOOL_NAME_MAP[raw]) return TOOL_NAME_MAP[raw]
  return raw.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

/** 按 DSH 工具卡认的入参形状改写（只改那几个映射到原生卡片的工具）。 */
export function dshToolArgs(name, input) {
  const args = input && typeof input === 'object' ? input : {}
  switch (name) {
    case 'mcp__dsh__task_start':
      return { description: args.label || '', prompt: args.task || '', ...(args.cwd ? { cwd: args.cwd } : {}) }
    case 'mcp__dsh__task_send':
      return { agent_id: args.id || '', message: args.message || '' }
    case 'Agent':
    case 'Task':
      return { description: args.description || '', prompt: args.prompt || '' }
    default:
      return args
  }
}

/** Anthropic usage → DSH TokenUsage。 */
export function usageOf(usage) {
  if (!usage || typeof usage !== 'object') return null
  const input = Number(usage.input_tokens) || 0
  const output = Number(usage.output_tokens) || 0
  const cacheRead = Number(usage.cache_read_input_tokens) || 0
  const cacheWrite = Number(usage.cache_creation_input_tokens) || 0
  if (!input && !output && !cacheRead && !cacheWrite) return null
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output + cacheRead + cacheWrite,
    ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite ? { cacheWriteTokens: cacheWrite } : {}),
  }
}

export function truncate(text, limit) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n…[已截断，共 ${value.length} 字符]`
}

/** Claude 的哪些工具调用算"产出了文件"（DSH 交付物）。 */
export function touchedFile(toolName, input) {
  if (!input || typeof input !== 'object') return null
  const raw = input.file_path || input.notebook_path || input.path
  if (typeof raw !== 'string' || !raw.trim()) return null
  const path = raw.trim()
  if (toolName === 'Write') return { path, kind: 'created' }
  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') return { path, kind: 'edited' }
  return null
}

function resultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : String(content)
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part?.type === 'text') return part.text || ''
      if (part?.type === 'image') return '[图片]'
      if (part?.type === 'tool_reference') return `[引用工具 ${part.tool_name || ''}]`
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * live(frame)：可选的流式出口（agent/assistant-stream 帧，不带 revision/attemptId，由调用方补齐）。
 * 同一条 API 消息的各个内容块（SDK 会拆成多条 assistant 消息）先合并，收到 message_stop 时
 * 一次性写成 assistant/message，再发结束帧 —— 界面就把逐字显示的临时行换成正式消息。
 */
export function createTranslator({ turn, append, live = null, maxToolResultChars = 30000, provider = 'claude-code', model = null, stepBase = 0, onWrote = null }) {
  // stepBase：同一个 DSH turn 里接着跑第二段 Claude（插话后）时，step 编号接着上一段往后数
  let step = stepBase
  let open = false
  let resolvedModel = model
  let ccSessionId = null
  let lastUsage = null
  let rateLimit = null
  let result = null
  let compacted = null
  const counts = { steps: 0, toolCalls: 0, results: 0, texts: 0 }
  const pendingCalls = new Set()
  const hiddenCalls = new Set()
  const wrote = new Map()
  // Write/Edit 的 callId → 写的文件：结果成功回来时交给 onWrote（当场交付，DSH 只认收尾回复之前的交付）
  const wroteCalls = new Map()
  // 当前 step 里是否已经写过 assistant 消息（直播时 step 先开、消息后写）
  let stepUsed = false
  // 正在组装的一条 API 消息
  let pending = null
  // 正在逐字直播的一次尝试：{ index, blocks: Map<apiIndex, {kind, id, name, hidden}> }
  let streaming = null

  const closeStep = () => {
    if (!open) return
    append('step/end', { turn, step })
    open = false
  }
  const openStep = () => {
    closeStep()
    step += 1
    append('step/start', { turn, step })
    open = true
    stepUsed = false
    counts.steps += 1
  }
  const toolResult = (callId, text, isError) => {
    if (!open) openStep()
    pendingCalls.delete(callId)
    counts.results += 1
    append(
      'tool/result',
      {
        turn,
        step,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId },
          toolCallId: callId,
          content: [{ type: 'text', text: truncate(text, maxToolResultChars) }],
          isError: isError === true,
          id: randomUUID(),
        },
      },
      { surfaceOp: 'append' },
    )
  }
  const liveChunk = (chunk) => {
    if (!live || !streaming?.started) return
    live({ type: 'chunk', index: streaming.index++, time: Date.now(), chunk })
  }
  const endLive = (outcome) => {
    if (!live || !streaming) return
    if (streaming.started) live({ type: 'end', index: streaming.index, outcome })
    streaming = null
  }

  /** 把组装好的一条 API 消息写进会话（新开一个 step），并结束对应的直播。 */
  const commit = () => {
    const message = pending
    pending = null
    if (!message || !message.content.length) {
      endLive({ kind: 'abandoned' })
      return
    }
    if (!open || stepUsed) openStep()
    stepUsed = true
    const event = append(
      'assistant/message',
      {
        turn,
        step,
        message: {
          role: 'assistant',
          content: message.content,
          source: { kind: 'model', provider, model: resolvedModel || model || provider },
          id: randomUUID(),
        },
        stream: [],
        ...(message.usage ? { usage: message.usage } : {}),
      },
      { surfaceOp: 'append' },
    )
    endLive(typeof event?.seq === 'number' ? { kind: 'committed', eventType: 'assistant/message', seq: event.seq } : { kind: 'abandoned' })
    for (const call of message.calls) {
      pendingCalls.add(call.id)
      counts.toolCalls += 1
      append('tool/call', { turn, step, callId: call.id, name: call.name, arguments: call.arguments })
    }
  }

  /** SDK 的 stream_event（Anthropic 流式事件）→ DSH 直播帧。 */
  const onStreamEvent = (event) => {
    if (!event || !live) return
    switch (event.type) {
      case 'message_start':
        if (pending) commit()
        endLive({ kind: 'abandoned' })
        streaming = { index: 0, blocks: new Map(), started: false }
        return
      case 'content_block_start': {
        if (!streaming) return
        const block = event.content_block || {}
        const kind = block.type === 'thinking' || block.type === 'redacted_thinking' ? 'reasoning' : block.type === 'tool_use' ? 'tool-call' : block.type === 'text' ? 'text' : null
        const hidden = !kind || (kind === 'tool-call' && HIDDEN_TOOLS.has(block.name))
        streaming.blocks.set(event.index, { kind, id: block.id, name: block.name, hidden, named: false })
        if (hidden) return
        if (!streaming.started) {
          openStep()
          live({ type: 'start', turn, step })
          streaming.started = true
        }
        liveChunk({ type: 'block-start', index: event.index, blockType: kind })
        return
      }
      case 'content_block_delta': {
        const info = streaming?.blocks.get(event.index)
        if (!info || info.hidden) return
        const delta = event.delta || {}
        if (delta.type === 'text_delta' && delta.text) liveChunk({ type: 'text-delta', index: event.index, text: delta.text })
        else if (delta.type === 'thinking_delta' && delta.thinking) liveChunk({ type: 'reasoning-delta', index: event.index, text: delta.thinking })
        else if (delta.type === 'input_json_delta') {
          liveChunk({ type: 'tool-call-delta', index: event.index, id: info.id, ...(info.named ? {} : { name: dshToolName(info.name) }), argumentsDelta: delta.partial_json || '' })
          info.named = true
        }
        return
      }
      case 'message_stop':
        if (pending) commit()
        return
      default:
    }
  }

  return {
    get step() {
      return step
    },
    get ccSessionId() {
      return ccSessionId
    },
    get result() {
      return result
    },
    get summary() {
      return { ...counts, model: resolvedModel, ccSessionId, usage: lastUsage, rateLimit, compacted, wrote: [...wrote.values()] }
    },
    push(raw) {
      if (!raw || typeof raw !== 'object') return
      // 子代理（Claude 自己的 Task/Agent 工具）内部的消息不进主对话：只保留它在主线上的调用与结果
      if (raw.parent_tool_use_id) return
      switch (raw.type) {
        case 'system':
          if (raw.subtype === 'init') {
            ccSessionId = raw.session_id || ccSessionId
            resolvedModel = raw.model || resolvedModel
          } else if (raw.subtype === 'compact_boundary') {
            compacted = raw.compact_metadata || {}
          }
          return
        case 'stream_event':
          onStreamEvent(raw.event)
          return
        case 'assistant': {
          const apiId = raw.message?.id || null
          if (pending && pending.apiId !== apiId) commit()
          pending ||= { apiId, content: [], calls: [], usage: null }
          const messageUsage = usageOf(raw.message?.usage)
          if (messageUsage) {
            lastUsage = raw.message.usage
            pending.usage = messageUsage
          }
          for (const block of Array.isArray(raw.message?.content) ? raw.message.content : []) {
            if (block?.type === 'text' && String(block.text || '').trim()) {
              pending.content.push({ type: 'text', text: block.text })
              counts.texts += 1
            } else if (block?.type === 'thinking' && String(block.thinking || '').trim()) {
              pending.content.push({ type: 'reasoning', text: block.thinking })
            } else if (block?.type === 'redacted_thinking') {
              pending.content.push({ type: 'reasoning', text: '(思考内容已隐藏)' })
            } else if (block?.type === 'tool_use') {
              if (HIDDEN_TOOLS.has(block.name)) {
                hiddenCalls.add(block.id)
                continue
              }
              const name = dshToolName(block.name)
              const args = JSON.stringify(dshToolArgs(block.name, block.input))
              pending.content.push({ type: 'tool-call', id: block.id, name, arguments: args })
              pending.calls.push({ id: block.id, name, arguments: args })
              const touched = touchedFile(String(block.name || ''), block.input)
              if (touched) {
                wrote.set(touched.path, { ...touched, callId: block.id })
                wroteCalls.set(block.id, touched)
              }
            }
          }
          // 没有直播（流式事件没开）时逐条落盘
          if (!live || !streaming) commit()
          return
        }
        case 'user': {
          if (pending) commit()
          const blocks = Array.isArray(raw.message?.content) ? raw.message.content : []
          for (const block of blocks) {
            if (block?.type !== 'tool_result') continue
            if (hiddenCalls.delete(block.tool_use_id)) continue
            toolResult(block.tool_use_id, resultText(block.content), block.is_error === true)
            const touched = wroteCalls.get(block.tool_use_id)
            if (touched && block.is_error !== true && onWrote) {
              try {
                onWrote(touched)
              } catch (error) {
                console.warn(`[claude-pilot] 交付物写入失败：${error.message}`)
              }
            }
          }
          return
        }
        case 'result':
          if (pending) commit()
          result = raw
          return
        case 'rate_limit_event':
          if (raw.rate_limit_info) rateLimit = raw.rate_limit_info
          return
        default:
          return
      }
    },
    /** 收尾：落盘未完成的消息，补齐没等到结果的工具调用（会话格式要求 call/result 成对），关掉当前 step。 */
    finish(reason = '已被用户停止：这个工具调用没有等到结果') {
      if (pending) commit()
      endLive({ kind: 'abandoned' })
      for (const callId of [...pendingCalls]) toolResult(callId, reason, true)
      closeStep()
      return this.summary
    },
  }
}
