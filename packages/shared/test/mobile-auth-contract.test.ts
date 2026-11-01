import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  MOBILE_ACCESS_TOKEN_PREFIX,
  MOBILE_ACCESS_TTL_MS,
  MOBILE_AUTH_ERROR_CODES,
  MOBILE_BOOTSTRAP_PATH,
  MOBILE_LOGIN_PATH,
  MOBILE_MAX_DEVICES_PER_USER,
  MOBILE_REFRESH_TOKEN_PREFIX,
  MOBILE_REFRESH_TTL_DAYS,
  MOBILE_TICKET_TTL_MS,
  MOBILE_WAKE_ERROR_CODES,
  MOBILE_WAKE_PATH,
  MobileAppPlatformSchema,
  MobileAuthTokensSchema,
  DesktopDeviceSchema,
  MobileBootstrapResponseSchema,
  MobileLoginRequestSchema,
  MobileRefreshRequestSchema,
  MobileTicketResponseSchema,
  MobileWakeResponseSchema,
  SettingsSchema,
  deviceKindOf,
} from '../src/index.js'

/**
 * WP40a：手机 App 认证与 bootstrap 的契约自检（`v2/契约草案-认证与bootstrap.md`）。
 *
 * 这些断言是 App 侧（A1）与 Hub 侧的共同底线：字段名、前缀、有效期、
 * 错误码名字只要有一边改了，这里先红。
 */

const ACCESS = `${MOBILE_ACCESS_TOKEN_PREFIX}${'a'.repeat(40)}`
const REFRESH = `${MOBILE_REFRESH_TOKEN_PREFIX}${'b'.repeat(40)}`

const TOKENS = {
  accessToken: ACCESS,
  accessExpiresAt: '2026-10-25T20:00:00.000Z',
  refreshToken: REFRESH,
  refreshExpiresAt: '2026-12-24T19:00:00.000Z',
  deviceId: `dv_${'1'.repeat(32)}`,
  user: { id: 7, username: 'alice', displayName: '小桃' },
}

describe('设备令牌前缀与有效期（契约 §1）', () => {
  it('前缀固定，且 access 与 refresh 互不误认', () => {
    expect(MOBILE_ACCESS_TOKEN_PREFIX).toBe('dshm_at_')
    expect(MOBILE_REFRESH_TOKEN_PREFIX).toBe('dshm_rt_')
    // 桌面端令牌不会被当成手机令牌
    expect(ACCESS.startsWith('dsh_dev_')).toBe(false)
    expect(REFRESH.startsWith(MOBILE_ACCESS_TOKEN_PREFIX)).toBe(false)
  })

  it('access 1 小时 / refresh 60 天 / ticket 30 秒', () => {
    expect(MOBILE_ACCESS_TTL_MS).toBe(3_600_000)
    expect(MOBILE_REFRESH_TTL_DAYS).toBe(60)
    expect(MOBILE_TICKET_TTL_MS).toBe(30_000)
    expect(MOBILE_MAX_DEVICES_PER_USER).toBe(10)
  })

  it('接口路径与文档一致', () => {
    expect(MOBILE_LOGIN_PATH).toBe('/api/mobile/auth/login')
    expect(MOBILE_BOOTSTRAP_PATH).toBe('/api/mobile/bootstrap')
    expect(MOBILE_WAKE_PATH).toBe('/api/mobile/instance/wake')
  })
})

describe('登录 / 刷新请求', () => {
  it('login 请求：四个字段，平台只有 android/ios', () => {
    const input = { username: 'Alice', password: 'Pass-1234', deviceName: 'Pixel 8', platform: 'android' }
    expect(MobileLoginRequestSchema.parse(input)).toMatchObject({ deviceName: 'Pixel 8' })
    expect(MobileAppPlatformSchema.safeParse('windows').success).toBe(false)
    // strictObject：未知字段直接拒（防协议漂移）
    expect(MobileLoginRequestSchema.safeParse({ ...input, extra: 1 }).success).toBe(false)
    // 设备名沿用桌面端规则（≤64、禁路径分隔符）
    expect(
      MobileLoginRequestSchema.safeParse({ ...input, deviceName: 'a/b' }).success,
    ).toBe(false)
    expect(MobileLoginRequestSchema.safeParse({ ...input, deviceName: '' }).success).toBe(false)
  })

  it('refresh 请求只收 refreshToken，格式不对拒掉', () => {
    expect(MobileRefreshRequestSchema.safeParse({ refreshToken: REFRESH }).success).toBe(true)
    expect(MobileRefreshRequestSchema.safeParse({ refreshToken: ACCESS }).success).toBe(false)
    expect(MobileRefreshRequestSchema.safeParse({}).success).toBe(false)
  })

  it('login/refresh 响应同形（MobileAuthTokensSchema）', () => {
    const parsed = MobileAuthTokensSchema.parse(TOKENS)
    expect(parsed.user.username).toBe('alice')
    expect(parsed.deviceId).toMatch(/^dv_/)
    // 令牌前缀写进 schema：服务端不会意外下发别的形状
    expect(MobileAuthTokensSchema.safeParse({ ...TOKENS, accessToken: `dsh_dev_${'x'.repeat(40)}` }).success).toBe(
      false,
    )
  })
})

