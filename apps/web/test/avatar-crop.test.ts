import { describe, expect, it } from 'vitest'

import {
  AVATAR_DEFAULT_QUALITY,
  AVATAR_MAX_BYTES,
  AVATAR_MIN_SCALE,
  AVATAR_OUTPUT_SIZE,
  AVATAR_QUALITY_LADDER,
  avatarFileName,
  clampScale,
  coverScale,
  displaySize,
  nextQuality,
  normalizeTransform,
  outputSize,
  shouldRetryQuality,
  sourceRect,
  validateAvatarFile,
  zoomBy,
} from '@/utils/avatar-crop'

/**
 * 头像裁剪器的参数计算（07 §6.2：512×512 webp、质量 .9、超 1MB 降质量重试）。
 *
 * 任务书允许跳过像素断言（jsdom 没有真实 canvas），所以这里只测纯函数：
 * 输出尺寸、缩放/偏移边界、源图裁剪矩形，以及降质量重试的档位。
 * 画布本身的走查见 WP5b 进度报告里的浏览器截图。
 */

const LANDSCAPE = { width: 1000, height: 500 }
const PORTRAIT = { width: 400, height: 1200 }
const SQUARE = { width: 800, height: 800 }
const FRAME = 288

describe('头像裁剪参数（utils/avatar-crop.ts）', () => {
  it('输出固定 512×512，默认质量 .9', () => {
    expect(AVATAR_OUTPUT_SIZE).toBe(512)
    expect(outputSize()).toEqual({ width: 512, height: 512 })
    expect(outputSize(256)).toEqual({ width: 256, height: 256 })
    expect(AVATAR_DEFAULT_QUALITY).toBe(0.9)
    expect(AVATAR_QUALITY_LADDER[0]).toBe(0.9)
  })

  it('coverScale：短边铺满裁剪框（scale=1 的基准）', () => {
    expect(coverScale(LANDSCAPE, FRAME)).toBeCloseTo(0.576, 6)
    // 竖图的短边是「宽」：400 → 288
    expect(coverScale(PORTRAIT, FRAME)).toBeCloseTo(0.72, 6)
    expect(coverScale(SQUARE, FRAME)).toBeCloseTo(0.36, 6)
    // 非法输入不除零
    expect(coverScale({ width: 0, height: 0 }, FRAME)).toBe(1)
  })

  it('displaySize：scale=1 时短边正好等于框，长边溢出', () => {
    const size = displaySize(LANDSCAPE, { scale: 1, offsetX: 0, offsetY: 0 }, FRAME)
    expect(size.width).toBeCloseTo(576, 6)
    expect(size.height).toBeCloseTo(288, 6)
  })

  it('clampScale：限制在 1–4 倍', () => {
    expect(clampScale(0.2)).toBe(AVATAR_MIN_SCALE)
    expect(clampScale(9)).toBe(4)
    expect(clampScale(2.5)).toBe(2.5)
  })

  it('zoomBy：滚轮在边界上不会越界', () => {
    expect(zoomBy(1, -0.5)).toBe(1)
    expect(zoomBy(4, 0.5)).toBe(4)
    expect(zoomBy(2, 0.1)).toBeCloseTo(2.2, 6)
  })

  it('normalizeTransform：偏移最多到「多出来的那一半」，不会露出空白', () => {
    const display = displaySize(LANDSCAPE, { scale: 1, offsetX: 0, offsetY: 0 }, FRAME)
    const normalized = normalizeTransform(LANDSCAPE, { scale: 1, offsetX: 9999, offsetY: 9999 }, FRAME)

    expect(normalized.offsetX).toBeCloseTo((display.width - FRAME) / 2, 6)
    expect(normalized.offsetY).toBe(0)
  })

  it('sourceRect：永远是正方形（所以输出必然是 512×512），且落在原图内', () => {
    const rect = sourceRect(LANDSCAPE, { scale: 1, offsetX: 0, offsetY: 0 }, FRAME)

    expect(rect.sw).toBeCloseTo(rect.sh, 6)
    expect(rect.sw).toBeCloseTo(500, 6) // 1000 × (288 / 576)
    expect(rect.sx).toBeCloseTo(250, 6)
    expect(rect.sy).toBeCloseTo(0, 6)
    expect(rect.sx + rect.sw).toBeLessThanOrEqual(LANDSCAPE.width)
    expect(rect.sy + rect.sh).toBeLessThanOrEqual(LANDSCAPE.height)
  })

  it('sourceRect：放大到 2 倍时裁剪窗口更小', () => {
    const rect = sourceRect(LANDSCAPE, { scale: 2, offsetX: 0, offsetY: 0 }, FRAME)

    expect(rect.sw).toBeCloseTo(250, 6)
    expect(rect.sx).toBeCloseTo(375, 6)
    expect(rect.sy).toBeCloseTo(125, 6)
  })

  it('sourceRect：拖到边界也不会越出原图', () => {
    for (const offsetX of [-9999, 0, 9999]) {
      for (const offsetY of [-9999, 0, 9999]) {
        const rect = sourceRect(LANDSCAPE, { scale: 1.7, offsetX, offsetY }, FRAME)
        expect(rect.sx).toBeGreaterThanOrEqual(0)
        expect(rect.sy).toBeGreaterThanOrEqual(0)
        expect(rect.sx + rect.sw).toBeLessThanOrEqual(LANDSCAPE.width + 1e-6)
        expect(rect.sy + rect.sh).toBeLessThanOrEqual(LANDSCAPE.height + 1e-6)
        expect(rect.sw).toBeCloseTo(rect.sh, 6)
      }
    }
  })

  it('竖图与方图也走同一套（cover 基准不同）', () => {
    const portrait = sourceRect(PORTRAIT, { scale: 1, offsetX: 0, offsetY: 0 }, FRAME)
    expect(portrait.sw).toBeCloseTo(portrait.sh, 6)
    expect(portrait.sw).toBeCloseTo(400, 6) // 短边是宽

    const square = sourceRect(SQUARE, { scale: 1, offsetX: 0, offsetY: 0 }, FRAME)
    expect(square.sw).toBeCloseTo(800, 6)
    expect(square.sx).toBe(0)
  })
})

