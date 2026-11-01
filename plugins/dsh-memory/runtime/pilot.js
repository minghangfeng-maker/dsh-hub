/** Shared adapter for Claude SDK MCP tools and Codex app-server dynamic tools.
 * Reuses the running memory service, including its configured home and policies.
 */
import { buildInjection } from './inject.js'
import { registerTools } from './tools.js'

export function createMemoryPilot(service) {
  const definitions = new Map()
  registerTools({ tools: { register(definition) {
    definitions.set(definition.name, definition)
    return () => definitions.delete(definition.name)
  } } }, service)

  return {
    specs: [...definitions.values()].map(({ name, description, parameters }) => ({
      name, description, inputSchema: parameters,
    })),
    async execute(name, args, { agent, signal } = {}) {
      const definition = definitions.get(name)
      if (!definition) return { text: `未知记忆工具：${name}`, isError: true }
      if (!agent?.session?.id) return { text: '记忆工具需要当前 DSH 会话身份。', isError: true }
      if (signal?.aborted) return { text: '操作已取消。', isError: true }
      try {
        const value = await definition.execute(args, { agent, signal })
        const blocks = definition.output.render(args, value)
        return { text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), isError: value.ok === false }
      } catch (error) {
        return { text: `记忆操作失败：${error.message}`, isError: true }
      }
    },
    async prepare(agent, previous = {}) {
      // Pilot compaction runs in the external agent. Its translated events live
      // in the DSH session; keep a separate cursor from native injection state.
      const compactions = (agent.session.snapshotEvents?.() || [])
        .filter((e) => e.type === 'compaction/end' || e.type === 'compaction/summary').length
      const result = await buildInjection({ service, agent, state: {
        ...previous,
        compacted: previous.compacted || compactions > (previous.pilotCompactions || 0),
      } })
      return {
        text: result.messages.flatMap((m) => m.content).map((b) => b.text || '').join('\n\n'),
        state: { ...result.state, pilotCompactions: compactions },
      }
    },
  }
}
