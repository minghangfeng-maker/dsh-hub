/**
 * translate.js 的回归测试：把 app-server 的通知流喂给翻译器，检查落盘的会话事件
 * 是否满足 DSH 的会话日志不变式。
 *
 * 重点回归：Codex 并行工具调用时，后一个 item 开始前一个还没 item/completed，
 * 以前会先写 step/end（留下未完成的 tool call）→ 整个 session 被 DSH 判成 corrupt。
 *
 * 跑法：node tools/test-translate.mjs
 */
import assert from 'node:assert/strict'
import { createTranslator } from '../runtime/translate.js'

const TURN = 1

function recorder() {
  const events = []
  return {
    events,
    append(type, data, intent) {
      const event = { type, seq: events.length, time: Date.now(), data: structuredClone(data), ...(intent ? { ...intent } : {}) }
      events.push(event)
      return event
    },
  }
}

/** DSH 的 loop 负责写 turn/start 和 turn/end，这里补上，按真实落盘顺序检查。 */
function withTurnLifecycle(make) {
  const sink = recorder()
  const originalAppend = sink.append
  sink.append = originalAppend
  sink.events.push({ type: 'turn/start', seq: 0, time: Date.now(), data: { turn: TURN } })
  const result = make(sink)
  sink.events.push({ type: 'turn/end', seq: sink.events.length, time: Date.now(), data: { turn: TURN, reason: { kind: 'completed' } } })
  return { ...result, events: sink.events }
}

/** 和 DSH session-format-v4 的关系校验同构：turn/step 边界不能留未完成的 tool call。 */
function checkInvariants(events) {
  let turn = null
  let step = null
  let nextTurn = 1
  let nextStep = 1
  const tools = new Map()
  for (const event of events) {
    const data = event.data || {}
    switch (event.type) {
      case 'turn/start':
        assert.equal(turn, null, `turn/start@${event.seq} 时已有打开的 turn`)
        assert.equal(data.turn, nextTurn, `turn/start@${event.seq} 编号跳了`)
        turn = data.turn
        step = null
        nextStep = 1
        tools.clear()
        break
      case 'turn/end':
        assert.equal(data.turn, turn, `turn/end@${event.seq} 不匹配打开的 turn`)
        assert.equal(step, null, `turn/end@${event.seq} 跨过打开的 step`)
        assert.equal(tools.size, 0, `turn/end@${event.seq} 留下未完成的 tool call：${[...tools.keys()]}`)
        turn = null
        nextTurn += 1
        break
      case 'step/start':
        assert.equal(data.turn, turn, `step/start@${event.seq} 不在打开的 turn 里`)
        assert.equal(step, null, `step/start@${event.seq} 时已打开 step`)
        assert.equal(data.step, nextStep, `step/start@${event.seq} 编号跳了：期望 ${nextStep}`)
        step = data.step
        break
      case 'step/end':
        assert.equal(data.turn, turn, `step/end@${event.seq} 不匹配打开的 turn`)
        assert.equal(data.step, step, `step/end@${event.seq} 不匹配打开的 step`)
        assert.equal(tools.size, 0, `step/end@${event.seq} 留下未完成的 tool call：${[...tools.keys()]}`)
        step = null
        nextStep += 1
        break
      case 'assistant/message':
        assert.equal(data.turn, turn, `assistant/message@${event.seq} 不在打开的 turn 里`)
        assert.equal(data.step, step, `assistant/message@${event.seq} 不在打开的 step 里`)
        for (const block of data.message?.content || []) {
          if (block.type !== 'tool-call') continue
          assert.ok(!tools.has(block.id), `assistant/message@${event.seq} 重复登记 ${block.id}`)
          tools.set(block.id, { turn: data.turn, step: data.step, started: false })
        }
        break
      case 'tool/call': {
        assert.equal(data.turn, turn, `tool/call@${event.seq} 不在打开的 turn 里`)
        assert.equal(data.step, step, `tool/call@${event.seq} 不在打开的 step 里`)
        const tool = tools.get(data.callId)
        assert.ok(tool, `tool/call@${event.seq} ${data.callId} 没有对应的 tool-call 广告`)
        assert.equal(tool.turn, data.turn, `tool/call@${event.seq} 换了 turn`)
        assert.equal(tool.step, data.step, `tool/call@${event.seq} 换了 step`)
        tool.started = true
        break
      }
      case 'tool/result': {
        assert.equal(data.turn, turn, `tool/result@${event.seq} 不在打开的 turn 里`)
        assert.equal(data.step, step, `tool/result@${event.seq} 不在打开的 step 里`)
        const callId = data.message?.toolCallId
        const tool = tools.get(callId)
        assert.ok(tool, `tool/result@${event.seq} ${callId} 没有对应的工具调用`)
        assert.equal(tool.turn, data.turn, `tool/result@${event.seq} 换了 turn`)
        assert.equal(tool.step, data.step, `tool/result@${event.seq} 换了 step`)
        assert.ok(tool.started, `tool/result@${event.seq} 先于 tool/call`)
        tools.delete(callId)
        break
      }
      default:
        break
    }
  }
  assert.equal(turn, null, '采集结束时 turn 还开着')
  assert.equal(step, null, '采集结束时 step 还开着')
  assert.equal(tools.size, 0, `采集结束时还有未完成的 tool call：${[...tools.keys()]}`)
}

