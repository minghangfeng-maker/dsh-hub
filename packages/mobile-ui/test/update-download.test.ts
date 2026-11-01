/**
 * 更新包下载引擎（0.3.1）：进度、取消、字节数校验、分块写入顺序。
 *
 * 真机背景：0.3.0 把 APK 地址交给 Chrome 下载，永远停在「已下载 8.52 MB，共 8.52 MB」；
 * 现在改成 WebView 里 fetch 流式读（只有浏览器内核能过阿里云旁路）+ Filesystem 分块写。
 * 这里用假 fetch / 假 sink 覆盖所有失败分支，不需要真机也不需要 @capacitor/filesystem。
 */

import { describe, expect, it } from 'vitest'
import { sha256Hex } from '@dsh-hub/mobile-core'
import {
  createCacheFileSink,
  downloadUpdate,
  downloadUpdateMirrors,
  updateApkPath,
  type FetchLike,
  type FetchLikeResponse,
  type UpdateCacheFs,
  type UpdateFileSink,
  type UpdateProgress,
} from '@/lib/update-download'

// ── 假数据 ──────────────────────────────────────────────────────────────────

function bytesOf(length: number, seed = 0): Uint8Array {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i += 1) out[i] = (seed + i * 7) % 256
  return out
}

/** 测试里不用 Buffer，用 atob 解码（和被测代码的 btoa 对称）。 */
function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

function fakeHeaders(map: Record<string, string>): FetchLikeResponse['headers'] {
  const lower = new Map<string, string>()
  for (const [key, value] of Object.entries(map)) lower.set(key.toLowerCase(), value)
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null }
}

function bodyFromChunks(chunks: Uint8Array[]): FetchLikeResponse['body'] {
  let index = 0
  return {
    getReader: () => ({
      read: async () => {
        if (index >= chunks.length) return { done: true, value: undefined }
        const value = chunks[index]
        index += 1
        return { done: false, value }
      },
    }),
  }
}

function responseOf(
  chunks: Uint8Array[],
  init: { total?: number; contentType?: string; status?: number } = {},
): FetchLikeResponse {
  const headers: Record<string, string> = {}
  if (init.total !== undefined) headers['content-length'] = String(init.total)
  if (init.contentType !== undefined) headers['content-type'] = init.contentType
  const status = init.status ?? 200
  return { ok: status >= 200 && status < 300, status, headers: fakeHeaders(headers), body: bodyFromChunks(chunks) }
}

/** 一直挂着、只在 abort 时失败的 reader —— 模拟「卡住的网络」。 */
function hangingFetch(): FetchLike {
  return async (_input, init) => ({
    ok: true,
    status: 200,
    headers: fakeHeaders({ 'content-length': '100' }),
    body: {
      getReader: () => ({
        read: () =>
          new Promise<{ done: boolean; value?: Uint8Array }>((_resolve, reject) => {
            const signal = init?.signal
            const abort = (): void => reject(new Error('aborted'))
            if (!signal) return
            if (signal.aborted) {
              abort()
              return
            }
            signal.addEventListener('abort', abort, { once: true })
          }),
      }),
    },
  })
}

function recordingSink(options: { failAt?: number } = {}): {
  sink: UpdateFileSink
  calls: string[]
  chunks: Uint8Array[]
  bytes: () => Uint8Array
} {
  const calls: string[] = []
  const chunks: Uint8Array[] = []
  const sink: UpdateFileSink = {
    async reset() {
      calls.push('reset')
    },
    async append(base64: string) {
      calls.push('append')
      if (options.failAt !== undefined && chunks.length === options.failAt) {
        throw new Error('磁盘满了')
      }
      chunks.push(decodeBase64(base64))
    },
  }
  return {
    sink,
    calls,
    chunks,
    bytes: () => {
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
      const out = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.byteLength
      }
      return out
    },
  }
}

// ── 正常路径 ────────────────────────────────────────────────────────────────

