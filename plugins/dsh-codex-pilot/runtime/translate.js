/**
 * codex app-server 的通知（item/started、item/completed、各种 delta）→ DSH 原生会话事件。
 *
 * 一个 DSH turn 内的事件顺序（同原生 loop）：
 *   step/start{turn,step}
 *   assistant/message{turn,step,message:{role,content:[reasoning|text|tool-call],source,id},stream:[]}  ← surfaceOp:'append'
 *   tool/call{turn,step,callId,name,arguments}
 *   tool/result{turn,step,message:{role:'tool',source:{kind:'tool',callId},toolCallId,content,isError,id}}
 *   step/end{turn,step}
 *
 * Codex 的 item 是一条一条来的：思考 / 正文先攒成一条 assistant 消息（边来边直播），
 * 遇到工具类 item（命令、改文件、MCP、动态工具、搜索）就把它作为 tool-call 收进这条消息并落盘，
 * 等它 item/completed 时写 tool/result；之后的思考 / 正文开新的 step。
 */
import { randomUUID } from 'node:crypto'

export function truncate(text, limit) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n…[已截断，共 ${value.length} 字符]`
}

const TOOL_TYPES = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageView', 'collabAgentToolCall', 'imageGeneration'])

/** "/bin/bash -lc 'ls -la'" → "ls -la"（只为显示）。 */
export function unwrapShell(command) {
  const text = Array.isArray(command) ? command.join(' ') : String(command || '')
  const trimmed = text.trim()
  const posix = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/.exec(trimmed)
  let raw = posix ? posix[1] : null
  if (raw === null) {
    // Windows：`["C:\path\"]cmd.exe /d /s /c "..."` 或 `[...]pwsh.exe -Command "..."`（Codex 在 Windows 上就是这么跑的）
    const head = /^(?:"([^"]+)"|(\S+))(?:\s+([\s\S]*))?$/.exec(trimmed)
    if (head) {
      const program = String(head[1] || head[2] || '').split(/[\\/]/).pop().toLowerCase()
      const rest = head[3] || ''
      if (/^cmd(\.exe)?$/.test(program)) {
        const match = /^\/[dD]\s+\/[sS]\s+\/[cC]\s+([\s\S]+)$/.exec(rest) || /^\/[cC]\s+([\s\S]+)$/.exec(rest)
        if (match) raw = match[1]
      } else if (/^(powershell|pwsh)(\.exe)?$/.test(program)) {
        const match = /^(?:(?:-NoProfile|-NoLogo|-NonInteractive)\s+|-ExecutionPolicy\s+\S+\s+)*(?:-Command|-c)\s+([\s\S]+)$/i.exec(rest)
        if (match) raw = match[1]
      }
    }
  }
  if (raw === null) return text
  let body = raw.trim()
  if ((body.startsWith("'") && body.endsWith("'")) || (body.startsWith('"') && body.endsWith('"'))) {
    body = body.slice(1, -1).replace(/'\\''/g, "'")
  }
  return body
}

/** 一段 unified diff → edit 卡片要的 old/new（每个 hunk 拼起来，hunk 之间用 ⋯ 隔开）。 */
export function diffToEdit(diff) {
  const olds = []
  const news = []
  let oldLines = null
  let newLines = null
  const flush = () => {
    if (oldLines) olds.push(oldLines.join('\n'))
    if (newLines) news.push(newLines.join('\n'))
    oldLines = null
    newLines = null
  }
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('@@')) {
      flush()
      oldLines = []
      newLines = []
      continue
    }
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('index ')) continue
    if (!oldLines) {
      oldLines = []
      newLines = []
    }
    if (line.startsWith('\\')) continue
    const mark = line[0]
    const body = line.slice(1)
    if (mark === '-') oldLines.push(body)
    else if (mark === '+') newLines.push(body)
    else {
      oldLines.push(mark === ' ' ? body : line)
      newLines.push(mark === ' ' ? body : line)
    }
  }
  flush()
  return { old_string: olds.join('\n⋯\n'), new_string: news.join('\n⋯\n') }
}

