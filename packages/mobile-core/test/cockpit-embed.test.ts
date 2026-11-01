/**
 * 管理座舱（WP56d）在 core 侧的契约与纯逻辑：
 *  - 交接码换令牌（`POST /api/mobile/auth/cockpit-exchange`）的请求/响应/错误语义；
 *  - 座舱令牌只放 sessionStorage（与普通网页版登录的 localStorage 隔离）；
 *  - `ops_call` 的方案结果识别（过程行「方案 #N · 等待确认」）。
 *
 * 这里刻意不测 DOM / postMessage（那在 ui 的 `test/cockpit-embed.test.ts`）。
 */

import { describe, expect, it } from 'vitest'
import {
  COCKPIT_EXCHANGE_TIMEOUT_MS,
  COCKPIT_HANDOFF_INVALID,
  exchangeCockpitHandoff,
} from '../src/http/cockpit.js'
import {
  COCKPIT_CODE_HASH_KEY,
  COCKPIT_EMBED_PARAM,
  COCKPIT_EMBED_VALUE,
  COCKPIT_NODE_ID,
  COCKPIT_TOKEN_STORAGE_KEY,
  canvasActionOf,
  cockpitActionText,
  cockpitProcessActions,
  maskSecretsInText,
  opsCallProposalOf,
  placementText,
} from '../src/cockpit/embed.js'
import { SessionStorageTokenStore, type StringStorage } from '../src/auth/token-store.js'
import { MOBILE } from '../src/contracts/auth-bootstrap.js'
import { HubApiError } from '../src/errors.js'
import { makeTokens } from './helpers/tokens.js'

/** 内存版 sessionStorage（只在这次调用里活着，模拟「关掉标签页就没了」）。 */
class MemoryStorage implements StringStorage {
  data = new Map<string, string>()
  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value)
  }
  removeItem(key: string): void {
    this.data.delete(key)
  }
}

