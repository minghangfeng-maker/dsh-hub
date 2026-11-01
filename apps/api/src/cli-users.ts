import { USERNAME_REGEX } from '@dsh-hub/shared'
import type { Clock } from './lib/clock.js'
import { HubError } from './lib/errors.js'
import { newSlug, newTempPassword } from './lib/ids.js'
import { checkPasswordStrength, hashPassword } from './lib/password.js'
import { revokeUserSessions } from './lib/session.js'
import { assertUsernameAvailable } from './lib/usernames.js'
import { findUserByUsername } from './lib/user-view.js'
import type { HubDb } from './db/index.js'
import { insertUserAsAdmin, setPasswordAndRevokeFlag } from './modules/admin-users/repo.js'

/**
 * 用户相关 CLI 命令（任务书交付物 4）：`create-admin`、`user:list`、`user:reset-password`。
 *
 * 与 `cli.ts` 分离是为了可测：命令只依赖 `{db, clock, io}`，测试直接注入假 io 断言输出，
 * 真正的进程/终端交互留在 `cli.ts` 的 `runCliUserCommand`。
 */
export interface CliIo {
  out(text: string): void
  err(text: string): void
}

export interface CliContext {
  db: HubDb
  clock: Clock
  io: CliIo
}

export const CLI_USAGE = `  create-admin --username <u> [--display-name <昵称>] [--password-stdin]
              创建管理员账号（交互式输入密码，或用 --password-stdin 从管道读）
  user:list   列出全部用户（含角色、状态、最近登录）
  user:reset-password <username>
              重置用户密码（生成 14 位临时密码，强制下次登录修改，并吊销其全部会话）
`

export interface CreateAdminOptions {
  username: string
  displayName?: string
  /** 已经拿到的密码（来自 --password-stdin 或交互输入）；不给则报错 */
  password?: string
}

/** `create-admin`：建一个 active 的管理员账号 */
export function createAdminCommand(ctx: CliContext, opts: CreateAdminOptions): number {
  const { db, clock, io } = ctx
  const username = opts.username.trim().toLowerCase()
  if (!USERNAME_REGEX.test(username)) {
    io.err(`用户名不合法：${opts.username}（只能小写字母开头，3–32 位小写字母/数字/-/_）\n`)
    return 1
  }
  try {
    assertUsernameAvailable(db, username)
  } catch (error) {
    if (error instanceof HubError && error.code === 'USERNAME_RESERVED') {
      io.err(`该用户名是系统保留字，请换一个（例如 hubadmin）：${username}\n`)
      return 1
    }
    if (error instanceof HubError && error.code === 'USERNAME_TAKEN') {
      io.err(`用户名已被占用：${username}\n`)
      return 1
    }
    throw error
  }
  if (!opts.password) {
    io.err('缺少密码：交互式运行会提示输入，或使用 --password-stdin\n')
    return 1
  }
  const reasons = checkPasswordStrength(opts.password, username)
  if (reasons.length > 0) {
    io.err(`密码强度不足：${reasons.join('；')}\n`)
    return 1
  }

  const now = clock.nowIso()
  const id = insertUserAsAdmin(db, {
    slug: newSlug(),
    username,
    displayName: opts.displayName?.trim() || username,
    passwordHash: hashPassword(opts.password),
    role: 'admin',
    roleLabel: '',
    // CLI 是运维在本机执行，密码由本人设定，不强制改密
    mustChangePassword: false,
    at: now,
  })
  io.out(`已创建管理员 #${id}：${username}\n`)
  return 0
}

/** `user:list`：一行一个用户 */
export function userListCommand(ctx: CliContext): number {
  const rows = ctx.db.all<{
    id: number
    username: string
    role: string
    status: string
    created_at: string
    last_login_at: string | null
    deleted_at: string | null
  }>(
    `SELECT id, username, role, status, created_at, last_login_at, deleted_at
       FROM users ORDER BY id ASC`,
  )
  if (rows.length === 0) {
    ctx.io.out('（还没有任何用户）\n')
    return 0
  }
  ctx.io.out('ID    用户名                 角色    状态        注册时间                 最近登录\n')
  for (const row of rows) {
    const deleted = row.deleted_at ? '(已删除)' : ''
    ctx.io.out(
      `${String(row.id).padEnd(6)}${row.username.padEnd(22)}${row.role.padEnd(8)}${(row.status + deleted).padEnd(
        12,
      )}${row.created_at.padEnd(25)}${row.last_login_at ?? '—'}\n`,
    )
  }
  ctx.io.out(`共 ${rows.length} 个用户\n`)
  return 0
}

/** `user:reset-password <username>`：临时密码只打印一次，并吊销该用户全部会话 */
export function resetPasswordCommand(ctx: CliContext, username: string): number {
  const { db, clock, io } = ctx
  const row = findUserByUsername(db, username)
  if (!row || row.deleted_at) {
    io.err(`用户不存在：${username}\n`)
    return 1
  }
  const tempPassword = newTempPassword(14)
  const now = clock.nowIso()
  setPasswordAndRevokeFlag(db, row.id, hashPassword(tempPassword), now)
  const revoked = revokeUserSessions(db, row.id, now)
  io.out(`已重置 ${row.username} 的密码（吊销 ${revoked} 个会话）\n`)
  io.out(`临时密码：${tempPassword}\n`)
  io.out('该密码只显示这一次；用户下次登录后必须立即修改。\n')
  return 0
}

/** `create-admin` 的密码输入：管道优先，TTY 下隐藏回显并要求二次确认 */
export async function readPassword(prompt: string, confirm = false): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array))
    return Buffer.concat(chunks)
      .toString('utf8')
      .split('\n')[0]!
      .trim()
  }
  const first = await readHiddenLine(prompt)
  if (!confirm) return first
  const second = await readHiddenLine('再输入一次确认：')
  if (first !== second) throw new HubError('VALIDATION_FAILED', '两次输入的密码不一致')
  return first
}

/** 关掉回显读一行（TTY 原始模式；Ctrl-C 直接退出） */
function readHiddenLine(prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin
    process.stdout.write(prompt)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let value = ''
    const cleanup = (): void => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
    }
    const onData = (char: string): void => {
      if (char === '\n' || char === '\r' || char === '\u0004') {
        cleanup()
        process.stdout.write('\n')
        resolve(value)
        return
      }
      if (char === '\u0003') {
        cleanup()
        process.stdout.write('\n已取消\n')
        reject(new HubError('CONFLICT', '已取消'))
        return
      }
      if (char === '\u007f' || char === '\b') {
        value = value.slice(0, -1)
        return
      }
      if (char >= ' ') value += char
    }
    stdin.on('data', onData)
  })
}
