import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { packLocalDirectory, type PackRunner } from '../src/modules/plugins/sources.js'

/**
 * `local` 来源的 `pnpm pack` 调用方式：在 Hub 仓库根启动（pnpm 由 corepack 提供时按仓库 packageManager 取固定版本），
 * 用 `-C` 指向插件副本；找不到 pnpm 时给部署提示而不是裸的 ENOENT。
 */
const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makePlugin(): { sourceDir: string; workDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'dshhub-test-packlocal-'))
  roots.push(root)
  const sourceDir = join(root, 'plugin')
  mkdirSync(sourceDir)
  writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({ name: '@smoke/plugin', version: '1.2.3' }))
  return { sourceDir, workDir: join(root, 'work') }
}

describe('packLocalDirectory 调用 pnpm 的方式', () => {
  it('cwd = 仓库根，参数用 -C 指向临时副本，产物写到 out 目录', async () => {
    const { sourceDir, workDir } = makePlugin()
    const calls: { command: string; args: string[]; cwd: string }[] = []
    const runner: PackRunner = (command, args, opts) => {
      calls.push({ command, args, cwd: opts.cwd })
      // 假装 pnpm pack 产出了 tgz
      writeFileSync(join(workDir, 'out', 'smoke-plugin-1.2.3.tgz'), 'x')
      return Promise.resolve({ stdout: 'ok', stderr: '' })
    }

    const packed = await packLocalDirectory(sourceDir, workDir, { registry: '', packRunner: runner })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.command).toBe('pnpm')
    expect(calls[0]!.args).toEqual([
      '-C',
      join(workDir, 'src'),
      'pack',
      '--pack-destination',
      join(workDir, 'out'),
    ])
    expect(calls[0]!.cwd.replace(/\/$/u, '')).toBe(REPO.replace(/\/$/u, ''))
    expect(packed.tgzFile).toBe(join(workDir, 'out', 'smoke-plugin-1.2.3.tgz'))
  })

  it('找不到 pnpm（ENOENT）：报部署提示，指向 upgrade.sh 与单元 PATH', async () => {
    const { sourceDir, workDir } = makePlugin()
    const runner: PackRunner = () =>
      Promise.reject(Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' }))

    const failure = packLocalDirectory(sourceDir, workDir, { registry: '', packRunner: runner })
    await expect(failure).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' })
    await expect(failure).rejects.toThrow(/PATH 里找不到 pnpm.*deploy\/upgrade\.sh/u)
    await expect(failure).rejects.not.toThrow(/spawn pnpm ENOENT/u)
  })

  it('其它失败原样带出原因', async () => {
    const { sourceDir, workDir } = makePlugin()
    const runner: PackRunner = () => Promise.reject(new Error('ERR_PNPM_BAD_PACKAGE_JSON'))
    await expect(
      packLocalDirectory(sourceDir, workDir, { registry: '', packRunner: runner }),
    ).rejects.toThrow(/pnpm pack 失败：ERR_PNPM_BAD_PACKAGE_JSON/u)
  })
})