describe('bootstrap / wake / ticket 响应', () => {
  const BOOTSTRAP = {
    user: { id: 7, username: 'alice', displayName: '小桃' },
    points: { balance: 123.45, enabled: true },
    backends: [
      {
        id: 'cloud:self',
        kind: 'cloud',
        name: '云实例',
        status: 'absent',
        connectable: false,
        reason: 'instance-not-running',
      },
    ],
    instance: { status: 'absent', capacityFull: false },
    app: { minVersionCode: 1, latestVersionCode: 1, downloadUrl: null },
    serverTime: '2026-10-25T19:00:00.000Z',
  }

  it('bootstrap 解析通过，且字段集合就是契约里那 6 个', () => {
    const parsed = MobileBootstrapResponseSchema.parse(BOOTSTRAP)
    expect(Object.keys(parsed).sort()).toEqual(['app', 'backends', 'instance', 'points', 'serverTime', 'user'])
    expect(parsed.points).toEqual({ balance: 123.45, enabled: true })
    expect(MobileBootstrapResponseSchema.safeParse({ ...BOOTSTRAP, serverTime: '2026-10-25 19:00' }).success).toBe(
      false,
    )
  })

  it('wake 只回 status（202）；错误码白名单按契约', () => {
    expect(MobileWakeResponseSchema.parse({ status: 'starting' })).toEqual({ status: 'starting' })
    expect(MobileWakeResponseSchema.safeParse({ status: 'nope' }).success).toBe(false)
    expect(MOBILE_WAKE_ERROR_CODES).toEqual(
      expect.arrayContaining([
        'CAPACITY_FULL',
        'INSUFFICIENT_POINTS',
        'INSTANCE_ABSENT',
        // 上线决定 ①：首次唤醒自动开通失败要能被 App 识别
        'INSTANCE_PROVISION_FAILED',
      ]),
    )
  })

  it('ticket 响应：ticket + ISO 到期时间', () => {
    const parsed = MobileTicketResponseSchema.parse({
      ticket: 't'.repeat(32),
      expiresAt: '2026-10-25T19:00:30.000Z',
    })
    expect(parsed.ticket).toHaveLength(32)
    expect(MobileTicketResponseSchema.safeParse({ ticket: 'short', expiresAt: '2026-10-25T19:00:30.000Z' }).success).toBe(
      false,
    )
  })

  it('App 侧要分支的错误码都在（契约 §1）', () => {
    expect(MOBILE_AUTH_ERROR_CODES).toEqual(
      expect.arrayContaining([
        'INVALID_CREDENTIALS',
        'USER_DISABLED',
        'USER_PENDING',
        'MUST_CHANGE_PASSWORD',
        'RATE_LIMITED',
      ]),
    )
  })
})

describe('settings.mobile.app（管理端可配的版本地板）', () => {
  it('默认 1 / 1 / null（不拦任何版本）', () => {
    expect(DEFAULT_SETTINGS.mobile).toEqual({
      app: { minVersionCode: 1, latestVersionCode: 1, downloadUrl: null },
    })
    expect(SettingsSchema.parse(DEFAULT_SETTINGS).mobile.app.latestVersionCode).toBe(1)
  })

  it('下载地址必须是 URL；versionCode 必须是正整数', () => {
    const bad = { app: { minVersionCode: 1, latestVersionCode: 2, downloadUrl: 'nope' } }
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, mobile: bad }).success).toBe(false)
    const ok = { app: { minVersionCode: 3, latestVersionCode: 9, downloadUrl: 'https://hub.example.com:8123/a.apk' } }
    expect(SettingsSchema.parse({ ...DEFAULT_SETTINGS, mobile: ok }).mobile.app.downloadUrl).toBe(
      'https://hub.example.com:8123/a.apk',
    )
  })
})

describe('设备台账：手机与桌面端共用一套 DTO', () => {
  const base = {
    deviceId: `dv_${'2'.repeat(32)}`,
    name: 'Pixel 8',
    platform: null,
    osMajor: null,
    arch: null,
    appVersion: null,
    appChannel: null,
    runtimeVersion: null,
    capabilities: null,
    appliedRevision: null,
    desiredRevision: null,
    appliedAt: null,
    applyState: 'unknown' as const,
    applyErrorCode: null,
    errorCount: null,
    presence: 'online' as const,
    firstSeenAt: '2026-10-25T19:00:00.000Z',
    registeredAt: '2026-10-25T19:00:00.000Z',
    lastReportAt: '2026-10-25T19:00:00.000Z',
    lastAuthAt: '2026-10-25T19:00:00.000Z',
    revokedAt: null,
    revokeReason: null,
    createdAt: '2026-10-25T19:00:00.000Z',
  }

  it('kind/mobilePlatform 可选：老 Hub 的响应按桌面端读', () => {
    expect(deviceKindOf(DesktopDeviceSchema.parse(base))).toBe('desktop')
    const mobile = DesktopDeviceSchema.parse({ ...base, kind: 'mobile', mobilePlatform: 'ios' })
    expect(deviceKindOf(mobile)).toBe('mobile')
    expect(mobile.mobilePlatform).toBe('ios')
  })
})
