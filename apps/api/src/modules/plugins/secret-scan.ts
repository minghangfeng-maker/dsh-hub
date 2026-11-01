import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * 插件包密钥扫描（06 §2.1）。入库前对包内**所有文本文件**做模式匹配，命中即拒绝入库。
 *
 * 两条硬要求：
 * 1. 只回 `{file, line, rule}`，**绝不回显命中的值**（否则日志/界面又泄漏一遍）。
 * 2. 常见误报要放过：`apiKeyEnv: FOO`（env 名，不是密钥）、`${VAR}`、`<your-key>`、`your-api-key` 等占位符。
 */

export interface SecretHit {
  /** 包内相对路径（`/` 分隔） */
  file: string
  /** 1 开始的行号 */
  line: number
  /** 规则名（稳定标识，前端/报告展示用） */
  rule: string
}

/** 单个文件扫描上限：再大就不像配置文件（避免把构建产物读进内存） */
export const MAX_SCAN_FILE_BYTES = 512 * 1024
/** 一次扫描的文件数上限 */
export const MAX_SCAN_FILES = 4000
/** 不扫的目录 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.pnpm-store', 'dist', 'build', '.cache'])

/** 扫描的文件类型（06 §2.1 的告警只针对插件包内的配置/源码；压缩产物不做赋值类检测） */
export const SCANNABLE_EXTENSIONS = ['.js', '.cjs', '.mjs', '.ts', '.json', '.yml', '.yaml', '.env'] as const

/** 超长行（打包/压缩产物）只做前缀类检测，避免把压缩代码里的普通赋值当密钥 */
export const LONG_LINE_CHARS = 2000

/** 形如 `<apiKey|token|secret|password|accessKey>` 的赋值行；**值**还要通过下面的严格检查 */
const ASSIGNMENT_RE =
  /^\s*(?:-\s*)?["']?([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|token|secret|password|passwd|accesskey|access[_-]?key|secret[_-]?key)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*(.+?)\s*$/i

interface PatternRule {
  name: string
  re: RegExp
}

/** 高置信度的密钥形状（命中即拒绝） */
const PATTERN_RULES: PatternRule[] = [
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/u },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/u },
  { name: 'modelscope-token', re: /\bms-[A-Za-z0-9]{20,}\b/u },
  { name: 'huggingface-token', re: /\bhf_[A-Za-z0-9]{20,}\b/u },
  { name: 'github-token', re: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/u },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/u },
  { name: 'slack-token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/u },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u },
  { name: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/u },
  // 用 new RegExp 写：字符类里的 `/` 在正则字面量里必须转义，容易看错
  { name: 'basic-auth-url', re: new RegExp('\\b[a-z][a-z0-9+.-]*://[^\\s/:@]+:[^\\s/@]{8,}@', 'iu') },
]

/** 文件名本身就是凭据文件 → 直接拒绝 */
const SENSITIVE_FILES = ['.credentials.yaml', 'credentials.yaml', 'id_rsa', 'id_ed25519', '.npmrc']

