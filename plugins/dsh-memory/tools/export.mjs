#!/usr/bin/env node
/**
 * 把本插件导出成「可安装包」：dist/ 下面生成
 *
 *   dsh-memory-<version>.tgz              ← 装到别的 DSH 用（npm tarball）
 *   dsh-memory-<version>-source.tar.gz    ← 对应源码快照（可选）
 *   INSTALL.md                            ← 安装说明（版本号已替换）
 *   install.sh                            ← 命令行一键安装
 *   SHA256SUMS                            ← 校验和
 *
 * 用法：
 *   node tools/export.mjs
 *
 * 约定：
 *   - 只导出**已提交**的内容（脚本会检查工作区干净，然后 git archive HEAD），
 *     避免把 backup 文件、临时改动打进安装包；
 *   - 打包前先在干净的 staging 副本里跑一遍单测 + 冒烟，再 npm pack；
 *   - 打包后逐项核对 tgz 内容（必需的运行时文件在、备份/测试/文档不在）。
 *
 * 没有 npm 依赖，只要求 Node 22+、git、tar、npm。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const STAGING = join(DIST, '.staging')

/** tarball 里必须有的文件（相对包根）。 */
const REQUIRED_FILES = [
  'package.json',
  'INSTALL.md',
  'client.js',
  'cordis.patch.yml',
  'README.md',
  'runtime/index.js',
  'runtime/service.js',
  'runtime/tools.js',
  'runtime/inject.js',
  'runtime/api.js',
  'runtime/consolidate.js',
  'runtime/scheduler.js',
  'runtime/store.js',
  'runtime/paths.js',
  'runtime/indexer.js',
  'runtime/notes.js',
  'runtime/stats.js',
  'runtime/graph.js',
  'runtime/config.js',
  'tools/smoke.mjs',
]

/** 子进程：继承输出并返回 stdout。 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? ''
    throw new Error(`${command} ${args.join(' ')} 失败（exit ${result.status}）${stderr ? `\n${stderr}` : ''}`)
  }
  return result.stdout ?? ''
}

/** 本目录必须在 git 仓库里，且工作区干净（dist/ 已 ignore）。 */
function assertCleanTree() {
  const status = run('git', ['status', '--porcelain'])
  if (status.trim() !== '') {
    throw new Error(
      '导出前工作区必须干净（导出只打包已提交内容）。请先提交：\n' +
        status
          .trim()
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n'),
    )
  }
}

async function readManifest(dir) {
  return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
}

/** 用 git archive HEAD 生成干净源码副本。 */
async function extractHead() {
  await mkdir(STAGING, { recursive: true })
  const archive = join(DIST, '.head.tar')
  run('git', ['archive', '--format=tar', `--output=${archive}`, 'HEAD'])
  run('tar', ['-xf', archive, '-C', STAGING])
  await rm(archive, { force: true })
}

/** 在 staging 里跑单测（导出物的运行时 + 测试一起过一遍）。 */
function runUnitTests() {
  const env = { ...process.env, NODE_ENV: 'test' }
  const result = spawnSync(process.execPath, ['--test'], { cwd: STAGING, env, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`staging 单测失败：\n${(result.stdout ?? '') + (result.stderr ?? '')}`)
  }
  const summary = (result.stdout ?? '').split('\n').filter((line) => /^ℹ (tests|pass|fail)/.test(line)).join(' · ')
  return summary.trim()
}

/** staging 冒烟：临时数据目录，不碰 ~/.dsh/memory。 */
function runSmoke() {
  const home = join(DIST, '.smoke-home')
  const result = spawnSync(process.execPath, ['tools/smoke.mjs'], {
    cwd: STAGING,
    env: { ...process.env, DSH_MEMORY_HOME: home },
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`staging 冒烟失败：\n${(result.stdout ?? '') + (result.stderr ?? '')}`)
  }
  const last = (result.stdout ?? '').trim().split('\n').at(-1) ?? ''
  return last.trim()
}

/** npm pack 到 dist/，返回包内文件名与内容清单。 */
async function npmPack() {
  const cache = join(DIST, '.npm-cache')
  const env = { ...process.env, npm_config_cache: cache, npm_config_loglevel: 'error', npm_config_fund: 'false', npm_config_audit: 'false' }
  const result = spawnSync('npm', ['pack', '--pack-destination', DIST, '--json'], {
    cwd: STAGING,
    env,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`npm pack 失败：\n${(result.stdout ?? '') + (result.stderr ?? '')}`)
  }
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new Error(`无法解析 npm pack --json 输出：\n${result.stdout}`)
  }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  if (!entry?.filename) throw new Error(`npm pack 输出里没有 filename：\n${result.stdout}`)
  return { packedName: entry.filename, files: (entry.files ?? []).map((file) => file.path) }
}

/** 用 tar 再核对一遍真实内容（npm 的 files 清单来自 staging 扫描，这里以产物为准）。 */
function listTarball(tarball) {
  const output = run('tar', ['-tzf', tarball])
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^package\//, ''))
    .filter((line) => line !== '' && !line.endsWith('/'))
}