function addedContent(diff) {
  const lines = String(diff || '').split('\n')
  const body = lines.filter((line) => !line.startsWith('@@') && !line.startsWith('+++') && !line.startsWith('---'))
  // 新增文件的 diff 每行都以 + 开头；不是的话原样给出
  return body.every((line) => line === '' || line.startsWith('+')) ? body.map((line) => line.slice(1)).join('\n') : String(diff || '')
}

function contentText(items) {
  if (!Array.isArray(items)) return ''
  return items
    .map((part) => {
      if (typeof part === 'string') return part
      if (part?.type === 'inputText' || part?.type === 'text') return part.text || ''
      if (part?.type === 'inputImage' || part?.type === 'image') return '[图片]'
      return part ? JSON.stringify(part) : ''
    })
    .filter(Boolean)
    .join('\n')
}

/** Codex item → 一个或多个 DSH 工具调用 {id, name, args, touched?}。 */
export function callsOf(item) {
  switch (item.type) {
    case 'commandExecution': {
      const command = unwrapShell(item.command)
      const first = command.split('\n')[0]
      return [{ id: item.id, name: 'bash', args: { description: first.length > 80 ? `${first.slice(0, 77)}…` : first, command, ...(item.cwd ? { workdir: item.cwd } : {}) } }]
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : []
      if (!changes.length) return [{ id: item.id, name: 'apply_patch', args: {} }]
      return changes.map((change, index) => {
        const id = changes.length === 1 ? item.id : `${item.id}#${index}`
        const kind = change.kind?.type
        if (kind === 'add') return { id, name: 'write', args: { file_path: change.path, content: addedContent(change.diff) }, touched: { path: change.path, kind: 'created' } }
        if (kind === 'delete') return { id, name: 'apply_patch', args: { file_path: change.path, action: 'delete' } }
        const target = change.kind?.move_path || change.path
        return { id, name: 'edit', args: { file_path: target, ...diffToEdit(change.diff) }, touched: { path: target, kind: 'edited' } }
      })
    }
    case 'mcpToolCall':
      return [{ id: item.id, name: `mcp__${item.server}__${item.tool}`, args: item.arguments && typeof item.arguments === 'object' ? item.arguments : { arguments: item.arguments } }]
    case 'dynamicToolCall': {
      const args = item.arguments && typeof item.arguments === 'object' ? item.arguments : {}
      if (item.tool === 'task_start') return [{ id: item.id, name: 'subagent', args: { description: args.label || '', prompt: args.task || '', ...(args.cwd ? { cwd: args.cwd } : {}) } }]
      if (item.tool === 'task_send') return [{ id: item.id, name: 'send_message', args: { agent_id: args.id || '', message: args.message || '' } }]
      return [{ id: item.id, name: item.tool, args }]
    }
    case 'webSearch': {
      const action = item.action || {}
      if (action.type === 'open_page') return [{ id: item.id, name: 'web_fetch', args: { url: action.url || item.query || '' } }]
      return [{ id: item.id, name: 'web_search', args: { query: item.query || action.query || (action.queries || []).join(' / ') } }]
    }
    case 'imageView':
      return [{ id: item.id, name: 'read_image', args: { file_path: item.path } }]
    case 'collabAgentToolCall':
      return [{ id: item.id, name: 'codex_agent', args: { action: item.tool, ...(item.prompt ? { prompt: item.prompt } : {}), ...(item.model ? { model: item.model } : {}) } }]
    case 'imageGeneration':
      return [{ id: item.id, name: 'image_generation', args: { prompt: item.prompt || item.revisedPrompt || '' } }]
    default:
      return []
  }
}

