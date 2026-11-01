/**
 * 与契约 fixtures 对拍（手机端的契约来源是同仓库的 `@dsh-hub/shared`）。
 *
 * 覆盖：
 *  - 9 个客户端帧逐字段等于 `test/fixtures/mobile-v1/client-*.json`；
 *  - 15 个服务端帧全部能被 `parseServerFrame` 接受；
 *  - 未知帧不崩、版本不符显式报错、坏帧丢弃；
 *  - 节点列表不含 home/cwd（M4 §3 硬约束）。
 */

import { describe, expect, it } from 'vitest'
import { MobileNodesResponseSchema } from '@dsh-hub/shared'
import {
  answerApproval,
  answerQuestion,
  create,
  encodeClientFrame,
  hello,
  history,
  parseServerFrame,
  ping,
  send,
  sessions,
  stop,
  subscribe,
  unsubscribe,
} from '../src/channel/wire.js'
import { FIXTURES_DIR, fixtureNames, fixtureServerFrames, readFixture } from './helpers/fixture.js'

describe('客户端帧与 fixtures 逐字段一致', () => {
  it('hello', () => {
    expect(hello('r1', { name: 'dsh-hub-android', version: '0.2.0' })).toEqual(
      readFixture('client-hello.json'),
    )
  })

  it('sessions', () => {
    expect(sessions('r2')).toEqual(readFixture('client-sessions.json'))
  })

  it('history', () => {
    expect(history('r3', 's_01J', { beforeSeq: null, limit: 30 })).toEqual(
      readFixture('client-history.json'),
    )
  })

  it('send', () => {
    expect(send('r4', 's_01J', '跑一下测试', 'm_01A', 'queue')).toEqual(
      readFixture('client-send.json'),
    )
  })

  it('stop', () => {
    expect(stop('r6', 's_01J')).toEqual(readFixture('client-stop.json'))
  })

  it('subscribe', () => {
    expect(subscribe('r5', 's_01J', 41)).toEqual(readFixture('client-subscribe.json'))
  })

  it('create', () => {
    expect(create('r7', { title: '手机新建' })).toEqual(readFixture('client-create.json'))
  })

  it('answer-question', () => {
    expect(
      answerQuestion('r8', 's_01J', 'ag_01J', 'call_q1', [
        { id: 'q1', selected: ['仅本机'], custom: '不要动生产' },
      ]),
    ).toEqual(readFixture('client-answer-question.json'))
  })

  it('answer-approval', () => {
    expect(answerApproval('r9', 's_01J', 'ap_01', 'approve')).toEqual(
      readFixture('client-answer-approval.json'),
    )
  })

  it('ping', () => {
    expect(ping(1730000000123)).toEqual(readFixture('client-ping.json'))
  })

  it('unsubscribe 是契约里的帧（fixtures 未收，形状固定）', () => {
    expect(unsubscribe('s_01J')).toEqual({ v: 1, type: 'unsubscribe', sessionId: 's_01J' })
  })

  it('encodeClientFrame 拒绝未知字段（与 Hub 的 strictObject 一致）', () => {
    expect(() =>
      encodeClientFrame({ v: 1, type: 'sessions', requestId: 'x', extra: true } as never),
    ).toThrow()
  })
})

describe('服务端帧解析', () => {
  it(`覆盖 fixtures 里的全部服务端帧（${fixtureServerFrames().length} 个）`, () => {
    const frames = fixtureServerFrames()
    expect(frames.length).toBeGreaterThanOrEqual(15)
    for (const { name, frame } of frames) {
      const parsed = parseServerFrame(frame)
      expect(parsed.kind, `${name} 应该被接受`).toBe('frame')
      if (parsed.kind !== 'frame') continue
      const expected = name
        .replace(/^server-/, '')
        .replace(/\.json$/, '')
        .replace(/^message-user$/, 'message')
      expect(parsed.frame.type, `${name} 类型`).toBe(expected)
    }
  })

  it('文本输入与对象输入等价', () => {
    const frame = readFixture('server-delta.json')
    const a = parseServerFrame(JSON.stringify(frame))
    const b = parseServerFrame(frame)
    expect(a.kind).toBe('frame')
    expect(b.kind).toBe('frame')
    if (a.kind === 'frame' && b.kind === 'frame') expect(a.frame).toEqual(b.frame)
  })

  it('未知 v 显式报 protocol-mismatch（M4 §7）', () => {
    expect(parseServerFrame({ v: 2, type: 'hello' })).toMatchObject({
      kind: 'protocol-mismatch',
      version: 2,
    })
  })

  it('未知帧类型不崩，交给上层丢弃', () => {
    expect(parseServerFrame({ v: 1, type: 'future-frame', whatever: 1 })).toMatchObject({
      kind: 'unknown',
      type: 'future-frame',
    })
  })

  it('已知类型但字段缺失 → malformed', () => {
    expect(parseServerFrame({ v: 1, type: 'delta', sessionId: 's1' })).toMatchObject({
      kind: 'malformed',
      type: 'delta',
    })
  })

  it('非 JSON / 非对象 → malformed', () => {
    expect(parseServerFrame('not json').kind).toBe('malformed')
    expect(parseServerFrame('[]').kind).toBe('malformed')
  })
})

describe('节点列表 fixture', () => {
  it('能被 shared 的 MobileNodesResponseSchema 解析，且不含 home/cwd/openUrl', () => {
    const raw = readFixture('nodes-response.json')
    const parsed = MobileNodesResponseSchema.parse(raw)
    expect(parsed.items.length).toBe(3)
    expect(parsed.items[0]!.id).toBe('cloud:self')
    const text = JSON.stringify(raw)
    expect(text).not.toContain('"home"')
    expect(text).not.toContain('"cwd"')
    expect(text).not.toContain('openUrl')
    // presence 绝不等于 connectable（M4 §3.1）
    const desktop = parsed.items.find((n) => n.kind === 'desktop' && n.presence === 'online')
    expect(desktop?.connectable).toBe(false)
    expect(desktop?.reason).toBe('desktop-remote-off')
  })

  it('fixtures 目录存在，文件名可枚举（防止路径写错静默跳过）', () => {
    expect(fixtureNames().length).toBeGreaterThan(25)
    expect(FIXTURES_DIR).toContain('fixtures')
  })
})
