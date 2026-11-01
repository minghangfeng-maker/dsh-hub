/**
 * 通道 v2 在状态机里的接线：features 协商、models/set-model、归档筛选，
 * 以及 §17 对 v1 缺陷的修正（连续性只看 index，不看 revision）。
 */

import { describe, expect, it } from 'vitest'
import {
  boot,
  createHarness,
  deltaFrame,
  helloFrame,
  historyFrame,
  openSession,
  sessionRow,
  sessionsFrame,
  sleep,
} from './helpers/fake-channel.js'
import { flattenModelCatalog } from '../src/models/catalog.js'
import { MOCK_MODEL_CATALOG } from '../src/mock/models-catalog.js'

const CAPS_V2 = {
  sessions: true,
  history: true,
  send: true,
  stop: true,
  stream: true,
  questions: true,
  approvals: false,
  create: true,
  models: true,
  archive: true,
  rename: true,
}

function v2Hello(requestId: string, features: string[] = ['models', 'archive']): unknown {
  return helloFrame({
    requestId,
    capabilities: CAPS_V2,
    features,
  })
}

function modelsFrame(requestId: string, current?: { provider: string; model: string; effort?: string }): unknown {
  const catalog = flattenModelCatalog(MOCK_MODEL_CATALOG, 'cloud:self')
  const items = catalog.items.map((m) => ({
    provider: m.provider,
    model: m.model,
    name: m.name,
    description: m.description ?? null,
    efforts: m.efforts.map((e) => ({
      ...e,
      tier:
        e.id === 'off'
          ? 'low'
          : e.id === 'low'
            ? 'medium'
            : e.id === 'high'
              ? 'high'
              : e.id === 'max'
                ? 'ultra'
                : null,
    })),
    defaultEffort: m.defaultEffort,
    input: { text: true, image: null },
  }))
  return {
    v: 1,
    type: 'models',
    requestId,
    failures: [],
    default: {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      effort: 'high',
    },
    ...(current ? { current } : {}),
    items,
  }
}

async function bootV2(h: ReturnType<typeof createHarness>): Promise<any> {
  h.controller.start()
  await sleep(0)
  const channel = h.channels[0]!
  channel.emitOpen()
  channel.server(v2Hello(channel.last('hello').requestId))
  const sessionsRequest = channel.last('sessions')
  channel.server(sessionsFrame(sessionsRequest.requestId, [sessionRow('s1')]))
  return channel
}

describe('v2 features 协商', () => {
  it('hello 回显 models/archive 后主动拉模型目录', async () => {
    const h = createHarness()
    const channel = await bootV2(h)
    expect(h.controller.getState().features).toEqual(['models', 'archive'])
    expect(channel.last('models')).toMatchObject({ type: 'models' })
    channel.server(modelsFrame(channel.last('models').requestId))
    const state = h.controller.getState()
    expect(state.models?.source).toBe('channel-v2')
    expect(state.models?.items).toHaveLength(2)
  })

  it('v1 节点（不回显 features）不发 models，也不能 set-model', async () => {
    const h = createHarness()
    const channel = await boot(h)
    channel.server(helloFrame({ requestId: channel.last('hello').requestId }))
    expect(channel.count('models')).toBe(0)
    h.controller.openSession('s1')
    channel.server(historyFrame(channel.last('history').requestId, 's1', []))
    h.controller.setModel({ provider: 'p', model: 'm', effort: 'high' })
    expect(channel.count('set-model')).toBe(0)
    expect(h.controller.getState().error?.code).toBe('feature-unsupported')
  })

  it('模型目录里的 current 会映射成 App 档位', async () => {
    const h = createHarness()
    const channel = await bootV2(h)
    channel.server(
      modelsFrame(channel.last('models').requestId, {
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        effort: 'max',
      }),
    )
    expect(h.controller.getState().modelSelection).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      effortTier: 'ultra',
    })
  })
})

