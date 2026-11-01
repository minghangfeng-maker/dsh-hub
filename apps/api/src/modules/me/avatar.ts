import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Hex } from '../../lib/crypto.js'
import { HubError } from '../../lib/errors.js'
import { resolveInside } from '../../lib/paths.js'

/**
 * 头像文件（02 §T12：只收 png/jpeg/webp、校验魔数、≤1MB、固定 Content-Type 回送）。
 *
 * 文件名 `<userId>-<sha256前12>.<ext>`（03 §2），扩展名**由魔数决定**而不是上传者的文件名，
 * 这样 `.html` 改名成 `.png` 也只会被当成图片内容存下来或被拒。
 */

export type AvatarFormat = 'png' | 'jpg' | 'webp'

export interface AvatarImage {
  format: AvatarFormat
  mime: string
}

/** 头像文件名（含哈希，可以放心长缓存） */
export const AVATAR_FILE_REGEX = /^\d{1,12}-[a-f0-9]{12}\.(png|jpg|webp)$/

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff])

/** 魔数嗅探；不认识就返回 null（调用方抛 UNSUPPORTED_MEDIA） */
export function sniffImage(data: Buffer): AvatarImage | null {
  if (data.length >= PNG_SIGNATURE.length && data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { format: 'png', mime: 'image/png' }
  }
  if (data.length >= JPEG_SIGNATURE.length && data.subarray(0, 3).equals(JPEG_SIGNATURE)) {
    return { format: 'jpg', mime: 'image/jpeg' }
  }
  // WebP：RIFF....WEBP
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return { format: 'webp', mime: 'image/webp' }
  }
  return null
}

export function avatarFileName(userId: number, data: Buffer, format: AvatarFormat): string {
  return `${userId}-${sha256Hex(data).slice(0, 12)}.${format}`
}

/** 落盘（目录 0700，文件只给属主读写） */
export function writeAvatar(dir: string, fileName: string, data: Buffer): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, fileName), data, { mode: 0o600 })
}

/** 删除旧头像；文件不存在/删不掉都不该影响本次上传 */
export function removeAvatar(dir: string, fileName: string | null | undefined): void {
  if (!fileName || !AVATAR_FILE_REGEX.test(fileName)) return
  try {
    rmSync(join(dir, fileName), { force: true })
  } catch {
    // 已经是别人的/不在了：忽略
  }
}

/** `GET /api/avatars/:file` 的路径解析：只允许 `<id>-<hash>.<ext>`，且必须落在 avatars/ 内 */
export function resolveAvatarFile(dir: string, file: string): string {
  if (!AVATAR_FILE_REGEX.test(file)) throw new HubError('NOT_FOUND')
  return resolveInside(dir, file)
}

export function avatarMime(file: string): string {
  if (file.endsWith('.png')) return 'image/png'
  if (file.endsWith('.webp')) return 'image/webp'
  return 'image/jpeg'
}