describe('超 1MB 的降质量重试（04 §3 / 07 §6.2）', () => {
  it('shouldRetryQuality：超过 1MB 才重试', () => {
    expect(shouldRetryQuality(AVATAR_MAX_BYTES)).toBe(false)
    expect(shouldRetryQuality(AVATAR_MAX_BYTES + 1)).toBe(true)
    expect(shouldRetryQuality(200 * 1024)).toBe(false)
  })

  it('nextQuality 按档位往下走，最后一档返回 null（放弃并提示）', () => {
    expect(nextQuality(0.9)).toBe(0.82)
    expect(nextQuality(0.82)).toBe(0.74)
    expect(nextQuality(0.5)).toBeNull()
    // 未知档位：从第二档开始，避免原地打转
    expect(nextQuality(0.123)).toBe(AVATAR_QUALITY_LADDER[1])
  })
})

describe('选文件前的就地校验', () => {
  it('只接受 PNG / JPEG / WebP', () => {
    expect(validateAvatarFile({ type: 'image/png', size: 1024 })).toBeNull()
    expect(validateAvatarFile({ type: 'image/jpeg', size: 1024 })).toBeNull()
    expect(validateAvatarFile({ type: 'image/webp', size: 1024 })).toBeNull()
    expect(validateAvatarFile({ type: 'image/gif', size: 1024 })).toContain('PNG')
    expect(validateAvatarFile({ type: 'text/html', size: 1024 })).toContain('PNG')
  })

  it('空文件、超大文件与空选择都有中文提示', () => {
    expect(validateAvatarFile(null)).toBe('没有选择文件')
    expect(validateAvatarFile({ type: 'image/png', size: 0 })).toContain('空的')
    expect(validateAvatarFile({ type: 'image/png', size: 12 * AVATAR_MAX_BYTES + 1 })).toContain('太大')
    // 原图可以比 1MB 大（裁剪后会变小）
    expect(validateAvatarFile({ type: 'image/png', size: 5 * AVATAR_MAX_BYTES })).toBeNull()
  })

  it('上传文件名默认 webp，且去掉不安全字符', () => {
    expect(avatarFileName('littletao')).toBe('littletao-avatar.webp')
    expect(avatarFileName('../../etc/passwd')).toBe('etcpasswd-avatar.webp')
    expect(avatarFileName('中文名')).toBe('avatar-avatar.webp')
  })

  it('浏览器给回 png/jpeg 时扩展名跟着实际 MIME 走', () => {
    expect(avatarFileName('littletao', 'image/png')).toBe('littletao-avatar.png')
    expect(avatarFileName('littletao', 'image/jpeg')).toBe('littletao-avatar.jpg')
    expect(avatarFileName('littletao', 'image/webp')).toBe('littletao-avatar.webp')
  })
})