/** 值明显是占位符/引用 → 不报 */
function looksLikePlaceholder(value: string): boolean {
  const trimmed = value.replace(/^["']|["']$/gu, '').trim()
  if (trimmed.length === 0) return true
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/u.test(trimmed)) return true // ${VAR} / $VAR
  if (/^%[A-Za-z_][A-Za-z0-9_]*%$/u.test(trimmed)) return true // %VAR%
  if (/^<[^>]*>$/u.test(trimmed)) return true // <your-key>
  if (/^process\.env\./u.test(trimmed)) return true
  if (
    /^(?:your|my|the|some|example|sample|test|dummy|fake|placeholder|change[-_]?me|todo|xxx+)[-_ ]/iu.test(
      trimmed,
    )
  )
    return true
  if (/^[A-Z][A-Z0-9_]*$/u.test(trimmed)) return true // FOO_ENV_NAME（含 apiKey: FOO）
  if (/^(?:null|true|false|none|undefined|\{\}|\[\])$/iu.test(trimmed)) return true
  if (trimmed.startsWith('!') || trimmed.startsWith('ref:')) return true
  return false
}

/**
 * 值是否「像」真密钥（D7 修复后的严格版）。
 *
 * 只认**不透明的高熵串**：长、无空白、无代码符号、非中文、非路径/URL/点号标识符，
 * 且字母+数字混合、香农熵达标。普通赋值（`token = this.token`、`apiKey: config.key`、
 * `label = '发送中…'`、i18n 中文文案）一律不报——这正是 `dsh-email@0.16.2` 误报的原因。
 */
export function looksLikeSecretValue(value: string): boolean {
  const trimmed = value.replace(/^["']|["']$/gu, '').trim()
  if (looksLikePlaceholder(trimmed)) return false
  // 带前缀的高置信度形状由 PATTERN_RULES 负责，这里只处理「无前缀但高熵」的值
  if (trimmed.length < 24) return false
  if (/\s/u.test(trimmed)) return false
  if (/[\u3400-\u9FFF\uF900-\uFAFF]/u.test(trimmed)) return false // 中文文案
  if (/[(){}[\]<>$,;!?*#@%^&|~`'"]/u.test(trimmed)) return false // 代码符号
  if (trimmed.includes('://') || trimmed.includes('/') || trimmed.includes('\\')) return false // URL/路径
  if (!/^[A-Za-z0-9+=_.:-]+$/u.test(trimmed)) return false
  if (/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z0-9_.]+$/u.test(trimmed)) return false // a.b.c 标识符/属性访问
  if (!/[A-Za-z]/u.test(trimmed) || !/[0-9]/u.test(trimmed)) return false // 要有字母也有数字
  return shannonEntropy(trimmed) >= 3.2
}

/** 香农熵（bits/char）：随机密钥通常 > 3.5，自然语言/重复串 < 3 */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const p = count / value.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

/** 文件是否属于「要扫的源码/配置」类型（D7：node_modules 之外的常见文本文件） */
export function isScannableFile(file: string): boolean {
  const lower = file.toLowerCase()
  const base = lower.split('/').pop() ?? lower
  if (base === '.env' || base.startsWith('.env.') || base.endsWith('.env')) return true
  return SCANNABLE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/**
 * 扫一段文本。赋值类规则（`apiKey: …`）只在值看起来是真密钥时命中；
 * `apiKeyEnv: FOO` / `tokenEnv: ${TOKEN}` 这类引用不会命中（06 §2.1 的误报要求）。
 */
export function scanText(file: string, content: string): SecretHit[] {
  const hits: SecretHit[] = []
  const lines = content.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    let matched = false
    for (const rule of PATTERN_RULES) {
      if (rule.re.test(line)) {
        hits.push({ file, line: index + 1, rule: rule.name })
        matched = true
        break
      }
    }
    // 打包/压缩后的超长行只做前缀类检测（D7：避免把压缩代码里的普通赋值当密钥）
    if (matched || line.length > LONG_LINE_CHARS) continue
    const assignment = ASSIGNMENT_RE.exec(line)
    if (assignment) {
      const key = assignment[1] ?? ''
      const value = assignment[2] ?? ''
      // apiKeyEnv / *_env：值是环境变量名，不是密钥本身
      if (!/(?:env|ref)$/iu.test(key) && looksLikeSecretValue(value)) {
        hits.push({ file, line: index + 1, rule: 'secret-assignment' })
      }
    }
    // `config_yaml` 里常见 `apiKeyEnv: HUB_MK_FOO`：HUB_MK_ 是 Hub 注入的 env 前缀，永远不算密钥
    void 0
  }
  return dedupeHits(hits)
}

function dedupeHits(hits: SecretHit[]): SecretHit[] {
  const seen = new Set<string>()
  return hits.filter((hit) => {
    const key = `${hit.file}:${hit.line}:${hit.rule}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 按文件名判定的规则（命中即拒绝，行号记 1） */
export function scanFileNames(files: string[]): SecretHit[] {
  const hits: SecretHit[] = []
  for (const file of files) {
    const base = file.split('/').pop() ?? file
    if (SENSITIVE_FILES.includes(base)) hits.push({ file, line: 1, rule: 'credentials-file' })
  }
  return hits
}

export function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192)
  return sample.includes(0)
}

export interface ScanDirectoryResult {
  hits: SecretHit[]
  scannedFiles: number
}

/**
 * 扫一个已解包/已展开的插件目录（跳过 node_modules/.git/构建产物与二进制文件）。
 * 目录不存在或不可读时抛错——入库流程必须因此失败，而不是静默放行。
 */
export function scanDirectory(root: string, opts: { maxFiles?: number } = {}): ScanDirectoryResult {
  const maxFiles = opts.maxFiles ?? MAX_SCAN_FILES
  const files: string[] = []
  const stack = ['']
  while (stack.length > 0) {
    const rel = stack.pop()!
    const abs = rel ? join(root, rel) : root
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        stack.push(childRel)
      } else if (entry.isFile()) {
        if (!isScannableFile(childRel)) continue
        files.push(childRel)
        if (files.length > maxFiles) throw new Error(`插件包文件数超过 ${String(maxFiles)}，拒绝扫描`)
      }
    }
  }

  const hits = scanFileNames(files)
  let scannedFiles = 0
  for (const rel of files.sort()) {
    const abs = join(root, rel.split('/').join(sep))
    const stat = statSync(abs)
    if (stat.size > MAX_SCAN_FILE_BYTES) continue
    const buffer = readFileSync(abs)
    if (isProbablyBinary(buffer)) continue
    scannedFiles += 1
    hits.push(...scanText(rel, buffer.toString('utf8')))
    if (hits.length > 50) break // 够多了：报告前 50 条即可，不必扫完
  }
  return { hits, scannedFiles }
}

/** 相对路径（`/` 分隔），用于把 tar 内路径与目录扫描结果统一展示 */
export function toPosixRelative(root: string, file: string): string {
  return relative(root, file).split(sep).join('/')
}
