import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormatsModule from 'ajv-formats'
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_CONFIG_ALLOWLIST,
  DESKTOP_CONFIG_ALLOWED_KEY_PATHS,
  DESKTOP_MANDATORY_UPDATE_CODE,
  DesktopConfigFragmentInputSchema,
  DesktopManifestSchema,
  checkClientUpdateNotMandatory,
  desktopLevelOfPolicy,
} from '@dsh-hub/shared'

/**
 * WP25b 的契约自检：**清单 zod 与 `D3-manifest.schema.json` 必须结论一致**。
 *
 * 做法：仓库里原样存了一份 D3 的 JSON Schema（`src/api/desktop-manifest.schema.json`，
 * sha256 与 `desktop-plan/D3-manifest.schema.json` 相同），这里用 ajv 8（strict）+ ajv-formats
 * 编���它，对同一批样例跑「ajv 校验」与「zod parse」，两者的接受/拒绝必须逐例相同。
 * 另外 D3 §5.7 的完整示例必须被两边同时接受 —— 这是「客户端拿到的清单长什么样」的基准。
 */

// 清单 JSON Schema 的仓库内副本（与 desktop-plan/D3-manifest.schema.json 逐字节相同）
const schemaPath = fileURLToPath(
  new URL('../../../packages/shared/src/api/desktop-manifest.schema.json', import.meta.url),
)
const jsonSchema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>

// ajv-formats 的类型声明在 NodeNext 下被当成模块命名空间（CJS 互操作），运行时它就是默认导出的插件函数
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020, opts?: unknown) => Ajv2020
const ajv = new Ajv2020({ strict: true, allErrors: true })
addFormats(ajv)
const validateWithSchema = ajv.compile(jsonSchema)

function schemaAccepts(value: unknown): boolean {
  return validateWithSchema(value) === true
}

function zodAccepts(value: unknown): boolean {
  return DesktopManifestSchema.safeParse(value).success
}

const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)
const HEX_C = 'c'.repeat(64)
const HEX_D = 'd'.repeat(64)

/** D3 §5.7 的完整示例（占位的 sha256 用 64 位真值补齐；其余逐字照抄） */
function documentedExample(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    revision: 1234,
    issuedAt: '2026-10-21T12:00:00.000Z',
    expiresAt: '2026-11-04T12:00:00.000Z',
    device: { deviceId: '9f3c0c1e-2b1a-4c11-9a51-2b0f4f0c8d11', userId: 7 },
    notice: '本周把 Claude Code 桥接插件升到 0.5.1',
    plugins: [
      {
        name: '@local/dsh-memory',
        version: '0.1.2',
        level: 'core',
        enabled: true,
        bundleOrder: 10,
        needsRestart: false,
        minDsh: '>=0.2.1-rc.2 <0.3.0',
        artifact: {
          url: 'https://hub.example/api/desktop/artifacts/41/108/dsh-memory-0.1.2.tgz',
          sha256: HEX_A,
          bytes: 123456,
          filename: 'dsh-memory-0.1.2.tgz',
          expiresAt: '2026-10-22T12:00:00.000Z',
        },
        config: [{ id: 'dsh-memory', config: { topK: 8, autoSummarize: true } }],
        reason: 'Hub 默认插件',
      },
      {
        name: '@local/dsh-claude-pilot',
        version: '0.5.1',
        level: 'default',
        bundleOrder: 20,
        needsRestart: true,
        artifact: {
          url: 'https://hub.example/api/desktop/artifacts/39/101/dsh-claude-pilot-0.5.1.tgz',
          sha256: HEX_B,
          bytes: 73600,
        },
      },
      {
        name: '@local/dsh-codex-pilot',
        version: '0.3.1',
        level: 'optional',
        enabled: false,
        artifact: {
          url: 'https://hub.example/api/desktop/artifacts/40/105/dsh-codex-pilot-0.3.1.tgz',
          sha256: HEX_C,
          bytes: 75366,
        },
      },
    ],
    uninstall: ['@local/dsh-image-gen'],
    config: {
      allowlistVersion: 1,
      digest: `sha256:${HEX_D}`,
      fragments: [
        {
          id: 'llm-pi-ai',
          mode: 'enforce',
          note: '中转站',
          config: {
            providers: {
              hub: {
                displayName: 'DSH Hub',
                baseURL: 'https://hub.example/v1',
                apiKeyEnv: 'HUB_MK_HUB',
              },
            },
          },
        },
        {
          id: 'claude-pilot',
          mode: 'default',
          config: { permissionMode: 'acceptEdits', defaultModel: '' },
        },
      ],
    },
    app: {
      channel: 'nightly',
      minVersion: '0.2.1',
      minVersionHard: false,
      targetVersion: '0.2.2-rc.1',
      feedUrl: 'https://hub.example/dsh-desk/feeds/win-x64/devices/9f3c0c1e/',
    },
  }
}

