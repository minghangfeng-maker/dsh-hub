// Behavior tests for the Host streaming-download route, over real files and a
// mock ctx/fs (the route is transport-agnostic: it takes a fetch Request and
// returns a Response). Run with `node test/route.test.mjs`.
import { apply } from '../index.js'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, statSync, lstatSync, openSync, readSync, closeSync, rmSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const workspace = mkdtempSync(resolve(tmpdir(), 'fd-test-'))
const root = resolve(workspace, 'docs')
mkdirSync(root, { recursive: true })
const textPath = resolve(root, 'report.txt')
const textBody = 'hello world\nsecond line\n'
writeFileSync(textPath, textBody, 'utf8')
const bigPath = resolve(root, 'big.bin')
const bigBytes = Buffer.alloc(9 * 1024 * 1024 + 12345)
for (let i = 0; i < bigBytes.length; i += 1) bigBytes[i] = (i * 31) % 251
writeFileSync(bigPath, bigBytes)
const emptyPath = resolve(root, 'empty.bin')
writeFileSync(emptyPath, '')
const dirPath = resolve(root, 'adir')
mkdirSync(dirPath)
const linkPath = resolve(root, 'link.txt')
symlinkSync(textPath, linkPath)

function localFs() {
  const infoOf = (p) => {
    let st
    try {
      st = statSync(p)
    } catch {
      return undefined
    }
    const type = st.isFile() ? 'file' : st.isDirectory() ? 'directory' : 'other'
    return { type, ...(type === 'file' ? { size: st.size } : {}), version: `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}` }
  }
  return {
    processPath: (target) => target.path,
    async resolve(p, opts) {
      const absolute = isAbsolute(p) ? p : resolve(opts?.cwd ?? workspace, p)
      return { targetKey: absolute, displayPath: absolute, path: absolute }
    },
    async lstat(p, opts) {
      const absolute = isAbsolute(p) ? p : resolve(opts?.cwd ?? workspace, p)
      const st = lstatSync(absolute, { throwIfNoEntry: false })
      if (st === undefined) return undefined
      const type = st.isFile() ? 'file' : st.isDirectory() ? 'directory' : st.isSymbolicLink() ? 'symlink' : 'other'
      return { type, ...(type === 'file' ? { size: st.size } : {}), version: `${st.dev}:${st.ino}:${st.size}` }
    },
    async stat(target) {
      const info = infoOf(target.path)
      if (info === undefined) return undefined
      return { version: info.version, type: info.type, ...(info.size === undefined ? {} : { size: info.size }) }
    },
    async readByteRange(target, range, signal) {
      if (signal?.aborted === true) throw Object.assign(new Error('aborted'), { code: 'FS_ABORTED' })
      const size = statSync(target.path).size
      const start = range.offset
      const want = Math.max(0, Math.min(range.length, size - start))
      if (want === 0) return new Uint8Array(0)
      const fd = openSync(target.path, 'r')
      const buf = Buffer.alloc(want)
      try {
        const read = readSync(fd, buf, 0, want, start)
        return new Uint8Array(buf.subarray(0, read))
      } finally {
        closeSync(fd)
      }
    },
  }
}

const fsImpl = localFs()
const sessions = new Map([
  ['s1', { header: { cwd: workspace } }],
  ['cold', { fromPersistence: true, header: {} }],
])
const routes = new Map()
const ctx = {
  get(name) {
    if (name === 'fs') return fsImpl
    if (name === 'sessions') {
      return {
        get: (id) => {
          const entry = sessions.get(id)
          return entry === undefined || entry.fromPersistence === true ? undefined : entry
        },
      }
    }
    if (name === 'sessionPersistence') {
      return { stat: async (id) => (sessions.has(id) ? { header: sessions.get(id).header } : undefined) }
    }
    if (name === 'sandboxPolicy') return { workspaceRoot: workspace }
    return undefined
  },
  inject(deps, callback) {
    callback({
      get: (name) => ctx.get(name),
      connection: { fetch: { register(route) { routes.set(route.path, route) } } },
    })
  },
}
apply(ctx)
const route = routes.get('/api/workspace.download')
if (route === undefined) throw new Error('route not registered')