interface Call {
  url: string
  init: RequestInit | undefined
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('座舱常量（docs/24 §3.3 / §6）', () => {
  it('节点固定 cloud:ops，入口参数与令牌键名都带 cockpit', () => {
    expect(COCKPIT_NODE_ID).toBe('cloud:ops')
    expect(COCKPIT_EMBED_PARAM).toBe('embed')
    expect(COCKPIT_EMBED_VALUE).toBe('cockpit')
    expect(COCKPIT_CODE_HASH_KEY).toBe('code')
    expect(COCKPIT_TOKEN_STORAGE_KEY).toContain('cockpit')
    // 与普通网页版登录的键（dshm.web.auth-v1）必须不同：互不覆盖
    expect(COCKPIT_TOKEN_STORAGE_KEY).not.toBe('dshm.web.auth-v1')
  })

  it('交换路径 = /api/mobile/auth/cockpit-exchange', () => {
    expect(MOBILE.cockpitExchange).toBe('/api/mobile/auth/cockpit-exchange')
  })
})

describe('exchangeCockpitHandoff', () => {
  it('POST 正确路径与 {code}，解析令牌并给出 scope=cockpit', async () => {
    const calls: Call[] = []
    const tokens = makeTokens()
    const result = await exchangeCockpitHandoff({
      origin: 'https://hub.test/',
      code: 'hc_abc',
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return jsonResponse({ ...tokens, scope: 'cockpit', platform: 'web' })
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://hub.test/api/mobile/auth/cockpit-exchange')
    expect(calls[0]!.init?.method).toBe('POST')
    expect((calls[0]!.init?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    )
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ code: 'hc_abc' })
    // 不带 Bearer：这一步发生在还没有任何令牌的时候
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBeUndefined()
    expect(result.scope).toBe('cockpit')
    expect(result.tokens.accessToken).toBe(tokens.accessToken)
    expect(result.tokens.user.username).toBe('demo')
  })

  it('老 Hub 不发 scope 也当 cockpit（这是唯一的调用方）', async () => {
    const result = await exchangeCockpitHandoff({
      origin: 'https://hub.test',
      code: 'hc_abc',
      fetchImpl: async () => jsonResponse(makeTokens()),
    })
    expect(result.scope).toBe('cockpit')
  })

  it('码无效（400 无信封）→ cockpit-handoff-invalid（等父页面重新发码）', async () => {
    const promise = exchangeCockpitHandoff({
      origin: 'https://hub.test',
      code: 'used',
      fetchImpl: async () => new Response('not found', { status: 404 }),
    })
    await expect(promise).rejects.toMatchObject({ code: COCKPIT_HANDOFF_INVALID })
  })

  it('信封里给了码 → 用服务端的码（5xx 才算可重试）', async () => {
    const promise = exchangeCockpitHandoff({
      origin: 'https://hub.test',
      code: 'x',
      fetchImpl: async () =>
        jsonResponse({ error: { code: 'RATE_LIMITED', message: 'slow down' } }, 429),
    })
    const error = await promise.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HubApiError)
    expect((error as HubApiError).code).toBe('RATE_LIMITED')
    // 与 HubClient 同一口径：429 不带 retry 按钮（倒计时由 retryAfterSec 表达）
    expect((error as HubApiError).retryable).toBe(false)
  })

  it('5xx → 可重试', async () => {
    const promise = exchangeCockpitHandoff({
      origin: 'https://hub.test',
      code: 'x',
      fetchImpl: async () => jsonResponse({ error: { code: 'INTERNAL' } }, 500),
    })
    await expect(promise).rejects.toMatchObject({ code: 'INTERNAL', retryable: true })
  })

  it('网线断了 → network（不清令牌、不回登录页由上层决定）', async () => {
    const promise = exchangeCockpitHandoff({
      origin: 'https://hub.test',
      code: 'x',
      fetchImpl: async () => {
        throw new TypeError('fetch failed')
      },
    })
    await expect(promise).rejects.toMatchObject({ code: 'network', retryable: true })
  })

  it('响应缺字段 → protocol（不把半份令牌当登录态）', async () => {
    const promise = exchangeCockpitHandoff({
      origin: 'https://hub.test',
      code: 'x',
      fetchImpl: async () => jsonResponse({ accessToken: 'dshm_at_short' }),
    })
    await expect(promise).rejects.toMatchObject({ code: 'protocol' })
  })

  it('超时 → timeout（AbortController 生效）', async () => {
    const promise = exchangeCockpitHandoff({
      origin: 'https://hub.test',
      code: 'x',
      timeoutMs: 20,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    })
    await expect(promise).rejects.toMatchObject({ code: 'timeout' })
    expect(COCKPIT_EXCHANGE_TIMEOUT_MS).toBeGreaterThan(0)
  })
})

describe('SessionStorageTokenStore（座舱令牌只放 sessionStorage）', () => {
  it('保存 / 读取 / 清除，键名与普通登录不同', async () => {
    const storage = new MemoryStorage()
    const store = new SessionStorageTokenStore('dshm.cockpit.auth-v1', storage)
    expect(await store.load()).toBeNull()
    await store.save(makeTokens())
    expect(storage.data.has('dshm.cockpit.auth-v1')).toBe(true)
    expect(storage.data.has('dshm.web.auth-v1')).toBe(false)
    expect((await store.load())?.accessToken).toBe(`dshm_at_${'a'.repeat(40)}`)
    await store.clear()
    expect(await store.load()).toBeNull()
    expect(storage.data.size).toBe(0)
  })

  it('读到坏数据 → 清掉并当未登录（不进入崩溃循环）', async () => {
    const storage = new MemoryStorage()
    storage.setItem('k', '{not json')
    const store = new SessionStorageTokenStore('k', storage)
    expect(await store.load()).toBeNull()
    expect(storage.getItem('k')).toBeNull()
  })

  it('存储不可用（隐私模式）时退化成内存：本次仍可用，刷新后要重新交接', async () => {
    const broken: StringStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }
    const store = new SessionStorageTokenStore('dshm.cockpit.auth-v1', broken)
    await store.save(makeTokens())
    expect((await store.load())?.user.username).toBe('demo')
  })
})

