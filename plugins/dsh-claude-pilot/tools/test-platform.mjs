/**
 * runtime/platform.js 的回归测试：Windows 适配的那些判断（都在 Linux 上用注入的 win32 语义跑，
 * 不需要真的 Windows 文件）。
 *
 * 重点回归：
 *   - Windows 环境变量键名是 `Path`：写 PATH 时不能多出一个 `PATH` 键（Node 只传字典序第一个匹配的）；
 *   - `claude` 在 Windows 上是 `claude.exe` / `claude.cmd`：按 PATHEXT 找，不能只看无扩展名的文件；
 *   - `*.cmd` 壳要经 cmd.exe（Node 18.20.2+ 直接 spawn 会 EINVAL），引号要按 cmd 的 /s 规则包；
 *   - Git Bash 探测必须排除 WSL 的 `WindowsApps\bash.exe` / `System32\bash.exe`；
 *   - `/c/Users/...`、`/mnt/c/...`、`/cygdrive/c/...` 要能归一化成本机路径；
 *   - 交付物是否在工作目录里要用 path 的语义（win32 的 `\`、大小写、盘符）。
 *
 * 跑法：node tools/test-platform.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { posix, win32 } from 'node:path'
import {
  addToPath,
  baseChildEnv,
  detectGitBash,
  displayPath,
  envDelete,
  envGet,
  envSet,
  gitBashCandidates,
  isAbsolutePath,
  isShellShim,
  isWslBash,
  pathExtensions,
  quoteWinArg,
  relativeInside,
  spawnSpecFor,
  terminateTree,
  toHostPath,
  whichFile,
} from '../runtime/platform.js'

const results = []
const test = async (name, fn) => {
  try {
    await fn()
    results.push(`✔ ${name}`)
  } catch (error) {
    results.push(`✘ ${name}\n    ${error?.message?.split('\n').join('\n    ')}`)
    process.exitCode = 1
  }
}

/* ------------------------------------------------- 环境变量：Path / PATH */

await test('envGet 大小写不敏感读', () => {
  assert.equal(envGet({ Path: 'C:\\a' }, 'PATH'), 'C:\\a')
  assert.equal(envGet({ Path: 'C:\\a' }, 'path'), 'C:\\a')
  assert.equal(envGet({ PATH: 'x' }, 'Path'), 'x')
  assert.equal(envGet({}, 'PATH'), undefined)
})

await test('envSet 写 PATH 时删掉 Path 变体（否则 spawn 取到旧的那个）', () => {
  const env = { Path: 'C:\\a' }
  envSet(env, 'PATH', 'C:\\b')
  assert.deepEqual(Object.keys(env), ['PATH'])
  assert.equal(env.PATH, 'C:\\b')
})

await test('envDelete 大小写不敏感删', () => {
  const env = { Path: 'C:\\a', PATH: 'C:\\b', Other: 'keep' }
  envDelete(env, 'path')
  assert.deepEqual(Object.keys(env), ['Other'])
})

await test('addToPath：Windows 用 ; 分隔、沿用原键名、去重、不丢原内容', () => {
  const env = { Path: 'C:\\Windows;C:\\Tools' }
  addToPath(env, ['c:\\tools', 'C:\\Extra'], true)
  assert.equal(env.Path, 'C:\\Windows;C:\\Tools;C:\\Extra')
  assert.equal(env.PATH, undefined, '不该多出一个 PATH 键')
  assert.equal(envGet(env, 'PATH'), 'C:\\Windows;C:\\Tools;C:\\Extra')
})

await test('addToPath：POSIX 用 : 分隔', () => {
  const env = { PATH: '/usr/bin:/bin' }
  addToPath(env, ['/bin', '/opt/x'], false)
  assert.equal(env.PATH, '/usr/bin:/bin:/opt/x')
})