let passed = 0
const failures = []
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`)
}
function request(params, init = {}) {
  return new Request(`http://dsh.internal/api/workspace.download?${new URLSearchParams(params).toString()}`, init)
}
async function bodyOf(response) {
  return Buffer.from(await response.arrayBuffer())
}

// Addressing and method basics.
{
  const bare = await route.fetch(request({}, { method: 'HEAD' }))
  check('bare HEAD is 400', bare.status === 400, String(bare.status))
  check('bare HEAD names the reason', bare.headers.get('x-file-download-error') === 'missing-parameters')
  check('bare HEAD has no body', bare.body === null)
  const nul = await route.fetch(request({ sessionId: 's1', path: 'docs/a\u0000b' }))
  check('NUL path is 400', nul.status === 400, String(nul.status))
  const missingFile = await route.fetch(request({ sessionId: 's1', path: 'nope.txt' }))
  check('missing file is 404', missingFile.status === 404, String(missingFile.status))
  check('missing file names the reason', missingFile.headers.get('x-file-download-error') === 'not-found')
  const missingSession = await route.fetch(request({ sessionId: 'ghost', path: 'docs/report.txt' }))
  check('unknown session is 404', missingSession.status === 404, String(missingSession.status))
  check('unknown session names the reason', missingSession.headers.get('x-file-download-error') === 'session-not-found')
  const directory = await route.fetch(request({ sessionId: 's1', path: 'docs/adir' }))
  check('directory is 403', directory.status === 403, String(directory.status))
  const link = await route.fetch(request({ sessionId: 's1', path: 'docs/link.txt' }))
  check('symlink is 403', link.status === 403, String(link.status))
}

// Full representation and download headers.
{
  const response = await route.fetch(request({ sessionId: 's1', path: 'docs/report.txt' }))
  const headers = Object.fromEntries(response.headers.entries())
  const body = await bodyOf(response)
  check('full is 200', response.status === 200, String(response.status))
  check('full body matches', body.toString('utf8') === textBody)
  check('full length matches', headers['content-length'] === String(Buffer.byteLength(textBody)))
  check('full advertises ranges', headers['accept-ranges'] === 'bytes')
  check('full is an attachment', (headers['content-disposition'] ?? '').startsWith('attachment;'))
  check('full filename is preserved', (headers['content-disposition'] ?? '').includes("filename*=UTF-8''report.txt"))
  check('full is never sniffed', headers['x-content-type-options'] === 'nosniff')
  check('full is never stored', (headers['cache-control'] ?? '').includes('no-store'))
  check('full is never re-encoded', (headers['cache-control'] ?? '').includes('no-transform'))
  check('full carries an etag', /^".+"$/.test(headers.etag ?? ''), headers.etag)
}

// HEAD mirrors GET without a body.
{
  const response = await route.fetch(request({ sessionId: 's1', path: 'docs/big.bin' }, { method: 'HEAD' }))
  check('HEAD is 200', response.status === 200, String(response.status))
  check('HEAD carries the full length', response.headers.get('content-length') === String(bigBytes.length))
  check('HEAD has no body', response.body === null)
}

// Ranged reads: prefix, open-ended, suffix, unsatisfiable, malformed.
{
  const prefix = await route.fetch(request({ sessionId: 's1', path: 'docs/big.bin' }, { headers: { range: 'bytes=0-4' } }))
  check('prefix is 206', prefix.status === 206, String(prefix.status))
  check('prefix body matches', (await bodyOf(prefix)).equals(bigBytes.subarray(0, 5)))
  check('prefix content-range', prefix.headers.get('content-range') === `bytes 0-4/${bigBytes.length}`)
  check('prefix content-length', prefix.headers.get('content-length') === '5')

  const start = 123456
  const open = await route.fetch(request({ sessionId: 's1', path: 'docs/big.bin' }, { headers: { range: `bytes=${start}-` } }))
  check('open range is 206', open.status === 206)
  check('open range body matches', (await bodyOf(open)).equals(bigBytes.subarray(start)))
  check('open range content-range', open.headers.get('content-range') === `bytes ${start}-${bigBytes.length - 1}/${bigBytes.length}`)

  const suffix = await route.fetch(request({ sessionId: 's1', path: 'docs/big.bin' }, { headers: { range: 'bytes=-3' } }))
  check('suffix range is 206', suffix.status === 206)
  check('suffix range body matches', (await bodyOf(suffix)).equals(bigBytes.subarray(bigBytes.length - 3)))

  const unsatisfiable = await route.fetch(request({ sessionId: 's1', path: 'docs/big.bin' }, { headers: { range: `bytes=${bigBytes.length + 10}-` } }))
  check('past-end range is 416', unsatisfiable.status === 416, String(unsatisfiable.status))
  check('past-end range names the size', unsatisfiable.headers.get('content-range') === `bytes */${bigBytes.length}`)

  const malformed = await route.fetch(request({ sessionId: 's1', path: 'docs/big.bin' }, { headers: { range: 'bytes=abc' } }))
  check('malformed range falls back to 200', malformed.status === 200, String(malformed.status))
}