/** 假的直播接收端：校验 start/end 成对、chunk 只落在打开的 attempt 里。 */
function fakeLive() {
  const frames = []
  const state = { attempt: 0, started: false, openStep: null, chunks: 0 }
  return {
    state,
    frames,
    handler(frame) {
      frames.push(frame)
      if (frame.type === 'start') {
        assert.equal(state.started, false, '重复 start')
        state.attempt += 1
        state.started = true
        state.openStep = frame.step
      } else if (frame.type === 'chunk') {
        assert.ok(state.started, 'chunk 出现在 start 之前/之后')
        state.chunks += 1
      } else if (frame.type === 'end') {
        assert.ok(state.started, 'end 出现在没有 start 的 attempt 里')
        state.started = false
        state.openStep = null
      }
    },
  }
}

function commandItem(id, command, extra = {}) {
  return { type: 'commandExecution', id, command: ['bash', '-lc', command], cwd: '/tmp', status: 'completed', exitCode: 0, aggregatedOutput: `out:${command}`, ...extra }
}

function started(t, item) {
  t.push({ method: 'item/started', params: { item } })
}
function completed(t, item) {
  t.push({ method: 'item/completed', params: { item } })
}
function run(t, events, opts = {}) {
  for (const message of t) events.push(message)
  return events
}