await test('baseChildEnv：Windows 上补齐 %APPDATA%\\npm 等目录、不把 Git 塞进 PATH、HOME 缺省补上', () => {
  const env = baseChildEnv([], {
    win: true,
    env: { Path: 'C:\\Windows', APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', NODE_ENV: 'production' },
    home: 'C:\\Users\\u',
  })
  assert.equal(env.PATH, undefined)
  assert.ok(env.Path.startsWith('C:\\Windows;'), '原 PATH 要留在最前面')
  assert.ok(env.Path.includes('C:\\Users\\u\\AppData\\Roaming\\npm'))
  assert.ok(env.Path.includes('C:\\Users\\u\\.local\\bin'))
  assert.ok(!/git[\\/]bin/i.test(env.Path), 'Git Bash 不进 agent 的 PATH')
  assert.equal(env.NODE_ENV, undefined)
  assert.equal(env.HOME, 'C:\\Users\\u')
})

/* ------------------------------------------------------ PATHEXT / 可执行文件 */

const tmp = mkdtempSync(posix.join(tmpdir(), 'dsh-platform-'))

await test('whichFile：POSIX 只看无扩展名的文件（真实文件系统）', () => {
  const dir = posix.join(tmp, 'posix-bin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(posix.join(dir, 'claude'), '#!/bin/sh\n')
  writeFileSync(posix.join(dir, 'codex.exe'), '')
  assert.equal(whichFile('claude', { PATH: dir }, false), posix.join(dir, 'claude'))
  assert.equal(whichFile('codex', { PATH: dir }, false), null)
})

await test('whichFile：按 PATHEXT 找 .cmd/.exe（注入 isFile，模拟 Windows）', () => {
  const files = new Set(['C:\\npm\\claude.cmd', 'C:\\npm\\codex.exe'])
  const env = { PATH: 'C:\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  const exists = (candidate) => files.has(candidate)
  assert.equal(whichFile('claude', env, true, exists), 'C:\\npm\\claude.cmd')
  assert.equal(whichFile('codex', env, true, exists), 'C:\\npm\\codex.exe')
  assert.equal(whichFile('nope', env, true, exists), null)
  // 名字自带扩展名：按原样找
  assert.equal(whichFile('codex.exe', env, true, exists), 'C:\\npm\\codex.exe')
  // PATHEXT 里没有 .CMD 就找不到
  assert.equal(whichFile('claude', { PATH: 'C:\\npm', PATHEXT: '.EXE' }, true, exists), null)
  // 引号包起来的 PATH 项（Windows 上很常见）
  assert.equal(whichFile('claude', { PATH: '"C:\\npm"', PATHEXT: '.CMD' }, true, exists), 'C:\\npm\\claude.cmd')
})

await test('pathExtensions：读 PATHEXT，缺省用 Windows 默认值', () => {
  assert.deepEqual(pathExtensions({ PATHEXT: '.EXE;.CMD' }), ['.exe', '.cmd'])
  assert.ok(pathExtensions({}).includes('.exe'))
})

await test('isShellShim：只认 .cmd/.bat，且只在 Windows 上', () => {
  assert.equal(isShellShim('C:\\npm\\claude.cmd', true), true)
  assert.equal(isShellShim('C:\\npm\\claude.CMD', true), true)
  assert.equal(isShellShim('C:\\npm\\claude.bat', true), true)
  assert.equal(isShellShim('C:\\npm\\claude.exe', true), false)
  assert.equal(isShellShim('/usr/bin/claude.cmd', false), false)
})

/* ------------------------------------------------------------- .cmd 壳启动 */

await test('.cmd 壳经 cmd.exe：引号与 /d /s /c 的形态', () => {
  const spec = spawnSpecFor('C:\\Program Files\\npm\\claude.cmd', ['auth', 'status', '--json'], { win: true, comspec: 'C:\\Windows\\System32\\cmd.exe' })
  assert.equal(spec.command, 'C:\\Windows\\System32\\cmd.exe')
  assert.deepEqual(spec.args, ['/d', '/s', '/c', '""C:\\Program Files\\npm\\claude.cmd" auth status --json"'])
  assert.equal(spec.windowsVerbatimArguments, true)
})

await test('.cmd 壳：参数里有空格/引号时逐个加引号', () => {
  const spec = spawnSpecFor('C:\\a\\x.cmd', ['--msg', 'a b', 'q"q'], { win: true, comspec: 'cmd.exe' })
  // 程序路径总是加引号；带空格/引号的参数也加（`"` 写成 `""`）；最外层再包一对给 cmd 的 /s 剥
  assert.equal(spec.args[3], '""C:\\a\\x.cmd" --msg "a b" "q""q""')
  assert.equal(quoteWinArg('a b'), '"a b"')
  assert.equal(quoteWinArg('plain'), 'plain')
})

await test('非 .cmd 的命令原样传（POSIX 行为不变）', () => {
  const spec = spawnSpecFor('/usr/bin/claude', ['auth', 'status'], { win: false })
  assert.equal(spec.command, '/usr/bin/claude')
  assert.deepEqual(spec.args, ['auth', 'status'])
  assert.equal(spec.windowsVerbatimArguments, false)
  const exe = spawnSpecFor('C:\\npm\\codex.exe', ['app-server'], { win: true })
  assert.equal(exe.command, 'C:\\npm\\codex.exe')
  assert.deepEqual(exe.args, ['app-server'])
  assert.equal(exe.windowsVerbatimArguments, false)
})

/* -------------------------------------------------------------- Git Bash */

await test('Git Bash：WSL 的 WindowsApps\\bash.exe 被排除', () => {
  const wsl = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe'
  assert.equal(isWslBash(wsl), true)
  assert.equal(isWslBash('C:\\Windows\\System32\\bash.exe'), true)
  assert.equal(isWslBash('C:\\Program Files\\Git\\bin\\bash.exe'), false)
  const env = { PATH: 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps', USERPROFILE: 'C:\\Users\\u' }
  const found = detectGitBash(env, { win: true, gitHome: null, which: () => wsl, exists: (candidate) => candidate === wsl })
  assert.equal(found, null, 'PATH 上只有 WSL bash 时不能当成 Git Bash')
  const paths = gitBashCandidates(env, { win: true, gitHome: null, which: () => wsl })
  assert.ok(!paths.some((entry) => entry.path.includes('WindowsApps')))
})

await test('Git Bash：同时有 Git 和 WSL 的 bash 时选 Git', () => {
  const wsl = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe'
  const git = 'C:\\Program Files\\Git\\bin\\bash.exe'
  const found = detectGitBash({}, { win: true, gitHome: null, which: () => wsl, exists: (candidate) => candidate === wsl || candidate === git })
  assert.deepEqual(found, { path: git, source: 'common' })
})

await test('Git Bash：注册表 InstallPath 优先于固定位置；CLAUDE_CODE_GIT_BASH_PATH 最优先', () => {
  const byRegistry = detectGitBash({}, { win: true, gitHome: 'D:\\Git', which: () => null, exists: (candidate) => candidate === 'D:\\Git\\bin\\bash.exe' })
  assert.deepEqual(byRegistry, { path: 'D:\\Git\\bin\\bash.exe', source: 'registry' })
  const byEnv = detectGitBash(
    { CLAUDE_CODE_GIT_BASH_PATH: 'E:\\gb\\bash.exe' },
    { win: true, gitHome: 'D:\\Git', which: () => null, exists: (candidate) => candidate === 'E:\\gb\\bash.exe' || candidate === 'D:\\Git\\bin\\bash.exe' },
  )
  assert.deepEqual(byEnv, { path: 'E:\\gb\\bash.exe', source: 'env:CLAUDE_CODE_GIT_BASH_PATH' })
})

await test('Git Bash：POSIX 上不给 Windows 候选', () => {
  assert.equal(detectGitBash({}, { win: false, exists: () => true })?.path, '/bin/bash')
})

/* ---------------------------------------------------------- 路径归一化 */

await test('isAbsolutePath：win32 上 /x 不算绝对（它是当前盘符下）', () => {
  assert.equal(isAbsolutePath('C:\\a\\b', true), true)
  assert.equal(isAbsolutePath('C:/a/b', true), true)
  assert.equal(isAbsolutePath('\\\\srv\\share\\a', true), true)
  assert.equal(isAbsolutePath('/c/Users/x', true), false)
  assert.equal(isAbsolutePath('rel.txt', true), false)
  assert.equal(isAbsolutePath('', true), false)
  // POSIX 语义不变
  assert.equal(isAbsolutePath('/usr/bin', false), true)
  assert.equal(isAbsolutePath('rel.txt', false), false)
})

await test('toHostPath：/c、/mnt/c、/cygdrive/c 归一化成本机路径', () => {
  assert.equal(toHostPath('/c/Users/x/a.txt', 'C:\\work', true), 'C:\\Users\\x\\a.txt')
  assert.equal(toHostPath('/cygdrive/c/Users/x', 'C:\\work', true), 'C:\\Users\\x')
  assert.equal(toHostPath('/mnt/d/test/a', 'C:\\work', true), 'D:\\test\\a')
  assert.equal(toHostPath('C:\\abs\\a', 'C:\\work', true), 'C:\\abs\\a')
  assert.equal(toHostPath('rel\\a.txt', 'C:\\work', true), 'C:\\work\\rel\\a.txt')
  // POSIX 上原样返回
  assert.equal(toHostPath('/c/Users/x', '/work', false), '/c/Users/x')
})

await test('displayPath：Windows 上统一 /', () => {
  assert.equal(displayPath('C:\\a\\b\\c.txt', true), 'C:/a/b/c.txt')
  assert.equal(displayPath('/a/b/c.txt', false), '/a/b/c.txt')
})

await test('relativeInside：win32 的 `\\`、大小写、盘符', () => {
  const cwd = 'C:\\work\\proj'
  assert.equal(relativeInside(cwd, 'C:\\work\\proj\\a.js', win32), 'a.js')
  assert.equal(relativeInside(cwd, 'C:\\work\\proj\\sub\\a.js', win32), 'sub\\a.js')
  assert.equal(relativeInside(cwd, 'c:\\work\\proj\\sub\\a.js', win32), 'sub\\a.js', '大小写不同也算在里面')
  assert.equal(relativeInside(cwd, 'C:\\work\\other\\a.js', win32), null)
  assert.equal(relativeInside(cwd, 'D:\\work\\proj\\a.js', win32), null, '别的盘符不算在里面')
  assert.equal(relativeInside(cwd, cwd, win32), null)
  assert.equal(relativeInside(cwd, 'C:\\work\\proj\\..\\x.js', win32), null)
  // POSIX 语义不变
  assert.equal(relativeInside('/w/p', '/w/p/a.js', posix), 'a.js')
  assert.equal(relativeInside('/w/p', '/w/q/a.js', posix), null)
})

/* ------------------------------------------------------------- 进程终止 */

// terminateTree 的等待定时器是 unref 的（真实场景里调用方 fire-and-forget，不该拖住进程退出），
// 单测里要自己留一个 keep-alive，否则事件循环空了 Node 会直接退出、await 永远不返回。
const keepAlive = () => {
  const timer = setInterval(() => {}, 1000)
  return () => clearInterval(timer)
}

await test('terminateTree：POSIX 行为不变（立即 SIGTERM，宽限期后 SIGKILL）', async () => {
  const signals = []
  let onExit = null
  const child = {
    pid: 1234,
    stdin: { end: () => assert.fail('POSIX 上不该先关 stdin（保持原行为）') },
    once: (event, fn) => {
      if (event === 'exit') onExit = fn
    },
    kill: (signal) => {
      signals.push(signal || 'SIGTERM')
    },
  }
  const stop = keepAlive()
  const done = terminateTree(child, { graceMs: 20, win: false })
  assert.deepEqual(signals, ['SIGTERM'])
  await done
  stop()
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  onExit?.()
})

await test('terminateTree：Windows 先关 stdin，宽限期后杀进程', async () => {
  let ended = false
  let killed = false
  const child = {
    pid: 0, // 0 → 不真的去跑 taskkill
    stdin: { end: () => { ended = true } },
    once: () => {},
    kill: () => {
      killed = true
    },
  }
  const stop = keepAlive()
  await terminateTree(child, { graceMs: 10, win: true })
  stop()
  assert.equal(ended, true)
  assert.equal(killed, true)
})

console.log(results.join('\n'))
if (process.exitCode) {
  console.log('\n有失败项')
} else {
  console.log('\n全部通过')
}
