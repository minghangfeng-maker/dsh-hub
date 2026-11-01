import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ProposalView, SecretRequestView } from '@dsh-hub/shared'
import { defineCapability, createCapabilityRegistry } from '../src/modules/cockpit/capabilities/index.js'
import { HubError } from '../src/lib/errors.js'
import type { CockpitService } from '../src/modules/cockpit/types.js'
import { createCockpitHarness, createHarnessService, type CockpitHarness } from './helpers-cockpit.js'

/**
 * 密钥引用（docs/24 §3.4 / §3.1 secret-requests）。
 *
 * ★ 能力里没有需要密钥的（`relay.channels.upsert` 之类归 WP56e），所以这里注入一个
 * 夹具能力 `fixture.use-secret`：它把 ref 换成明文后只回「长度」，用来验证
 * 「参数只收 secretRef → 管理员填值 → 执行时解引用 → 用完即删 → 全程不出现在对话/审计里」。
 */

const SECRET_VALUE = 'sk-live-9f8e7d6c5b4a39281706f5e4'

const fixtureCapability = defineCapability({
  id: 'fixture.use-secret',
  area: 'settings',
  title: '夹具：用一次密钥',
  description: '测试专用写能力：把 secretRef 换成明文后只返回长度与标签，绝不回显密钥本身。',
  risk: 'R2',
  secretFields: ['apiKey'],
  input: z.object({
    apiKey: z.string().min(1),
    label: z.string().max(32).default('默认'),
  }),
  async preview(_ctx, args) {
    return { summary: `用一次密钥（${args.label}）` }
  },
  async run(_ctx, args) {
    return { label: args.label, length: args.apiKey.length, ok: true }
  },
})

const META = { ip: '10.219.60.2', userAgent: 'vitest-ops', publicRequest: false }

let h: CockpitHarness
let service: CockpitService

beforeEach(async () => {
  h = await createCockpitHarness()
  service = createHarnessService(h, createCapabilityRegistry([fixtureCapability]))
})

afterEach(async () => {
  await h.close()
})

function actor() {
  return { id: h.admin.user.id, username: h.admin.user.username }
}

async function settled(id: number, timeoutMs = 5_000): Promise<ProposalView> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const view = service.getProposal(id)
    if (view.status !== 'pending' && view.status !== 'running') return view
    if (Date.now() > deadline) throw new Error('方案没有结束')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function expectHubError(promise: Promise<unknown>, code: string): Promise<HubError> {
  try {
    await promise
  } catch (error) {
    expect(HubError.is(error)).toBe(true)
    const hubError = error as HubError
    expect(hubError.code).toBe(code)
    return hubError
  }
  throw new Error('期望抛出 HubError，但没有')
}

