/**
 * 文件互通（从 dsh-claude-code-agent 搬来，那边已经实测过）：
 *   - 用户在 DSH 里附带的文件 → 落到会话工作目录的 .dsh-inbox/，并告诉 Claude 位置；
 *   - Claude 用 Write/Edit 写过的文件 → 作为 DSH 交付物（deliverables/presented）挂在本轮上。
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
// 带版本号 import：改 platform.js 也能热加载（ESM 按 URL 缓存）
const { IS_WIN, displayPath, isAbsolutePath, relativeInside, toHostPath } = await import(`./platform.js${new URL(import.meta.url).search}`)

const ATTACHMENT_INBOX = '.dsh-inbox'
// Windows 的路径分隔符是 `\`：两套都认，否则 .git / node_modules 里的文件也会变成交付物
const DELIVERABLE_SKIP = /(^|[\\/])(node_modules|\.git|\.dsh-inbox|dist|build|out|\.cache|__pycache__|target)([\\/]|$)/
const MAX_DELIVERABLES = 10

/** 从一批用户消息里取出附件 part（image / file）。 */
export function attachmentPartsOf(messages) {
  const parts = []
  for (const message of messages || []) {
    const content = Array.isArray(message?.content) ? message.content : []
    for (const part of content) {
      if (part && (part.type === 'image' || part.type === 'file')) parts.push(part)
    }
  }
  return parts
}

// Windows 保留名（CON、PRN、NUL、COM1…）不能当文件名，哪怕带了扩展名
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i

function safeFileName(name, fallback) {
  const base = String(name || '').split(/[\\/]/).pop() || ''
  let cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^\.+/, '').trim()
  if (IS_WIN && WIN_RESERVED.test(cleaned)) cleaned = `_${cleaned}`
  return cleaned.slice(0, 120) || fallback
}

function imageExtension(mediaType) {
  switch (mediaType) {
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    default: return 'png'
  }
}

function formatSize(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 用户通过 DSH 附带的文件 → 落到会话工作目录的 .dsh-inbox/，返回给 claude 的提示前缀。
 *
 * 为什么落盘而不是只把 attachmentId 告诉它：claude 只认文件路径，而且落盘后文件名、扩展名
 * 是干净的（图片能被它的 Read 当图片读）。DSH 的 attachments 服务给了两条路：
 *   readImage/readFileStream 拿字节（首选，能保证文件名）→ 失败再退回 imageHostPath/fileHostPath。
 */
export async function materializeAttachments(ctx, cwd, parts) {
  const notes = []
  const skipped = []
  const list = Array.isArray(parts) ? parts : []
  if (!list.length) return { notes, skipped, dir: null }
  const attachments = ctx.get('attachments')
  const dir = join(cwd, ATTACHMENT_INBOX)
  const used = new Set()
  let made = false

  for (const part of list) {
    const ref = part.attachment || {}
    const id = String(ref.attachmentId || '')
    const fallback = `attachment-${id.slice(0, 8) || Math.random().toString(36).slice(2, 10)}`
    let name = safeFileName(ref.name, fallback)
    if (part.type === 'image' && !/\.(png|jpe?g|webp|gif)$/i.test(name)) name = `${name}.${imageExtension(ref.mediaType)}`
    let target = join(dir, name)
    if (used.has(target)) target = join(dir, `${id.slice(0, 8) || 'dup'}-${name}`)
    used.add(target)

    let bytes = null
    let hostPath = null
    try {
      if (part.type === 'image') {
        const stored = await attachments?.readImage?.(ref)
        if (stored?.data) bytes = Buffer.from(stored.data)
        else hostPath = attachments?.imageHostPath?.(ref) ?? null
      } else if (attachments?.readFileStream) {
        const chunks = []
        for await (const chunk of attachments.readFileStream(ref)) chunks.push(Buffer.from(chunk))
        bytes = Buffer.concat(chunks)
      } else {
        hostPath = attachments?.fileHostPath?.(ref) ?? null
      }
    } catch (error) {
      hostPath = (part.type === 'image' ? attachments?.imageHostPath?.(ref) : attachments?.fileHostPath?.(ref)) ?? null
      if (!hostPath) {
        skipped.push({ name, reason: String(error?.message || error) })
        continue
      }
    }

    if (bytes) {
      try {
        if (!made) { mkdirSync(dir, { recursive: true }); made = true }
        writeFileSync(target, bytes)
      } catch (error) {
        skipped.push({ name, reason: `写到工作目录失败：${error.message}` })
        continue
      }
    }

    const path = bytes ? target : hostPath
    if (!path) {
      skipped.push({ name, reason: 'DSH 没给这个附件暴露文件路径' })
      continue
    }
    // 提示给 Claude 的路径统一用 `/`（Git Bash 和 Windows 工具都认），别给反斜杠
    const shown = bytes ? displayPath(join(ATTACHMENT_INBOX, target.slice(dir.length + 1))) : displayPath(path)
    const kind = part.type === 'image'
      ? `图片${ref.mediaType ? ` ${ref.mediaType}` : ''}${ref.width && ref.height ? ` ${ref.width}×${ref.height}` : ''}`
      : '文件'
    const size = formatSize(ref.bytes || (bytes ? bytes.length : 0))
    notes.push(`- ${shown}（${kind}${size && size !== '0 B' ? `，${size}` : ''}）`)
  }
  return { notes, skipped, dir: made ? dir : null }
}

/** 给 claude 的提示前缀：把附件位置告诉它。 */
export function attachmentPreamble(notes, skipped) {
  if (!notes?.length && !skipped?.length) return ''
  const lines = ['[用户通过 DSH 界面附带了文件，已放在当前工作目录，请按需用 Read 查看]']
  lines.push(...(notes || []))
  for (const item of skipped || []) lines.push(`- ${item.name}（拿不到文件路径：${item.reason}）`)
  return `${lines.join('\n')}\n\n`
}

/**
 * Claude Code 这一轮写过的文件 → 作为 DSH 交付物挂在这个 turn 上。
 * 客户端渲染成可打开的文件卡（事件名和载荷照抄 dsh-tool-present：
 *   session.append('deliverables/presented', { turn, callId, files:[{path, description}]}) ）。
 */
export function appendDeliverables(session, turn, wrote, cwd, seen = new Set()) {
  const files = []
  for (const item of wrote || []) {
    if (files.length >= MAX_DELIVERABLES) break
    const raw = String(item?.path || '').trim()
    if (!raw) continue
    // Claude 在 Git Bash 里常给 /c/Users/... 这种 POSIX 路径；Windows 上 path.isAbsolute('/x') 还是 true 但指错盘
    const abs = isAbsolutePath(raw) ? raw : toHostPath(raw, cwd)
    // 自动交付（Write/Edit）跳过构建产物目录；显式交付的（deliver_files）照交
    if ((item.kind !== 'delivered' && DELIVERABLE_SKIP.test(abs)) || seen.has(abs)) continue
    try {
      if (!statSync(abs).isFile()) continue
    } catch {
      continue // 没真正落盘（或已被删除）就不交付
    }
    seen.add(abs)
    // 用 path 的语义判断是否在工作目录里（Windows 上是 win32：`\`、大小写、盘符都能对上）
    const rel = relativeInside(cwd, abs)
    files.push({
      path: displayPath(rel ?? abs),
      description: item.description || (item.kind === 'created' ? '新建' : item.kind === 'delivered' ? '交付' : '修改'),
    })
  }
  if (!files.length) return []
  session.append('deliverables/presented', { turn, callId: `cc-present-${randomUUID()}`, files })
  return files
}
