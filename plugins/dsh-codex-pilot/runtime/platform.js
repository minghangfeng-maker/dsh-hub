/**
 * 跨平台小工具（Windows 适配）。两个 pilot 各带一份同样的实现（将来可以提到共享包）。
 *
 * 桌面端要处理的 Windows 事实：
 *   - PATH 在 Windows 上按 `;` 分隔，且环境变量的键名大小写不固定（系统给的是 `Path`），
 *     Node 的 spawn 只传「按字典序第一个大小写不敏感匹配」的那个键，所以混用 PATH/Path 会丢掉真正的 PATH；
 *   - 可执行文件要按 PATHEXT 找（.exe/.cmd/.bat/.com），不能只看无扩展名的 `claude`；
 *   - Node 18.20.2 起（CVE-2024-27980）直接 spawn `.cmd`/`.bat` 会 EINVAL，必须经 cmd.exe；
 *   - Windows 上没有 SIGTERM 语义：child.kill() 等于 TerminateProcess，不会让子进程有机会收尾，
 *     而且杀掉 `.cmd`/node 壳进程不会带走它启动的真实程序（codex.exe 会变孤儿）；
 *   - 控制台子进程默认会弹黑窗口，spawn 要带 windowsHide；
 *   - `path.isAbsolute('/foo')` 在 win32 上是 true，但它是「当前盘符下的路径」，直接用会指错盘；
 *   - Claude Code 在 Windows 上要一个 shell 工具：Git for Windows 的 bash（`CLAUDE_CODE_GIT_BASH_PATH`）
 *     或者 PowerShell 工具。PATH 上的 `bash` 往往是 WSL 的 `WindowsApps\bash.exe`，不能拿来当 Git Bash。
 *
 * 平台相关函数都带一个可选的 `win` 参数（默认 = 当前平台），这样在 Linux 上也能用 win32 语义写单测。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, posix, resolve, sep, win32 } from 'node:path'
import { homedir } from 'node:os'

export const IS_WIN = process.platform === 'win32'

/** 所有 Windows 子进程 spawn 都带上：不隐藏窗口会弹黑框（`claude` 每轮一个进程，codex 是常驻进程）。 */
export const HIDE = { windowsHide: true }

/** PATHEXT 读不到时的兜底（Windows 默认值）。 */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/** 不是 Git Bash 的 bash：WSL 的两个入口（WindowsApps 的商店壳、System32\bash.exe）。 */
const WSL_BASH = /[\\/](?:WindowsApps|System32)[\\/]bash\.exe$/i

/** Windows 环境变量的键名大小写不固定：按大小写不敏感读。 */
export function envGet(env, name) {
  if (!env || !name) return undefined
  const exact = env[name]
  if (exact !== undefined) return exact
  const lower = String(name).toLowerCase()
  for (const key of Object.keys(env)) if (key.toLowerCase() === lower) return env[key]
  return undefined
}

/** 写入时先删掉其它大小写变体，免得 spawn 时取到旧的那一个（Node 只传字典序第一个匹配）。 */
export function envSet(env, name, value) {
  if (!env || !name) return
  const lower = String(name).toLowerCase()
  for (const key of Object.keys(env)) if (key.toLowerCase() === lower && key !== name) delete env[key]
  env[name] = value
}

export function envDelete(env, name) {
  if (!env || !name) return
  const lower = String(name).toLowerCase()
  for (const key of Object.keys(env)) if (key.toLowerCase() === lower) delete env[key]
}

/** PATH 里追加目录（保留原有顺序与内容，键名沿用原来的 `Path`/`PATH`）。 */
export function addToPath(env, dirs, win = IS_WIN) {
  if (!env) return
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') || 'PATH'
  const listSep = win ? ';' : delimiter
  const norm = (dir) => (win ? String(dir).toLowerCase() : String(dir))
  const current = String(env[key] || '').split(listSep).filter(Boolean)
  const seen = new Set(current.map(norm))
  const next = [...current]
  for (const dir of dirs || []) {
    if (!dir || seen.has(norm(dir))) continue
    seen.add(norm(dir))
    next.push(String(dir))
  }
  envSet(env, key, next.join(listSep))
}

