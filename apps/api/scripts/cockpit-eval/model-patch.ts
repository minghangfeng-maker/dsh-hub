/**
 * 座舱容器里 DSH 的模型配置（**只给测试用**）：把 `llm-pi-ai` 指到假上游。
 *
 * 为什么写在脚本里而不是改生产接线：`settings.cockpit.model` → 容器模型配置的接线归
 * WP56e1（任务书第 10 项）；本文件在**容器启动前**覆写 hub-ops 的 `managed/managed.patch.yml`
 * （那份文件本来就由 `models.renderManaged()` 在 provision 时写，`start`/`restart` 不会重写），
 * 于是座舱 DSH 起来时读到的就是我们这份。生产路径一行没动。
 *
 * 关键字段（与 `apps/api/src/modules/models/render.ts` 的 `providerEntryConfig()` 同形）：
 * `llm-pi-ai.config.providers.<route>.{displayName,api,baseURL,apiKeyEnv?,models[]}` +
 * `agent-default-model.config.{provider,model}`。假上游不校验密钥，所以**不写 apiKeyEnv**
 * （对应 `keyMode='none'`：pi-ai 不要求这条路由有密钥）。
 */

/** 假上游的模型名（与 `upstream.ts` 的 `FAKE_MODEL_ID` 一致） */
export const FAKE_MODEL_ID = 'deepseek-v4.1-flash'

/** 假上游在 `llm-pi-ai` 里的路由名 */
export const FAKE_PROVIDER_KEY = 'fake'

export interface ModelPatchInput {
  /** 容器能访问到的假上游基地址，例如 `http://10.219.63.1:8303/v1` */
  baseUrl: string
  /** 模型名（缺省 deepseek-v4.1-flash） */
  modelId?: string
}

/**
 * 生成 `managed.patch.yml` 全文。
 *
 * 同时保留 `workspace-controller` 与两条停用条目：它们本来就在生产渲染结果里，
 * 少了不会崩，但保留能让「假上游」与真模型的差异只剩模型那一段。
 */
export function cockpitModelPatch(input: ModelPatchInput): string {
  const modelId = input.modelId ?? FAKE_MODEL_ID
  return [
    '# 由 WP56e2 评测脚本生成（**测试用**，不是生产渲染结果）：把座舱模型指到假上游。',
    '# 生产路径的模型接线由 apps/api/src/modules/models 负责，这里只在容器启动前覆写本文件。',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    `      ${FAKE_PROVIDER_KEY}:`,
    '        displayName: 座舱评测假上游',
    '        api: openai-completions',
    `        baseURL: ${input.baseUrl}`,
    // pi-ai 要求启用中的路由「有一个 apiKeyEnv」，值会作为 `Authorization: Bearer …` 发出去。
    // 这里借用容器里稳定存在、且**不是密钥**的环境变量（镜像 ENV `DSH_TELEMETRY_DISABLED=1`）：
    // 假上游不校验；真模型模式下真正的密钥由 forwarder.ts 在宿主侧注入。
    '        apiKeyEnv: DSH_TELEMETRY_DISABLED',
    '        models:',
    `          - id: ${modelId}`,
    `            name: ${modelId}`,
    '- id: agent-default-model',
    '  config:',
    `    provider: ${FAKE_PROVIDER_KEY}`,
    `    model: ${modelId}`,
    '- id: workspace-controller',
    '  config:',
    '    documentsDirectory: /workspace',
    '    documentsLookupTimeoutMs: 10000',
    '- id: ui-settings-account',
    '  disabled: true',
    '- id: llm-deepseek-account',
    '  disabled: true',
    '',
  ].join('\n')
}
