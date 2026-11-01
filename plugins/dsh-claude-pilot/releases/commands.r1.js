/**
 * dsh-claude-pilot/commands —— 挂在「Claude Code」预设里的命令插件。
 *
 * 预设里的插件装在 agent 自己的上下文下，所以这里注册的命令只对 Claude Code 模式的对话生效，
 * 并且会遮蔽同名的 DSH 全局命令（例如 /compact 在这里压缩的是 Claude 的上下文）。
 * 命令目录与实现都在 host 插件（index.r1.js 经 globalThis.__claudePilot 交过来）。
 */
export const name = 'claude-pilot-commands'
export const inject = ['commands']

export function apply(ctx) {
  const pilot = globalThis.__claudePilot
  if (!pilot) {
    console.warn('[claude-pilot] 命令插件找不到 host 插件（@local/dsh-claude-pilot 没有加载？）')
    return
  }
  ctx.effect(() => {
    let disposed = false
    let disposers = []
    const unregister = () => {
      for (const dispose of disposers) dispose()
      disposers = []
    }
    const register = (list) => {
      if (disposed) return
      unregister()
      for (const command of list) {
        try {
          const dispose = ctx.commands.register({
            name: command.name,
            description: command.description || `Claude Code /${command.name}`,
            ...(command.hint ? { input: { hint: command.hint } } : {}),
            handler: (invocation) =>
              pilot
                .loadImpl()
                .then((current) => current.runCommand(pilot.ctx, pilot.cfg, pilot.state, command.name, invocation))
                .catch((error) => ({ kind: 'error', text: `Claude Code 命令出错：${error?.message || error}` })),
          })
          if (typeof dispose === 'function') disposers.push(dispose)
        } catch (error) {
          console.warn(`[claude-pilot] 注册 /${command.name} 失败：${error?.message}`)
        }
      }
    }
    // 命令目录在后台刷新完（或之后再刷新）时重新注册
    pilot.state.commandListeners ||= new Set()
    pilot.state.commandListeners.add(register)
    void pilot
      .loadImpl()
      .then((impl) => register(impl.commandList(pilot.state, pilot.cfg)))
      .catch((error) => console.warn(`[claude-pilot] 读取命令目录失败：${error?.message}`))
    return () => {
      disposed = true
      pilot.state.commandListeners?.delete(register)
      unregister()
    }
  }, 'claude-pilot: Claude Code commands')
}
