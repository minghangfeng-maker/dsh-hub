import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPaths, isInside, resolveInside } from '../src/lib/paths.js'
import { loadOrCreateMasterKey, loadMasterKeyIfExists } from '../src/lib/secrets.js'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshhub-paths-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('resolveInside（防路径穿越，02 §T11）', () => {
  const root = '/srv/dsh-hub'

  it('正常相对路径解析到 root 之下', () => {
    expect(resolveInside(root, 'users/u1/home')).toBe(join(root, 'users/u1/home'))
    expect(resolveInside(root, './a/b')).toBe(join(root, 'a/b'))
    expect(resolveInside(root, 'a/../b')).toBe(join(root, 'b'))
    expect(resolveInside(root, '.')).toBe(root)
  })

  it('拒绝绝对路径与盘符路径', () => {
    expect(() => resolveInside(root, '/etc/passwd')).toThrow(/只允许相对路径/)
    expect(() => resolveInside(root, 'C:\\Windows\\system32')).toThrow(/只允许相对路径/)
    expect(() => resolveInside(root, '\\\\server\\share')).toThrow(/只允许相对路径/)
  })

  it('拒绝 .. 逃逸（含各种变形）', () => {
    expect(() => resolveInside(root, '..')).toThrow(/越界/)
    expect(() => resolveInside(root, '../etc')).toThrow(/越界/)
    expect(() => resolveInside(root, 'users/../../etc')).toThrow(/越界/)
    expect(() => resolveInside(root, 'a/b/../../../..')).toThrow(/越界/)
  })

  it('拒绝空串与空字节', () => {
    expect(() => resolveInside(root, '')).toThrow(/不能为空/)
    expect(() => resolveInside(root, 'a\0b')).toThrow(/非法字符/)
  })

  it('前缀相同的兄弟目录不算在内', () => {
    expect(() => resolveInside(root, '../dsh-hub-evil/x')).toThrow(/越界/)
    expect(isInside(root, `${root}-evil/x`)).toBe(false)
    expect(isInside(root, join(root, 'x'))).toBe(true)
    expect(isInside(root, root)).toBe(true)
  })
})

describe('createPaths（03 §2 磁盘布局）', () => {
  it('各目录都落在 HUB_DATA_DIR 之下', () => {
    const root = tempDir()
    const paths = createPaths(root)
    expect(paths.root).toBe(resolve(root))
    expect(paths.dbFile).toBe(join(root, 'hub.db'))
    expect(paths.masterKeyFile).toBe(join(root, 'secrets', 'master.key'))
    expect(paths.userHome('u7k2m9xz')).toBe(join(root, 'users', 'u7k2m9xz', 'home'))
    expect(paths.userWorkspace('u7k2m9xz')).toBe(join(root, 'users', 'u7k2m9xz', 'workspace'))
    expect(paths.userManaged('u7k2m9xz')).toBe(join(root, 'users', 'u7k2m9xz', 'managed'))
    expect(paths.userProfileDir('u7k2m9xz')).toBe(
      join(root, 'users', 'u7k2m9xz', 'home', '.dsh', 'profiles', 'web'),
    )
    expect(paths.userExportFile('u7k2m9xz', 'dsh-alice-1.zip')).toBe(
      join(root, 'exports', 'u7k2m9xz', 'dsh-alice-1.zip'),
    )
    expect(paths.runtimeBuildDirFor('0.2.0-rc.2')).toBe(join(root, 'runtime-build', '0.2.0-rc.2'))
  })

  it('非法 slug / 文件名 / 版本号被拒绝', () => {
    const paths = createPaths(tempDir())
    expect(() => paths.userHome('../etc')).toThrow(/slug 不合法/)
    expect(() => paths.userHome('u7k2m9x')).toThrow(/slug 不合法/) // 只有 6 位
    expect(() => paths.userExportFile('u7k2m9xz', '../../etc/passwd')).toThrow(/不合法/)
    expect(() => paths.runtimeBuildDirFor('../..')).toThrow(/不合法/)
  })

  it('ensureBaseDirs 建好基础目录', () => {
    const root = tempDir()
    const paths = createPaths(root)
    paths.ensureBaseDirs()
    expect(paths.secretsDir.startsWith(root + sep)).toBe(true)
    expect(isInside(root, paths.exportsDir)).toBe(true)
  })
})

describe('secrets（0600/0700，02 §6）', () => {
  it('首次调用生成 32 字节主密钥并可重复读取', () => {
    const root = tempDir()
    const file = join(root, 'secrets', 'master.key')
    expect(loadMasterKeyIfExists(file)).toBeNull()
    const key = loadOrCreateMasterKey(file)
    expect(key).toHaveLength(32)
    expect(loadOrCreateMasterKey(file).equals(key)).toBe(true)
  })
})
