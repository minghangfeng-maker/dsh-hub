import type { FastifyInstance } from 'fastify'
import {
  CreateToolChannelRequestSchema,
  UpdateToolSettingsRequestSchema,
  type CreateToolChannelRequest,
  type ToolChannel,
  type ToolSettings,
} from '@dsh-hub/shared'
import type { TestApp } from './helpers.js'

/**
 * 搜索 / 抓取池的测试脚手架（WP18a）：直接调 `relay.tools` 的 service 造数据，
 * 假上游用 `helpers-relay.ts` 的 `startFakeUpstream`（进程内、随机端口、不碰真实上游）。
 */

export const TOOLS_META = { ip: '127.0.0.1', userAgent: 'vitest' }

export function toolService(app: FastifyInstance) {
  return app.deps.services.relay.tools
}

/** 与路由一样先过 zod（补默认值），再交给 service */
export function createToolChannel(
  app: FastifyInstance,
  input: Partial<CreateToolChannelRequest> & { name: string; kind: 'deepseek' | 'tavily'; baseUrl: string },
): ToolChannel {
  const parsed = CreateToolChannelRequestSchema.parse(input)
  return toolService(app).createChannel(parsed, 1, TOOLS_META)
}

export function updateToolSettings(app: FastifyInstance, patch: Partial<ToolSettings>): void {
  const parsed = UpdateToolSettingsRequestSchema.parse(patch)
  toolService(app).updateSettings(parsed, 1, TOOLS_META)
}

/** 把内部监听器地址设上（测试不真的起监听器；渲染与下发判定要用） */
export function markInternalListening(app: FastifyInstance, baseUrl = 'http://10.213.0.1:7710/v1'): void {
  app.deps.services.relay.setInternalBaseUrl(baseUrl)
  app.deps.services.relay.setInternalListening(true)
}

export const DEEPSEEK_SEARCH_BODY = {
  results: [
    { url: 'https://ds.test/1', title: 'DeepSeek 结果', snippet: '来自 DeepSeek', date: '2026-10-01' },
    { url: 'https://ds.test/2', title: '第二条', snippet: '', date: null },
  ],
}

export const TAVILY_SEARCH_BODY = {
  results: [
    { title: 'Tavily 结果', url: 'https://tv.test/1', content: '来自 Tavily', score: 0.9 },
    { title: '没有日期', url: 'https://tv.test/2', content: '第二条', score: 0.5 },
  ],
}

export const TAVILY_FETCH_BODY = {
  results: [{ url: 'https://tv.test/1', raw_content: '# 标题\n\n正文' }],
  failed_results: [],
}

export const DEEPSEEK_FETCH_BODY = { content: '# 标题\n\n正文' }

export type { TestApp }
