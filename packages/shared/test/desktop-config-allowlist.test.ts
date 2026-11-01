import { describe, expect, it } from 'vitest'
import { DesktopConfigDeliverRequestSchema } from '../src/index.js'

/**
 * 系统 hub-relay 路由（hub-max / hub-high / hub-xhigh …）渲染出来的 `llm-pi-ai` 自带 provider 级 `reasoning`，
 * 「带入模型预设 → 下发」必须原样过白名单；默认模型的 `reasoningEffort` 覆盖 pi-ai 的全部档位。
 */
describe('桌面配置白名单：系统预设渲染的思考档位', () => {
  const provider = (reasoning?: string) => ({
    displayName: 'DSH Hub',
    api: 'openai-completions',
    baseURL: 'https://hub.test/v1',
    apiKeyEnv: 'HUB_MK_HUB',
    models: [{ id: 'deepseek-v4.1-flash@upstream-b', name: 'DeepSeek V4.1 Flash' }],
    ...(reasoning === undefined ? {} : { reasoning }),
  })

  it('provider 带 reasoning、默认模型 reasoningEffort=xhigh 都能下发', () => {
    const parsed = DesktopConfigDeliverRequestSchema.safeParse({
      target: { scope: 'all' },
      fragments: [
        {
          id: 'llm-pi-ai',
          mode: 'enforce',
          config: { providers: { hub: provider(), 'hub-max': provider('max'), 'hub-xhigh': provider('xhigh') } },
        },
        {
          id: 'agent-default-model',
          mode: 'enforce',
          config: { provider: 'hub-xhigh', model: 'deepseek-v4.1-flash@upstream-b', reasoningEffort: 'xhigh' },
        },
      ],
    })
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
  })

  it('不认识的档位仍然拒收', () => {
    const parsed = DesktopConfigDeliverRequestSchema.safeParse({
      target: { scope: 'all' },
      fragments: [{ id: 'llm-pi-ai', mode: 'enforce', config: { providers: { hub: provider('turbo') } } }],
    })
    expect(parsed.success).toBe(false)
  })
})
