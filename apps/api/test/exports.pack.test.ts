import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildManifest,
  buildPluginsJson,
  buildReadme,
  contentDisposition,
  dependenciesOf,
  exportFileName,
  isExcludedDirName,
  isExcludedFileName,
  parseRange,
  scanExport,
  timestampCompact,
  writeArchive,
  type ArchiveEntry,
} from '../src/modules/exports/pack.js'
import { readZip } from './zipfile.js'

/** 06 §6 打包细节：排除规则、符号链接、maxBytes、ZIP/tar.gz 可解压、Range、中文文件名 */
let root: string
let userRoot: string
let socketPath: string
let socketServer: Server | undefined

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'dshhub-test-wp4-pack-'))
  userRoot = join(root, 'users', 'uabc1234')
  const workspace = join(userRoot, 'workspace')
  const dshHome = join(userRoot, 'home', '.dsh')
  mkdirSync(join(workspace, 'docs'), { recursive: true })
  mkdirSync(join(workspace, 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(join(workspace, '.cache'), { recursive: true })
  mkdirSync(join(workspace, '.pnpm-store'), { recursive: true })
  mkdirSync(join(dshHome, 'sessions'), { recursive: true })
  mkdirSync(join(dshHome, 'attachments'), { recursive: true })
  mkdirSync(join(dshHome, 'profiles', 'web'), { recursive: true })

  writeFileSync(join(workspace, 'README.md'), '# hello\n')
  writeFileSync(join(workspace, 'docs', 'a.txt'), 'aaa\n')
  writeFileSync(join(workspace, '.env'), 'SECRET=1\n')
  writeFileSync(join(workspace, '.env.local'), 'SECRET=2\n')
  writeFileSync(join(workspace, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
  writeFileSync(join(workspace, '.cache', 'x'), 'cache\n')
  writeFileSync(join(workspace, '.pnpm-store', 'y'), 'store\n')
  writeFileSync(join(dshHome, 'sessions', 's1.json'), '{"id":"s1"}\n')
  writeFileSync(join(dshHome, 'attachments', 'a.bin'), 'binary\n')
  writeFileSync(join(dshHome, '.credentials.yaml'), 'token: top-secret\n')
  writeFileSync(
    join(dshHome, 'profiles', 'web', 'package.json'),
    JSON.stringify({ dependencies: { 'dsh-email': '1.0.0', 'dsh-files': '^2.0.0' } }),
  )
  writeFileSync(join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'patch: []\n')

  // 符号链接：内部（保留为链接）、外部（跳过并记录）
  symlinkSync('docs/a.txt', join(workspace, 'link-in'))
  symlinkSync('../home/.dsh/sessions', join(workspace, 'link-dsh'))
  symlinkSync('/etc/passwd', join(workspace, 'link-out'))
  symlinkSync('../../../..', join(workspace, 'link-escape'))

  // 套接字（特殊文件）：应当被跳过
  socketPath = join(workspace, 'sock')
  socketServer = createServer()
  await new Promise<void>((resolve) => {
    socketServer!.listen(socketPath, resolve)
  })
})

afterAll(() => {
  socketServer?.close()
  rmSync(root, { recursive: true, force: true })
})

function sources() {
  return {
    workspace: [{ path: join(userRoot, 'workspace'), archivePrefix: 'workspace', kind: 'dir' as const }],
    sessions: [
      {
        path: join(userRoot, 'home', '.dsh', 'sessions'),
        archivePrefix: 'dsh/sessions',
        kind: 'dir' as const,
      },
      {
        path: join(userRoot, 'home', '.dsh', 'attachments'),
        archivePrefix: 'dsh/attachments',
        kind: 'dir' as const,
      },
    ],
    settings: [
      {
        path: join(userRoot, 'home', '.dsh', 'profiles', 'web', 'package.json'),
        archivePrefix: 'dsh/settings/profile',
        kind: 'file' as const,
      },
      {
        path: join(userRoot, 'home', '.dsh', 'profiles', 'web', 'cordis.patch.yml'),
        archivePrefix: 'dsh/settings/profile',
        kind: 'file' as const,
      },
    ],
  }
}

describe('导出打包 · 遍历', () => {
  it('排除敏感文件与缓存目录，保留内部符号链接，记录越界链接与特殊文件', () => {
    const scan = scanExport({ userRoot, sources: sources(), maxBytes: Number.POSITIVE_INFINITY })
    const names = scan.entries.map((entry) => entry.archivePath).sort()

    expect(names).toContain('workspace/README.md')
    expect(names).toContain('workspace/docs/a.txt')
    expect(names).toContain('dsh/sessions/s1.json')
    expect(names).toContain('dsh/attachments/a.bin')
    expect(names).toContain('dsh/settings/profile/package.json')
    expect(names).toContain('dsh/settings/profile/cordis.patch.yml')

    // 永远排除（验收 E3）
    expect(names.some((name) => name.includes('.credentials.yaml'))).toBe(false)
    expect(names.some((name) => name.includes('.env'))).toBe(false)
    expect(names.some((name) => name.includes('node_modules'))).toBe(false)
    expect(names.some((name) => name.includes('.cache'))).toBe(false)
    expect(names.some((name) => name.includes('.pnpm-store'))).toBe(false)

    // 内部符号链接保留为链接（不跟随）
    const linkIn = scan.entries.find((entry) => entry.archivePath === 'workspace/link-in')
    expect(linkIn?.kind).toBe('symlink')
    expect(linkIn?.linkTarget).toBe('docs/a.txt')
    const linkDsh = scan.entries.find((entry) => entry.archivePath === 'workspace/link-dsh')
    expect(linkDsh?.kind).toBe('symlink')

    // 越界符号链接与套接字进跳过清单（验收 E2）
    const skippedPaths = scan.skipped.map((entry) => entry.path)
    expect(skippedPaths).toContain('workspace/link-out')
    expect(skippedPaths).toContain('workspace/link-escape')
    expect(skippedPaths).toContain('workspace/sock')
    expect(scan.skipped.find((entry) => entry.path === 'workspace/link-out')?.reason).toContain('/etc/passwd')
    // 跳过清单里不能出现被排除文件的名字
    expect(skippedPaths.some((path) => path.includes('.credentials.yaml'))).toBe(false)
  })

  it('超过 maxBytes 抛 EXPORT_TOO_LARGE', () => {
    expect(() => scanExport({ userRoot, sources: sources(), maxBytes: 4 })).toThrow(/过大/)
    try {
      scanExport({ userRoot, sources: sources(), maxBytes: 4 })
    } catch (error) {
      expect((error as { code?: string }).code).toBe('EXPORT_TOO_LARGE')
    }
  })

  it('排除规则判定（大小写/前缀）', () => {
    expect(isExcludedDirName('node_modules')).toBe(true)
    expect(isExcludedDirName('.cache')).toBe(true)
    expect(isExcludedDirName('cache')).toBe(false)
    expect(isExcludedFileName('.env')).toBe(true)
    expect(isExcludedFileName('.env.production')).toBe(true)
    expect(isExcludedFileName('.credentials.yaml')).toBe(true)
    expect(isExcludedFileName('env')).toBe(false)
  })
})

describe('导出打包 · 写归档', () => {
  it('ZIP 能被解压校验（CRC32），含 README/manifest/符号链接', async () => {
    const scan = scanExport({ userRoot, sources: sources(), maxBytes: Number.POSITIVE_INFINITY })
    const target = join(root, 'out.zip')
    const progress: number[] = []
    const result = await writeArchive({
      format: 'zip',
      targetPath: target,
      entries: scan.entries,
      extras: [
        {
          name: 'dsh-user-20261012-2130/README.txt',
          content: buildReadme(manifestInput(scan.files, scan.bytes, scan.skipped)),
        },
        {
          name: 'dsh-user-20261012-2130/manifest.json',
          content: buildManifest(manifestInput(scan.files, scan.bytes, scan.skipped)),
        },
      ],
      onProgress: (p) => progress.push(p.filesDone),
      progressIntervalMs: 0,
    })

    expect(result.sizeBytes).toBeGreaterThan(0)
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)

    const entries = readZip(readFileSync(target))
    const names = entries.map((entry) => entry.name)
    expect(names).toContain('dsh-user-20261012-2130/README.txt')
    expect(names).toContain('dsh-user-20261012-2130/manifest.json')
    expect(names).toContain('workspace/README.md')
    expect(names).not.toContain('workspace/link-out')

    const link = entries.find((entry) => entry.name === 'workspace/link-in')!
    expect(link.mode & 0o170000).toBe(0o120000)
    expect(link.data.toString('utf8')).toBe('docs/a.txt')

    const manifest = JSON.parse(
      entries.find((entry) => entry.name.endsWith('manifest.json'))!.data.toString('utf8'),
    ) as { skipped: { path: string }[]; files: number }
    expect(manifest.skipped.map((entry) => entry.path)).toContain('workspace/link-out')
    expect(manifest.files).toBe(scan.files)
    // 进度事件节流后可观测
    expect(progress.length).toBeGreaterThan(0)
  })

  it('tar.gz 能被系统 tar 解开（没有 tar 就跳过）', async () => {
    let hasTar = true
    try {
      execFileSync('tar', ['--version'], { stdio: 'ignore' })
    } catch {
      hasTar = false
    }
    if (!hasTar) return

    const scan = scanExport({ userRoot, sources: sources(), maxBytes: Number.POSITIVE_INFINITY })
    const target = join(root, 'out.tar.gz')
    await writeArchive({
      format: 'tar.gz',
      targetPath: target,
      entries: scan.entries,
      extras: [{ name: 'dsh-user-20261012-2130/README.txt', content: 'hi\n' }],
    })
    const listing = execFileSync('tar', ['-tzf', target], { encoding: 'utf8' })
    expect(listing).toContain('workspace/README.md')
    expect(listing).toContain('dsh-user-20261012-2130/README.txt')
  })

  it('打包失败不会留下正式文件（只清理临时文件）', async () => {
    const target = join(root, 'broken.zip')
    const badEntry: ArchiveEntry = {
      kind: 'file',
      archivePath: 'x.txt',
      sourcePath: join(root, 'nope.txt'),
      sizeBytes: 1,
    }
    await expect(
      writeArchive({ format: 'zip', targetPath: target, entries: [badEntry], extras: [] }),
    ).rejects.toThrow()
    expect(() => readFileSync(target)).toThrow()
    expect(() => readFileSync(`${target}.part`)).toThrow()
  })
})

describe('导出打包 · 文件名与下载头', () => {
  it('文件名/归档根目录/时间戳', () => {
    const iso = '2026-10-12T13:30:45.000Z'
    expect(timestampCompact(iso)).toBe('20261012-1330')
    expect(exportFileName('alice', iso, 'zip')).toBe('dsh-alice-20261012-1330.zip')
    expect(exportFileName('alice', iso, 'tar.gz')).toBe('dsh-alice-20261012-1330.tar.gz')
  })

  it('Content-Disposition 用 RFC 5987 编码中文文件名', () => {
    const header = contentDisposition('DSH数据导出-alice-20261012-1330.zip')
    expect(header).toContain('attachment;')
    expect(header).toContain("filename*=UTF-8''DSH%E6%95%B0%E6%8D%AE%E5%AF%BC%E5%87%BA")
    expect(header).toContain('filename="DSH____-alice-20261012-1330.zip"')
    expect(contentDisposition('plain.zip')).toBe(
      'attachment; filename="plain.zip"; filename*=UTF-8\'\'plain.zip',
    )
  })

  it('Range 解析：单段/后缀/越界', () => {
    expect(parseRange(undefined, 100)).toBeNull()
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=50-1000', 100)).toEqual({ start: 50, end: 99 })
    expect(parseRange('bytes=200-300', 100)).toBe('invalid')
    expect(parseRange('bytes=9-1', 100)).toBe('invalid')
    expect(parseRange('items=0-1', 100)).toBe('invalid')
    expect(parseRange('bytes=-', 100)).toBe('invalid')
  })

  it('plugins.json 与 profile 依赖', () => {
    const profile = { dependencies: { 'dsh-email': '1.0.0', other: 42 } }
    expect(dependenciesOf(profile)).toEqual({ 'dsh-email': '1.0.0' })
    expect(dependenciesOf(null)).toEqual({})
    const json = JSON.parse(
      buildPluginsJson({ exportedAt: 'now', profilePackage: profile, dependencies: { a: '1' } }),
    ) as { dependencies: Record<string, string> }
    expect(json.dependencies).toEqual({ a: '1' })
  })
})

function manifestInput(files: number, bytes: number, skipped: { path: string; reason: string }[]) {
  return {
    hubVersion: '0.1.0',
    username: 'alice',
    displayName: 'Alice',
    parts: ['workspace'] as const,
    format: 'zip' as const,
    exportedAt: '2026-10-12T13:30:45.000Z',
    dshVersion: '0.2.0-rc.2',
    root: 'dsh-alice-20261012-1330',
    files,
    bytes,
    skipped,
  }
}