/** 按 PATHEXT（Windows）或空扩展名（POSIX）列出候选扩展。 */
export function pathExtensions(env = process.env) {
  const raw = String(envGet(env, 'PATHEXT') || '').trim() || DEFAULT_PATHEXT
  const list = raw
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean)
    .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`))
  return [...new Set(list)]
}

/**
 * 按 PATH + PATHEXT 找可执行文件，返回绝对路径（找不到 null）。
 * Windows 上 `codex` 实际是 `%APPDATA%\npm\codex.cmd`，只看无扩展名的文件永远找不到。
 */
export function whichFile(name, env = process.env, win = IS_WIN, isFile) {
  const file = String(name || '').trim()
  if (!file) return null
  // isFile 可注入（单测在 Linux 上用 win32 语义跑，不必真的有 Windows 文件）
  const check = isFile || ((candidate) => statSync(candidate).isFile())
  const listSep = win ? ';' : delimiter
  const exts = win ? pathExtensions(env) : ['']
  const lower = file.toLowerCase()
  // 名字自带 PATHEXT 里的扩展名：先按原样找；否则按 PATHEXT 逐个试，最后再试无扩展名的
  const suffixes = win ? (exts.some((ext) => lower.endsWith(ext)) ? [''] : [...exts, '']) : ['']
  const dirs = String(envGet(env, 'PATH') || '').split(listSep)
  for (const raw of dirs) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1')
    if (!dir) continue
    for (const suffix of suffixes) {
      const candidate = win ? win32.join(dir, file + suffix) : join(dir, file + suffix)
      try {
        if (check(candidate)) return candidate
      } catch {
        /* 下一个 */
      }
    }
  }
  return null
}

/** 这个文件是不是 `.cmd`/`.bat` 壳（npm 全局安装的 shim）。 */
export function isShellShim(file, win = IS_WIN) {
  if (!win || !file) return false
  return /\.(cmd|bat)$/i.test(String(file))
}

/** cmd.exe 命令行里给一个参数加引号（`"` 要写成 `""`）。 */
export function quoteWinArg(value) {
  const text = String(value ?? '')
  if (!text) return '""'
  if (!/[\s"]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

/**
 * 把 (可执行文件, 参数) 变成真正能 spawn 的 command/args。
 * `.cmd`/`.bat` 必须经 cmd.exe（Node 18.20.2+ 直接 spawn 会 EINVAL），并且要自己加引号：
 * cmd 的 /s 规则会把「整串命令」最外层的一对引号剥掉，所以最后一层还要再包一对（Node 自己
 * `shell: true` 时也是这么做的），同时 windowsVerbatimArguments 防止 Node 二次加引号。
 */
export function spawnSpecFor(file, args = [], options = {}) {
  const win = options.win ?? IS_WIN
  if (!isShellShim(file, win)) return { command: file, args, windowsVerbatimArguments: false }
  const comspec = options.comspec || envGet(process.env, 'ComSpec') || 'C:\\Windows\\System32\\cmd.exe'
  const quotedFile = `"${String(file).replace(/"/g, '""')}"`
  const inner = [quotedFile, ...args.map((arg) => quoteWinArg(arg))].join(' ')
  return { command: comspec, args: ['/d', '/s', '/c', `"${inner}"`], windowsVerbatimArguments: true }
}

/**
 * 收掉一个子进程（Windows 上还有它启动的整棵进程树）。
 *   - POSIX：行为与原来完全一致 —— SIGTERM，3 秒后 SIGKILL；
 *   - Windows：没有 SIGTERM 语义。先关 stdin（codex app-server 读到 EOF 会自己退出，真机 exit 0），
 *     宽限期内没走就 TerminateProcess + `taskkill /pid <pid> /t /f` 收拾整棵树
 *     （`.cmd` 壳 / node 壳被杀了不会带走它启动的真实程序）。
 */
export function terminateTree(child, { graceMs = 3000, win = IS_WIN } = {}) {
  if (!child) return Promise.resolve()
  return new Promise((finish) => {
    let done = false
    const end = () => {
      if (done) return
      done = true
      finish()
    }
    child.once('exit', end)
    if (!win) {
      try {
        child.kill('SIGTERM')
      } catch {
        /* 已退出 */
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* 已退出 */
        }
        end()
      }, graceMs)
      timer.unref?.()
      return
    }
    try {
      child.stdin?.end?.()
    } catch {
      /* 已经没有 stdin */
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      if (child.pid) {
        try {
          spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { ...HIDE, stdio: 'ignore' })
        } catch {
          /* 没有 taskkill 就算了 */
        }
      }
      end()
    }, graceMs)
    timer.unref?.()
  })
}