/** 复现：两个工具并行（A 还没完成 B 就开始了），然后依次完成、结束回合。 */
function parallelTools({ live }, sink) {
  const frames = fakeLive()
  const translator = createTranslator({ turn: TURN, append: sink.append, live: live ? frames.handler : null, stepBase: 0 })
  const push = (method, params) => translator.push({ method, params })
  const a = commandItem('exec-a', 'sleep 2')
  const b = commandItem('exec-b', 'echo hi')
  push('item/started', { item: { ...a, status: 'inProgress', exitCode: null, aggregatedOutput: '' } })
  push('item/started', { item: { ...b, status: 'inProgress', exitCode: null, aggregatedOutput: '' } })
  push('item/completed', { item: b })
  push('item/completed', { item: a })
  push('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
  translator.finish()
  return { events: sink.events, frames, translator }
}

/** 一个工具完成后再开下一个（普通顺序），确认行为没变。 */
function sequentialTools({ live }, sink) {
  const frames = fakeLive()
  const translator = createTranslator({ turn: TURN, append: sink.append, live: live ? frames.handler : null, stepBase: 0 })
  const push = (method, params) => translator.push({ method, params })
  push('item/started', { item: { ...commandItem('exec-a', 'echo a'), status: 'inProgress', exitCode: null, aggregatedOutput: '' } })
  push('item/completed', { item: commandItem('exec-a', 'echo a') })
  push('item/started', { item: { ...commandItem('exec-b', 'echo b'), status: 'inProgress', exitCode: null, aggregatedOutput: '' } })
  push('item/completed', { item: commandItem('exec-b', 'echo b') })
  push('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
  translator.finish()
  return { events: sink.events, frames, translator }
}

/** 用户中途停止：还有工具没结果时 finish 必须补 tool/result，不能留悬空调用。 */
function interrupted(_, sink) {
  const translator = createTranslator({ turn: TURN, append: sink.append, live: null })
  const push = (method, params) => translator.push({ method, params })
  push('item/started', { item: { ...commandItem('exec-a', 'sleep 100'), status: 'inProgress', exitCode: null, aggregatedOutput: '' } })
  push('item/started', { item: { ...commandItem('exec-b', 'sleep 100'), status: 'inProgress', exitCode: null, aggregatedOutput: '' } })
  translator.finish('已被用户停止：这个工具调用没有等到结果')
  const results = sink.events.filter((event) => event.type === 'tool/result')
  assert.equal(results.length, 2, '停止时要补两条 tool/result')
  assert.ok(results.every((event) => event.data.message.isError === true), '补的结果要标记 isError')
  return { events: sink.events }
}

const scenarios = [
  ['并行工具（直播）', () => withTurnLifecycle((sink) => parallelTools({ live: true }, sink))],
  ['并行工具（非直播）', () => withTurnLifecycle((sink) => parallelTools({ live: false }, sink))],
  ['顺序工具（直播）', () => withTurnLifecycle((sink) => sequentialTools({ live: true }, sink))],
  ['顺序工具（非直播）', () => withTurnLifecycle((sink) => sequentialTools({ live: false }, sink))],
]

let failed = 0
for (const [name, make] of scenarios) {
  try {
    const { events, frames, translator } = make()
    checkInvariants(events)
    if (frames) {
      assert.equal(frames.state.started, false, '采集结束时还有没关掉的直播 attempt')
      assert.equal(frames.state.openStep, null, '采集结束时直播还挂在某个 step 上')
    }
    const stepCount = events.filter((event) => event.type === 'step/start').length
    assert.ok(stepCount >= 1, '至少一个 step')
    assert.equal(translator.step, stepCount, `summary step 数与 step/start 数对不上：${translator.step} vs ${stepCount}`)
    const calls = events.filter((event) => event.type === 'tool/call').length
    const results = events.filter((event) => event.type === 'tool/result').length
    assert.equal(calls, results, `tool/call 与 tool/result 不成对：${calls} vs ${results}`)
    console.log(`✔ ${name}（${stepCount} steps, ${calls} calls）`)
  } catch (error) {
    failed += 1
    console.error(`✖ ${name}`)
    console.error(error?.stack || error)
  }
}

try {
  const { events } = withTurnLifecycle((sink) => interrupted(null, sink))
  checkInvariants(events)
  console.log('✔ 中途停止补齐 tool/result')
} catch (error) {
  failed += 1
  console.error('✖ 中途停止补齐 tool/result')
  console.error(error?.stack || error)
}

// 并行工具这个场景以前会写出 step/end + 悬空 tool call；这里再显式确认一次事件顺序：
try {
  const { events } = withTurnLifecycle((sink) => parallelTools({ live: true }, sink))
  const endIndex = events.findIndex((event) => event.type === 'step/end')
  const resultIndex = events.findIndex((event) => event.type === 'tool/result')
  assert.ok(endIndex === -1 || resultIndex < endIndex, '第一个 step/end 之前必须先有 tool/result')
  const firstEndStep = events.findIndex((event) => event.type === 'step/end')
  if (firstEndStep !== -1) {
    const openCalls = events
      .slice(0, firstEndStep)
      .filter((event) => event.type === 'tool/call')
      .map((event) => event.data.callId)
    const results = new Set(events.slice(0, firstEndStep).filter((event) => event.type === 'tool/result').map((event) => event.data.message.toolCallId))
    for (const callId of openCalls) assert.ok(results.has(callId), `step/end 前 ${callId} 还没有结果`)
  }
  console.log('✔ 并行工具场景的 step/end 前工具都已收齐')
} catch (error) {
  failed += 1
  console.error('✖ 并行工具场景的 step/end 前工具都已收齐')
  console.error(error?.stack || error)
}

// 随机顺序 fuzz：多个工具任意先后开始/完成，任何顺序都不许写出悬空 tool call、配对错误。
try {
  let seed = 42
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  const shuffle = (list) => {
    const copy = [...list]
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      ;[copy[i], copy[j]] = [copy[j], copy[i]]
    }
    return copy
  }
  for (let round = 0; round < 200; round += 1) {
    const sink = recorder()
    const frames = fakeLive()
    const translator = createTranslator({ turn: TURN, append: sink.append, live: round % 2 === 0 ? frames.handler : null })
    const push = (method, params) => translator.push({ method, params })
    const count = 1 + Math.floor(rnd() * 4)
    const items = Array.from({ length: count }, (_, index) => commandItem(`exec-f${index}`, `echo ${index}`))
    const startOrder = shuffle(items.map((item, index) => index))
    const completeOrder = shuffle(items.map((item, index) => index))
    for (const index of startOrder) {
      const item = items[index]
      push('item/started', { item: { ...item, status: 'inProgress', exitCode: null, aggregatedOutput: '' } })
    }
    for (const index of completeOrder) push('item/completed', { item: items[index] })
    push('turn/completed', { turn: { id: `turn-${round}`, status: 'completed' } })
    translator.finish()
    checkInvariants([{ type: 'turn/start', seq: -1, data: { turn: TURN } }, ...sink.events, { type: 'turn/end', seq: 9999, data: { turn: TURN, reason: { kind: 'completed' } } }])
    assert.equal(sink.events.filter((e) => e.type === 'tool/call').length, count, 'call 数不对')
    assert.equal(sink.events.filter((e) => e.type === 'tool/result').length, count, 'result 数不对')
    if (frames) assert.equal(frames.state.started, false, `fuzz round ${round}: 直播 attempt 没关`)
  }
  console.log('✔ 随机顺序 fuzz（200 轮）')
} catch (error) {
  failed += 1
  console.error('✖ 随机顺序 fuzz')
  console.error(error?.stack || error)
}

if (failed > 0) {
  console.error(`\n${failed} 个场景失败`)
  process.exit(1)
}
console.log('\n全部通过')