function assertTarballContents(files, manifest) {
  const set = new Set(files)
  const missing = REQUIRED_FILES.filter((file) => !set.has(file))
  if (missing.length > 0) throw new Error(`tarball 缺文件：${missing.join(', ')}`)

  const forbidden = files.filter((file) => {
    const segments = file.split('/')
    return (
      segments.includes('test') ||
      segments.includes('docs') ||
      segments.includes('node_modules') ||
      segments.includes('dist') ||
      file.includes('.bak')
    )
  })
  if (forbidden.length > 0) throw new Error(`tarball 混进了不该有的文件：${forbidden.join(', ')}`)

  const runtimeCount = files.filter((file) => file.startsWith('runtime/') && file.endsWith('.js')).length
  if (runtimeCount < 14) throw new Error(`runtime/ 下只有 ${runtimeCount} 个 js，疑似漏文件`)
  if (files.length > REQUIRED_FILES.length + 8) {
    throw new Error(`tarball 文件数异常（${files.length} 个）：${files.join(', ')}`)
  }

  if (manifest.name !== '@local/dsh-memory') throw new Error(`包名不对：${manifest.name}`)
  if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('package.json 缺少 dsh.bundle.patch')
  if (manifest.dsh?.client?.platform !== 'web') throw new Error('package.json 缺少 dsh.client.platform=web')
  if (!Array.isArray(manifest.files) || !manifest.files.includes('runtime/')) throw new Error('package.json files 字段异常')
}

/** 把安装文档里的 {{VERSION}} 换掉。 */
async function renderInstallDoc(version) {
  const text = await readFile(join(ROOT, 'INSTALL.md'), 'utf8')
  return text.replaceAll('{{VERSION}}', version)
}

async function sha256(file) {
  const hash = createHash('sha256')
  hash.update(await readFile(file))
  return hash.digest('hex')
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('需要 Node 22+')
  if (!existsSync(join(ROOT, '.git'))) throw new Error('本脚本要在 git 仓库里运行')

  assertCleanTree()
  const manifest = await readManifest(ROOT)
  const version = manifest.version
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error(`package.json version 不像版本号：${version}`)

  // 安全检查：dist 必须就在仓库根下，避免 rm -rf 打偏。
  if (resolve(DIST) !== resolve(join(ROOT, 'dist'))) throw new Error('dist 路径异常')
  await rm(DIST, { recursive: true, force: true })
  await mkdir(DIST, { recursive: true })

  console.log(`\n== dsh-memory v${version} 导出 ==\n`)

  console.log('→ 从 HEAD 生成干净源码副本')
  await extractHead()
  const stagedManifest = await readManifest(STAGING)
  if (stagedManifest.version !== version) throw new Error(`staging 版本 ${stagedManifest.version} 与 HEAD ${version} 不一致`)

  // tgz 里也带一份安装说明（版本号已替换）：只把 tgz 拷到目标机的人也能看到怎么装。
  const installDoc = await renderInstallDoc(version)
  await writeFile(join(STAGING, 'INSTALL.md'), installDoc, 'utf8')

  console.log('→ staging 单测')
  const testSummary = runUnitTests()
  console.log(`   ${testSummary}`)

  console.log('→ staging 冒烟')
  console.log(`   ${runSmoke()}`)

  console.log('→ npm pack')
  const { packedName, files: packedFiles } = await npmPack()
  const tgzName = `dsh-memory-${version}.tgz`
  const tgzPath = join(DIST, tgzName)
  await rename(join(DIST, packedName), tgzPath)
  console.log(`   ${tgzName}`)

  console.log('→ 核对 tarball 内容')
  const files = listTarball(tgzPath)
  assertTarballContents(files, stagedManifest)
  if (packedFiles.length !== files.length) {
    throw new Error(`npm 文件清单（${packedFiles.length}）与 tar 实际内容（${files.length}）不一致`)
  }
  console.log(`   ${files.length} 个文件，${formatBytes((await readFile(tgzPath)).length)}`)

  console.log('→ 生成源码快照')
  const sourceName = `dsh-memory-${version}-source.tar.gz`
  run('git', ['archive', '--format=tar.gz', `--prefix=dsh-memory-${version}/`, `--output=${join(DIST, sourceName)}`, 'HEAD'])

  console.log('→ 复制安装说明 / 安装脚本')
  await writeFile(join(DIST, 'INSTALL.md'), installDoc, 'utf8')
  await cp(join(ROOT, 'install.sh'), join(DIST, 'install.sh'))
  await chmod(join(DIST, 'install.sh'), 0o755)

  console.log('→ 写 SHA256SUMS')
  const sums = []
  for (const name of [tgzName, sourceName, 'INSTALL.md', 'install.sh']) {
    sums.push([await sha256(join(DIST, name)), name])
  }
  await writeFile(join(DIST, 'SHA256SUMS'), `${sums.map(([hash, name]) => `${hash}  ${name}`).join('\n')}\n`, 'utf8')

  // 清理中间产物
  await rm(STAGING, { recursive: true, force: true })
  await rm(join(DIST, '.npm-cache'), { recursive: true, force: true })
  await rm(join(DIST, '.smoke-home'), { recursive: true, force: true })

  const outputs = (await readdir(DIST)).sort()
  console.log('\n== 完成 ==')
  for (const name of outputs) console.log(`  dist/${name}`)
  console.log(`\n装到别的 DSH：把 dist/ 整个目录传过去，按 INSTALL.md 操作（或直接 ./install.sh <profile>）。\n`)
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

main().catch((error) => {
  console.error(`\n导出失败：${error?.message || error}\n`)
  process.exit(1)
})
