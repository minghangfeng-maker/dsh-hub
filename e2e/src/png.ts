import { inflateSync } from 'node:zlib'

/**
 * 极简 PNG 读取器（只做 e2e 像素断言要的那点事）。
 *
 * 为什么不引第三方库：整个仓库的 e2e 依赖只有 `playwright-core`，为了一次「取中位色」加一个
 * 图片解码库不划算。这里只支持 Playwright 截图会产出的形态：8 位、非隔行、`colorType` 2（RGB）
 * 或 6（RGBA），并实现 PNG 的五种行过滤器。遇到别的形态直接返回 null（调用方会记 skip）。
 *
 * 另外**不走浏览器解码**：页面的 CSP `connect-src 'self'` 会拦住 `fetch(data:…)`，
 * 早一版在页面里用 `fetch` + `createImageBitmap` 就是这么失败的（拿不到像素还看不出原因）。
 */
export interface RgbaImage {
  width: number
  height: number
  /** 每像素 4 字节（RGBA） */
  data: Buffer
}

/** 解码 PNG；不支持的形态返回 null */
export function decodePng(buffer: Buffer): RgbaImage | null {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) return null
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat: Buffer[] = []
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const start = offset + 8
    const end = start + length
    if (end + 4 > buffer.length) return null
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(start)
      height = buffer.readUInt32BE(start + 4)
      const bitDepth = buffer[start + 8]
      colorType = buffer[start + 9] ?? 0
      const interlace = buffer[start + 12]
      if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) return null
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(start, end))
    } else if (type === 'IEND') {
      break
    }
    offset = end + 4
  }
  if (width === 0 || height === 0 || idat.length === 0) return null

  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(idat))
  } catch {
    return null
  }
  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  if (raw.length < (stride + 1) * height) return null

  const out = Buffer.alloc(width * height * 4)
  const previous = Buffer.alloc(stride)
  const current = Buffer.alloc(stride)
  for (let row = 0; row < height; row += 1) {
    const base = row * (stride + 1)
    const filter = raw[base] ?? 0
    raw.copy(current, 0, base + 1, base + 1 + stride)
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? current[index - channels]! : 0
      const up = previous[index] ?? 0
      const upLeft = index >= channels ? previous[index - channels]! : 0
      let value = current[index]!
      switch (filter) {
        case 0:
          break
        case 1:
          value = (value + left) & 0xff
          break
        case 2:
          value = (value + up) & 0xff
          break
        case 3:
          value = (value + ((left + up) >> 1)) & 0xff
          break
        case 4: {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
          value = (value + predictor) & 0xff
          break
        }
        default:
          return null
      }
      current[index] = value
    }
    for (let x = 0; x < width; x += 1) {
      const source = x * channels
      const target = (row * width + x) * 4
      out[target] = current[source]!
      out[target + 1] = current[source + 1]!
      out[target + 2] = current[source + 2]!
      out[target + 3] = channels === 4 ? current[source + 3]! : 255
    }
    current.copy(previous)
  }
  return { width, height, data: out }
}

/** 一张图的中位色（按通道取中位数，能剔除文字/边框这种少量像素） */
export function medianColor(image: RgbaImage): { r: number; g: number; b: number } {
  const reds: number[] = []
  const greens: number[] = []
  const blues: number[] = []
  for (let index = 0; index < image.data.length; index += 4) {
    reds.push(image.data[index]!)
    greens.push(image.data[index + 1]!)
    blues.push(image.data[index + 2]!)
  }
  const median = (values: number[]): number => {
    values.sort((left, right) => left - right)
    return values[Math.floor(values.length / 2)] ?? 0
  }
  return { r: median(reds), g: median(greens), b: median(blues) }
}
