/**
 * 测试共用的小工具：临时 home、假 agent、假 LLM、假工具注册表。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemoryService } from '../runtime/service.js'

/** 建一个临时数据目录，测试结束删除。 */
export async function tempHome(prefix = 'dsh-mem-test-') {
  const home = await mkdtemp(join(tmpdir(), prefix))
  return {
    home,
    async cleanup() {
      await rm(home, { recursive: true, force: true })
    },
  }
}

/** 建一个不自动轻整理的 service。 */
export async function testService(options = {}) {
  const { home, cleanup } = await tempHome(options.prefix)
  const service = createMemoryService(null, {
    hotBudgetChars: options.hotBudgetChars ?? 6000,
    injectBudgetChars: options.injectBudgetChars ?? 9000,
    recentSessions: options.recentSessions ?? 20,
    graceSessions: options.graceSessions ?? 5,
    staleDays: options.staleDays ?? 30,
    subagentWrites: options.subagentWrites ?? 'inbox',
  }, { home, autoLightMs: 0 })
  return { home, service, cleanup }
}

/** 一个假 agent（session/Session 对象只需要 id/header）。 */
export function fakeAgent({ id = 'session-test-1', cwd = '/home/alice/project', origin, depth } = {}) {
  const header = { id, cwd }
  if (origin !== undefined) header.origin = origin
  if (depth !== undefined) header.delegationDepth = depth
  const session = { id, header }
  return {
    id,
    session,
    options: depth !== undefined ? { subagentDepth: depth } : {},
  }
}

/** 假 LLM：按 prompt 片段返回固定内容；记录调用次数。 */
export function fakeLlm(handlers) {
  const calls = []
  return {
    available: true,
    calls,
    async complete({ system, prompt, maxTokens, signal }) {
      calls.push({ system, prompt, maxTokens })
      for (const [needle, reply] of handlers) {
        if (prompt.includes(needle)) {
          return typeof reply === 'function' ? reply({ prompt, system, calls }) : reply
        }
      }
      return '{}'
    },
  }
}

/** 假工具注册表。 */
export function fakeToolsContext(extra = {}) {
  const tools = new Map()
  const ctx = {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    ...extra,
  }
  return { ctx, tools }
}

/** 运行一个工具并返回 value。 */
export async function runTool(tools, name, args, exec = {}) {
  const definition = tools.get(name)
  if (!definition) throw new Error(`tool not registered: ${name}`)
  return definition.execute(args, { signal: new AbortController().signal, agent: exec.agent, ...exec })
}

/** 简易等待。 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