/** 工具 item 完成后给 DSH 的结果文本。 */
export function resultOf(item, call) {
  switch (item.type) {
    case 'commandExecution': {
      const output = String(item.aggregatedOutput ?? '').replace(/\s+$/, '')
      const code = item.exitCode
      const failed = item.status === 'failed' || item.status === 'declined' || (typeof code === 'number' && code !== 0)
      const tailNote = item.status === 'declined' ? '（被拒绝执行）' : typeof code === 'number' && code !== 0 ? `\n[exit code ${code}]` : ''
      return { text: `${output || (failed ? '' : '(无输出)')}${tailNote}`.trim() || '(无输出)', isError: failed }
    }
    case 'fileChange': {
      const ok = item.status === 'completed'
      const change = (item.changes || []).find((entry, index) => (item.changes.length === 1 ? item.id : `${item.id}#${index}`) === call.id)
      const verb = { add: '已新建', delete: '已删除', update: '已修改' }[change?.kind?.type] || '已修改'
      return ok ? { text: `${verb} ${change?.path || ''}`.trim(), isError: false } : { text: `没有应用（${item.status}）`, isError: true }
    }
    case 'mcpToolCall':
      if (item.error) return { text: item.error.message || JSON.stringify(item.error), isError: true }
      return { text: contentText(item.result?.content) || (item.result?.structuredContent ? JSON.stringify(item.result.structuredContent) : '(无输出)'), isError: false }
    case 'dynamicToolCall':
      return { text: contentText(item.contentItems) || (item.success === false ? '失败' : '(无输出)'), isError: item.success === false }
    case 'webSearch': {
      const results = Array.isArray(item.results) ? item.results : []
      const lines = results.slice(0, 10).map((entry) => (typeof entry === 'string' ? entry : [entry?.title, entry?.url].filter(Boolean).join(' — ') || JSON.stringify(entry)))
      return { text: lines.length ? lines.join('\n') : `已搜索：${item.query || ''}`, isError: false }
    }
    case 'imageView':
      return { text: '[图片已查看]', isError: false }
    case 'collabAgentToolCall':
      return { text: `${item.status}${item.receiverThreadIds?.length ? `：${item.receiverThreadIds.join(', ')}` : ''}`, isError: item.status === 'failed' }
    default:
      return { text: item.status ? String(item.status) : '完成', isError: item.status === 'failed' }
  }
}

/** 思考摘要里的加粗标题（Codex TUI 拿它当状态行），例如 "**Inspecting the repo**"。 */
export function headerOf(text) {
  const match = /\*\*([^*\n]{2,80})\*\*/.exec(String(text || ''))
  return match ? match[1].trim() : null
}

