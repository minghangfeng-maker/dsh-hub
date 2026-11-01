import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MOBILE_DEFAULT_EFFORT_TIER,
  MOBILE_DSH_EFFORT_BY_TIER,
  MOBILE_EFFORT_TIERS,
  MOBILE_EFFORT_TIER_LABELS,
  MOBILE_V2_FEATURE_OF_FRAME,
  MOBILE_V2_FEATURES,
  MOBILE_V2_FILE_CHUNK_RAW_BYTES,
  MOBILE_V2_FILE_MAX_BYTES,
  MOBILE_V2_IMAGE_MAX_BYTES,
  MOBILE_V2_MAX_FRAME_BYTES,
  DesktopRelayFrameEnvelopeV2Schema,
  MobileClientCreateV2Schema,
  MobileClientFrameAllSchema,
  MobileClientFrameSchema,
  MobileClientHelloV2Schema,
  MobileClientSendV2Schema,
  MobileNodeCapabilitiesFullSchema,
  MobileServerFrameAllSchema,
  MobileServerFrameSchema,
  MobileToolFrameSchema,
  availableTiers,
  dshEffortOfTier,
  tierOfDshEffort,
  type MobileClientFrameAll,
} from '../src/index.js'

/**
 * 通道 v2 契约的**否定用例**与 v1 兼容性。
 *
 * 正向回放由 adapter 的 `test/v2.*.test.ts` 做（喂真实 Host fixture）；这里只钉住
 * 「哪些必须被拒」「v1 一个字节都不许变」这两件容易在评审里漏掉的事。
 */

const here = dirname(fileURLToPath(import.meta.url))
const v1Fixtures = join(here, 'fixtures', 'mobile-v1')
const fixturesV2 = join(here, '..', '..', 'dsh-node-remote', 'test', 'fixtures', 'v2')

function loadV1(name: string): unknown {
  return JSON.parse(readFileSync(join(v1Fixtures, name), 'utf8')) as unknown
}

describe('v2 特性协商（§17 D1）', () => {
  it('特性白名单固定为 10 项，且每个 v2 独有帧都映射到一个特性', () => {
    expect([...MOBILE_V2_FEATURES]).toEqual([
      'models',
      'tools',
      'reasoning',
      'files',
      'deliverables',
      'attachments',
      'rename',
      'archive',
      // WP45 加了 usage 却没同步这份硬编码列表，基线一直是红的；WP46 一并修好
      'usage',
      // WP46（M6 §2）：会话快照
      'session-state',
    ])
    for (const type of [
      'models',
      'set-model',
      'rename',
      'archive',
      'file-read',
      'file-list',
      'upload-begin',
      'usage',
      'session-state-request',
    ]) {
      expect(MOBILE_V2_FEATURE_OF_FRAME[type], type).toBeDefined()
    }
  })

  it('hello 带 features 通过；未知特性被拒', () => {
    expect(
      MobileClientHelloV2Schema.safeParse({
        v: 1,
        type: 'hello',
        requestId: 'r1',
        client: { name: 'app', version: '0.2.1' },
        features: ['models', 'files'],
      }).success,
    ).toBe(true)
    expect(
      MobileClientHelloV2Schema.safeParse({
        v: 1,
        type: 'hello',
        requestId: 'r1',
        client: { name: 'app', version: '0.2.1' },
        features: ['teleport'],
      }).success,
    ).toBe(false)
  })

  it('老客户端 hello（无 features）仍然通过，且 v1 schema 与 v2 schema 都接受', () => {
    const hello = loadV1('client-hello.json')
    expect(MobileClientFrameSchema.safeParse(hello).success).toBe(true)
    expect(MobileClientFrameAllSchema.safeParse(hello).success).toBe(true)
  })
})

