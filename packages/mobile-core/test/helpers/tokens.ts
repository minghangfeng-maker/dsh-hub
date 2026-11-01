import type { AuthTokens } from '../../src/contracts/auth-bootstrap.js'

export const NOW = Date.parse('2026-10-25T12:00:00.000Z')

export function makeTokens(overrides: Partial<AuthTokens> = {}): AuthTokens {
  return {
    accessToken: `dshm_at_${'a'.repeat(40)}`,
    accessExpiresAt: new Date(NOW + 3_600_000).toISOString(),
    refreshToken: `dshm_rt_${'b'.repeat(40)}`,
    refreshExpiresAt: new Date(NOW + 60 * 86_400_000).toISOString(),
    deviceId: `dv_${'0'.repeat(32)}`,
    user: { id: 1, username: 'demo', displayName: 'demo' },
    ...overrides,
  }
}
