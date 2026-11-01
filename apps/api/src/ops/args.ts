import { HubError } from '../lib/errors.js'

/**
 * 运维命令的参数解析（`cli.ts` 用）：支持 `--flag`、`--key value`、`--key=value`。
 * 只服务 WP7a 的三个命令，刻意不引入依赖（11 §5 不新增依赖）。
 */
export function hasFlag(args: string[], name: string): boolean {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`))
}

/** 取值：`--out DIR` 或 `--out=DIR`；缺值抛 VALIDATION_FAILED */
export function flagValue(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === name) {
      const value = args[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new HubError('VALIDATION_FAILED', `${name} 缺少取值`)
      }
      return value
    }
    if (arg.startsWith(`${name}=`)) {
      const value = arg.slice(name.length + 1)
      if (value.length === 0) throw new HubError('VALIDATION_FAILED', `${name} 缺少取值`)
      return value
    }
  }
  return undefined
}

export function numberFlag(args: string[], name: string, fallback: number): number {
  const raw = flagValue(args, name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new HubError('VALIDATION_FAILED', `${name} 需要一个数字，收到 ${raw}`)
  }
  return value
}
