import type { AgentMode, AgentModeSettings } from '@dsh-hub/shared'

/**
 * 18 §4.1：Claude Code / Codex 的容器 env（纯函数，便于单测）。
 *
 * 只放「是否开通 + 密钥 + 地址」；模型、显示名、倍率由插件运行时向 Hub 拉取（18 D6），
 * 所以开通后 env 不再变化，不会因为改价格/改模型触发容器重建。
 */

/** 模式在界面上的名字（告警与 env 注释用） */
export const AGENT_MODE_ENV_LABEL: Record<AgentMode, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

/** Claude Code 的根地址：Anthropic SDK 自己拼 `/v1/messages`，base 不能带 `/v1`（12 §7.0） */
export function claudeRootUrl(internalBaseUrl: string): string {
  const trimmed = internalBaseUrl.replace(/\/+$/u, '')
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed
}

/** Codex 的 provider base_url：Responses API 要带 `/v1`（18 F3） */
export function codexBaseUrl(internalBaseUrl: string): string {
  const trimmed = internalBaseUrl.replace(/\/+$/u, '')
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
}

/** targets 是否包含这个用户（`{ all: true }` 或明确列了 userId） */
export function isTargeted(targets: AgentModeSettings['targets'], userId: number): boolean {
  if ('all' in targets) return targets.all
  return targets.userIds.includes(userId)
}

export interface ModeEnvResult {
  env: Record<string, string>
  /** 无法注入的原因（中文，给管理页 warnings）；能注入 = null */
  warning: string | null
}

export interface ModeEnvInput {
  mode: AgentMode
  settings: AgentModeSettings
  userId: number
  /** 内部监听器地址（含 `/v1`）；关闭 = null */
  internalBaseUrl: string | null
  /** 该用户该作用域的 system 密钥明文；签发/解密失败 = null（未开通时不会调用） */
  key: string | null
}

/**
 * 一个模式的 env。以下情况返回空 env：
 * 没开通、用户不在 targets、内部监听器关闭、密钥不可用（后两种给 warning）。
 */
export function modeEnv(input: ModeEnvInput): ModeEnvResult {
  const { mode, settings, userId, internalBaseUrl, key } = input
  if (!settings.enabled || !isTargeted(settings.targets, userId)) {
    return { env: {}, warning: null }
  }
  const label = AGENT_MODE_ENV_LABEL[mode]
  if (internalBaseUrl === null) {
    return { env: {}, warning: `${label}：中转站内部监听器没开，用户容器连不上中转站` }
  }
  if (key === null) {
    return { env: {}, warning: `${label}：模式密钥签发失败，本次不注入` }
  }
  if (mode === 'claude-code') {
    return {
      env: {
        HUB_CLAUDE_AUTH: 'apiKey',
        HUB_CLAUDE_KEY: key,
        HUB_CLAUDE_BASE_URL: claudeRootUrl(internalBaseUrl),
      },
      warning: null,
    }
  }
  return {
    env: {
      HUB_CODEX_KEY: key,
      HUB_CODEX_BASE_URL: codexBaseUrl(internalBaseUrl),
      HUB_CODEX_WIRE_API: 'responses',
    },
    warning: null,
  }
}

export interface ModesEnvInput {
  settings: Record<AgentMode, AgentModeSettings>
  userId: number
  internalBaseUrl: string | null
  /** 该用户某作用域的 system 密钥明文（没有就签发；失败 null） */
  keyFor(mode: AgentMode): string | null
}

/** 两个模式的 env 合并（`models.containerEnv` 用）；同名的变量不会冲突 */
export function modesEnv(input: ModesEnvInput): { env: Record<string, string>; warnings: string[] } {
  const env: Record<string, string> = {}
  const warnings: string[] = []
  for (const mode of ['claude-code', 'codex'] as const) {
    const settings = input.settings[mode]
    if (!settings.enabled || !isTargeted(settings.targets, input.userId)) continue
    const result = modeEnv({
      mode,
      settings,
      userId: input.userId,
      internalBaseUrl: input.internalBaseUrl,
      key: input.keyFor(mode),
    })
    Object.assign(env, result.env)
    if (result.warning !== null) warnings.push(result.warning)
  }
  return { env, warnings }
}