/** 绝对路径判断：Windows 上 `/foo` 不是绝对路径（它是「当前盘符下」的路径）。 */
export function isAbsolutePath(value, win = IS_WIN) {
  const text = String(value || '')
  if (!text) return false
  if (!win) return isAbsolute(text)
  if (!win32.isAbsolute(text)) return false
  // C:\x、C:/x、\\server\share 才算绝对；/x 与 \x 是盘符相对的
  return /^[A-Za-z]:/.test(text) || text.startsWith('\\\\') || text.startsWith('//')
}

/**
 * Claude / Codex 经 Git Bash 给出的 POSIX 风格路径 → 本机路径：
 * `/c/Users/x`、`/cygdrive/c/Users/x`、`/mnt/c/Users/x` → `C:\Users\x`。
 * 已经是 Windows 路径或相对路径的原样返回。POSIX 上不改（返回原值）。
 */
export function toHostPath(value, cwd = process.cwd(), win = IS_WIN) {
  const text = String(value || '').trim()
  if (!text || !win) return text
  if (isAbsolutePath(text, win)) return text
  const P = win32
  const match = /^(?:\/cygdrive|\/mnt)?\/([A-Za-z])(\/.*)?$/.exec(text) || /^\/([A-Za-z])\/(.*)$/.exec(text)
  if (match) {
    const drive = match[1].toUpperCase()
    const rest = String(match[2] || '')
      .replace(/^\/+/, '')
      .split('/')
      .filter(Boolean)
      .join(P.sep)
    return rest ? `${drive}:${P.sep}${rest}` : `${drive}:${P.sep}`
  }
  if (text.startsWith('/')) return P.resolve(cwd, text.slice(1))
  return P.resolve(cwd, text)
}

/** 展示用路径：Windows 上统一 `/` 分隔（Git Bash 和 Windows 工具都认）。 */
export function displayPath(value, win = IS_WIN) {
  const text = String(value || '')
  return win ? text.replace(/\\/g, '/') : text
}

/**
 * target 在 cwd 里 → 返回相对路径（展示用），否则 null。
 * 用 path 的语义判断（Windows 上是 win32：`\`、大小写、盘符都能对上），不再手拼 `cwd + '/'`。
 */
export function relativeInside(cwd, target, pathApi = IS_WIN ? win32 : posix) {
  const base = String(cwd || '')
  const file = String(target || '')
  if (!base || !file) return null
  let rel
  try {
    rel = pathApi.relative(base, file)
  } catch {
    return null
  }
  if (!rel || pathApi.isAbsolute(rel)) return null
  if (rel.split(/[\\/]/)[0] === '..') return null
  return rel
}

/* ------------------------------------------------------------ Git Bash */