describe('v1 帧在 v2 schema 下逐字节兼容', () => {
  const FILES = readdirSync(v1Fixtures).filter((name) => name.startsWith('client-') && name.endsWith('.json'))
  it('每个 v1 客户端帧都能被 v2 联合解析，且解析结果与 v1 相同（不多不少）', () => {
    for (const name of FILES) {
      const raw = loadV1(name)
      const v1 = MobileClientFrameSchema.parse(raw)
      const v2 = MobileClientFrameAllSchema.parse(raw)
      expect(v2, name).toEqual(v1)
    }
  })

  it('每个 v1 服务端帧都能被 v2 联合解析', () => {
    for (const name of readdirSync(v1Fixtures).filter((file) => file.startsWith('server-'))) {
      const raw = loadV1(name)
      expect(MobileServerFrameAllSchema.safeParse(raw).success, name).toBe(true)
      expect(MobileServerFrameSchema.parse(raw)).toEqual(MobileServerFrameAllSchema.parse(raw))
    }
  })

  it('v1 中继帧（无 v2 能力位）通过 v2 外层；带 v2 能力位也通过', () => {
    const relay = loadV1('relay-hello.json')
    expect(DesktopRelayFrameEnvelopeV2Schema.safeParse(relay).success).toBe(true)
    const withV2 = JSON.parse(JSON.stringify(relay)) as {
      capabilities: Record<string, unknown>
    }
    withV2.capabilities = { ...withV2.capabilities, models: true, filesRead: true }
    const parsed = DesktopRelayFrameEnvelopeV2Schema.parse(withV2)
    expect(parsed.type).toBe('hello')
    if (parsed.type !== 'hello') throw new Error('期望 relay hello')
    expect(MobileNodeCapabilitiesFullSchema.parse(parsed.capabilities).models).toBe(true)
  })

  it('relay hello 的 relayFeatures（WP48）：旧 connector 不发=undefined，新 connector 声明放行集合', () => {
    const relay = loadV1('relay-hello.json')
    const legacy = DesktopRelayFrameEnvelopeV2Schema.parse(relay)
    if (legacy.type !== 'hello') throw new Error('期望 relay hello')
    // 旧 connector：字段缺失 → Hub 按「只支持 v1 帧」降级（不能当成空声明之外的任何含义）
    expect(legacy.relayFeatures).toBeUndefined()

    const declared = DesktopRelayFrameEnvelopeV2Schema.parse({
      ...(JSON.parse(JSON.stringify(relay)) as Record<string, unknown>),
      relayFeatures: ['models', 'files', 'rename'],
    })
    if (declared.type !== 'hello') throw new Error('期望 relay hello')
    expect(declared.relayFeatures).toEqual(['models', 'files', 'rename'])

    // 只认契约里的 9 个特性 id：写错一个就整帧不合法（strictObject 语义一致）
    expect(
      DesktopRelayFrameEnvelopeV2Schema.safeParse({
        ...(JSON.parse(JSON.stringify(relay)) as Record<string, unknown>),
        relayFeatures: ['models', 'not-a-feature'],
      }).success,
    ).toBe(false)
  })
})

describe('v2 客户端帧的严格性', () => {
  it('create 拒绝客户端传 cwd（工作目录由 adapter 写死）', () => {
    const result = MobileClientCreateV2Schema.safeParse({
      v: 1,
      type: 'create',
      requestId: 'r1',
      cwd: '/etc',
    })
    expect(result.success).toBe(false)
  })

  it('send 拒绝未知附件字段；附件数量上限 10', () => {
    const base = {
      v: 1,
      type: 'send',
      requestId: 'r1',
      sessionId: 's_1',
      text: '看图',
      clientMessageId: 'm1',
      attachments: [{ kind: 'image', uploadId: 'up_1', name: 'a.png', mimeType: 'image/png', bytes: 10 }],
    }
    expect(MobileClientSendV2Schema.safeParse(base).success).toBe(true)
    const tooMany = {
      ...base,
      attachments: Array.from({ length: 11 }, (_, index) => ({
        kind: 'file',
        uploadId: `up_${String(index)}`,
        name: 'a.pdf',
        mimeType: 'application/pdf',
        bytes: 10,
      })),
    }
    expect(MobileClientSendV2Schema.safeParse(tooMany).success).toBe(false)
    const extra = { ...base, attachments: [{ ...base.attachments[0], path: '/etc/passwd' }] }
    expect(MobileClientSendV2Schema.safeParse(extra).success).toBe(false)
  })

  it('v2 联合里 create/send 只有一个变体（不会出现两个同 type 的分支）', () => {
    const types = MobileClientFrameAllSchema.options.map(
      (option) => (option.shape as { type: { value: string } }).type.value,
    )
    expect(new Set(types).size).toBe(types.length)
    expect((MobileClientFrameAllSchema.options as unknown as { length: number }).length).toBe(
      new Set(types).size,
    )
    const frame: MobileClientFrameAll = {
      v: 1,
      type: 'create',
      requestId: 'r1',
      preset: 'chat',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      effort: 'high',
    }
    expect(MobileClientFrameAllSchema.safeParse(frame).success).toBe(true)
  })
})

describe('§17 D3：四档一一映射', () => {
  it('低→off、中等→low、高→high、超高→max；默认档是「高」', () => {
    expect(MOBILE_EFFORT_TIERS).toEqual(['low', 'medium', 'high', 'ultra'])
    expect(MOBILE_DSH_EFFORT_BY_TIER).toEqual({
      low: 'off',
      medium: 'low',
      high: 'high',
      ultra: 'max',
    })
    expect(dshEffortOfTier('low')).toBe('off')
    expect(dshEffortOfTier('ultra')).toBe('max')
    expect(MOBILE_DEFAULT_EFFORT_TIER).toBe('high')
    expect(MOBILE_EFFORT_TIER_LABELS.high).toBe('高')
  })

  it('反查四档，未知 id 返回 null（UI 忽略，不显示）', () => {
    expect(tierOfDshEffort('off')).toBe('low')
    expect(tierOfDshEffort('max')).toBe('ultra')
    expect(tierOfDshEffort('minimal')).toBeNull()
    expect(availableTiers(['off', 'low', 'high', 'max', 'weird'])).toEqual(['low', 'medium', 'high', 'ultra'])
    // 模型只有两档时，另两档置灰
    expect(availableTiers(['low', 'max'])).toEqual(['medium', 'ultra'])
    expect(availableTiers([])).toEqual([])
  })
})

