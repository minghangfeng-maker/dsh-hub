/**
 * 文件路径的**四步包含检查**（契约 §8.3 / §17「安全」）。
 *
 * 背景（实测）：DSH 的 `workspaceFiles/read|stat` **不做工作区包含检查** ——
 * 模块注释原话是 *"File reads follow the composed filesystem's read access, including
 * paths outside the workspace"*；`/etc/passwd`、`../../etc/hostname` 都能读。所以
 * 「手机只能读自己会话目录里的文件」这条边界**只能由 adapter 实现**。
 *
 * 四步：
 *   1. 拒绝空串 / NUL / 超长；
 *   2. 拒绝 URL、UNC、盘符相对路径；
 *   3. posix 与 win32 各归一化一次，任一残留 `..` 段即拒；
 *   4. 相对路径按会话 cwd 拼成绝对路径，并按**路径段**比较是否落在允许根内；
 *   6~8. 调 `workspaceFiles/stat` 后，用 Host 返回的 `absolutePath`（已 realpath）
 *      **再比一次** —— 这一步堵死「cwd 里放一个指向 /etc/passwd 的软链」。
 */
import { posix, win32 } from 'node:path'

/** 允许根：会话 cwd（+ 部署额外给的根）与 `<chatDir>/artifacts`。 */
export interface PathRules {
  /** 会话的工作目录（绝对路径；云是 `/workspace/chat`，桌面是 Windows 路径）。 */
  cwd: string
  /** 额外允许的绝对路径根（例如 `<chatDir>/artifacts`）。 */
  roots: readonly string[]
}

export type PathStyle = 'posix' | 'win32'

export type ResolvedPath = { ok: true; absolute: string; style: PathStyle } | { ok: false; reason: string }

/** 单段路径的最大长度（契约 §8.3 第 1 步）。 */
export const MAX_PATH_INPUT = 4096

/** 按写法判断路径风格：盘符或 UNC 前缀 → win32；其余按 posix。 */
export function pathStyleOf(value: string): PathStyle {
  if (/^[A-Za-z]:[\\/]/u.test(value)) return 'win32'
  if (/^\\\\/u.test(value)) return 'win32'
  return 'posix'
}

function implOf(style: PathStyle): typeof posix {
  return style === 'win32' ? win32 : posix
}

function separators(style: PathStyle, value: string): string[] {
  const pattern = style === 'win32' ? /[\\/]+/u : /\/+/u
  return value.split(pattern).filter((part) => part !== '' && part !== '.')
}

/**
 * 归一化成「可以按路径段比较」的形式：统一分隔符、win32 小写、去掉尾部分隔符。
 * 只用于**比较**，不用于再回传给 Host（回传的永远是 Host 自己给的 absolutePath）。
 */
export function comparablePath(value: string): string {
  const style = pathStyleOf(value)
  const normalized = implOf(style).normalize(value)
  const unified = normalized.replace(/[\\/]+/gu, '/')
  const trimmed = unified.length > 1 ? unified.replace(/\/+$/u, '') : unified
  return style === 'win32' ? trimmed.toLowerCase() : trimmed
}

/** `candidate` 是否落在 `roots` 之一内（按路径段，不是字符串前缀）。 */
export function isInsideRoots(candidate: string, roots: readonly string[]): boolean {
  const target = comparablePath(candidate)
  if (target === '' || target === '.') return false
  for (const root of roots) {
    if (root === '') continue
    const base = comparablePath(root)
    if (base === '' || base === '.') continue
    if (target === base) return true
    if (target.startsWith(base.endsWith('/') ? base : `${base}/`)) return true
  }
  return false
}

/** 第 1、2 步：输入本身的形状检查（不做任何文件系统访问）。 */
export function rejectReasonOfShape(input: string): string | null {
  if (typeof input !== 'string') return 'path-missing'
  if (input.length === 0) return 'path-empty'
  if (input.length > MAX_PATH_INPUT) return 'path-too-long'
  if (input.includes('\u0000')) return 'path-nul'
  if (input.includes('://')) return 'path-url'
  if (/^\\\\/u.test(input)) return 'path-unc'
  // 盘符相对（C:foo）会被 win32 解析成「C 盘当前目录」，含义不可控
  if (/^[A-Za-z]:(?![\\/])/u.test(input)) return 'path-drive-relative'
  return null
}

/**
 * 第 1~5 步：把客户端给的路径变成**候选绝对路径**并做词法包含检查。
 *
 * 注意：这一步只看字符串。真正允许读之前必须再走 `authorizeStat()`（realpath 兜底）。
 */
export function resolveRequestPath(input: string, rules: PathRules): ResolvedPath {
  const shape = rejectReasonOfShape(input)
  if (shape !== null) return { ok: false, reason: shape }
  const style = pathStyleOf(rules.cwd)
  const impl = implOf(style)
  const base = rules.cwd
  // 相对路径按会话 cwd 拼；绝对路径原样（两个风格都试一遍，防止 `\` 写法绕过）
  const joined = impl.isAbsolute(input) ? input : impl.join(base, input)
  const normalized = impl.normalize(joined)
  // 第 3 步：任一风格归一化后仍残留 `..` 段 → 拒（`..` 只可能出现在最前面）
  for (const candidateStyle of ['posix', 'win32'] as const) {
    if (separators(candidateStyle, implOf(candidateStyle).normalize(normalized)).includes('..')) {
      return { ok: false, reason: 'path-dotdot' }
    }
    if (separators(candidateStyle, input).includes('..')) {
      // 输入里出现 `..` 段本身也拒：不允许用相对回退跨出会话目录（即便最终落在根内）
      return { ok: false, reason: 'path-dotdot' }
    }
  }
  if (!isInsideRoots(normalized, [base, ...rules.roots])) return { ok: false, reason: 'path-outside-roots' }
  return { ok: true, absolute: normalized, style }
}

/**
 * 第 6~8 步：Host `stat` 已经 realpath 过，用返回值再比一次根。
 *
 * 这一步是**软链逃逸的唯一防线**：词法检查只能保证「请求的字符串」在根内，
 * `cwd/link -> /etc/passwd` 的 realpath 是 `/etc/passwd`，只有这里能拦住。
 */
export function authorizeStat(absolutePath: string, rules: PathRules): boolean {
  if (absolutePath === '' || absolutePath.includes('\u0000')) return false
  return isInsideRoots(absolutePath, [rules.cwd, ...rules.roots])
}

/** 把绝对路径变成相对会话根的展示名（`pathLabel` 永不带绝对路径）。 */
export function relativeLabel(absolutePath: string, cwd: string): string {
  const style = pathStyleOf(cwd)
  const impl = implOf(style)
  const relative = impl.relative(cwd, absolutePath)
  return relative === '' ? '.' : relative.replace(/\\/gu, '/')
}

/** `fileRef` 的载荷：对 App 不透明；adapter 内部是 `b64url(JSON)`。 */
export interface FileRefPayload {
  v: 1
  /** 会话 id：`fileRef` 只在签发它的会话里有效（防止跨会话重放）。 */
  s: string
  /** 绝对路径（已经过包含检查）。 */
  p: string
}

export function encodeFileRef(payload: FileRefPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/** 解不开或版本不对一律 null（调用方回 `file-refused`，不回显内容）。 */
export function decodeFileRef(value: string): FileRefPayload | null {
  if (value.length === 0 || value.length > 2048) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (record['v'] !== 1) return null
  if (typeof record['s'] !== 'string' || record['s'] === '') return null
  if (typeof record['p'] !== 'string' || record['p'] === '') return null
  return { v: 1, s: record['s'], p: record['p'] }
}