describe('downloadUpdate：正常下载', () => {
  it('读完流、按 Content-Length 校验字节数，先 reset 再写', async () => {
    const first = bytesOf(5, 1)
    const second = bytesOf(7, 2)
    const recorder = recordingSink()
    const result = await downloadUpdate({
      url: 'https://cdn.example.com/downloads/mobile-app/x.apk',
      sink: recorder.sink,
      fetchImpl: async () => responseOf([first, second], { total: 12 }),
    })

    expect(result).toEqual({ ok: true, bytes: 12, total: 12 })
    expect(recorder.calls).toEqual(['reset', 'append'])
    expect(Array.from(recorder.bytes())).toEqual([...first, ...second])
  })

  it('进度回调：已下载 / 总量 / 百分比，最后一块是 100%', async () => {
    const events: UpdateProgress[] = []
    const recorder = recordingSink()
    const result = await downloadUpdate({
      url: 'https://x.test/a.apk',
      sink: recorder.sink,
      fetchImpl: async () => responseOf([bytesOf(2), bytesOf(2)], { total: 4 }),
      onProgress: (progress) => events.push({ ...progress }),
      chunkBytes: 1024,
    })

    expect(result.ok).toBe(true)
    expect(events.map((event) => [event.received, event.total, event.percent])).toEqual([
      [0, 4, 0],
      [2, 4, 50],
      [4, 4, 100],
    ])
  })

  it('服务器没给 Content-Length：percent 为 null，但下载照常成功', async () => {
    const events: UpdateProgress[] = []
    const recorder = recordingSink()
    const result = await downloadUpdate({
      url: 'https://x.test/a.apk',
      sink: recorder.sink,
      fetchImpl: async () => responseOf([bytesOf(9)]),
      onProgress: (progress) => events.push({ ...progress }),
    })

    expect(result).toEqual({ ok: true, bytes: 9, total: null })
    expect(events.at(-1)).toEqual({ received: 9, total: null, percent: null })
  })
})

// ── 分块写 ──────────────────────────────────────────────────────────────────

describe('downloadUpdate：分块写', () => {
  it('按 chunkBytes 攒够才写，最后一块余量单独写，顺序与内容都对', async () => {
    const chunks = [bytesOf(3, 1), bytesOf(3, 2), bytesOf(3, 3)]
    const recorder = recordingSink()
    const result = await downloadUpdate({
      url: 'https://x.test/a.apk',
      sink: recorder.sink,
      fetchImpl: async () => responseOf(chunks, { total: 9 }),
      chunkBytes: 4,
    })

    expect(result.ok).toBe(true)
    // 3 + 3 ≥ 4 → 第一块写 6 字节；剩下 3 字节收尾再写一次
    expect(recorder.chunks.map((chunk) => chunk.byteLength)).toEqual([6, 3])
    expect(Array.from(recorder.bytes())).toEqual([...chunks[0]!, ...chunks[1]!, ...chunks[2]!])
  })

  it('空的网络分片被忽略（不会凭空多写一块）', async () => {
    const recorder = recordingSink()
    const result = await downloadUpdate({
      url: 'https://x.test/a.apk',
      sink: recorder.sink,
      fetchImpl: async () => responseOf([new Uint8Array(0), bytesOf(2), new Uint8Array(0)], { total: 2 }),
    })
    expect(result.ok).toBe(true)
    expect(recorder.chunks.map((chunk) => chunk.byteLength)).toEqual([2])
  })
})

// ── 失败分支 ────────────────────────────────────────────────────────────────

