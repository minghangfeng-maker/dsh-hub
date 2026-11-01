import { inflateRawSync } from 'node:zlib'

/**
 * 极简 ZIP 读取器（测试用）：解析中央目录、解压每个条目并校验 CRC32 —— 等价于
 * `unzip -t`，但本机没有 unzip 时也能跑（任务书：用 node 解压库或系统 unzip，没有就跳过；
 * 这里不引入新依赖，自己实现最小的校验足够）。
 */
export interface ZipEntry {
  name: string
  /** unix 权限位（含文件类型，0o120000 = 符号链接） */
  mode: number
  size: number
  /** 解压后的内容（已校验 CRC32） */
  data: Buffer
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[i] = value >>> 0
  }
  return table
})()

export function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function readZip(buffer: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer)
  const entryCount = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []

  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`中央目录条目 ${i} 签名不正确`)
    }
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const expectedCrc = buffer.readUInt32LE(offset + 16)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const externalAttributes = buffer.readUInt32LE(offset + 38)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    offset += 46 + nameLength + extraLength + commentLength

    // 流式写法会置 data descriptor 位（0x08）：长度/CRC 以中央目录为准，数据仍紧跟本地头
    void flags
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`条目 ${name} 的本地头签名不正确`)
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw)
    if (uncompressedSize !== data.length) {
      throw new Error(`条目 ${name} 解压后长度与目录不一致`)
    }
    if (crc32(data) !== expectedCrc) {
      throw new Error(`条目 ${name} CRC32 校验失败`)
    }
    entries.push({
      name,
      mode: (externalAttributes >>> 16) & 0xffff,
      size: uncompressedSize,
      data,
    })
  }
  return entries
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i
  }
  throw new Error('不是合法的 ZIP：找不到中央目录结尾记录')
}
