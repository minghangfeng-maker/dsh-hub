import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { AES_KEY_BYTES } from './crypto.js'
import { HubError } from './errors.js'

/** 目录 0700、文件 0600（02 §6）；只在创建时设 mode，已存在则显式 chmod 兜底 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700)
  } catch {
    // 某些文件系统（如挂载的 Windows 盘）不支持 chmod，忽略
  }
}

function writePrivateFile(file: string, content: string): void {
  writeFileSync(file, content, { mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    // 同上
  }
}

/**
 * 主密钥：`HUB_DATA_DIR/secrets/master.key`，不存在则生成。
 * 文件里存 **32 字节随机的 base64**（44 字符），消费方一律用本函数拿 `Buffer`。
 */
export function loadOrCreateMasterKey(file: string): Buffer {
  ensurePrivateDir(dirname(file))
  if (!existsSync(file)) {
    writePrivateFile(file, randomBytes(AES_KEY_BYTES).toString('base64'))
  }
  return readMasterKey(file)
}

/** 只读方式取主密钥；不存在返回 null（用于「还没初始化」的场景） */
export function loadMasterKeyIfExists(file: string): Buffer | null {
  if (!existsSync(file)) return null
  return readMasterKey(file)
}

function readMasterKey(file: string): Buffer {
  const raw = readFileSync(file, 'utf8').trim()
  const key = Buffer.from(raw, 'base64')
  if (key.length !== AES_KEY_BYTES) {
    throw new HubError('INTERNAL', `主密钥文件损坏（应为 ${AES_KEY_BYTES} 字节 base64）：${file}`)
  }
  return key
}