describe('set-model 与投影', () => {
  it('set-model 发 DSH effort id；投影回来更新选择（model-changed 只清 loading）', async () => {
    const h = createHarness()
    const channel = await bootV2(h)
    channel.server(modelsFrame(channel.last('models').requestId))
    h.controller.openSession('s1')
    channel.server(historyFrame(channel.last('history').requestId, 's1', []))

    h.controller.setModel({ provider: 'deepseek-official', model: 'deepseek-v4-pro', effort: 'max' })
    const sent = channel.last('set-model')
    expect(sent).toMatchObject({
      sessionId: 's1',
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      effort: 'max',
    })

    channel.server({
      v: 1,
      type: 'model-changed',
      requestId: sent.requestId,
      sessionId: 's1',
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      effort: 'max',
    })
    // 冻结契约：芯片以投影为准；这里没有投影，model-changed 兜底更新
    expect(h.controller.getState().modelSelection?.effortTier).toBe('ultra')

    channel.server({
      v: 1,
      type: 'state',
      sessionId: 's1',
      key: 'modelSelection',
      value: {
        lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' },
        next: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' },
      },
      seq: 1,
    })
    expect(h.controller.getState().modelSelection).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      effortTier: 'low',
    })
  })

  it('created 回显的 model 会写入当前选择', async () => {
    const h = createHarness()
    const channel = await bootV2(h)
    channel.server(modelsFrame(channel.last('models').requestId))
    h.controller.createSession({
      preset: 'chat',
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      effort: 'max',
    })
    const sent = channel.last('create')
    expect(sent).toMatchObject({ preset: 'chat', provider: 'deepseek-official', effort: 'max' })
    channel.server({
      v: 1,
      type: 'created',
      requestId: sent.requestId,
      sessionId: 's_new',
      preset: 'chat',
      model: { provider: 'deepseek-official', model: 'deepseek-v4-pro', effort: 'max' },
    })
    expect(h.controller.getState().modelSelection).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      effortTier: 'ultra',
    })
  })
})

describe('归档筛选（D5）', () => {
  it('setIncludeArchived 用 includeArchived 重拉，并保留 archived 标记', async () => {
    const h = createHarness()
    const channel = await bootV2(h)
    h.controller.setIncludeArchived(true)
    const request = channel.last('sessions')
    expect(request.includeArchived).toBe(true)
    channel.server(
      sessionsFrame(request.requestId, [
        sessionRow('s1'),
        { ...(sessionRow('s2', '归档的会话') as object), archived: true },
      ]),
    )
    const state = h.controller.getState()
    expect(state.sessionsIncludeArchived).toBe(true)
    expect(state.sessions.map((s) => [s.sessionId, s.archived])).toEqual([
      ['s1', undefined],
      ['s2', true],
    ])
  })

  it('archived 帧更新行的归档状态', async () => {
    const h = createHarness()
    const channel = await bootV2(h)
    h.controller.setIncludeArchived(true)
    channel.server(
      sessionsFrame(channel.last('sessions').requestId, [
        sessionRow('s1'),
        { ...(sessionRow('s2') as object), archived: true },
      ]),
    )
    channel.server({
      v: 1,
      type: 'archived',
      requestId: 'rx',
      sessionId: 's2',
      archived: false,
      sessionIds: [],
    })
    const row = h.controller.getState().sessions.find((s) => s.sessionId === 's2')!
    expect(row.archived).toBe(false)
  })

  it('默认列表里归档成功后该行消失（D5：默认不含已归档）', async () => {
    const h = createHarness()
    const channel = await bootV2(h)
    channel.server(
      sessionsFrame(channel.last('sessions').requestId, [sessionRow('s1'), sessionRow('s2')]),
    )
    channel.server({
      v: 1,
      type: 'archived',
      requestId: 'rx',
      sessionId: 's2',
      archived: true,
      sessionIds: ['s2'],
    })
    const ids = h.controller.getState().sessions.map((s) => s.sessionId)
    expect(ids).toEqual(['s1'])
  })
})

describe('§17 修正：连续性只比 index', () => {
  it('revision 回退但 index 递增时仍然接受（v1 客户端会误判）', async () => {
    const h = createHarness()
    const channel = await bootV2(h)
    h.controller.openSession('s1')
    openSession(channel, 's1')

    channel.server(deltaFrame('s1', 'att1', 1, 'A', 'text', 5))
    channel.server(deltaFrame('s1', 'att1', 2, 'B', 'text', 4))
    expect(h.controller.getState().streamingText).toBe('AB')

    // 重复 index 仍然丢弃
    channel.server(deltaFrame('s1', 'att1', 2, 'B', 'text', 4))
    expect(h.controller.getState().streamingText).toBe('AB')
  })
})