/** 只读查注册表（不写，也不改任何系统设置）。 */
function regQuery(key, value) {
  try {
    const run = spawnSync('reg', ['query', key, '/v', value], { ...HIDE, encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] })
    if (run.status !== 0 || !run.stdout) return null
    const match = /InstallPath\s+REG_(?:EXPAND_)?SZ\s+(.+)/i.exec(run.stdout)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

/** Git for Windows 的安装目录（注册表 HKLM/HKCU，含 32 位视图；查不到 null）。 */
export function gitForWindowsHome(win = IS_WIN) {
  if (!win) return null
  for (const key of ['HKLM\\SOFTWARE\\GitForWindows', 'HKCU\\SOFTWARE\\GitForWindows', 'HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows']) {
    const found = regQuery(key, 'InstallPath')
    if (found) return found
  }
  return null
}

/** WSL 的 bash（`WindowsApps\bash.exe` / `System32\bash.exe`）不能当 Git Bash 用。 */
export function isWslBash(file) {
  return WSL_BASH.test(String(file || ''))
}

/**
 * `claude` 需要的 Git Bash 候选（按可信度排序，已排除 WSL 的 bash）：
 *   1. `CLAUDE_CODE_GIT_BASH_PATH`（用户/宿主显式指定）；
 *   2. 注册表里 Git for Windows 的 `<InstallPath>\bin\bash.exe`（以及 `usr\bin\bash.exe`）；
 *   3. 官方自动探测的那两个固定位置 + `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`；
 *   4. scoop 的 git；
 *   5. PATH 上的 `bash`（这台机器上通常先命中 WSL 的，会被排除）。
 * options: { win, gitHome（默认读注册表；null 表示不查）, which（默认 whichFile） }。
 */
export function gitBashCandidates(env = process.env, options = {}) {
  const win = options.win ?? IS_WIN
  if (!win) return [{ path: '/bin/bash', source: 'posix' }, { path: '/usr/bin/bash', source: 'posix' }]
  const list = []
  const push = (path, source) => {
    if (path) list.push({ path: String(path), source })
  }
  push(envGet(env, 'CLAUDE_CODE_GIT_BASH_PATH'), 'env:CLAUDE_CODE_GIT_BASH_PATH')
  const home = 'gitHome' in options ? options.gitHome : gitForWindowsHome(win)
  if (home) {
    push(win32.join(home, 'bin', 'bash.exe'), 'registry')
    push(win32.join(home, 'usr', 'bin', 'bash.exe'), 'registry')
  }
  push('C:\\Program Files\\Git\\bin\\bash.exe', 'common')
  push('C:\\Program Files (x86)\\Git\\bin\\bash.exe', 'common')
  const localAppData = envGet(env, 'LOCALAPPDATA')
  if (localAppData) push(win32.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'), 'common')
  const userProfile = envGet(env, 'USERPROFILE')
  if (userProfile) push(win32.join(userProfile, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'), 'scoop')
  const onPath = options.which ? options.which('bash') : whichFile('bash', env, win)
  push(onPath, 'path')
  const seen = new Set()
  return list.filter((entry) => {
    const key = entry.path.toLowerCase()
    if (seen.has(key) || isWslBash(entry.path)) return false
    seen.add(key)
    return true
  })
}

/** 找到可用的 Git Bash：{ path, source } | null。options.exists 可注入（单测在 Linux 上用）。 */
export function detectGitBash(env = process.env, options = {}) {
  const exists = options.exists || existsSync
  for (const candidate of gitBashCandidates(env, options)) {
    try {
      if (exists(candidate.path)) return candidate
    } catch {
      /* 下一个 */
    }
  }
  return null
}

export function hasGitBash(env = process.env, options = {}) {
  return Boolean(detectGitBash(env, options))
}

/** 候选路径列表（给设置页诊断用，不含「哪个能用」的判断）。 */
export function gitBashPaths(env = process.env, options = {}) {
  return gitBashCandidates(env, options).map((entry) => entry.path)
}

/* --------------------------------------------------------- 子进程环境 */

/** 子进程的基础环境：保留原样，只补齐 PATH / HOME 这类在 Windows 上不齐的东西。 */
export function baseChildEnv(extraDirs = [], options = {}) {
  const win = options.win ?? IS_WIN
  const env = { ...(options.env || process.env) }
  const home = options.home || homedir()
  const dirs = win
    ? [
        win32.join(home, '.local', 'bin'),
        envGet(env, 'APPDATA') ? win32.join(envGet(env, 'APPDATA'), 'npm') : null,
        envGet(env, 'LOCALAPPDATA') ? win32.join(envGet(env, 'LOCALAPPDATA'), 'Programs', 'nodejs') : null,
        'C:\\Program Files\\nodejs',
        ...extraDirs,
      ]
    : [join(home, '.local/bin'), join(home, '.nvm/versions/node', process.version, 'bin'), '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin', ...extraDirs]
  addToPath(env, dirs, win)
  // Git Bash 认 HOME；Windows 上默认只有 USERPROFILE
  if (!envGet(env, 'HOME')) envSet(env, 'HOME', home)
  envDelete(env, 'NODE_ENV')
  return env
}
