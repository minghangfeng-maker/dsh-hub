/**
 * mock 模型目录，**逐字段取自** `mobile-plan/v2/fixtures-v2/models-catalog.json`
 * （WP40c-1 用真实容器 `session/modelCatalog` 导出的形状）。
 *
 * 为什么保留原始形状而不是先摊平：通道 v2 的 `models` 帧是 Hub 摊平后的结果，
 * 而 mock/测试需要在「原始形状 → 帧」这一步也走同一段代码；以后 WP40c-2 接上真
 * Hub 时，把这里的常量换成 `models` 帧即可，`flattenModelCatalog()` 仍可复用。
 *
 * TODO(WP40c-2)：真实 Hub 会通过 `models` 帧下发；这里只是 mock 数据源。
 */

export interface RawCatalogEffort {
  id: string
  name: string
  description?: string
}

export interface RawCatalogModel {
  id: string
  name: string
  description?: string
  reasoning?: {
    efforts: RawCatalogEffort[]
    defaultEffort?: string
  }
}

export interface RawCatalogGroup {
  id: string
  name: string
  models: RawCatalogModel[]
}

export interface RawModelCatalog {
  default: { provider: string; model: string; reasoningEffort?: string }
  routableProviders: string[]
  groups: RawCatalogGroup[]
  failures: Array<{ provider: string; name: string; message: string }>
}

export const MOCK_MODEL_CATALOG: RawModelCatalog = {
  default: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
  routableProviders: ['deepseek-official'],
  groups: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        {
          id: 'deepseek-flash',
          name: 'DeepSeek-V4.1-Flash',
          reasoning: {
            efforts: [
              {
                id: 'off',
                name: 'Off',
                description: 'Use for simple tasks that do not need reasoning.',
              },
              {
                id: 'low',
                name: 'Low',
                description: 'Prefer for routine or latency-sensitive tasks.',
              },
              {
                id: 'high',
                name: 'High',
                description: 'The default balance for most tasks.',
              },
              {
                id: 'max',
                name: 'Max',
                description: 'Reserve for the hardest quality-first tasks.',
              },
            ],
            defaultEffort: 'high',
          },
        },
        {
          id: 'deepseek-v4-pro',
          name: 'DeepSeek-V4-Pro',
          description:
            'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
          reasoning: {
            efforts: [
              {
                id: 'off',
                name: 'Off',
                description: 'Use for simple tasks that do not need reasoning.',
              },
              {
                id: 'low',
                name: 'Low',
                description: 'Prefer for routine or latency-sensitive tasks.',
              },
              {
                id: 'high',
                name: 'High',
                description: 'The default balance for most tasks.',
              },
              {
                id: 'max',
                name: 'Max',
                description: 'Reserve for the hardest quality-first tasks.',
              },
            ],
            defaultEffort: 'high',
          },
        },
      ],
    },
  ],
  failures: [],
}