describe('§17 D4：分块与上限', () => {
  it('分块原始 144 KiB（base64 后 192 KiB），整帧仍在 256 KiB 内', () => {
    const base64 = Math.ceil(MOBILE_V2_FILE_CHUNK_RAW_BYTES / 3) * 4
    expect(base64).toBe(192 * 1024)
    expect(base64 + 512).toBeLessThan(MOBILE_V2_MAX_FRAME_BYTES)
  })

  it('图片 5 MiB、单文件 20 MiB', () => {
    expect(MOBILE_V2_IMAGE_MAX_BYTES).toBe(5 * 1024 * 1024)
    expect(MOBILE_V2_FILE_MAX_BYTES).toBe(20 * 1024 * 1024)
  })
})

describe('服务端 v2 帧的形状约束', () => {
  it('tool 帧的预览字段上限（UTF-8 由 adapter 保证，这里保证 schema 不放大）', () => {
    const frame = {
      v: 1,
      type: 'tool',
      sessionId: 's_1',
      callId: 'call-1',
      kind: 'bash',
      name: 'bash',
      phase: 'end',
      seq: 17,
      turn: 1,
      step: 1,
      status: 'ok',
      title: '运行命令',
      inputPreview: '写一段中文并统计行数',
      outputPreview: '2 /workspace/artifacts/a.txt',
      durationMs: 25,
    }
    expect(MobileToolFrameSchema.safeParse(frame).success).toBe(true)
    expect(MobileToolFrameSchema.safeParse({ ...frame, kind: 'shell' }).success).toBe(false)
    expect(MobileToolFrameSchema.safeParse({ ...frame, phase: 'middle' }).success).toBe(false)
  })

  it('history 条目允许 reasoning，但 ≤ 16 KiB', () => {
    const history = {
      v: 1,
      type: 'history',
      requestId: 'r1',
      sessionId: 's_1',
      items: [
        { seq: 1, role: 'user', at: 1, text: '你好' },
        { seq: 2, role: 'assistant', at: 2, text: '在', reasoning: '思考中' },
      ],
      nextBeforeSeq: null,
      cursor: 2,
      hasMore: false,
    }
    expect(MobileServerFrameAllSchema.safeParse(history).success).toBe(true)
    const tooLong = {
      ...history,
      items: [{ seq: 2, role: 'assistant', at: 2, text: '在', reasoning: 'x'.repeat(16 * 1024 + 1) }],
    }
    expect(MobileServerFrameAllSchema.safeParse(tooLong).success).toBe(false)
  })

  it('服务端只认白名单里的 v2 错误码（不会把 DSH 原始码漏出去）', () => {
    const base = { v: 1, type: 'error', message: 'x', retryable: false }
    expect(MobileServerFrameAllSchema.safeParse({ ...base, code: 'file-refused' }).success).toBe(true)
    expect(MobileServerFrameAllSchema.safeParse({ ...base, code: 'effort-unsupported' }).success).toBe(true)
    expect(MobileServerFrameAllSchema.safeParse({ ...base, code: 'workspace-file/not-found' }).success).toBe(
      false,
    )
    expect(MobileServerFrameAllSchema.safeParse({ ...base, code: 'gateway/bad-request' }).success).toBe(false)
  })
})

describe('fixtures-v2 存在且可用作回放输入', () => {
  it('关键 fixture 都在（adapter 回放测试依赖它们）', () => {
    const files = readdirSync(fixturesV2)
    for (const name of [
      'models-catalog.json',
      'history-page.json',
      'follow-tool-turn.ndjson',
      'follow-reasoning.ndjson',
      'follow-deliverable.ndjson',
      'workspace-follow.json',
      'errors.json',
      'file-stat.json',
      'file-list.json',
      'projections.json',
      'tool-result-large.json',
    ]) {
      expect(files, name).toContain(name)
    }
    const catalog = JSON.parse(readFileSync(join(fixturesV2, 'models-catalog.json'), 'utf8')) as {
      groups: { models: { id: string; reasoning?: { efforts: { id: string }[] } }[] }[]
    }
    const efforts = catalog.groups[0]?.models[0]?.reasoning?.efforts.map((item) => item.id)
    expect(efforts).toEqual(['off', 'low', 'high', 'max'])
  })
})
