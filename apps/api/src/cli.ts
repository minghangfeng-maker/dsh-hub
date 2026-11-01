import { collectTlsInfo, renderTlsInfo } from './cli-tls.js'
import { HUB_VERSION, loadConfig } from './config.js'
import { openDb } from './db/index.js'
import { runMigrations } from './db/migrate.js'
import { systemClock } from './lib/clock.js'
import { createPaths } from './lib/paths.js'
import {
  CLI_USAGE,
  createAdminCommand,
  readPassword,
  resetPasswordCommand,
  userListCommand,
  type CliContext,
} from './cli-users.js'
import {
  flagValue as opsFlagValue,
  hasFlag,
  numberFlag,
  runAdoptRuntime,
  runDbBackup,
  runDoctor,
  runStopAll,
} from './ops/index.js'

/**
 * 最小命令分发器：`node dist/cli.js <cmd>`（11 §6）。
 * 用户命令（create-admin / user:list / user:reset-password）归 WP1，实现放 `cli-users.ts`；
 * WP7a 的运维命令（db:backup / instance:stop-all / doctor）实现在 `ops/`，这里只做分发。
 * 两边各自加 case 与 USAGE 段落，互不改动对方的逻辑。
 */
const USAGE = `dsh-hub CLI ${HUB_VERSION}

用法：node dist/cli.js <命令> [参数]

命令：
  migrate    执行数据库迁移（读 HUB_DATA_DIR，默认 <repo>/.data）
  version    打印版本
  help       显示本帮助
${CLI_USAGE}
阶段二（WP7b，08 §3–§6）：
  tls:info   查看 TLS 证书：来源、主体、SAN、签发者、到期时间、剩余天数、SHA-256 指纹

运维命令（WP7a，08 §8 §10）：
  db:backup [--out DIR] [--keep-days N]
             SQLite VACUUM INTO + secrets 打包（默认 <HUB_DATA_DIR>/backups，保留 14 天）
  instance:stop-all [--dry-run] [--timeout SEC]
             停掉所有 Hub 管理的容器（label dshhub.managed=1）
  doctor      自检：Docker 可达、数据目录权限、磁盘余量、默认 runtime 是否存在
  runtime:adopt <dshVersion> [--default] [--allow-version-mismatch]
               把本机已存在的 dshhub/runtime:<版本> 镜像登记为 ready 的运行时
               （校验镜像存在 + 冒烟 dsh --version 与版本一致；--default 同时设为默认版本）
               --allow-version-mismatch：镜像 tag 带构建后缀（如 0.2.1-rc.2-chat1）时放行版本差异
`

/** 极简 flag 解析：`--key value` / `--flag`，够用且不引依赖 */
function parseFlags(argv: string[]): { positionals: string[]; flags: Record<string, string | true> } {
  const positionals: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next
      i += 1
    } else {
      flags[key] = true
    }
  }
  return { positionals, flags }
}

function flagValue(flags: Record<string, string | true>, key: string): string | undefined {
  const value = flags[key]
  return typeof value === 'string' ? value : undefined
}

/** 打开数据库并跑迁移（CLI 直接连数据目录，不启动 HTTP 服务） */
function openCliContext(): { ctx: CliContext; close: () => void } {
  const config = loadConfig()
  const paths = createPaths(config.dataDir)
  paths.ensureBaseDirs()
  const db = openDb(paths.dbFile)
  runMigrations(db, { log: (line) => process.stdout.write(`${line}\n`) })
  return {
    ctx: {
      db,
      clock: systemClock,
      io: {
        out: (text) => process.stdout.write(text),
        err: (text) => process.stderr.write(text),
      },
    },
    close: () => db.close(),
  }
}

async function runUserCommand(argv: string[]): Promise<number> {
  const command = argv[0]
  const { positionals, flags } = parseFlags(argv.slice(1))
  const { ctx, close } = openCliContext()
  try {
    switch (command) {
      case 'create-admin': {
        const username = flagValue(flags, 'username') ?? positionals[0]
        if (!username) {
          ctx.io.err('用法：create-admin --username <u> [--display-name <昵称>] [--password-stdin]\n')
          return 1
        }
        const password = flags['password-stdin'] === true ? await readPassword('') : await readPassword('密码：', true)
        return createAdminCommand(ctx, {
          username,
          displayName: flagValue(flags, 'display-name'),
          password,
        })
      }
      case 'user:list':
        return userListCommand(ctx)
      case 'user:reset-password': {
        const username = flagValue(flags, 'username') ?? positionals[0]
        if (!username) {
          ctx.io.err('用法：user:reset-password <username>\n')
          return 1
        }
        return resetPasswordCommand(ctx, username)
      }
      default:
        return -1
    }
  } finally {
    close()
  }
}

