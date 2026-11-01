/**
 * `workspaceFiles/readBytes` 的响应是 **multipart/form-data**，不是 JSON
 * （实测：字节在名为 `bytes-0` 的部分里，`metadata` 部分才是 JSON 信封，
 * `value.data` 是 `null` + `attachments:[{path:['data'],codec:'bytes',part:'bytes-0'}]`）。
 *
 * 所以 Hub **不能** `JSON.parse` 整包；这里做一个只处理 `Buffer` 的最小解析器
 * （按字节找分隔符，避免把二进制内容当文本处理坏）。
 */

export interface MultipartPart {
  name: string | null
  filename: string | null
  contentType: string | null
  data: Buffer
}

/** 从 `content-type` 里取 boundary；没有就返回 null。 */
export function boundaryOf(contentType: string): string | null {
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/iu.exec(contentType)
  const boundary = match?.[1] ?? match?.[2] ?? null
  return boundary === null || boundary === '' ? null : boundary
}

function headerValue(headerBlock: string, key: string): string | null {
  for (const line of headerBlock.split('\r\n')) {
    const index = line.indexOf(':')
    if (index < 0) continue
    if (line.slice(0, index).trim().toLowerCase() !== key) continue
    return line.slice(index + 1).trim()
  }
  return null
}

function dispositionParam(header: string | null, key: string): string | null {
  if (header === null) return null
  const match =
    new RegExp(`${key}="([^"]*)"`, 'iu').exec(header) ?? new RegExp(`${key}=([^;\\s]+)`, 'iu').exec(header)
  return match?.[1] ?? null
}

/**
 * 解析 multipart 响应体。
 *
 * 只实现 RFC 7578 的「每个部分有头 + 原始字节」这一子集：不带嵌套 multipart、
 * 不做 transfer-encoding。解析不出来返回 `null`（调用方回 `upstream-unavailable`）。
 */
export function parseMultipart(body: Buffer, contentType: string): MultipartPart[] | null {
  const boundary = boundaryOf(contentType)
  if (boundary === null) return null
  const dash = Buffer.from(`--${boundary}`, 'utf8')
  const headerSeparator = Buffer.from('\r\n\r\n', 'utf8')
  const parts: MultipartPart[] = []
  let cursor = body.indexOf(dash)
  if (cursor < 0) return null
  while (true) {
    cursor += dash.length
    // 结束分隔符 `--boundary--`
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) return parts
    // 分隔符后必须是 CRLF
    if (body[cursor] !== 0x0d || body[cursor + 1] !== 0x0a) return null
    cursor += 2
    const headerEnd = body.indexOf(headerSeparator, cursor)
    if (headerEnd < 0) return null
    const headerBlock = body.subarray(cursor, headerEnd).toString('utf8')
    const dataStart = headerEnd + headerSeparator.length
    const nextBoundary = body.indexOf(Buffer.concat([Buffer.from('\r\n'), dash]), dataStart)
    const dataEnd = nextBoundary < 0 ? body.length : nextBoundary
    parts.push({
      name: dispositionParam(headerValue(headerBlock, 'content-disposition'), 'name'),
      filename: dispositionParam(headerValue(headerBlock, 'content-disposition'), 'filename'),
      contentType: headerValue(headerBlock, 'content-type'),
      data: body.subarray(dataStart, dataEnd),
    })
    if (nextBoundary < 0) return parts
    cursor = nextBoundary + 2
  }
}

export interface ByteReadEnvelope {
  ok: boolean
  value?: {
    absolutePath?: string
    version?: string
    bytes?: number
    offset?: number
    eof?: boolean
    data?: unknown
  }
  error?: { code?: string; message?: string; details?: unknown }
  /** 附件里声明的「字节在哪个 part」。 */
  partName?: string
}

export interface ByteReadResult {
  bytes: Buffer
  absolutePath: string | null
  totalBytes: number | null
  eof: boolean
  envelope: ByteReadEnvelope
}

/**
 * 从 multipart 响应里取出字节与元数据。
 *
 * `attachments[].part` 给出真正的字节 part 名（实测 `bytes-0`），拿不到就退回
 * 「第一个非 metadata、带 filename 的部分」。
 */
export function readByteResponse(body: Buffer, contentType: string): ByteReadResult | null {
  const parts = parseMultipart(body, contentType)
  if (parts === null) return null
  const metadataPart = parts.find((part) => part.name === 'metadata')
  let envelope: ByteReadEnvelope = { ok: false }
  if (metadataPart !== undefined) {
    try {
      const parsed: unknown = JSON.parse(metadataPart.data.toString('utf8'))
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        const result =
          typeof record['result'] === 'object' && record['result'] !== null
            ? (record['result'] as Record<string, unknown>)
            : {}
        const value =
          typeof result['value'] === 'object' && result['value'] !== null
            ? (result['value'] as ByteReadEnvelope['value'])
            : undefined
        const error =
          typeof result['error'] === 'object' && result['error'] !== null
            ? (result['error'] as ByteReadEnvelope['error'])
            : undefined
        const attachments = Array.isArray(record['attachments']) ? record['attachments'] : []
        const attachment =
          typeof attachments[0] === 'object' && attachments[0] !== null
            ? (attachments[0] as Record<string, unknown>)
            : undefined
        envelope = {
          ok: result['ok'] === true,
          ...(value === undefined ? {} : { value }),
          ...(error === undefined ? {} : { error }),
          ...(typeof attachment?.['part'] === 'string' ? { partName: attachment['part'] } : {}),
        }
      }
    } catch {
      return null
    }
  }
  const dataPart =
    (envelope.partName === undefined ? undefined : parts.find((part) => part.name === envelope.partName)) ??
    parts.find(
      (part) =>
        part.name !== 'metadata' &&
        (part.filename !== null || part.contentType === 'application/octet-stream'),
    )
  if (dataPart === undefined) return null
  const value = envelope.value
  return {
    bytes: dataPart.data,
    absolutePath: typeof value?.absolutePath === 'string' ? value.absolutePath : null,
    totalBytes: typeof value?.bytes === 'number' ? value.bytes : null,
    eof: value?.eof === true,
    envelope,
  }
}

/** 单部分 multipart 请求体（上传用；`HostHttp` 只做原始字节 POST，这里自己拼）。 */
export function buildMultipartBody(
  boundary: string,
  part: { name: string; filename?: string; contentType: string; data: Buffer },
): Buffer {
  const head = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="${part.name}"${part.filename === undefined ? '' : `; filename="${part.filename}"`}`,
    `Content-Type: ${part.contentType}`,
    '',
    '',
  ].join('\r\n')
  const tail = `\r\n--${boundary}--\r\n`
  return Buffer.concat([Buffer.from(head, 'utf8'), part.data, Buffer.from(tail, 'utf8')])
}