describe('ops_call 方案结果识别（过程行「方案 #N · 等待确认」）', () => {
  const card = (preview: string, extra: Partial<{ name: string; phase: 'start' | 'end'; status: 'running' | 'ok' | 'error' }> = {}) => ({
    name: extra.name ?? 'ops_call',
    phase: extra.phase ?? ('end' as const),
    status: extra.status ?? ('ok' as const),
    outputPreview: preview,
  })

  it('parse 出 id / title / risk', () => {
    const preview = JSON.stringify({
      kind: 'proposal',
      proposal: { id: 12, title: '下发 dsh-memory 0.1.4', risk: 'R2', status: 'pending' },
    })
    expect(opsCallProposalOf(card(preview))).toEqual({
      id: 12,
      title: '下发 dsh-memory 0.1.4',
      risk: 'R2',
    })
  })

  it('data / done 不是方案', () => {
    expect(
      opsCallProposalOf(card(JSON.stringify({ kind: 'data', data: { rows: [] }, truncated: false }))),
    ).toBeNull()
    expect(
      opsCallProposalOf(card(JSON.stringify({ kind: 'done', result: { ok: true }, auditId: 3 }))),
    ).toBeNull()
  })

  it('预览被截断时也能认出方案 id', () => {
    const preview =
      '{"kind":"proposal","proposal":{"id":7,"title":"重启实例","risk":"R2","steps":[{"capability":"instances.stop","args":{"x":'
    expect(opsCallProposalOf(card(preview))?.id).toBe(7)
  })

  it('别的工具、运行中、失败都不认', () => {
    const preview = JSON.stringify({ kind: 'proposal', proposal: { id: 3 } })
    expect(opsCallProposalOf(card(preview, { name: 'bash' }))).toBeNull()
    expect(opsCallProposalOf(card(preview, { phase: 'start', status: 'running' }))).toBeNull()
    expect(opsCallProposalOf(card(preview, { status: 'error' }))).toBeNull()
  })

  it('工具名可以带命名空间前缀', () => {
    const preview = JSON.stringify({ kind: 'proposal', proposal: { id: 5 } })
    expect(opsCallProposalOf(card(preview, { name: 'dshhub_ops.ops_call' }))?.id).toBe(5)
  })

  it('方案行的文案：⟶ 方案 #N · 待确认（右舷）', () => {
    expect(cockpitActionText({ kind: 'proposal', id: 12, title: '', risk: 'R2' })).toBe(
      '⟶ 方案 #12 · 待确认（右舷）',
    )
  })

  it('控制台主题（docs/26）没有两舷：投放 / 更新 / 方案都说「右侧」', () => {
    const opts = { console: true }
    expect(cockpitActionText({ kind: 'proposal', id: 12, title: '', risk: 'R2' }, opts)).toBe(
      '⟶ 方案 #12 · 待确认（右侧）',
    )
    expect(
      cockpitActionText(
        { kind: 'canvas', id: 'cv_1', title: '近 7 天积分消耗', placement: 'left', update: false },
        opts,
      ),
    ).toBe('⟶ 已放到右侧：近 7 天积分消耗')
    expect(
      cockpitActionText(
        { kind: 'canvas', id: 'cv_1', title: '近 7 天积分消耗', placement: 'left', update: true },
        opts,
      ),
    ).toBe('⟶ 已更新右侧卡片：近 7 天积分消耗')
    expect(
      cockpitActionText({ kind: 'canvas', id: 'cv_1', title: '', placement: 'right', update: false }, opts),
    ).toBe('⟶ 已放到右侧')
  })
})

describe('canvas_show / canvas_update（投放）', () => {
  const card = (
    preview: string,
    extra: Partial<{ name: string; phase: 'start' | 'end'; status: 'running' | 'ok' | 'error' }> = {},
  ) => ({
    name: extra.name ?? 'canvas_show',
    phase: extra.phase ?? ('end' as const),
    status: extra.status ?? ('ok' as const),
    outputPreview: preview,
  })

  it('CanvasItem 回包：id / title / placement', () => {
    const action = canvasActionOf(
      card(
        JSON.stringify({
          id: 'cv_1',
          title: '近 7 天积分消耗',
          spec: { kind: 'chart', placement: 'left' },
          placement: 'left',
          pinned: false,
          order: 0,
          origin: 'dsh',
        }),
      ),
    )
    expect(action).toEqual({
      kind: 'canvas',
      id: 'cv_1',
      title: '近 7 天积分消耗',
      placement: 'left',
      update: false,
    })
    expect(cockpitActionText(action!)).toBe('⟶ 已投放左舷：近 7 天积分消耗')
  })

  it('缺 placement 时按卡片类型兜底：数据卡左舷、行动卡右舷', () => {
    expect(canvasActionOf(card(JSON.stringify({ id: 'cv_a', title: 'Top 5', spec: { kind: 'table' } })))?.placement).toBe('left')
    expect(canvasActionOf(card(JSON.stringify({ id: 'cv_b', title: '任务', spec: { kind: 'job' } })))?.placement).toBe('right')
    expect(
      canvasActionOf(card(JSON.stringify({ id: 'cv_c', title: '方案', spec: { kind: 'proposal' } })))?.placement,
    ).toBe('right')
    expect(
      canvasActionOf(card(JSON.stringify({ id: 'cv_d', title: 'x', placement: 'auto', spec: { kind: 'stats' } })))?.placement,
    ).toBe('left')
  })

  it('包了一层的回包（{ok, item}）也认', () => {
    const action = canvasActionOf(
      card(JSON.stringify({ ok: true, item: { id: 'cv_9', title: '失败任务', spec: { kind: 'table' }, placement: 'right' } })),
    )
    expect(action?.id).toBe('cv_9')
    expect(action?.placement).toBe('right')
  })

  it('canvas_update → 「已更新」', () => {
    const action = canvasActionOf(
      card(JSON.stringify({ id: 'cv_1', title: '近 7 天积分消耗', placement: 'left' }), {
        name: 'canvas_update',
      }),
    )
    expect(action?.update).toBe(true)
    expect(cockpitActionText(action!)).toBe('⟶ 已更新左舷：近 7 天积分消耗')
  })

  it('预览被截断（JSON 不完整）时仍能认出 id 与舷位', () => {
    const action = canvasActionOf(
      card('{"id":"cv_7","title":"近 7 天","placement":"right","spec":{"kind":"chart","series":['),
    )
    expect(action).toEqual({
      kind: 'canvas',
      id: 'cv_7',
      title: '近 7 天',
      placement: 'right',
      update: false,
    })
  })

  it('别的工具 / 运行中 / 失败都不认', () => {
    const preview = JSON.stringify({ id: 'cv_1', title: 'x', placement: 'left' })
    expect(canvasActionOf(card(preview, { name: 'bash' }))).toBeNull()
    expect(canvasActionOf(card(preview, { phase: 'start', status: 'running' }))).toBeNull()
    expect(canvasActionOf(card(preview, { status: 'error' }))).toBeNull()
    expect(canvasActionOf(card(JSON.stringify({ id: '', title: 'x' })))).toBeNull()
  })

  it('舷位中文名', () => {
    expect(placementText('left')).toBe('左舷')
    expect(placementText('right')).toBe('右舷')
  })
})

