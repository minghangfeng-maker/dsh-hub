import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  RESERVED_ENTRY_IDS,
  WORKSPACE_CONTROLLER_ENTRY,
  buildManifest,
  renderManagedPatch,
  type RenderManagedInput,
  type RenderPresetInput,
} from '../src/modules/models/render.js'

/** managed.patch.yml 渲染（06 §4.3，纯函数）。 */

const NOW = '2026-10-12T13:00:00.000Z'

function preset(overrides: Partial<RenderPresetInput> = {}): RenderPresetInput {
  return {
    id: 3,
    name: '默认',
    revision: 7,
    defaultProvider: 'hub-relay',
    defaultModel: 'deepseek-chat',
    providers: [
      {
        routeKey: 'hub-relay',
        displayName: '小站中转',
        kind: 'pi-ai',
        api: 'openai-completions',
        baseUrl: 'https://relay.example.com/v1',
        models: [{ id: 'deepseek-chat', name: 'DeepSeek V3', contextWindow: 131072 }],
        compat: null,
        extra: null,
        keyMode: 'shared',
        enabled: true,
      },
    ],
    ...overrides,
  }
}

function input(overrides: Partial<RenderManagedInput> = {}): RenderManagedInput {
  return {
    user: { id: 7, slug: 'u7k2m9x', modelPolicy: 'managed', runtimeVersion: '0.2.0-rc.2' },
    preset: preset(),
    plugins: [],
    now: NOW,
    ...overrides,
  }
}

function entriesOf(content: string): Record<string, unknown>[] {
  const parsed = parseYaml(content, { logLevel: 'silent' }) as unknown
  expect(Array.isArray(parsed)).toBe(true)
  return parsed as Record<string, unknown>[]
}

