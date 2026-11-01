/**
 * 通道 v2 帧与 features 协商（M5 §17 D1）。
 * 服务端没回显 feature 的节点必须按 v1 工作；回显后才发/收 v2 帧。
 */

import { describe, expect, it } from 'vitest'
import {
  decodeClientFrame,
  encodeClientFrame,
  hello,
  models,
  parseServerFrame,
  sessions,
  setModel,
  create,
  type AnyServerFrame,
} from '../src/channel/wire.js'
import {
  APP_DECLARED_FEATURES,
  MOBILE_V2_FEATURES,
  MobileClientHelloV2Schema,
} from '../src/contracts/mobile-v2.js'

const BASE_CAPS = {
  sessions: true,
  history: true,
  send: true,
  stop: true,
  stream: true,
  questions: true,
  approvals: false,
  create: true,
}

describe('features 协商', () => {
  it('客户端声明全部 8 个 v2 特性；白名单只包含已知特性', () => {
    // A2：工具卡/思考/文件/交付物/附件/重命名/归档都做了，全量声明；
    // Hub 用「双方都支持」求交集并回显，客户端只认回显。
    expect(APP_DECLARED_FEATURES).toEqual([...MOBILE_V2_FEATURES])
    for (const feature of APP_DECLARED_FEATURES) {
      expect(MOBILE_V2_FEATURES).toContain(feature)
    }
  })

  it('hello 带 features 时能通过 v2 严格校验；decode 能拿回 features', () => {
    const frame = hello('r1', { name: 'dsh-hub-app', version: '0.1.0-dev' }, APP_DECLARED_FEATURES)
    expect(MobileClientHelloV2Schema.safeParse(frame).success).toBe(true)
    const encoded = encodeClientFrame(frame)
    expect(decodeClientFrame(JSON.parse(encoded))).toMatchObject({
      type: 'hello',
      features: [...MOBILE_V2_FEATURES],
    })
  })

  it('没有 features 的 hello 仍是 v1 形状（老客户端兼容）', () => {
    const frame = hello('r1', { name: 'old', version: '0.2.0' })
    expect(Object.keys(frame)).not.toContain('features')
  })

  it('服务端 hello 回显 features 与 v2 能力位（不能被 v1 schema 丢掉）', () => {
    const parsed = parseServerFrame({
      v: 1,
      type: 'hello',
      requestId: 'r1',
      node: { id: 'cloud:self', kind: 'cloud', name: '云服务器', status: 'running' },
      capabilities: BASE_CAPS,
      // 契约把 v2 能力位放在平级的 `capabilitiesV2`（与 v1 的 8 个同一层，不嵌套）。
      capabilitiesV2: { models: true, archive: true, filesRead: true },
      subscribed: [],
      serverTime: 1,
      features: ['models', 'archive'],
    })
    expect(parsed.kind).toBe('frame')
    if (parsed.kind !== 'frame') return
    const frame = parsed.frame as Extract<AnyServerFrame, { type: 'hello' }> & {
      features?: string[]
      capabilitiesV2?: { models?: boolean; archive?: boolean; filesRead?: boolean }
    }
    expect(frame.features).toEqual(['models', 'archive'])
    expect(frame.capabilitiesV2?.models).toBe(true)
    expect(frame.capabilitiesV2?.archive).toBe(true)
    expect(frame.capabilitiesV2?.filesRead).toBe(true)
  })
})

describe('v2 上行帧', () => {
  it('models / set-model / create / sessions(includeArchived) 都能编码', () => {
    expect(decodeClientFrame(JSON.parse(encodeClientFrame(models('r1', 's1'))))).toMatchObject({
      type: 'models',
      sessionId: 's1',
    })
    expect(
      decodeClientFrame(
        JSON.parse(
          encodeClientFrame(
            setModel('r2', 's1', { provider: 'p', model: 'm', effort: 'high' }),
          ),
        ),
      ),
    ).toMatchObject({ type: 'set-model', effort: 'high' })
    expect(
      decodeClientFrame(
        JSON.parse(
          encodeClientFrame(
            create('r3', {
              preset: 'chat',
              provider: 'p',
              model: 'm',
              effort: 'max',
            }),
          ),
        ),
      ),
    ).toMatchObject({ type: 'create', preset: 'chat', provider: 'p', effort: 'max' })
    expect(
      decodeClientFrame(JSON.parse(encodeClientFrame(sessions('r4', true, true)))),
    ).toMatchObject({ type: 'sessions', includeArchived: true })
  })

  it('create 不带 cwd（客户端永远不传路径）', () => {
    const frame = create('r3', { provider: 'p', model: 'm' }) as Record<string, unknown>
    expect(frame).not.toHaveProperty('cwd')
  })
})

