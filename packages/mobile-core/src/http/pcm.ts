/**
 * 流式朗读的 PCM 字节处理（0.4.6 / WP51）。
 *
 * HTTP 分块传输**不保证**按样本边界切：一个 `Uint8Array` chunk 可能是奇数长度，下一个
 * chunk 的第一个字节才是这个样本的低位。直接把每块当成 `Int16Array` 会得到「半个样本」，
 * 播放出来是持续的噪声/爆音（0.4.6 真机前的关键细节）。
 *
 * `alignPcm16` 把相邻两块拼成一个完整样本再交出：内部最多留存 **1 个字节**，末尾多出来的
 * 半个样本（流在样本中间断掉）直接丢弃——它本来就不是一段完整的声音。
 */

/** 16bit 单声道一个样本的字节数。 */
export const PCM16_BYTES = 2

/**
 * 把任意切分的 PCM16 字节块重新对齐成偶数字节的块。
 *
 * - 奇数尾字节会留到下一块的开头（跨块拼接），不会丢；
 * - 空块跳过；
 * - 流结束时若还剩 1 个字节，丢弃（不完整样本）。
 */
export async function* alignPcm16(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array, void, void> {
  let carry: Uint8Array | null = null
  for await (const chunk of chunks) {
    if (chunk.byteLength === 0) continue
    let bytes = chunk
    if (carry !== null) {
      const merged = new Uint8Array(carry.byteLength + chunk.byteLength)
      merged.set(carry, 0)
      merged.set(chunk, carry.byteLength)
      bytes = merged
      carry = null
    }
    const usable = bytes.byteLength - (bytes.byteLength % PCM16_BYTES)
    if (usable === 0) {
      carry = bytes
      continue
    }
    if (usable < bytes.byteLength) {
      // 尾字节留到下一块（copy 出来：底层 buffer 可能被复用）
      carry = bytes.slice(usable)
    }
    yield usable === bytes.byteLength ? bytes : bytes.subarray(0, usable)
  }
  // carry 里只剩半个样本：结束时不交出去
}

/** 把多块字节拼成一整块（缓存一段完整 PCM 时用）。 */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
