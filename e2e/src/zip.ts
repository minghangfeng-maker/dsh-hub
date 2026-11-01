import { inflateRawSync } from 'node:zlib'

/**
 * 极简 ZIP 读取器（只读中心目录，不解压外的东西）。
 *
 * J6 要校验导出包的内容与排除清单，而项目里**没有也不打算引入** zip 依赖
 * （WP4 的测试也是自写读取器）。支持 stored(0)/deflate(8) 两种方法，
 * 够覆盖 `archiver` 产出的包；ZIP64 只在超大导出里才会出现，这里显式报错而不是静默出错。
 */

export interface ZipEntry {
  name: string
  /** 目录条目（名字以 / 结尾且大小为 0） */
  directory: boolean
  /** 符号链接条目（外部属性里的 unix mode 高 16 位 = 0o120000） */
  symlink: boolean
  size: number
  compressedSize: number
  method: number
  data: Buffer
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const ZIP64_EOCD_LOCATOR = 0x07064b50

function findEocd(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - 22 - 65_535)
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  throw new Error('不是合法的 ZIP：找不到 EOCD 记录')
}

export function readZip(buffer: Buffer): ZipEntry[] {
  const eocd = findEocd(buffer)
  const entries = buffer.readUInt16LE(eocd + 10)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (buffer.readUInt32LE(eocd - 20) === ZIP64_EOCD_LOCATOR) {
    throw new Error('暂不支持 ZIP64 导出包（>4GB），请缩小导出范围后再跑 J6')
  }

  const result: ZipEntry[] = []
  let offset = centralOffset
  for (let index = 0; index < entries; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error(`ZIP 中心目录第 ${String(index)} 条签名不对（offset ${String(offset)}）`)
    }
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const size = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const externalAttrs = buffer.readUInt32LE(offset + 38)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)

    if ((flags & 0x1) === 0x1) throw new Error(`ZIP 条目 ${name} 是加密的，读不了`)

    // 本地头的 extra 长度可能与中心目录不同，必须按本地头重新算数据起点
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`ZIP 条目 ${name} 的本地头签名不对`)
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null
    if (data === null) throw new Error(`ZIP 条目 ${name} 用了不支持的方法 ${String(method)}`)
    if (size !== 0 && data.length !== size) {
      throw new Error(`ZIP 条目 ${name} 解压后大小不符：期望 ${String(size)}，实际 ${String(data.length)}`)
    }

    result.push({
      name,
      directory: name.endsWith('/'),
      symlink: (externalAttrs >>> 16) === 0o120000,
      size,
      compressedSize,
      method,
      data,
    })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return result
}

/** 按后缀找条目（导出包顶层目录带用户名与时间，测试不关心它） */
export function findBySuffix(entries: ZipEntry[], suffix: string): ZipEntry[] {
  return entries.filter((entry) => entry.name.endsWith(suffix))
}

export function hasSuffix(entries: ZipEntry[], suffix: string): boolean {
  return findBySuffix(entries, suffix).length > 0
}