/** 最小清单（只有必填字段） */
function minimalExample(): Record<string, unknown> {
  return { schemaVersion: 1, revision: 1, issuedAt: '2026-10-21T12:00:00.000Z', plugins: [] }
}

function withMutation(mutate: (value: Record<string, unknown>) => void): Record<string, unknown> {
  const value = documentedExample()
  mutate(value)
  return value
}

describe('清单：zod 与 D3-manifest.schema.json 结论一致', () => {
  it('D3 §5.7 的完整示例：ajv 与 zod 都接受', () => {
    const example = documentedExample()
    const ajvErrors = schemaAccepts(example) ? [] : [...(validateWithSchema.errors ?? [])]
    expect(ajvErrors).toEqual([])
    const parsed = DesktopManifestSchema.safeParse(example)
    expect(parsed.success).toBe(true)
  })

  it('最小清单：ajv 与 zod 都接受', () => {
    const example = minimalExample()
    expect(schemaAccepts(example)).toBe(true)
    expect(zodAccepts(example)).toBe(true)
  })

  /** 每一例都必须被两边同时拒绝 —— 任何一侧放松了，清单校验就漂移了 */
  const rejected: { name: string; value: Record<string, unknown> }[] = [
    { name: 'schemaVersion 2', value: withMutation((v) => (v.schemaVersion = 2)) },
    { name: 'revision 0', value: withMutation((v) => (v.revision = 0)) },
    { name: 'revision 非整数', value: withMutation((v) => (v.revision = 1.5)) },
    { name: 'issuedAt 不是时间', value: withMutation((v) => (v.issuedAt = 'yesterday')) },
    {
      name: 'artifact sha256 非十六进制',
      value: withMutation((v) => {
        ;(v.plugins as Record<string, unknown>[])[0]!['artifact'] = {
          url: 'https://hub.example/x.tgz',
          sha256: 'xyz',
          bytes: 1,
        }
      }),
    },
    {
      name: 'artifact url 是 http',
      value: withMutation((v) => {
        ;(v.plugins as Record<string, unknown>[])[0]!['artifact'] = {
          url: 'http://hub.example/x.tgz',
          sha256: HEX_A,
          bytes: 1,
        }
      }),
    },
    {
      name: 'level 未知',
      value: withMutation((v) => {
        ;(v.plugins as Record<string, unknown>[])[0]!['level'] = 'must'
      }),
    },
    { name: '顶层多一个字段', value: withMutation((v) => (v.extra = true)) },
    {
      name: 'patch 条目既没有 id 也没有 insert',
      value: withMutation((v) => {
        ;(v.plugins as Record<string, unknown>[])[0]!['config'] = [{ config: { a: 1 } }]
      }),
    },
    {
      name: '配置片段没有 mode',
      value: withMutation((v) => {
        const config = v.config as { fragments: Record<string, unknown>[] }
        delete config.fragments[0]!['mode']
      }),
    },
    {
      name: 'feedUrl 带查询串',
      value: withMutation((v) => {
        ;(v.app as Record<string, unknown>)['feedUrl'] = 'https://hub.example/feeds/win-x64/?a=1'
      }),
    },
    {
      name: '版本号不是三段式',
      value: withMutation((v) => {
        ;(v.plugins as Record<string, unknown>[])[0]!['version'] = '1.2'
      }),
    },
    {
      name: 'artifact filename 带路径',
      value: withMutation((v) => {
        ;(v.plugins as Record<string, unknown>[])[0]!['artifact'] = {
          url: 'https://hub.example/x.tgz',
          sha256: HEX_A,
          bytes: 1,
          filename: '../../etc/passwd.tgz',
        }
      }),
    },
    { name: 'uninstall 不是包名数组', value: withMutation((v) => (v.uninstall = [123])) },
    {
      name: 'app 缺 minVersion',
      value: withMutation((v) => {
        delete (v.app as Record<string, unknown>)['minVersion']
      }),
    },
    { name: 'device.deviceId 太短', value: withMutation((v) => (v.device = { deviceId: 'dv_1' })) },
    {
      name: 'config.digest 形状不对',
      value: withMutation((v) => {
        ;(v.config as Record<string, unknown>)['digest'] = 'sha256:xyz'
      }),
    },
  ]

  for (const { name, value } of rejected) {
    it(`拒绝：${name}（两边一致）`, () => {
      expect(schemaAccepts(value)).toBe(false)
      expect(zodAccepts(value)).toBe(false)
    })
  }
})

