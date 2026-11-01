import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WEAK_PASSWORDS } from '@dsh-hub/shared'

/**
 * 弱口令黑名单（02 §5「内置 Top-1000 弱口令」）。
 *
 * 词表分两处：`@dsh-hub/shared` 的内置小表（前后端共用、无 IO）与同目录的
 * `weak-passwords.txt`（约 1500 条常见弱口令/键盘走位/拼音，`#` 开头是注释）。
 * 比较一律小写做，加载失败时退化成内置表——**不能**因为少一个文件就让注册 500。
 */
let cache: { words: Set<string>; source: 'file' | 'builtin' } | null = null

/** 词表文件位置：构建产物在 dist/lib/ 旁边，源码直跑时回退到 src/lib/ */
function resolveWordListFile(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const beside = join(here, 'weak-passwords.txt')
  if (existsSync(beside)) return beside
  return join(here, '..', '..', 'src', 'lib', 'weak-passwords.txt')
}

function load(): { words: Set<string>; source: 'file' | 'builtin' } {
  const words = new Set<string>(WEAK_PASSWORDS.map((w) => w.toLowerCase()))
  const file = resolveWordListFile()
  if (!existsSync(file)) return { words, source: 'builtin' }
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const value = line.trim().toLowerCase()
    if (value.length === 0 || value.startsWith('#')) continue
    words.add(value)
  }
  return { words, source: 'file' }
}

function table(): { words: Set<string>; source: 'file' | 'builtin' } {
  cache ??= load()
  return cache
}

/** 是否命中弱口令（大小写不敏感；前后空白不参与比较） */
export function isWeakPassword(password: string): boolean {
  return table().words.has(password.trim().toLowerCase())
}

/** 词表规模（自检与测试用：应 ≥ 1000） */
export function weakPasswordCount(): number {
  return table().words.size
}

/** 词表来源（`builtin` 表示没读到 weak-passwords.txt，仅内置表可用） */
export function weakPasswordSource(): 'file' | 'builtin' {
  return table().source
}