describe('密钥引用：只收 secretRef、用完即删、不落对话与审计', () => {
  it('明文参数直接 400（只接受 secretRef）', async () => {
    const error = await expectHubError(
      service.call(
        {
          sessionId: 's1',
          capability: 'fixture.use-secret',
          args: { apiKey: SECRET_VALUE },
          title: '用一次密钥',
        },
        META,
      ),
      'VALIDATION_FAILED',
    )
    expect(error.message).toContain('只接受密钥引用')
  })

  it('完整链路：申请 → 填值 → 方案 → 执行时解引用 → 密文清除 → 不留明文', async () => {
    const request = service.createSecretRequest({
      sessionId: 's1',
      purpose: '夹具渠道的 API Key',
      capability: 'fixture.use-secret',
      field: 'apiKey',
    })
    expect(request.status).toBe('pending')
    expect(request.id.startsWith('sec_')).toBe(true)
    expect(request.id).toHaveLength(36)

    // 画布上出现密钥输入卡（Hub 生成）
    const cards = service.listCanvas('s1')
    expect(cards.some((card) => card.spec.kind === 'secret-request')).toBe(true)

    // 还没填就提方案：能建方案（预览不解引用），但执行会失败
    const early = await service.call(
      {
        sessionId: 's1',
        capability: 'fixture.use-secret',
        args: { apiKey: request.id, label: '早' },
        title: '用一次密钥',
      },
      META,
    )
    if (early.kind !== 'proposal') throw new Error('应该是方案')
    await service.approveProposal(early.proposal.id, actor(), META)
    const failed = await settled(early.proposal.id)
    expect(failed.status).toBe('failed')
    expect(failed.outcome?.[0]?.ok).toBe(false)

    // 管理员填值（值不经过 iframe、不进对话）
    service.fillSecretRequest(request.id, SECRET_VALUE, actor())
    const filled = service.waitSecretRequest(request.id, 0)
    const filledView = await filled
    expect(filledView.status).toBe('filled')
    expect(filledView.secretRef).toBe(request.id)
    expect(JSON.stringify(filledView)).not.toContain(SECRET_VALUE)

    // 再提方案并批准：执行时解引用
    const created = await service.call(
      {
        sessionId: 's1',
        capability: 'fixture.use-secret',
        args: { apiKey: request.id, label: '正式' },
        title: '用一次密钥',
      },
      META,
    )
    if (created.kind !== 'proposal') throw new Error('应该是方案')
    // 方案里存的是引用号，不是明文
    expect(JSON.stringify(created.proposal)).not.toContain(SECRET_VALUE)
    expect(created.proposal.steps[0]?.args.apiKey).toBe(request.id)

    await service.approveProposal(created.proposal.id, actor(), META)
    const done = await settled(created.proposal.id)
    expect(done.status).toBe('succeeded')
    const step = done.outcome?.[0]
    expect(step?.ok).toBe(true)
    expect((step?.result as { length: number }).length).toBe(SECRET_VALUE.length)
    expect(JSON.stringify(done)).not.toContain(SECRET_VALUE)

    // 用完即删：密文清空、状态 expired
    const row = h.app.deps.db.get<{ ciphertext: string | null; used_at: string | null; status: string }>(
      'SELECT ciphertext, used_at, status FROM cockpit_secrets WHERE id = ?',
      request.id,
    )
    expect(row?.ciphertext).toBeNull()
    expect(row?.used_at).not.toBeNull()
    expect(row?.status).toBe('expired')

    // 审计与密钥请求表里都搜不到明文
    const auditText = h.app.deps.db
      .all<{ action: string; target_id: string | null; detail_json: string | null }>(
        'SELECT action, target_id, detail_json FROM audit_logs',
      )
      .map((item) => `${item.action} ${item.target_id ?? ''} ${item.detail_json ?? ''}`)
      .join('\n')
    expect(auditText).not.toContain(SECRET_VALUE)
    expect(auditText).toContain('cockpit.secret-fill')
    const secretText = h.app.deps.db
      .all<{ request_json: string; ciphertext: string | null }>(
        'SELECT request_json, ciphertext FROM cockpit_secrets',
      )
      .map((item) => `${item.request_json}${item.ciphertext ?? ''}`)
      .join('\n')
    expect(secretText).not.toContain(SECRET_VALUE)
  })

  it('15 分钟过期：过期后执行失败并提示过期', async () => {
    const request = service.createSecretRequest({
      sessionId: 's1',
      purpose: '过期用例',
      capability: 'fixture.use-secret',
      field: 'apiKey',
    })
    service.fillSecretRequest(request.id, SECRET_VALUE, actor())
    const created = await service.call(
      {
        sessionId: 's1',
        capability: 'fixture.use-secret',
        args: { apiKey: request.id },
        title: '用一次密钥',
      },
      META,
    )
    if (created.kind !== 'proposal') throw new Error('应该是方案')
    h.ctx.clock.advance(16 * 60 * 1000)
    expect(service.getSecretRequest(request.id).status).toBe('expired')
    await service.approveProposal(created.proposal.id, actor(), META)
    const view = await settled(created.proposal.id)
    expect(view.status).toBe('failed')
    expect(view.outcome?.[0]?.error?.message).toContain('过期')
  })

  it('凭据只能在申请的会话里用：换个 sessionId 提交会失败', async () => {
    const request = service.createSecretRequest({
      sessionId: 's1',
      purpose: '会话归属',
      capability: 'fixture.use-secret',
      field: 'apiKey',
    })
    service.fillSecretRequest(request.id, SECRET_VALUE, actor())
    const created = await service.call(
      {
        sessionId: 's2',
        capability: 'fixture.use-secret',
        args: { apiKey: request.id },
        title: '跨会话用密钥',
      },
      META,
    )
    if (created.kind !== 'proposal') throw new Error('应该是方案')
    await service.approveProposal(created.proposal.id, actor(), META)
    const view = await settled(created.proposal.id)
    expect(view.status).toBe('failed')
    expect(view.outcome?.[0]?.error?.message).toContain('不属于当前会话')
  })

  it('申请时字段必须是该能力声明的 secretFields', async () => {
    const error = await expectHubError(
      Promise.resolve().then(() =>
        service.createSecretRequest({
          sessionId: 's1',
          purpose: '字段不对',
          capability: 'fixture.use-secret',
          field: 'cookie',
        }),
      ),
      'VALIDATION_FAILED',
    )
    expect(error.message).toContain('没有密钥参数')
    // 没有 secretFields 的能力也不行
    await expectHubError(
      Promise.resolve().then(() =>
        service.createSecretRequest({
          sessionId: 's1',
          purpose: '能力不对',
          capability: 'invites.create',
          field: 'apiKey',
        }),
      ),
      'VALIDATION_FAILED',
    )
  })

  it('取消：状态 cancelled，之后不能填', async () => {
    const request: SecretRequestView = service.createSecretRequest({
      sessionId: 's1',
      purpose: '取消用例',
      capability: 'fixture.use-secret',
      field: 'apiKey',
    })
    service.cancelSecretRequest(request.id, actor())
    expect(service.getSecretRequest(request.id).status).toBe('cancelled')
    await expectHubError(
      Promise.resolve().then(() => service.fillSecretRequest(request.id, SECRET_VALUE, actor())),
      'CONFLICT',
    )
  })
})