export function createTranslator({ turn, append, live = null, maxToolResultChars = 30000, provider = 'codex', model = null, onActivity = null, stepBase = 0, onWrote = null }) {
  // stepBase：同一个 DSH turn 里接着跑下一段 Codex 时，step 编号接着上一段往后数
  let step = stepBase
  let open = false
  let stepUsed = false
  let segment = null
  let resolvedModel = model
  let usage = null
  let compacted = false
  let turnInfo = null
  const errors = []
  const counts = { steps: 0, toolCalls: 0, results: 0, texts: 0 }
  const pendingCalls = new Map()
  const wrote = new Map()
  // item 级的缓冲：思考摘要、正文（直播开始前也要攒着）
  const buffers = new Map()
  const startedTools = new Set()

  // Codex 会并行跑工具：后一个 item 开始时前一个可能还没出结果。工具没出结果前绝不能写
  // step/end（DSH 会把「step/end 留着未完成的 tool call」判成会话日志损坏，整段历史都打不开）。
  // 这段窗口里后来的内容先并进当前 step（一步里放多条 assistant 消息是合法的），
  // 直播帧先攒着，等工具收齐、能开新 step 时再补发。
  const busy = () => pendingCalls.size > 0
  const closeStep = () => {
    if (!open || busy()) return false
    append('step/end', { turn, step })
    open = false
    return true
  }
  const openStep = () => {
    if (busy()) return false
    closeStep()
    step += 1
    append('step/start', { turn, step })
    open = true
    stepUsed = false
    counts.steps += 1
    return true
  }
  const liveStart = () => {
    if (!live || !segment || segment.started) return
    if (!openStep()) return
    segment.started = true
    live({ type: 'start', turn, step })
    for (const frame of segment.frames.splice(0)) live(frame)
  }
  const ensureSegment = () => {
    if (segment) return segment
    segment = { content: [], calls: [], index: 0, blocks: new Map(), started: false, frames: [] }
    if (live) liveStart()
    return segment
  }
  const liveChunk = (chunk) => {
    if (!live || !segment) return
    const frame = { type: 'chunk', index: segment.index++, time: Date.now(), chunk }
    if (segment.started) live(frame)
    else segment.frames.push(frame)
  }
  const blockIndex = (itemId, kind) => {
    const seg = ensureSegment()
    if (!seg.blocks.has(itemId)) {
      const index = seg.blocks.size
      seg.blocks.set(itemId, index)
      liveChunk({ type: 'block-start', index, blockType: kind })
    }
    return seg.blocks.get(itemId)
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
    // 工具收齐了：如果新一段内容在等 step，现在补开并补发攒下的直播帧
    liveStart()
  }
  const commit = () => {
    const seg = segment
    segment = null
    if (!seg) return
    if (!seg.content.length) {
      if (live && seg.started) live({ type: 'end', index: seg.index, outcome: { kind: 'abandoned' } })
      return
    }
    if (!open || stepUsed) openStep()
    stepUsed = true
    const event = append(
      'assistant/message',
      {
        turn,
        step,
        message: { role: 'assistant', content: seg.content, source: { kind: 'model', provider, model: resolvedModel || provider }, id: randomUUID() },
        stream: [],
      },
      { surfaceOp: 'append' },
    )
    if (live && seg.started) {
      live({ type: 'end', index: seg.index, outcome: typeof event?.seq === 'number' ? { kind: 'committed', eventType: 'assistant/message', seq: event.seq } : { kind: 'abandoned' } })
    }
    for (const call of seg.calls) {
      pendingCalls.set(call.id, call)
      counts.toolCalls += 1
      append('tool/call', { turn, step, callId: call.id, name: call.name, arguments: call.arguments })
    }
  }

  const toolStarted = (item) => {
    if (startedTools.has(item.id)) return
    startedTools.add(item.id)
    const calls = callsOf(item)
    if (!calls.length) return
    const seg = ensureSegment()
    for (const call of calls) {
      const args = JSON.stringify(call.args)
      const index = seg.blocks.size
      seg.blocks.set(call.id, index)
      liveChunk({ type: 'block-start', index, blockType: 'tool-call' })
      liveChunk({ type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: args })
      seg.content.push({ type: 'tool-call', id: call.id, name: call.name, arguments: args })
      seg.calls.push({ id: call.id, name: call.name, arguments: args, item: item.id })
      if (call.touched) wrote.set(call.touched.path, call.touched)
    }
    commit()
  }
  const toolCompleted = (item) => {
    if (!startedTools.has(item.id)) toolStarted(item)
    // fileChange 的 changes 在完成时才齐全：开始时没有的文件补登记
    if (item.type === 'fileChange') for (const call of callsOf(item)) if (call.touched) wrote.set(call.touched.path, call.touched)
    for (const call of [...pendingCalls.values()].filter((entry) => entry.item === item.id)) {
      const { text, isError } = resultOf(item, call)
      toolResult(call.id, text, isError)
      // 改文件成功 → 当场交付（DSH 只认收尾回复之前的交付）
      if (!isError && item.type === 'fileChange' && onWrote) {
        const touched = callsOf(item).find((entry) => entry.id === call.id)?.touched
        if (touched) {
          try {
            onWrote(touched)
          } catch (error) {
            console.warn(`[codex-pilot] 交付物写入失败：${error.message}`)
          }
        }
      }
    }
  }

  const buffer = (itemId) => {
    if (!buffers.has(itemId)) buffers.set(itemId, { text: '', live: false })
    return buffers.get(itemId)
  }
  const delta = (itemId, kind, text) => {
    if (!text) return
    const entry = buffer(itemId)
    entry.text += text
    if (!live) return
    const index = blockIndex(itemId, kind)
    liveChunk({ type: kind === 'reasoning' ? 'reasoning-delta' : 'text-delta', index, text })
  }

  return {
    get step() {
      return step
    },
    get summary() {
      return { ...counts, model: resolvedModel, usage, compacted, errors: [...errors], turn: turnInfo, wrote: [...wrote.values()] }
    },
    /** 还没等到结果的工具 item（停止时用来找出要结束的命令） */
    pendingItems() {
      return [...new Set([...pendingCalls.values()].map((call) => call.item))]
    },
    setModel(value) {
      if (value) resolvedModel = value
    },
    /** 插话被 Codex 吃进去的那一刻：先把手上的内容落盘、关掉当前 step，再让调用方写 user/message（和 DSH 自己 step 边界插话的顺序一致） */
    interject(write) {
      if (segment) commit()
      closeStep()
      write()
    },
    push(message) {
      const params = message?.params || {}
      switch (message?.method) {
        case 'item/started': {
          const item = params.item || {}
          if (TOOL_TYPES.has(item.type)) toolStarted(item)
          else if (item.type === 'contextCompaction') compacted = true
          return
        }
        case 'item/agentMessage/delta':
          delta(params.itemId, 'text', params.delta)
          return
        case 'item/reasoning/summaryTextDelta':
        case 'item/reasoning/textDelta': {
          delta(params.itemId, 'reasoning', params.delta)
          const header = headerOf(buffer(params.itemId).text)
          if (header) onActivity?.(header)
          return
        }
        case 'item/reasoning/summaryPartAdded':
          if (buffer(params.itemId).text) delta(params.itemId, 'reasoning', '\n\n')
          return
        case 'item/completed': {
          const item = params.item || {}
          if (item.type === 'reasoning') {
            const text = (item.summary || []).join('\n\n').trim() || (item.content || []).join('\n').trim() || buffer(item.id).text.trim()
            buffers.delete(item.id)
            if (!text) return
            const seg = ensureSegment()
            if (!seg.blocks.has(item.id)) blockIndex(item.id, 'reasoning')
            seg.content.push({ type: 'reasoning', text })
            const header = headerOf(text)
            if (header) onActivity?.(header)
          } else if (item.type === 'agentMessage') {
            const text = String(item.text || buffer(item.id).text || '')
            buffers.delete(item.id)
            if (!text.trim()) return
            const seg = ensureSegment()
            if (!seg.blocks.has(item.id)) {
              blockIndex(item.id, 'text')
              liveChunk({ type: 'text-delta', index: seg.blocks.get(item.id), text })
            }
            seg.content.push({ type: 'text', text })
            counts.texts += 1
          } else if (TOOL_TYPES.has(item.type)) {
            toolCompleted(item)
          } else if (item.type === 'contextCompaction') {
            compacted = true
          } else if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') {
            // review 的结论在 exitedReviewMode.review 里（同时也会作为正文出现）
          }
          return
        }
        case 'turn/plan/updated': {
          const plan = Array.isArray(params.plan) ? params.plan : []
          if (!plan.length) return
          const todos = plan.map((entry) => ({ content: entry.step, status: entry.status === 'inProgress' ? 'in_progress' : entry.status === 'completed' ? 'completed' : 'pending' }))
          const id = `plan-${randomUUID().slice(0, 8)}`
          const seg = ensureSegment()
          const args = JSON.stringify({ todos })
          seg.content.push({ type: 'tool-call', id, name: 'todo_write', arguments: args })
          seg.calls.push({ id, name: 'todo_write', arguments: args, item: id })
          commit()
          toolResult(id, todos.map((todo) => `[${todo.status === 'completed' ? 'x' : todo.status === 'in_progress' ? '~' : ' '}] ${todo.content}`).join('\n'), false)
          return
        }
        case 'thread/tokenUsage/updated':
          usage = params.tokenUsage || usage
          return
        case 'error':
          if (!params.willRetry && params.error?.message) errors.push(params.error.message)
          return
        case 'turn/completed':
          turnInfo = params.turn || null
          if (segment) commit()
          return
        case 'server/exited':
          errors.push(params.message || 'codex app-server 退出了')
          return
        default:
      }
    },
    /** 收尾：落盘没提交的内容，补齐没等到结果的工具调用（call/result 必须成对），关掉当前 step。 */
    finish(reason = '已被用户停止：这个工具调用没有等到结果') {
      if (segment) commit()
      for (const callId of [...pendingCalls.keys()]) toolResult(callId, reason, true)
      closeStep()
      return this.summary
    },
  }
}
