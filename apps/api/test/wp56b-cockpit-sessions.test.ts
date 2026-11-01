import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MobileClientFrameAll, MobileServerFrameAll, MobileSessionRowV2 } from '@dsh-hub/shared'
import { MobileSessionRowV2Schema } from '@dsh-hub/shared'
import type { FrameSink, NodeRemote } from '@dsh-hub/dsh-node-remote'
import { NodeSession } from '../src/modules/mobile/node-session.js'
import {
  cockpitSessionInitiators,
  recordCockpitSessionInitiator,
} from '../src/modules/mobile/cockpit-repo.js'
import { createUser, createTestApp, type TestApp } from './helpers.js'

/**
 * WP56b / docs/24 §6：`cloud:ops` 会话行的 `initiator`（这条会话是谁开的）。
 *
 * 三个来源各一条：服务端 `created`（新建会话）、客户端 `send`（首次发消息）、以及会话列表帧的装饰。
 * 普通节点（没有钩子）的会话行**不带** initiator。
 */

/** 最小 fake adapter：只为把服务端帧推进 NodeSession 的 sink */
function fakeRemote(): NodeRemote & { emit: (frame: MobileServerFrameAll) => void } {
  let sink: FrameSink | null = null
  const remote = {
    capabilities: {
      sessions: true,
      history: true,
      send: true,
      stop: true,
      stream: true,
      questions: true,
      approvals: true,
      create: true,
    },
    compatible: true,
    missing: [],
    node: { id: 'cloud:ops', kind: 'cloud' as const, name: '座舱 DSH', status: 'running' as const },
    async dispatch(frame: MobileClientFrameAll, next: FrameSink) {
      sink = next
      void frame
    },
    emit(frame: MobileServerFrameAll) {
      // FrameSink 就是一个函数：adapter 的异步帧都从这里交给 NodeSession
      // （v2 字段在 NodeSession 里按通道特性过滤，adapter 的类型只到 v1，这里强转）
      sink?.(frame as unknown as Parameters<FrameSink>[0])
    },
    async close() {
      // 测试里不需要收尾
    },
  }
  return remote as unknown as NodeRemote & { emit: (frame: MobileServerFrameAll) => void }
}

const ROW = (sessionId: string): MobileSessionRowV2 => ({
  sessionId,
  title: `会话 ${sessionId}`,
  updatedAt: 1,
  running: false,
  blank: false,
  agentAvailable: true,
})

let ctx: TestApp
let userId: number

beforeEach(async () => {
  ctx = await createTestApp()
  const user = await createUser(ctx.app, { username: 'ops-admin', displayName: '值班管理员', role: 'admin' })
  userId = user.id
})

afterEach(async () => {
  await ctx.close()
})

function harness(options: { decorate?: boolean } = {}) {
  const remote = fakeRemote()
  const recorded: string[] = []
  const decorateSessions = (items: MobileSessionRowV2[]): MobileSessionRowV2[] => {
    const who = cockpitSessionInitiators(
      ctx.app.deps.db,
      items.map((item) => item.sessionId),
    )
    if (who.size === 0) return items
    return items.map((item) => {
      const initiator = who.get(item.sessionId)
      if (initiator === undefined) return item
      return {
        ...item,
        initiator: {
          username: initiator.username,
          ...(initiator.displayName === null ? {} : { displayName: initiator.displayName }),
        },
      }
    })
  }
  const session = new NodeSession({
    userId,
    nodeId: 'cloud:ops',
    remote,
    lingerMs: 60_000,
    parkMs: 60_000,
    log: () => undefined,
    onSessionCreated: (sessionId) => recorded.push(sessionId),
    onSessionTouched: (sessionId) => recorded.push(sessionId),
    ...(options.decorate === false ? {} : { decorateSessionRows: decorateSessions }),
  })
  const frames: MobileServerFrameAll[] = []
  session.attach('c1', (frame) => frames.push(frame))
  /** 让 adapter 拿到 sink（真实链路里第一条 hello 就会给），之后的 `emit` 才推得动 */
  const prime = async (): Promise<void> => {
    await session.dispatch('c1', {
      v: 1,
      type: 'hello',
      requestId: 'h1',
      client: { name: 'app', version: '0.4.0' },
    })
  }
  return { session, remote, frames, recorded, prime }
}

describe('座舱会话的发起人', () => {
  it('record 是幂等的：同一会话只记第一个管理员', () => {
    recordCockpitSessionInitiator(ctx.app.deps.db, {
      sessionId: 's_a',
      adminId: userId,
      username: 'ops-admin',
      displayName: '值班管理员',
      at: ctx.clock.nowIso(),
    })
    recordCockpitSessionInitiator(ctx.app.deps.db, {
      sessionId: 's_a',
      adminId: userId + 999,
      username: 'later-admin',
      displayName: null,
      at: ctx.clock.nowIso(),
    })
    const map = cockpitSessionInitiators(ctx.app.deps.db, ['s_a'])
    expect(map.get('s_a')).toMatchObject({ username: 'ops-admin', displayName: '值班管理员' })
  })

  it('服务端 `created` 帧与客户端 `send` 帧都会触发登记', async () => {
    const { session, remote, recorded, prime } = harness()
    await prime()
    remote.emit({ v: 1, type: 'created', requestId: 'r1', sessionId: 's_new' })
    await session.dispatch('c1', {
      v: 1,
      type: 'send',
      requestId: 'r2',
      sessionId: 's_old',
      text: '你好',
      clientMessageId: 'm1',
    })
    expect(recorded).toEqual(['s_new', 's_old'])
  })

  it('会话列表帧带上 initiator，且符合契约', async () => {
    recordCockpitSessionInitiator(ctx.app.deps.db, {
      sessionId: 's_a',
      adminId: userId,
      username: 'ops-admin',
      displayName: '值班管理员',
      at: ctx.clock.nowIso(),
    })
    const { remote, frames, prime } = harness()
    await prime()
    remote.emit({ v: 1, type: 'sessions', requestId: 'r3', items: [ROW('s_a'), ROW('s_b')] })
    const listFrame = frames.find((frame) => frame.type === 'sessions')
    expect(listFrame).toBeDefined()
    const items = (listFrame as Extract<MobileServerFrameAll, { type: 'sessions' }>)
      .items as MobileSessionRowV2[]
    // 契约必须仍然成立（多一个可选字段）
    for (const item of items) expect(MobileSessionRowV2Schema.safeParse(item).success).toBe(true)
    expect(items[0]).toMatchObject({
      sessionId: 's_a',
      initiator: { username: 'ops-admin', displayName: '值班管理员' },
    })
    expect(items[1]?.initiator).toBeUndefined()
  })

  it('普通节点（没有装饰钩子）的会话行不带 initiator', async () => {
    recordCockpitSessionInitiator(ctx.app.deps.db, {
      sessionId: 's_a',
      adminId: userId,
      username: 'ops-admin',
      displayName: '值班管理员',
      at: ctx.clock.nowIso(),
    })
    const { remote, frames, prime } = harness({ decorate: false })
    await prime()
    remote.emit({ v: 1, type: 'sessions', requestId: 'r4', items: [ROW('s_a')] })
    const listFrame = frames.find((frame) => frame.type === 'sessions')
    const items = (listFrame as Extract<MobileServerFrameAll, { type: 'sessions' }>)
      .items as MobileSessionRowV2[]
    expect(items[0]?.initiator).toBeUndefined()
  })
})