describe('过程行的投放/方案列表（按出现顺序）', () => {
  const tool = (name: string, preview: unknown) => ({
    kind: 'tool',
    card: { name, phase: 'end' as const, status: 'ok' as const, outputPreview: JSON.stringify(preview) },
  })

  it('一轮里 3 次 canvas_show（左、左、右）+ 1 次 ops_call → 4 条，顺序不变', () => {
    const rows = [
      { kind: 'reasoning' },
      tool('canvas_show', { id: 'cv_1', title: '近 7 天积分消耗', placement: 'left' }),
      tool('canvas_show', { id: 'cv_2', title: 'Top 5 用户', placement: 'left' }),
      tool('canvas_show', { id: 'cv_3', title: '下发进度', placement: 'right' }),
      tool('ops_call', { kind: 'proposal', proposal: { id: 12, title: '下发 dsh-memory' } }),
    ]
    const actions = cockpitProcessActions(rows)
    expect(actions.map((action) => cockpitActionText(action))).toEqual([
      '⟶ 已投放左舷：近 7 天积分消耗',
      '⟶ 已投放左舷：Top 5 用户',
      '⟶ 已投放右舷：下发进度',
      '⟶ 方案 #12 · 待确认（右舷）',
    ])
    expect(actions.map((action) => (action.kind === 'canvas' ? action.id : action.id))).toEqual([
      'cv_1',
      'cv_2',
      'cv_3',
      12,
    ])
  })

  it('没有投放/方案时是空数组（普通回合不受影响）', () => {
    expect(cockpitProcessActions([{ kind: 'reasoning' }])).toEqual([])
    expect(
      cockpitProcessActions([tool('bash', { output: 'ok' })]),
    ).toEqual([])
  })
})

describe('maskSecretsInText：座舱发送前打码（docs/24 §0-4）', () => {
  it('常见凭据形态换成 [已隐藏]，普通文字不动', () => {
    const { text, masked } = maskSecretsInText('加一个渠道，key 是 sk-j11-0123456789abcdef0123456789abcdef，谢谢')
    expect(text).toBe('加一个渠道，key 是 [已隐藏]，谢谢')
    expect(masked).toBe(1)
    expect(maskSecretsInText('订阅 https://u:p4ss@sub.example.com/x?token=abc123').text).toBe(
      'https://[已隐藏]@sub.example.com/x?token=[已隐藏]'.replace(/^/, '订阅 '),
    )
    expect(maskSecretsInText('Authorization: Bearer abcdefgh12345678').text).toBe('Authorization: [已隐藏]')
    expect(maskSecretsInText('这周谁用得最多？给 alice 升级 dsh-memory')).toEqual({
      text: '这周谁用得最多？给 alice 升级 dsh-memory',
      masked: 0,
    })
  })
})