describe('v2 下行帧', () => {
  it('models 帧（默认/当前/items/failures）', () => {
    const parsed = parseServerFrame({
      v: 1,
      type: 'models',
      requestId: 'r1',
      default: { provider: 'p', model: 'm', effort: 'high' },
      current: { provider: 'p', model: 'm', effort: 'low' },
      items: [
        {
          provider: 'p',
          model: 'm',
          name: 'M',
          description: null,
          efforts: [
            { id: 'off', name: 'Off', tier: 'low' },
            { id: 'low', name: 'Low', tier: 'medium' },
            { id: 'high', name: 'High', tier: 'high' },
            { id: 'max', name: 'Max', tier: 'ultra' },
          ],
          defaultEffort: 'high',
          input: { text: true, image: null },
        },
      ],
      failures: [{ provider: 'x', name: 'X', message: 'no key' }],
    })
    expect(parsed.kind).toBe('frame')
    if (parsed.kind === 'frame') expect(parsed.frame.type).toBe('models')
  })

  it('model-changed / created(model) / renamed / archived', () => {
    for (const frame of [
      {
        v: 1,
        type: 'model-changed',
        sessionId: 's1',
        provider: 'p',
        model: 'm',
        effort: 'high',
      },
      {
        v: 1,
        type: 'created',
        requestId: 'r1',
        sessionId: 's1',
        preset: 'chat',
        model: { provider: 'p', model: 'm', effort: 'high' },
      },
      {
        v: 1,
        type: 'renamed',
        requestId: 'r1',
        sessionId: 's1',
        title: '新标题',
        seq: 3,
      },
      {
        v: 1,
        type: 'archived',
        requestId: 'r1',
        sessionId: 's1',
        archived: true,
        sessionIds: ['s1'],
      },
      {
        v: 1,
        type: 'sessions',
        requestId: 'r1',
        items: [
          {
            sessionId: 's1',
            title: null,
            updatedAt: 1,
            running: false,
            blank: false,
            agentAvailable: true,
            archived: true,
          },
        ],
      },
    ]) {
      const parsed = parseServerFrame(frame)
      expect(parsed.kind, JSON.stringify(frame)).toBe('frame')
    }
  })

  it('delta 的 done 标记（v2 扩展）能解析；v1 delta 仍然通过', () => {
    const withDone = parseServerFrame({
      v: 1,
      type: 'delta',
      sessionId: 's1',
      attemptId: 'a1',
      revision: 5,
      index: 3,
      turn: 1,
      step: 1,
      part: { kind: 'reasoning', text: '想完了' },
      done: true,
    })
    expect(withDone.kind).toBe('frame')
    if (withDone.kind === 'frame') {
      expect((withDone.frame as { done?: boolean }).done).toBe(true)
    }
  })

  it('tool / deliverable / file / file-chunk / file-list 帧类型可用（A2 用）', () => {
    const frames = [
      {
        v: 1,
        type: 'tool',
        sessionId: 's1',
        callId: 'c1',
        kind: 'bash',
        name: 'bash',
        phase: 'start',
        seq: 1,
        turn: 1,
        step: 1,
        title: '运行命令',
      },
      {
        v: 1,
        type: 'deliverable',
        sessionId: 's1',
        seq: 2,
        turn: 1,
        callId: 'c2',
        files: [{ fileRef: 'f1', name: 'a.png', pathLabel: 'a.png', mediaType: 'image' }],
      },
      {
        v: 1,
        type: 'file',
        requestId: 'r1',
        sessionId: 's1',
        fileRef: 'f1',
        name: 'a.png',
        mediaType: 'image',
        mimeType: 'image/png',
        bytes: 3,
        encoding: 'base64',
        data: 'AAA',
      },
      {
        v: 1,
        type: 'file-chunk',
        requestId: 'r1',
        sessionId: 's1',
        fileRef: 'f1',
        seq: 0,
        final: true,
        encoding: 'base64',
        data: 'AAA',
        bytes: 3,
      },
      {
        v: 1,
        type: 'file-list',
        requestId: 'r1',
        sessionId: 's1',
        path: '',
        entries: [{ name: 'a.png', kind: 'file' }],
        truncated: false,
      },
    ]
    for (const frame of frames) {
      expect(parseServerFrame(frame).kind, JSON.stringify(frame)).toBe('frame')
    }
  })
})
