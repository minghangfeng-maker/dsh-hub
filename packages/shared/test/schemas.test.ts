import { describe, expect, it } from 'vitest'
import {
  CheckUsernameQuerySchema,
  CreateExportRequestSchema,
  DEFAULT_QUOTA,
  LoginRequestSchema,
  QuotaSchema,
  RegisterRequestSchema,
  StrategySchema,
  TargetsSchema,
  UpdateMeRequestSchema,
  UserPublicSchema,
  isReservedUsername,
  parseExportParts,
  pagedOf,
  providerKeyEnvName,
} from '../src/index.js'

describe('注册 / 登录校验', () => {
  it('接受合法注册请求', () => {
    const parsed = RegisterRequestSchema.parse({
      username: 'alice',
      password: 'a-long-password-1',
      displayName: '爱丽丝',
      inviteCode: 'ABCDEFGHJKLM',
    })
    expect(parsed.username).toBe('alice')
  })

  it('用户名先规整成小写再校验（10 §B3 要求 Admin → 保留字而不是格式错误）', () => {
    const res = RegisterRequestSchema.safeParse({ username: 'Alice', password: 'a-long-password-1' })
    expect(res.success).toBe(true)
    expect(res.data?.username).toBe('alice')

    const trimmed = RegisterRequestSchema.safeParse({ username: '  Bob  ', password: 'a-long-password-1' })
    expect(trimmed.data?.username).toBe('bob')

    // 含大写以外的非法字符仍然拒绝，并给中文提示
    const bad = RegisterRequestSchema.safeParse({ username: '中文名字', password: 'a-long-password-1' })
    expect(bad.success).toBe(false)
    expect(bad.error?.issues[0]?.message).toContain('只能包含小写字母')

    const tooShort = RegisterRequestSchema.safeParse({ username: 'a', password: 'a-long-password-1' })
    expect(tooShort.success).toBe(false)
  })

  it('拒绝过短密码', () => {
    expect(RegisterRequestSchema.safeParse({ username: 'alice', password: 'short' }).success).toBe(false)
  })

  it('登录请求 remember 可省略', () => {
    const parsed = LoginRequestSchema.parse({ username: 'alice', password: 'x' })
    expect(parsed.remember).toBeUndefined()
  })

  it('check-username 查询串需要 username', () => {
    expect(CheckUsernameQuerySchema.safeParse({}).success).toBe(false)
    expect(CheckUsernameQuerySchema.parse({ username: 'bob' }).username).toBe('bob')
  })
})

describe('个人资料校验', () => {
  it('bio 不超过 200 字', () => {
    expect(UpdateMeRequestSchema.safeParse({ bio: 'x'.repeat(201) }).success).toBe(false)
    expect(UpdateMeRequestSchema.safeParse({ bio: 'x'.repeat(200) }).success).toBe(true)
  })
})

describe('配额（03 §1.5）', () => {
  it('默认配额合法', () => {
    expect(QuotaSchema.parse(DEFAULT_QUOTA)).toEqual(DEFAULT_QUOTA)
  })

  it('拒绝越界值', () => {
    expect(QuotaSchema.safeParse({ ...DEFAULT_QUOTA, cpus: 16 }).success).toBe(false)
    expect(QuotaSchema.safeParse({ ...DEFAULT_QUOTA, memoryMb: 100 }).success).toBe(false)
  })
})

describe('下发目标与策略（04 §4.8）', () => {
  it('targets 支持三种形式', () => {
    expect(TargetsSchema.safeParse({ all: true }).success).toBe(true)
    expect(TargetsSchema.safeParse({ userIds: [1, 2] }).success).toBe(true)
    expect(TargetsSchema.safeParse({ filter: { status: 'active' } }).success).toBe(true)
    expect(TargetsSchema.safeParse({ userIds: [] }).success).toBe(false)
  })

  it('strategy 应用默认值', () => {
    const parsed = StrategySchema.parse({})
    expect(parsed).toEqual({ concurrency: 3, canary: 1, maxFailureRatio: 0.2, restart: 'now' })
  })

  it('strategy 越界报错', () => {
    expect(StrategySchema.safeParse({ concurrency: 99 }).success).toBe(false)
    expect(StrategySchema.safeParse({ maxFailureRatio: 2 }).success).toBe(false)
  })
})

describe('导出', () => {
  it('parts 至少一项，format 默认 zip', () => {
    expect(CreateExportRequestSchema.safeParse({ parts: [] }).success).toBe(false)
    expect(CreateExportRequestSchema.parse({ parts: ['workspace'] }).format).toBe('zip')
  })

  it('parseExportParts 忽略未知项与空串', () => {
    expect(parseExportParts('workspace, sessions ,bogus,')).toEqual(['workspace', 'sessions'])
  })
})

describe('公共类型与工具', () => {
  it('UserPublic 要求 ISO 时间与合法 slug', () => {
    const base = {
      id: 1,
      slug: 'u7k2m9xz',
      username: 'alice',
      displayName: '',
      bio: '',
      avatarUrl: null,
      role: 'user',
      status: 'active',
      mustChangePassword: false,
      createdAt: '2026-10-12T13:00:00.000Z',
      lastLoginAt: null,
      usernameChangedAt: null,
    }
    expect(UserPublicSchema.safeParse(base).success).toBe(true)
    expect(UserPublicSchema.safeParse({ ...base, slug: 'alice' }).success).toBe(false)
    expect(UserPublicSchema.safeParse({ ...base, createdAt: '2026-10-12 13:00' }).success).toBe(false)
  })

  it('pagedOf 生成分页包', () => {
    const schema = pagedOf(UserPublicSchema)
    const res = schema.safeParse({ items: [], total: 0, page: 1, pageSize: 20 })
    expect(res.success).toBe(true)
    expect(schema.safeParse({ items: [], total: 0 }).success).toBe(false)
  })

  it('保留字判断忽略大小写', () => {
    expect(isReservedUsername('Admin')).toBe(true)
    expect(isReservedUsername('alice')).toBe(false)
  })

  it('提供方密钥 env 名（05 §4）', () => {
    expect(providerKeyEnvName('hub-relay')).toBe('HUB_MK_HUB_RELAY')
  })
})