describe('renderManagedPatch · 模型条目', () => {
  it('managed：llm-pi-ai + agent-default-model + workspace-controller', () => {
    const { content, warnings } = renderManagedPatch(input())
    expect(warnings).toEqual([])
    expect(content).toContain('# 由 DSH Hub 生成，请勿手改 —— preset "默认" r7 · 2026-10-12T13:00:00.000Z')
    expect(content).toContain('# 用户 u7k2m9x · runtime 0.2.0-rc.2')
    const entries = entriesOf(content)
    expect(entries.map((entry) => entry.id)).toEqual([
      'llm-pi-ai',
      'agent-default-model',
      'workspace-controller',
      'ui-settings-account',
      'llm-deepseek-account',
    ])
    const llm = entries[0]!.config as { providers: Record<string, Record<string, unknown>> }
    expect(llm.providers['hub-relay']).toMatchObject({
      displayName: '小站中转',
      api: 'openai-completions',
      baseURL: 'https://relay.example.com/v1',
      apiKeyEnv: 'HUB_MK_HUB_RELAY',
      models: [{ id: 'deepseek-chat', name: 'DeepSeek V3', contextWindow: 131072 }],
    })
    expect(entries[1]!.config).toEqual({ provider: 'hub-relay', model: 'deepseek-chat' })
    // patch 是整块替换，workspace-controller 的字段要写全（真容器 --dump-config 的 schema）
    expect(entries[2]!.config).toEqual({
      documentsDirectory: '/workspace',
      documentsLookupTimeoutMs: 10_000,
    })
  })

  it('free 策略：不输出模型条目，但仍输出 workspace-controller', () => {
    const { content } = renderManagedPatch(
      input({ user: { id: 7, slug: 'u7k2m9x', modelPolicy: 'free', runtimeVersion: null } }),
    )
    expect(content).toContain('model_policy=free')
    expect(content).not.toContain('llm-pi-ai')
    expect(content).not.toContain('agent-default-model')
    const entries = entriesOf(content)
    expect(entries.map((entry) => entry.id)).toEqual([
      'workspace-controller',
      'ui-settings-account',
      'llm-deepseek-account',
    ])
  })

  it('没有预设：只有 workspace-controller，且给出提示', () => {
    const { content } = renderManagedPatch(input({ preset: null }))
    expect(content).toContain('还没有可用的模型预设')
    expect(entriesOf(content).map((entry) => entry.id)).toEqual([
      'workspace-controller',
      'ui-settings-account',
      'llm-deepseek-account',
    ])
  })

  it('deepseek-official 提供方：只出默认模型条目（密钥走 env）', () => {
    const { content } = renderManagedPatch(
      input({
        preset: preset({
          defaultProvider: 'deepseek-official',
          defaultModel: 'deepseek-flash',
          providers: [
            {
              routeKey: 'deepseek-official',
              displayName: 'DeepSeek 官方',
              kind: 'deepseek-official',
              api: null,
              baseUrl: null,
              models: [],
              compat: null,
              extra: null,
              keyMode: 'shared',
              enabled: true,
            },
          ],
        }),
      }),
    )
    const ids = entriesOf(content).map((entry) => entry.id)
    expect(ids).toEqual([
      'agent-default-model',
      'workspace-controller',
      'ui-settings-account',
      'llm-deepseek-account',
    ])
    expect(entriesOf(content)[0]!.config).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
  })

  it('key_mode=none 不输出 apiKeyEnv；非法思考档位被丢弃并告警', () => {
    const { content, warnings } = renderManagedPatch(
      input({
        preset: preset({
          providers: [
            {
              routeKey: 'inner',
              displayName: '内网',
              kind: 'pi-ai',
              api: 'anthropic-messages',
              baseUrl: 'http://10.0.0.5:8000',
              models: [{ id: 'm1', name: 'M1', reasoningEfforts: ['low', 'bogus'] }],
              compat: null,
              extra: null,
              keyMode: 'none',
              enabled: true,
            },
          ],
        }),
      }),
    )
    const providers = (
      entriesOf(content)[0]!.config as { providers: Record<string, Record<string, unknown>> }
    ).providers
    expect(providers['inner']!.apiKeyEnv).toBeUndefined()
    expect(providers['inner']!.models).toEqual([{ id: 'm1', name: 'M1', reasoningEfforts: { low: 'low' } }])
    expect(warnings.some((warning) => warning.includes('bogus'))).toBe(true)
  })

  it('思考档位：off 渲染成 null（关闭时不发思考参数），只有 off 的声明被丢弃并告警', () => {
    const { content, warnings } = renderManagedPatch(
      input({
        preset: preset({
          providers: [
            {
              routeKey: 'relay',
              displayName: '中转',
              kind: 'pi-ai',
              api: 'openai-completions',
              baseUrl: 'http://10.0.0.5:8888/v1',
              models: [
                { id: 'flash', name: 'Flash', reasoningEfforts: ['off', 'low', 'high', 'max'] },
                { id: 'only-off', name: 'Only Off', reasoningEfforts: ['off'] },
              ],
              compat: null,
              extra: null,
              keyMode: 'none',
              enabled: true,
            },
          ],
        }),
      }),
    )
    expect(content).toMatch(/off: null/)
    const providers = (
      entriesOf(content)[0]!.config as { providers: Record<string, Record<string, unknown>> }
    ).providers
    expect(providers['relay']!.models).toEqual([
      { id: 'flash', name: 'Flash', reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
      { id: 'only-off', name: 'Only Off' },
    ])
    expect(warnings.some((warning) => warning.includes('only-off') && warning.includes('"off"'))).toBe(true)
  })

  it('输入类型：声明了 text / image 就写 input（去重），没声明或为空不写', () => {
    const { content } = renderManagedPatch(
      input({
        preset: preset({
          providers: [
            {
              routeKey: 'relay',
              displayName: '中转',
              kind: 'pi-ai',
              api: 'openai-completions',
              baseUrl: 'http://10.0.0.5:8888/v1',
              models: [
                {
                  id: 'vision',
                  name: 'Vision',
                  contextWindow: 1_000_000,
                  maxTokens: 64_000,
                  input: ['text', 'image', 'text'],
                },
                { id: 'plain', name: 'Plain', input: [] },
                { id: 'unset', name: 'Unset' },
              ],
              compat: null,
              extra: null,
              keyMode: 'none',
              enabled: true,
            },
          ],
        }),
      }),
    )
    const providers = (
      entriesOf(content)[0]!.config as { providers: Record<string, Record<string, unknown>> }
    ).providers
    expect(providers['relay']!.models).toEqual([
      { id: 'vision', name: 'Vision', contextWindow: 1_000_000, maxTokens: 64_000, input: ['text', 'image'] },
      { id: 'plain', name: 'Plain' },
      { id: 'unset', name: 'Unset' },
    ])
  })

  it('缺少 api/baseUrl 或没有模型时告警（DSH 会拒绝这条路由）', () => {
    const { warnings } = renderManagedPatch(
      input({
        preset: preset({
          providers: [
            {
              routeKey: 'broken',
              displayName: 'Broken',
              kind: 'pi-ai',
              api: null,
              baseUrl: null,
              models: [],
              compat: null,
              extra: null,
              keyMode: 'shared',
              enabled: true,
            },
          ],
        }),
      }),
    )
    expect(warnings.some((warning) => warning.includes('broken'))).toBe(true)
  })

  it('禁用的提供方不进渲染', () => {
    const { content } = renderManagedPatch(
      input({
        preset: preset({
          providers: [
            {
              routeKey: 'off',
              displayName: '关闭的',
              kind: 'pi-ai',
              api: 'openai-completions',
              baseUrl: 'https://x/v1',
              models: [{ id: 'm', name: 'M' }],
              compat: null,
              extra: null,
              keyMode: 'none',
              enabled: false,
            },
          ],
        }),
      }),
    )
    expect(content).not.toContain('关闭的')
  })
})

describe('renderManagedPatch · 插件配置', () => {
  it('按 bundle_order 追加，且保留 !!js 标签', () => {
    const { content } = renderManagedPatch(
      input({
        plugins: [
          {
            packageName: 'dsh-email',
            version: '0.16.0',
            bundleOrder: 20,
            configYaml: '- id: email\n  config:\n    from: a@b.c\n',
          },
          {
            packageName: 'dsh-ws',
            version: '1.0.0',
            bundleOrder: 10,
            configYaml: '- id: workspace-files\n  config:\n    maxFileBytes: !!js ctx.config.big ?? 1\n',
          },
        ],
      }),
    )
    const ids = entriesOf(content).map((entry) => entry.id)
    expect(ids).toEqual([
      'llm-pi-ai',
      'agent-default-model',
      'workspace-controller',
      'ui-settings-account',
      'llm-deepseek-account',
      'workspace-files',
      'email',
    ])
    expect(content).toContain('!!js ctx.config.big ?? 1')
  })

  it('同一 id 重复：保留最后一次定义并告警', () => {
    const { content, warnings } = renderManagedPatch(
      input({
        plugins: [
          { packageName: 'a', version: '1', bundleOrder: 1, configYaml: '- id: dup\n  config:\n    v: 1\n' },
          { packageName: 'b', version: '1', bundleOrder: 2, configYaml: '- id: dup\n  config:\n    v: 2\n' },
        ],
      }),
    )
    expect(warnings.some((warning) => warning.includes('dup'))).toBe(true)
    const dup = entriesOf(content).filter((entry) => entry.id === 'dup')
    expect(dup).toHaveLength(1)
    expect(dup[0]!.config).toEqual({ v: 2 })
  })

  it('插件里的 llm-pi-ai / workspace-controller 被忽略并告警（Hub 的为准）', () => {
    const { content, warnings } = renderManagedPatch(
      input({
        plugins: [
          {
            packageName: 'evil',
            version: '1',
            bundleOrder: 1,
            configYaml:
              '- id: llm-pi-ai\n  config:\n    providers: {}\n- id: workspace-controller\n  config:\n    documentsDirectory: /tmp\n',
          },
        ],
      }),
    )
    expect(warnings.filter((warning) => warning.includes('冲突')).length).toBe(2)
    expect(content).not.toContain('/tmp')
    const ids = entriesOf(content).map((entry) => entry.id)
    expect(ids).toEqual([
      'llm-pi-ai',
      'agent-default-model',
      'workspace-controller',
      'ui-settings-account',
      'llm-deepseek-account',
    ])
    expect(RESERVED_ENTRY_IDS.has('workspace-controller')).toBe(true)
  })

  it('坏 YAML 的插件只跳过自己，不拖垮整份配置', () => {
    const { content, warnings } = renderManagedPatch(
      input({
        plugins: [
          { packageName: 'broken', version: '1', bundleOrder: 1, configYaml: '- id: [oops\n' },
          {
            packageName: 'ok',
            version: '1',
            bundleOrder: 2,
            configYaml: '- id: fine\n  config:\n    a: 1\n',
          },
        ],
      }),
    )
    expect(warnings.some((warning) => warning.includes('broken'))).toBe(true)
    expect(content).toContain('fine')
  })

  it('渲染结果里只有 env 名，没有任何密钥明文', () => {
    const { content } = renderManagedPatch(input())
    expect(content).toContain('HUB_MK_HUB_RELAY')
    expect(content).not.toMatch(/sk-[A-Za-z0-9]/u)
    expect(content).not.toMatch(/apiKey:/u)
  })

  it('顶层永远是数组（DSH 对非数组 fatal），即使没有插件也没有预设', () => {
    for (const value of [input(), input({ preset: null }), input({ plugins: [] })]) {
      expect(Array.isArray(parseYaml(renderManagedPatch(value).content))).toBe(true)
    }
  })

  it('manifest 记录 presetRevision 与已装插件版本', () => {
    const manifest = buildManifest(
      input({
        plugins: [
          { packageName: 'dsh-email', version: '0.16.0', bundleOrder: 1, configYaml: '' },
          { packageName: 'no-version', version: null, bundleOrder: 2, configYaml: '' },
        ],
      }),
    )
    expect(manifest).toMatchObject({
      userId: 7,
      slug: 'u7k2m9x',
      presetId: 3,
      presetRevision: 7,
      runtimeVersion: '0.2.0-rc.2',
      generatedAt: NOW,
    })
    expect(manifest.plugins).toEqual([{ packageName: 'dsh-email', version: '0.16.0' }])
  })

  it('WORKSPACE_CONTROLLER_ENTRY 与真容器 schema 一致', () => {
    expect(WORKSPACE_CONTROLLER_ENTRY).toEqual({
      id: 'workspace-controller',
      config: { documentsDirectory: '/workspace', documentsLookupTimeoutMs: 10_000 },
    })
  })
})

describe('renderManagedPatch · 「普通对话」预设（WP40d）', () => {
  it('chatPreset=true：插入 preset-chat 行，并把注册表默认预设改成 chat', () => {
    const { content, warnings } = renderManagedPatch(input({ chatPreset: true }))
    expect(warnings).toEqual([])
    const entries = entriesOf(content)
    const insert = entries.find((entry) => Array.isArray(entry.insert)) as
      | { insert: { id: string; name: string; config: Record<string, unknown> }[] }
      | undefined
    expect(insert?.insert.map((row) => row.id)).toEqual(['preset-chat'])
    const presetRow = insert!.insert[0]!
    expect(presetRow.name).toBe('@deepseek-ai/dsh-agent-preset')
    expect(presetRow.config).toMatchObject({ id: 'chat', name: '普通对话', order: 0 })
    const registry = entries.find((entry) => entry.id === 'agent-preset-registry')
    expect(registry?.config).toEqual({ default: 'chat' })
    // 预设条目在 workspace-controller 之前（Hub 拥有的条目顺序稳定，便于 diff）
    const ids = entries.map((entry) => entry.id ?? 'insert')
    expect(ids.indexOf('insert')).toBeLessThan(ids.indexOf('workspace-controller'))
    // 子插件的必填 config 不能漏：真容器里 tool-fs-search 缺 sampleOverCapGlobResults 会让
    // agent-preset 的激活审计直接拒绝整个会话（WP40d 实测 agent-preset/invalid）
    const plugins = (presetRow.config as { plugins: { id: string; config?: Record<string, unknown> }[] })
      .plugins
    const fsSearch = plugins.find((plugin) => plugin.id === 'tool-fs-search')
    expect(fsSearch?.config).toEqual({ sampleOverCapGlobResults: false })
    // WP47：提问工具必须显式开 timed（没人应答 = pending 结果，不是 NO_PROVIDER 错误）。
    // legacy（缺省）会阻塞等待并在没有应答者时抛错，真机事故就是这么让模型自行继续的。
    const askUser = plugins.find((plugin) => plugin.id === 'tool-ask-user')
    expect(askUser?.config).toEqual({ mode: 'timed', timeout: 120 })
  })

  it('系统提示带「没拿到回答就别做破坏性操作」的护栏（WP47）', () => {
    const { content } = renderManagedPatch(input({ chatPreset: true }))
    for (const phrase of ['没拿到回答', '破坏性', '结束这一轮', '等用户确认']) {
      expect(content).toContain(phrase)
    }
  })

  it('chatPreset 缺省 / false：不写预设条目（不影响既有部署与测试断言）', () => {
    for (const value of [undefined, false]) {
      const { content } = renderManagedPatch(input({ chatPreset: value }))
      expect(content).not.toContain('preset-chat')
      expect(content).not.toContain('agent-preset-registry')
    }
  })

  it('系统提示覆盖三条硬要求与三条能力，且不写死密钥', () => {
    const { content } = renderManagedPatch(input({ chatPreset: true }))
    for (const phrase of ['简体中文', '不主动展示命令行', '不要删除', '联网', 'python3', 'outputs/', 'Noto Sans CJK SC']) {
      expect(content).toContain(phrase)
    }
    // 预设条目里不能带密钥；注意 `ask-user` 里也有 `sk-u`，所以不能拿 3 字符前缀当判据
    const presetRow = (
      entriesOf(content).find((entry) => Array.isArray(entry.insert)) as {
        insert: Record<string, unknown>[]
      }
    ).insert[0]!
    const presetText = JSON.stringify(presetRow)
    expect(presetText).not.toContain('apiKey')
    expect(presetText).not.toMatch(/sk-[A-Za-z0-9]{20,}/u)
  })

  it('插件配置里的同名条目（preset-chat / agent-preset-registry）被忽略并告警', () => {
    const { content, warnings } = renderManagedPatch(
      input({
        chatPreset: true,
        plugins: [
          {
            packageName: 'rogue',
            version: '1',
            bundleOrder: 1,
            configYaml:
              '- id: agent-preset-registry\n  config:\n    default: standard\n- id: preset-chat\n  config:\n    id: evil\n',
          },
        ],
      }),
    )
    expect(warnings.filter((warning) => warning.includes('冲突')).length).toBe(2)
    const entries = entriesOf(content)
    const registry = entries.find((entry) => entry.id === 'agent-preset-registry')
    expect(registry?.config).toEqual({ default: 'chat' })
    expect(content).not.toContain('id: evil')
  })
})
