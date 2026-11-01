import { describe, expect, it } from 'vitest'

import { detectLandingPlatform } from '@/utils/landing-platform'

/**
 * 公开主页默认模式（WP42）：云上模式是主推，默认永远落云上；
 * `?platform=cloud|desktop|android` 可强制指定，非法值回落默认。
 */
describe('detectLandingPlatform（WP42）', () => {
  it('没有 query 时默认云上模式', () => {
    expect(detectLandingPlatform('')).toBe('cloud')
    expect(detectLandingPlatform('?foo=1')).toBe('cloud')
  })

  it('?platform= 支持三种模式', () => {
    expect(detectLandingPlatform('?platform=cloud')).toBe('cloud')
    expect(detectLandingPlatform('?platform=desktop')).toBe('desktop')
    expect(detectLandingPlatform('?platform=android')).toBe('android')
  })

  it('非法值回落云上模式', () => {
    expect(detectLandingPlatform('?platform=windows')).toBe('cloud')
    expect(detectLandingPlatform('?platform=')).toBe('cloud')
    expect(detectLandingPlatform('?platform=CLOUD')).toBe('cloud')
  })
})