// Resume validators: If-Range decides whether a resumed request is still valid.
{
  const head = await route.fetch(request({ sessionId: 's1', path: 'docs/big.bin' }, { method: 'HEAD' }))
  const etag = head.headers.get('etag')
  const stale = await route.fetch(request({ sessionId: 's1', path: 'docs/big.bin' }, { headers: { range: 'bytes=100-', 'if-range': '"bogus"' } }))
  check('stale If-Range restarts at 200', stale.status === 200, String(stale.status))
  const fresh = await route.fetch(request({ sessionId: 's1', path: 'docs/big.bin' }, { headers: { range: 'bytes=100-', 'if-range': etag } }))
  check('matching If-Range resumes at 206', fresh.status === 206, String(fresh.status))
}

// Session resolution: a live header, a cold persisted header with sandbox fallback.
{
  const cold = await route.fetch(request({ sessionId: 'cold', path: 'docs/report.txt' }))
  check('cold session resolves', cold.status === 200, String(cold.status))
}

// Empty file edge case.
{
  const response = await route.fetch(request({ sessionId: 's1', path: 'docs/empty.bin' }))
  check('empty file is 200', response.status === 200, String(response.status))
  check('empty file length is 0', response.headers.get('content-length') === '0')
  check('empty file body is empty', (await bodyOf(response)).length === 0)
  const ranged = await route.fetch(request({ sessionId: 's1', path: 'docs/empty.bin' }, { headers: { range: 'bytes=0-' } }))
  check('empty file range is 416', ranged.status === 416, String(ranged.status))
}

// Large file: bounded windows, multiple reads, exact bytes.
{
  const reads = []
  const original = fsImpl.readByteRange
  fsImpl.readByteRange = async (target, range, signal) => {
    reads.push(range.length)
    return original(target, range, signal)
  }
  const response = await route.fetch(request({ sessionId: 's1', path: 'docs/big.bin' }))
  const body = await bodyOf(response)
  fsImpl.readByteRange = original
  check(
    'large file bytes match',
    createHash('sha256').update(body).digest('hex') === createHash('sha256').update(bigBytes).digest('hex'),
  )
  check('large file is read in windows', reads.length > 1, String(reads.length))
  check('no window exceeds the chunk cap', Math.max(...reads) <= 4 * 1024 * 1024, String(Math.max(...reads)))
}

// Absolute paths keep the backend's read authority (mirrors preview/readBytes).
{
  const outside = resolve(tmpdir(), `fd-outside-${String(process.pid)}.txt`)
  writeFileSync(outside, 'outside')
  const response = await route.fetch(request({ sessionId: 's1', path: outside }))
  check('absolute path outside workspace reads', response.status === 200, String(response.status))
  check('absolute path body matches', (await bodyOf(response)).toString('utf8') === 'outside')
  rmSync(outside)
}

rmSync(workspace, { recursive: true, force: true })
console.log(failures.length === 0 ? `route tests passed (${String(passed)})` : `route tests FAILED: ${String(failures.length)} of ${String(passed + failures.length)}`)
for (const failure of failures) console.error(' -', failure)
if (failures.length > 0) process.exitCode = 1
