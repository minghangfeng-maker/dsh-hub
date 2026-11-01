/**
 * 头像裁剪的纯计算部分（07 §6.2：512×512 webp，质量 .9，超 1MB 降质量重试）。
 *
 * 抽出来单独放，是为了让「输出尺寸 / 缩放与偏移的边界 / 降质量重试」这些参数逻辑
 * 不依赖 canvas 就能测（任务书「测试」节：jsdom 里跳过像素断言，只测参数计算函数）。
 */

/** 输出边长（07 §6.2：512×512） */
export const AVATAR_OUTPUT_SIZE = 512

/** 服务端限制（04 §3：≤ 1MB） */
export const AVATAR_MAX_BYTES = 1024 * 1024

/** 允许的输入类型（04 §3：png/jpeg/webp） */
export const AVATAR_ACCEPT = 'image/png,image/jpeg,image/webp'

const SUPPORTED_TYPES = ['image/png', 'image/jpeg', 'image/webp']

/** 缩放档位：1 = 刚好铺满裁剪框，4 = 放到 4 倍 */
export const AVATAR_MIN_SCALE = 1
export const AVATAR_MAX_SCALE = 4

/** 输出质量（07 §6.2：质量 .9） */
export const AVATAR_DEFAULT_QUALITY = 0.9

/** 降质量重试的档位（首档 .9；都试完还超 1MB 就放弃并提示） */
export const AVATAR_QUALITY_LADDER = [AVATAR_DEFAULT_QUALITY, 0.82, 0.74, 0.66, 0.58, 0.5] as const

export interface Size {
  width: number
  height: number
}

export interface CropTransform {
  /** 相对「铺满」的缩放倍数（1–4） */
  scale: number
  /** 图片中心相对裁剪框中心的偏移（显示像素） */
  offsetX: number
  offsetY: number
}

export const IDENTITY_TRANSFORM: CropTransform = { scale: 1, offsetX: 0, offsetY: 0 }

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** 输入类型是否是服务端接受的（伪装扩展名的文件由服务端再拦一次） */
export function isSupportedAvatarType(type: string): boolean {
  return SUPPORTED_TYPES.includes(type)
}

/** 选文件后的就地校验：返回中文错误，`null` = 通过。 */
export function validateAvatarFile(file: { type: string; size: number } | null): string | null {
  if (!file) return '没有选择文件'
  if (!isSupportedAvatarType(file.type)) return '只支持 PNG / JPEG / WebP 图片'
  if (file.size <= 0) return '这个文件是空的，换一张试试'
  // 原图可以比 1MB 大一点（裁剪后会变小），但不能离谱
  if (file.size > 12 * AVATAR_MAX_BYTES) return '图片太大了，先压缩一下再上传'
  return null
}

/** 「铺满裁剪框」所需的最小缩放：短边贴合。 */
export function coverScale(image: Size, frame: number): number {
  if (image.width <= 0 || image.height <= 0 || frame <= 0) return 1
  return Math.max(frame / image.width, frame / image.height)
}

export function clampScale(scale: number): number {
  return clamp(scale, AVATAR_MIN_SCALE, AVATAR_MAX_SCALE)
}

/** 图片在裁剪框里的显示尺寸（像素）。 */
export function displaySize(image: Size, transform: CropTransform, frame: number): Size {
  const base = coverScale(image, frame)
  const ratio = base * clampScale(transform.scale)
  return { width: image.width * ratio, height: image.height * ratio }
}

/** 平移边界：图片不能小于裁剪框，因此偏移最多到「多出来的那一半」。 */
export function clampOffset(
  transform: CropTransform,
  display: Size,
  frame: number,
): { offsetX: number; offsetY: number } {
  const maxX = Math.max(0, (display.width - frame) / 2)
  const maxY = Math.max(0, (display.height - frame) / 2)
  return {
    offsetX: clamp(transform.offsetX, -maxX, maxX),
    offsetY: clamp(transform.offsetY, -maxY, maxY),
  }
}

/** 规范化变换：缩放进档位、偏移收进边界。 */
export function normalizeTransform(image: Size, transform: CropTransform, frame: number): CropTransform {
  const scale = clampScale(transform.scale)
  const display = displaySize(image, { ...transform, scale }, frame)
  const { offsetX, offsetY } = clampOffset({ ...transform, scale }, display, frame)
  return { scale, offsetX, offsetY }
}

/**
 * 源图上的裁剪矩形（给 `ctx.drawImage(img, sx, sy, sw, sh, 0, 0, 512, 512)` 用）。
 * 永远是正方形，所以输出必然是 512×512。
 */
export function sourceRect(
  image: Size,
  transform: CropTransform,
  frame: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const normalized = normalizeTransform(image, transform, frame)
  const display = displaySize(image, normalized, frame)
  const ratio = image.width / display.width

  const size = frame * ratio
  const sx = clamp((image.width - size) / 2 - normalized.offsetX * ratio, 0, Math.max(0, image.width - size))
  const sy = clamp(
    (image.height - size) / 2 - normalized.offsetY * ratio,
    0,
    Math.max(0, image.height - size),
  )

  return { sx, sy, sw: size, sh: size }
}

/** 滚轮/滑块：把缩放倍数推广到下一个边界值。 */
export function zoomBy(scale: number, delta: number): number {
  return clampScale(Number((scale * (1 + delta)).toFixed(4)))
}

/** 当前质量之后的下一个档位（没有更低的就返回 null）。 */
export function nextQuality(current: number): number | null {
  const index = (AVATAR_QUALITY_LADDER as readonly number[]).indexOf(current)
  const next = index < 0 ? AVATAR_QUALITY_LADDER[1] : AVATAR_QUALITY_LADDER[index + 1]
  return next ?? null
}

/** 超过 1MB 就要降质量重试（04 §3）。 */
export function shouldRetryQuality(bytes: number, maxBytes = AVATAR_MAX_BYTES): boolean {
  return bytes > maxBytes
}

/** 输出尺寸（固定 512×512；写出来是为了让测试有个明确的断言点）。 */
export function outputSize(output = AVATAR_OUTPUT_SIZE): Size {
  return { width: output, height: output }
}

/**
 * 上传文件名：默认 `.webp`（07 §6.2 的输出格式）。
 * 浏览器不支持 webp 编码时 `toBlob` 会给回 png，这时扩展名跟着实际 MIME 走
 * （服务端按 MIME 校验，扩展名只是给人看的）。
 */
export function avatarFileName(username: string, mimeType = 'image/webp'): string {
  const safe = username.replace(/[^a-z0-9_-]/gi, '') || 'avatar'
  const extension = mimeType.includes('png')
    ? 'png'
    : mimeType.includes('jpeg') || mimeType.includes('jpg')
      ? 'jpg'
      : 'webp'
  return `${safe}-avatar.${extension}`
}