describe('downloadUpdate：失败分支', () => {
  it('字节数少于 Content-Length：判失败（不能把半截包交给安装器）', async () => {
    const recorder = recordingSink()
    const result = await downloadUpdate({
      url: 'https://x.test/a.apk',
      sink: recorder.sink,
      fetchImpl: async () => responseOf([bytesOf(6)], { total: 10 }),
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('incomplete')
    expect(result.message).toContain('6/10')
  })

  it('一个字节都没收到：判失败', async () => {
    const result = await downloadUpdate({
      url: 'https://x.test/a.apk',
      sink: recordingSink().sink,
      fetchImpl: async () => responseOf([], { total: 10 }),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('empty')
  })

  it('HTTP 404：判失败并带上状态码，不写文件', async () => {
    const recorder = recordingSink()
    const result = await downloadUpdate({
      url: 'https://x.test/a.apk',
      sink: recorder.sink,
      fetchImpl: async () => responseOf([], { status: 404 }),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('http')
      expect(result.status).toBe(404)
    }
    expect(recorder.chunks).toHaveLength(0)
  })

  it('200 但返回网页（网关错误页）：判失败', async () => {
    const result = await downloadUpdate({
      url: 'https://x.test/a.apk',
      sink: recordingSink().sink,
      fetchImpl: async () =>
        responseOf([bytesOf(20)], { total: 20, contentType: 'text/html; charset=utf-8' }),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('content')
  })

  it('fetch 直接抛错（DNS/连接被 reset）：判网络失败', async () => {
    const result = await downloadUpdate({
      url: 'https://x.test/a.apk',
      sink: recordingSink().sink,
      fetchImpl: async () => {
        throw new Error('net::ERR_CONNECTION_RESET')
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('network')
  })

  it('写文件失败（存储满）：单独判 write，不误报成网络问题', async () => {
    const recorder = recordingSink({ failAt: 0 })
    const result = await downloadUpdate({
      url: 'https://x.test/a.apk',
      sink: recorder.sink,
      fetchImpl: async () => responseOf([bytesOf(4)], { total: 4 }),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('write')
      expect(result.message).toContain('保存安装包失败')
    }
  })
})

// ── 取消 / 超时 ─────────────────────────────────────────────────────────────

describe('downloadUpdate：取消与超时', () => {
  it('用户取消：返回 canceled，不再写任何块', async () => {
    const hanging = hangingFetch()
    const recorder = recordingSink()
    const controller = new AbortController()

    const pending = downloadUpdate({
      url: 'https://x.test/a.apk',
      sink: recorder.sink,
      fetchImpl: hanging,
      signal: controller.signal,
      timeoutMs: 5_000,
    })
    // 让引擎先真正开始读
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort()

    const result = await pending
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('canceled')
    expect(recorder.chunks).toHaveLength(0)
  })

  it('已经取消过的 signal：立刻返回 canceled', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await downloadUpdate({
      url: 'https://x.test/a.apk',
      sink: recordingSink().sink,
      fetchImpl: hangingFetch(),
      signal: controller.signal,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('canceled')
  })

  it('长时间收不到数据：空闲超时判失败（不无限转圈）', async () => {
    const result = await downloadUpdate({
      url: 'https://x.test/a.apk',
      sink: recordingSink().sink,
      fetchImpl: hangingFetch(),
      timeoutMs: 15,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('timeout')
  })
})

// ── Filesystem sink（假实现） ───────────────────────────────────────────────

describe('createCacheFileSink', () => {
  it('reset 递归删旧目录；第一块 writeFile，之后 appendFile', async () => {
    const calls: string[] = []
    const fs: UpdateCacheFs<string> = {
      async writeFile(options) {
        calls.push(`write:${options.path}:${options.directory}:${String(options.recursive)}`)
      },
      async appendFile(options) {
        calls.push(`append:${options.path}:${options.directory}`)
      },
      async rmdir(options) {
        calls.push(`rmdir:${options.path}:${options.directory}:${String(options.recursive)}`)
      },
    }
    const sink = createCacheFileSink(fs, {
      path: 'updates/dsh-hub-app-0.3.1.apk',
      dir: 'updates',
      directory: 'CACHE',
    })

    await sink.reset()
    await sink.append('AAEC')
    await sink.append('AwQF')
    // 再 reset 一次（重新下载）：下一条又是 writeFile
    await sink.reset()
    await sink.append('BgcI')

    expect(calls).toEqual([
      'rmdir:updates:CACHE:true',
      'write:updates/dsh-hub-app-0.3.1.apk:CACHE:true',
      'append:updates/dsh-hub-app-0.3.1.apk:CACHE',
      'rmdir:updates:CACHE:true',
      'write:updates/dsh-hub-app-0.3.1.apk:CACHE:true',
    ])
  })

  it('旧目录不存在（rmdir 抛错）时继续下载，不把失败丢给用户', async () => {
    const calls: string[] = []
    const fs: UpdateCacheFs<string> = {
      async writeFile() {
        calls.push('write')
      },
      async appendFile() {
        calls.push('append')
      },
      async rmdir() {
        throw new Error('Directory does not exist')
      },
    }
    const sink = createCacheFileSink(fs, { path: 'updates/a.apk', dir: 'updates', directory: 'CACHE' })
    await sink.reset()
    await sink.append('AA==')
    expect(calls).toEqual(['write'])
  })
})

describe('updateApkPath', () => {
  it('按版本号生成 Cache 内的相对路径', () => {
    expect(updateApkPath('0.3.1')).toBe('updates/dsh-hub-app-0.3.1.apk')
  })

  it('版本号里的怪字符被剔掉，认不出来就退到 latest', () => {
    expect(updateApkPath('0.3.1/../../x')).toBe('updates/dsh-hub-app-0.3.1....x.apk')
    expect(updateApkPath(null)).toBe('updates/dsh-hub-app-latest.apk')
    expect(updateApkPath('')).toBe('updates/dsh-hub-app-latest.apk')
  })
})


// ── 多镜像（0.4.11 / WP52）──────────────────────────────────────────────────

describe('downloadUpdateMirrors：按顺序回退', () => {
  it('第一个地址网络失败 → 换第二个，成功后不再试别的', async () => {
    const seen: string[] = []
    const recorder = recordingSink()
    const result = await downloadUpdateMirrors({
      urls: ['https://cn.test/a.apk', 'https://sg.test/a.apk', 'https://third.test/a.apk'],
      sink: recorder.sink,
      fetchImpl: async (url) => {
        seen.push(url)
        if (url === 'https://cn.test/a.apk') throw new TypeError('Failed to fetch')
        return responseOf([bytesOf(5)], { total: 5 })
      },
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.url).toBe('https://sg.test/a.apk')
      expect(result.attempts).toBe(2)
      expect(result.bytes).toBe(5)
    }
    expect(seen).toEqual(['https://cn.test/a.apk', 'https://sg.test/a.apk'])
  })

  it('字节数不符（下载不完整）也换下一个地址', async () => {
    const recorder = recordingSink()
    const result = await downloadUpdateMirrors({
      urls: ['https://cn.test/a.apk', 'https://sg.test/a.apk'],
      sink: recorder.sink,
      fetchImpl: async (url) =>
        url === 'https://cn.test/a.apk'
          ? responseOf([bytesOf(3)], { total: 10 })
          : responseOf([bytesOf(10)], { total: 10 }),
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.url).toBe('https://sg.test/a.apk')
  })

  it('sha256 不符 → 换下一个地址（防止某个镜像同步了别的包）', async () => {
    const good = bytesOf(8, 3)
    const goodHash = await sha256Hex(good)
    const recorder = recordingSink()
    const result = await downloadUpdateMirrors({
      urls: ['https://cn.test/a.apk', 'https://sg.test/a.apk'],
      sink: recorder.sink,
      expectedSha256: goodHash,
      fetchImpl: async (url) => {
        const payload = url.includes('cn.test') ? bytesOf(8, 9) : good
        return responseOf([payload], { total: payload.byteLength })
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.url).toBe('https://sg.test/a.apk')
  })

  it('用户取消：立刻停，不再试下一个地址', async () => {
    const seen: string[] = []
    const controller = new AbortController()
    const recorder = recordingSink()
    const result = await downloadUpdateMirrors({
      urls: ['https://cn.test/a.apk', 'https://sg.test/a.apk'],
      sink: recorder.sink,
      signal: controller.signal,
      fetchImpl: async (url) => {
        seen.push(url)
        throw new TypeError('Failed to fetch')
      },
      onEvent: (name) => {
        // 第一次失败后模拟用户点「取消下载」
        if (name === 'update:mirror-fail') controller.abort()
      },
    })
    // 取消发生在第一次失败之后：第二次不该再发起（signal 已 abort，downloadUpdate 直接 canceled）
    expect(result.ok).toBe(false)
    expect(seen).toEqual(['https://cn.test/a.apk'])
    if (!result.ok) expect(result.reason).toBe('canceled')
  })

  it('全部地址都失败：返回最后一次的失败原因 + 试过几个', async () => {
    const recorder = recordingSink()
    const result = await downloadUpdateMirrors({
      urls: ['https://cn.test/a.apk', 'https://sg.test/a.apk'],
      sink: recorder.sink,
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch')
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('network')
      expect(result.attempts).toBe(2)
      expect(result.url).toBe('https://sg.test/a.apk')
      expect(result.message).toContain('已试过 2 个下载地址')
    }
  })

  it('没有可用地址：no-url，不发任何请求', async () => {
    let called = 0
    const recorder = recordingSink()
    const result = await downloadUpdateMirrors({
      urls: [],
      sink: recorder.sink,
      fetchImpl: async () => {
        called += 1
        return responseOf([bytesOf(1)], { total: 1 })
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('no-url')
      expect(result.attempts).toBe(0)
    }
    expect(called).toBe(0)
  })
})