describe('配置片段白名单 v1', () => {
  const validFragments = [
    {
      id: 'llm-pi-ai',
      mode: 'enforce',
      config: {
        providers: {
          hub: {
            displayName: 'DSH Hub',
            api: 'openai-completions',
            baseURL: 'https://hub.example/v1',
            apiKeyEnv: 'HUB_MK_HUB',
            models: [{ id: 'deepseek-v4', name: 'DeepSeek V4', contextWindow: 128000 }],
          },
        },
      },
      note: '中转站',
    },
    {
      id: 'agent-default-model',
      mode: 'enforce',
      config: { provider: 'hub', model: 'deepseek-v4', reasoningEffort: 'high' },
    },
    {
      id: 'claude-pilot',
      mode: 'default',
      config: { hubMode: true, permissionMode: 'acceptEdits', defaultModel: 'claude-x' },
    },
    {
      id: 'codex-pilot',
      mode: 'default',
      config: { hubMode: true, sandbox: 'workspace-write', approvalPolicy: 'on-request' },
    },
    {
      id: 'hub-connector',
      mode: 'enforce',
      config: {
        hubProxy: { http: 'http://proxy.local:3128', https: 'http://proxy.local:3128', noProxy: ['*.local'] },
        python: {
          mirror: 'https://pypi.tuna.tsinghua.edu.cn/simple',
          trustedHost: 'pypi.tuna.tsinghua.edu.cn',
        },
      },
    },
  ]

  it('五类条目都能通过（覆盖白名单的全部键）', () => {
    for (const fragment of validFragments) {
      const parsed = DesktopConfigFragmentInputSchema.safeParse(fragment)
      expect(parsed.success, JSON.stringify(fragment)).toBe(true)
    }
  })

  it('白名单只列这五个 Loader 条目，且键路径可枚举', () => {
    expect(Object.keys(DESKTOP_CONFIG_ALLOWLIST.entries).sort()).toEqual(
      ['agent-default-model', 'claude-pilot', 'codex-pilot', 'hub-connector', 'llm-pi-ai'].sort(),
    )
    expect(DESKTOP_CONFIG_ALLOWED_KEY_PATHS).toEqual(
      expect.arrayContaining([
        'llm-pi-ai.providers',
        'agent-default-model.model',
        'claude-pilot.hubMode',
        'codex-pilot.hubMode',
        'hub-connector.hubProxy.http',
        'hub-connector.hubProxy.noProxy',
        'hub-connector.python.mirror',
      ]),
    )
  })

  const rejectedFragments: { name: string; value: unknown }[] = [
    { name: '未知条目 id', value: { id: 'hub-secret', mode: 'enforce', config: {} } },
    {
      name: 'agent-default-model 里的非白名单键',
      value: {
        id: 'agent-default-model',
        mode: 'enforce',
        config: { provider: 'hub', model: 'x', temperature: 0.7 },
      },
    },
    {
      name: 'llm-pi-ai 的 apiKeyEnv 不是 HUB_MK_HUB',
      value: {
        id: 'llm-pi-ai',
        mode: 'enforce',
        config: {
          providers: {
            hub: {
              displayName: 'x',
              baseURL: 'https://hub.example/v1',
              apiKeyEnv: 'OPENAI_API_KEY',
              models: [{ id: 'm', name: 'm' }],
            },
          },
        },
      },
    },
    {
      name: 'hub-connector 用了未登记的形状',
      value: { id: 'hub-connector', mode: 'enforce', config: { proxy: { http: 'http://x' } } },
    },
    {
      name: 'claude-pilot 未知键（shell）',
      value: { id: 'claude-pilot', mode: 'enforce', config: { hubMode: true, shell: 'bash -lc' } },
    },
    {
      name: 'hub-connector 空对象',
      value: { id: 'hub-connector', mode: 'enforce', config: {} },
    },
    { name: 'mode 非法', value: { id: 'codex-pilot', mode: 'force', config: { hubMode: true } } },
  ]

  for (const { name, value } of rejectedFragments) {
    it(`拒绝：${name}`, () => {
      expect(DesktopConfigFragmentInputSchema.safeParse(value).success).toBe(false)
    })
  }
})

describe('level 映射与强更响应形状', () => {
  it('插件库 policy → 清单 level（hidden 不下发）', () => {
    expect(desktopLevelOfPolicy('required')).toBe('core')
    expect(desktopLevelOfPolicy('default')).toBe('default')
    expect(desktopLevelOfPolicy('optional')).toBe('optional')
    expect(desktopLevelOfPolicy('hidden')).toBeNull()
  })

  it('「不强制」响应逐字照 D3 §1.4', () => {
    const body = checkClientUpdateNotMandatory()
    expect(body).toEqual({ code: 0, data: { biz_code: 0, biz_data: null } })
    expect(DESKTOP_MANDATORY_UPDATE_CODE).toBe(40005)
  })
})