const USER_COMMANDS = new Set(['create-admin', 'user:list', 'user:reset-password'])

async function main(): Promise<number> {
  const command = process.argv[2]
  const args = process.argv.slice(3)

  if (command && USER_COMMANDS.has(command)) {
    return runUserCommand(process.argv.slice(2))
  }

  switch (command) {
    case 'version': {
      process.stdout.write(`dsh-hub ${HUB_VERSION} (node ${process.version})\n`)
      return 0
    }
    case 'migrate': {
      const config = loadConfig()
      const paths = createPaths(config.dataDir)
      paths.ensureBaseDirs()
      const db = openDb(paths.dbFile)
      try {
        const result = runMigrations(db, { log: (line) => process.stdout.write(`${line}\n`) })
        process.stdout.write(
          `迁移完成：应用 ${result.applied.length} 个、跳过 ${result.skipped.length} 个，当前版本 ${result.current ?? '—'}\n`,
        )
        return 0
      } finally {
        db.close()
      }
    }

    // ── WP7a 运维命令 ────────────────────────────────────────────────────────
    case 'db:backup': {
      const config = loadConfig()
      const result = await runDbBackup({
        config,
        outDir: opsFlagValue(args, '--out'),
        keepDays: numberFlag(args, '--keep-days', 14),
        log: (line) => process.stdout.write(`${line}\n`),
      })
      process.stdout.write(
        `备份完成：${result.dbFile}（${result.dbBytes} B）` +
          `${result.secretsFile ? ` + ${result.secretsFile}` : ''}\n`,
      )
      return 0
    }
    case 'instance:stop-all': {
      const config = loadConfig()
      const result = await runStopAll({
        config,
        dryRun: hasFlag(args, '--dry-run'),
        timeoutSec: numberFlag(args, '--timeout', 10),
        log: (line) => process.stdout.write(`${line}\n`),
      })
      process.stdout.write(
        `共 ${result.total} 个容器：停止 ${result.stopped.length}、本来就停着 ${result.alreadyStopped.length}、失败 ${result.failed.length}\n`,
      )
      return result.failed.length === 0 ? 0 : 1
    }
    case 'doctor': {
      const config = loadConfig()
      const result = await runDoctor({
        config,
        log: (line) => process.stdout.write(`${line}\n`),
      })
      return result.failed === 0 ? 0 : 1
    }
    // ── WP8b P1：登记本机已有镜像（首次部署不必重新构建） ────────────────────
    case 'runtime:adopt': {
      const dshVersion = args.find((arg) => !arg.startsWith('--'))
      if (!dshVersion) {
        process.stderr.write('用法：runtime:adopt <dshVersion> [--default] [--allow-version-mismatch]\n')
        return 1
      }
      const { ctx, close } = openCliContext()
      try {
        const result = await runAdoptRuntime({
          config: loadConfig(),
          db: ctx.db,
          dshVersion,
          makeDefault: hasFlag(args, '--default'),
          allowVersionMismatch: hasFlag(args, '--allow-version-mismatch'),
          log: (line) => process.stdout.write(`${line}\n`),
        })
        process.stdout.write(
          `runtime #${String(result.runtimeId)}：${result.image}（${result.dshVersion}）ready` +
            `${result.isDefault ? '，默认版本' : ''}\n`,
        )
        return 0
      } finally {
        close()
      }
    }

    // ── WP7b：证书信息（deploy/hubctl tls:info） ─────────────────────────────
    case 'tls:info': {
      const config = loadConfig()
      return renderTlsInfo(collectTlsInfo(config), (text) => process.stdout.write(text))
    }

    case 'help':
    case undefined: {
      process.stdout.write(USAGE)
      return command === undefined ? 1 : 0
    }
    default: {
      process.stderr.write(`未知命令：${command}\n\n${USAGE}`)
      return 1
    }
  }
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    process.stderr.write(`命令执行失败：${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  },
)
