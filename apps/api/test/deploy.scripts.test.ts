import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * 部署与运维脚本的静态 + 行为测试（任务书「测试」节）：
 * - 所有 shell 脚本 `bash -n`（有 shellcheck 就顺带跑）；
 * - `deploy/nft/dshhub.nft` 与 02 §4 的代码块逐行一致（只容忍已记录的链名改名）；
 * - `nft/install.sh --dry-run/--print` 的渲染结果与失败判定；
 * - `deploy/upgrade.sh` 的回退逻辑（临时 git 仓库 + 假 pnpm/systemctl/curl）；
 * - systemd 单元的关键字段；prereq.sh 只读；backup.sh 干跑不写文件。
 */
const REPO = fileURLToPath(new URL('../../../', import.meta.url))

function repoPath(rel: string): string {
  return join(REPO, rel)
}

/** 直接跑脚本，返回 {code, output} */
function runScript(
  script: string,
  args: string[] = [],
  opts: { env?: Record<string, string>; cwd?: string } = {},
): { code: number; output: string } {
  const result = spawnSync('bash', [script, ...args], {
    cwd: opts.cwd ?? REPO,
    env: { ...process.env, ...opts.env },
    encoding: 'utf8',
  })
  return { code: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function listShellScripts(): string[] {
  const dirs = ['deploy', 'scripts']
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith('.sh')) {
        found.push(full)
      }
    }
  }
  for (const dir of dirs) walk(repoPath(dir))
  return found.sort()
}

describe('shell 脚本静态检查', () => {
  it('bash -n 全部通过', () => {
    const scripts = listShellScripts()
    expect(scripts.length).toBeGreaterThanOrEqual(6)
    for (const script of scripts) {
      const result = spawnSync('bash', ['-n', script], { encoding: 'utf8' })
      expect(result.status, `${script}: ${result.stderr}`).toBe(0)
    }
  })

  it('shellcheck（没装就跳过，并在测试输出里注明）', () => {
    const probe = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' })
    if (probe.error || probe.status !== 0) {
      console.warn('shellcheck 未安装，跳过 shellcheck 检查（bash -n 已覆盖语法）')
      return
    }
    const scripts = listShellScripts()
    const result = spawnSync('shellcheck', ['-x', '-S', 'warning', ...scripts], { encoding: 'utf8' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
  })
})

describe('nft 出网规则与 02 §4 一致', () => {
  it('规则行与文档代码块逐行一致（只容忍 chain fwd → fwd4）', () => {
    const doc = readFileSync(repoPath('docs/design/02-安全设计.md'), 'utf8')
    const block = /```nft\n([\s\S]*?)```/.exec(doc)
    expect(block, 'docs/design/02-安全设计.md 里应该有 ```nft 代码块').toBeTruthy()
    const normalize = (text: string): string =>
      text
        .split('\n')
        .map((line) => line.replace(/\s+$/, ''))
        .filter((line) => line.trim().length > 0 && !line.trim().startsWith('#'))
        .map((line) => line.replace(/chain fwd \{/, 'chain fwd4 {')) // fwd 是 nft 保留字
        .join('\n')
    expect(normalize(readFileSync(repoPath('deploy/nft/dshhub.nft'), 'utf8'))).toBe(normalize(block![1]!))
  })

  it('文件头记录了为什么改链名（防止有人「修回去」）', () => {
    const text = readFileSync(repoPath('deploy/nft/dshhub.nft'), 'utf8')
    expect(text).toMatch(/保留字/)
    expect(text).toMatch(/fwd4/)
  })

  it('nft -c -f 只报 netlink 权限错误（语法层面通过）', () => {
    const probe = spawnSync('nft', ['--version'], { encoding: 'utf8' })
    if (probe.error) {
      console.warn('没装 nft，跳过 nft -c 检查')
      return
    }
    const result = spawnSync('nft', ['-c', '-f', repoPath('deploy/nft/dshhub.nft')], {
      encoding: 'utf8',
    })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    const realErrors = output
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .filter((line) => !line.includes('netlink: Error: cache initialization failed'))
    expect(realErrors, realErrors.join('\n')).toEqual([])
  })

  it('install.sh --print 渲染出规则与 systemd 单元', () => {
    const result = runScript(repoPath('deploy/nft/install.sh'), ['--print'])
    expect(result.code).toBe(0)
    expect(result.output).toContain('table inet dshhub')
    expect(result.output).toContain('chain fwd4')
    expect(result.output).toContain('ip saddr $USERS drop')
    expect(result.output).toContain('After=docker.service')
    expect(result.output).toContain('ExecStart=/usr/sbin/nft -f /etc/dshhub/dshhub.nft')
    expect(result.output).toContain('ExecStop=/usr/sbin/nft delete table inet dshhub')
  })

  it('install.sh --dry-run 不动系统（不需要 root）', () => {
    const result = runScript(repoPath('deploy/nft/install.sh'), ['--dry-run'])
    expect(result.code).toBe(0)
    expect(result.output).toContain('干跑')
    expect(result.output).toContain('table inet dshhub')
    expect(result.output).not.toContain('OK  : 规则 →')
  })

  it('规则写坏时 --dry-run 非零退出', () => {
    const probe = spawnSync('nft', ['--version'], { encoding: 'utf8' })
    if (probe.error) {
      console.warn('没装 nft，跳过坏规则检查')
      return
    }
    const dir = mkdtempSync(join(tmpdir(), 'dshhub-test-wp7a-nft-'))
    try {
      for (const file of ['dshhub.nft', 'dshhub-egress.service', 'install.sh']) {
        writeFileSync(join(dir, file), readFileSync(repoPath(`deploy/nft/${file}`)))
      }
      chmodSync(join(dir, 'install.sh'), 0o755)
      writeFileSync(join(dir, 'dshhub.nft'), 'table inet dshhub { chain fwd { type filter }\n')
      const result = runScript(join(dir, 'install.sh'), ['--dry-run'])
      expect(result.code).not.toBe(0)
      expect(result.output).toContain('FAIL')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('systemd 单元', () => {
  it('dsh-hub.service 是阶段一配置（明文 7700、TLS/跳转关闭、不继承代理）', () => {
    const unit = readFileSync(repoPath('deploy/systemd/dsh-hub.service'), 'utf8')
    expect(unit).toContain('HUB_DATA_DIR=/srv/dsh-hub')
    expect(unit).toContain('HUB_PUBLIC_ORIGIN=http://127.0.0.1:7700')
    expect(unit).toContain('HUB_TLS_PORT=0')
    expect(unit).toContain('HUB_REDIRECT_PORT=0')
    expect(unit).toMatch(/UnsetEnvironment=.*http_proxy/)
    expect(unit).toContain('WorkingDirectory=%h/dsh-hub-prod')
    expect(unit).toContain('apps/api/dist/main.js')
    // 服务端 `pnpm pack` 靠单元 PATH 找 pnpm：必须含 upgrade.sh 生成入口的目录，以及系统目录
    expect(unit).toMatch(/^Environment=PATH=%h\/\.local\/share\/dsh-hub\/bin:.*\/bin$/m)
    // node 路径不写死：用 /usr/bin/env node 找 PATH 里的 node
    expect(unit).toContain('ExecStart=/usr/bin/env node apps/api/dist/main.js')
    expect(unit).toContain('Restart=always')
    expect(unit).toContain('WantedBy=default.target')
  })

  it('备份单元与 timer 指向 scripts/backup.sh，03:30 跑', () => {
    const unit = readFileSync(repoPath('deploy/systemd/dsh-hub-backup.service'), 'utf8')
    expect(unit).toContain('ExecStart=%h/dsh-hub-prod/scripts/backup.sh')
    expect(unit).toContain('HUB_BACKUP_DIR=/mnt/backup/dsh-hub')
    expect(unit).toContain('Type=oneshot')

    const timer = readFileSync(repoPath('deploy/systemd/dsh-hub-backup.timer'), 'utf8')
    expect(timer).toContain('OnCalendar=*-*-* 03:30:00')
    expect(timer).toContain('Persistent=true')
    expect(timer).toContain('Unit=dsh-hub-backup.service')
    expect(timer).toContain('WantedBy=timers.target')
  })

  it('出网规则单元是 oneshot + RemainAfterExit，卸载时删表', () => {
    const unit = readFileSync(repoPath('deploy/nft/dshhub-egress.service'), 'utf8')
    expect(unit).toContain('Type=oneshot')
    expect(unit).toContain('RemainAfterExit=yes')
    expect(unit).toContain('After=docker.service')
    expect(unit).toContain('__NFT_BIN__ -f __RULES_DEST__')
    expect(unit).toContain('ExecStop=__NFT_BIN__ delete table inet dshhub')
    expect(unit).toContain('WantedBy=multi-user.target')
  })
})

describe('deploy/prereq.sh 只读', () => {
  it('跑完不在数据目录/备份目录里留任何东西', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshhub-test-wp7a-prereq-'))
    try {
      const dataDir = join(dir, 'data')
      const backupDir = join(dir, 'backup')
      mkdirSync(dataDir)
      mkdirSync(backupDir)
      const result = runScript(repoPath('deploy/prereq.sh'), [], {
        env: { HUB_DATA_DIR: dataDir, HUB_BACKUP_DIR: backupDir, HUB_PROD_DIR: join(dir, 'prod') },
      })
      expect([0, 1]).toContain(result.code)
      expect(result.output).toContain('前置条件检查')
      expect(result.output).toContain('汇总：OK')
      expect(result.output).toContain('3) 数据目录')
      expect(result.output).toContain('4) 出网规则')
      expect(readdirSync(dataDir)).toEqual([])
      expect(readdirSync(backupDir)).toEqual([])
      expect(existsSync(join(dir, 'prod'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('scripts/backup.sh 与 restore-db.sh', () => {
  it('--dry-run 只打印，不建文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshhub-test-wp7a-backup-sh-'))
    try {
      const dataDir = join(dir, 'data')
      mkdirSync(join(dataDir, 'users', 'alice', 'workspace'), { recursive: true })
      writeFileSync(join(dataDir, 'users', 'alice', 'workspace', 'a.txt'), 'hi')
      const dest = join(dir, 'dest')
      mkdirSync(dest)
      const result = runScript(repoPath('scripts/backup.sh'), ['--dry-run'], {
        env: { HUB_DATA_DIR: dataDir, HUB_BACKUP_DIR: dest },
      })
      expect(result.code).toBe(0)
      expect(result.output).toContain('DRY  |')
      expect(result.output).toContain('db:backup')
      expect(result.output).toContain('--listed-incremental')
      expect(readdirSync(dest)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('restore-db.sh --list 列出 hub-*.db 与配套 secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshhub-test-wp7a-restore-'))
    try {
      const dbDir = join(dir, 'db')
      mkdirSync(dbDir)
      writeFileSync(join(dbDir, 'hub-20261012-033000.db'), 'SQLite format 3\0not-really')
      writeFileSync(join(dbDir, 'secrets-20261012-033000.tar.gz'), 'x')
      const result = runScript(repoPath('scripts/restore-db.sh'), ['--list'], {
        env: { HUB_BACKUP_DIR: dir, HUB_DATA_DIR: join(dir, 'data') },
      })
      expect(result.code).toBe(0)
      expect(result.output).toContain('hub-20261012-033000.db')
      expect(result.output).toContain('secrets-20261012-033000.tar.gz')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('restore-db.sh 拒绝非 SQLite 文件（不覆盖线上库）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshhub-test-wp7a-restore2-'))
    try {
      const dataDir = join(dir, 'data')
      mkdirSync(dataDir)
      writeFileSync(join(dataDir, 'hub.db'), 'SQLite format 3\0live')
      const fake = join(dir, 'fake.db')
      writeFileSync(fake, 'not a database at all')
      const result = runScript(repoPath('scripts/restore-db.sh'), ['--from', fake, '--yes', '--no-service'], {
        env: { HUB_DATA_DIR: dataDir, HUB_BACKUP_DIR: join(dir, 'backup') },
      })
      expect(result.code).not.toBe(0)
      expect(result.output).toContain('不是 SQLite 文件')
      expect(readFileSync(join(dataDir, 'hub.db'), 'utf8')).toContain('live')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('deploy/upgrade.sh 的回退逻辑', () => {
  interface Fixture {
    /** 临时根目录（假命令、marker、日志都放这里，仓库里保持干净） */
    root: string
    /** 生产目录（git 仓库） */
    dir: string
    /** C0：升级前的提交 */
    base: string
    /** C1：release 上的新提交 */
    next: string
    head(): string
    log(): string
    cleanup(): void
  }

  /** 临时仓库：C0 → 切到 C1，再 detached 回 C0，让 merge --ff-only release 前移 */
  function makeRepo(): Fixture {
    const root = mkdtempSync(join(tmpdir(), 'dshhub-test-wp7a-upgrade-'))
    const dir = join(root, 'repo')
    const bin = join(root, 'bin')
    const logFile = join(root, 'stub.log')
    mkdirSync(dir)
    mkdirSync(bin)
    writeFileSync(logFile, '')
    const git = (args: string[]): string =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitEnv() })

    git(['init', '-q', '-b', 'release'])
    writeFileSync(join(dir, 'version.txt'), 'v1\n')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'C0'])
    const c0 = git(['rev-parse', 'HEAD']).trim()
    writeFileSync(join(dir, 'version.txt'), 'v2\n')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'C1'])
    const c1 = git(['rev-parse', 'HEAD']).trim()
    git(['checkout', '-q', '--detach', c0])

    // 假 pnpm / systemctl / curl：记录调用；行为由 marker 文件控制
    const stub = (name: string, body: string): void => {
      const file = join(bin, name)
      writeFileSync(file, `#!/usr/bin/env bash\nprintf '%s %s\\n' '${name}' "$*" >>"\${STUB_LOG}"\n${body}\n`)
      chmodSync(file, 0o755)
    }
    stub(
      'pnpm',
      'printf \'NODE_ENV=%s\\n\' "${NODE_ENV-unset}" >>"${STUB_LOG}"\n' +
        'if [ -f "$STUB_DIR/fail-build" ] && [ "$1" = "build" ]; then exit 1; fi\nexit 0',
    )
    stub('systemctl', 'exit 0')
    stub('curl', 'if [ -f "$STUB_DIR/health-fail" ]; then exit 22; fi\nprintf \'{"ok":true}\\n\'\nexit 0')

    return {
      root,
      dir,
      base: c0,
      next: c1,
      head: () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(),
      log: () => readFileSync(logFile, 'utf8'),
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    }
  }

  function gitEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_AUTHOR_NAME: 'wp7a',
      GIT_AUTHOR_EMAIL: 'wp7a@example.invalid',
      GIT_COMMITTER_NAME: 'wp7a',
      GIT_COMMITTER_EMAIL: 'wp7a@example.invalid',
    }
  }

  function upgradeEnv(fx: Fixture): Record<string, string> {
    return {
      HUB_PROD_DIR: fx.dir,
      HUB_RELEASE_BRANCH: 'release',
      HUB_SERVICE: 'dsh-hub',
      HUB_HEALTH_URL: 'http://127.0.0.1:1/api/health',
      HUB_HEALTH_TIMEOUT: '2',
      HUB_HEALTH_INTERVAL: '1',
      HUB_PNPM: join(fx.root, 'bin', 'pnpm'),
      HUB_SYSTEMCTL: join(fx.root, 'bin', 'systemctl'),
      HUB_CURL: join(fx.root, 'bin', 'curl'),
      STUB_LOG: join(fx.root, 'stub.log'),
      STUB_DIR: fx.root,
    }
  }

  /**
   * 没有 HUB_PNPM、也看不到宿主机上任何 pnpm/corepack 的环境：PATH = 假命令目录 + 一个只放了脚本必需系统命令的目录。
   * （这台机器的 /usr/bin 里就有 corepack，所以不能直接用 /usr/bin。）
   */
  function bareEnv(fx: Fixture): Record<string, string> {
    const sysBin = join(fx.root, 'sysbin')
    mkdirSync(sysBin, { recursive: true })
    for (const name of [
      'git',
      'bash',
      'sh',
      'env',
      'date',
      'sleep',
      'mkdir',
      'chmod',
      'dirname',
      'cat',
      'rm',
    ]) {
      const real = ['/usr/bin', '/bin'].map((dir) => join(dir, name)).find((file) => existsSync(file))
      if (real) symlinkSync(real, join(sysBin, name))
    }
    const env = upgradeEnv(fx)
    delete env.HUB_PNPM
    env.PATH = `${join(fx.root, 'bin')}:${sysBin}`
    env.HUB_TOOLS_DIR = join(fx.root, 'tools')
    return env
  }

  /** 假 corepack：`enable --install-directory <dir> pnpm` 会在 <dir> 里放一个记日志的 pnpm */
  function installFakeCorepack(fx: Fixture): void {
    const file = join(fx.root, 'bin', 'corepack')
    writeFileSync(
      file,
      [
        '#!/usr/bin/env bash',
        'printf \'corepack %s\\n\' "$*" >>"${STUB_LOG}"',
        'if [ "$1" = "enable" ] && [ "$2" = "--install-directory" ]; then',
        '  mkdir -p "$3"',
        '  {',
        "    echo '#!/usr/bin/env bash'",
        '    echo \'printf "pnpm %s\\n" "$*" >>"$STUB_LOG"\'',
        '    echo \'printf "NODE_ENV=%s\\n" "${NODE_ENV-unset}" >>"$STUB_LOG"\'',
        '  } >"$3/pnpm"',
        '  chmod +x "$3/pnpm"',
        'fi',
        'exit 0',
        '',
      ].join('\n'),
    )
    chmodSync(file, 0o755)
  }

  it('shell 里是 NODE_ENV=production：install / build 照样在没有 NODE_ENV 下跑', () => {
    const fx = makeRepo()
    try {
      const result = runScript(repoPath('deploy/upgrade.sh'), [], {
        env: { ...upgradeEnv(fx), NODE_ENV: 'production' },
      })
      expect(result.code, result.output).toBe(0)
      const log = fx.log()
      expect(log.match(/NODE_ENV=unset/g)?.length).toBe(2) // install + build
      expect(log).not.toContain('NODE_ENV=production')
    } finally {
      fx.cleanup()
    }
  })

  it('重启前先 daemon-reload（单元文件是软链接，升级可能改了它）', () => {
    const fx = makeRepo()
    try {
      const result = runScript(repoPath('deploy/upgrade.sh'), [], { env: upgradeEnv(fx) })
      expect(result.code, result.output).toBe(0)
      const log = fx.log()
      expect(log.indexOf('systemctl daemon-reload')).toBeGreaterThanOrEqual(0)
      expect(log.indexOf('systemctl daemon-reload')).toBeLessThan(log.indexOf('systemctl restart dsh-hub'))
    } finally {
      fx.cleanup()
    }
  })

  it('PATH 里没有 pnpm 但有 corepack：自动生成 pnpm 入口并用它 install / build', () => {
    const fx = makeRepo()
    try {
      rmSync(join(fx.root, 'bin', 'pnpm'))
      installFakeCorepack(fx)
      const result = runScript(repoPath('deploy/upgrade.sh'), [], {
        env: { ...bareEnv(fx), NODE_ENV: 'production' },
      })
      expect(result.code, result.output).toBe(0)
      expect(fx.head()).toBe(fx.next)
      const log = fx.log()
      expect(log).toContain(`corepack enable --install-directory ${join(fx.root, 'tools')} pnpm`)
      expect(existsSync(join(fx.root, 'tools', 'pnpm'))).toBe(true)
      expect(log).toContain('pnpm install --frozen-lockfile')
      expect(log).toContain('pnpm build')
      expect(log).not.toContain('NODE_ENV=production')
    } finally {
      fx.cleanup()
    }
  })

  it('既没有 pnpm 也没有 corepack：动手之前就报错，不碰工作区', () => {
    const fx = makeRepo()
    try {
      rmSync(join(fx.root, 'bin', 'pnpm'))
      const result = runScript(repoPath('deploy/upgrade.sh'), [], { env: bareEnv(fx) })
      expect(result.code).toBe(1)
      expect(result.output).toContain('找不到 pnpm')
      expect(fx.head()).toBe(fx.base)
      expect(fx.log()).not.toContain('systemctl')
    } finally {
      fx.cleanup()
    }
  })

  it('健康检查通过：前移到 release 并保持不动', () => {
    const fx = makeRepo()
    try {
      const result = runScript(repoPath('deploy/upgrade.sh'), [], { env: upgradeEnv(fx) })
      expect(result.output).toContain('git merge --ff-only release')
      expect(result.code).toBe(0)
      expect(fx.head()).toBe(fx.next)
      expect(readFileSync(join(fx.dir, 'version.txt'), 'utf8')).toBe('v2\n')
      expect(fx.log()).toContain('pnpm install --frozen-lockfile')
      expect(fx.log()).toContain('pnpm build')
      expect(fx.log()).toContain('systemctl restart dsh-hub')
      expect(result.output).toContain('升级完成')
      expect(result.output).not.toContain('回退到')
    } finally {
      fx.cleanup()
    }
  })

  it('健康检查失败：回退到升级前的提交并重启旧版本', () => {
    const fx = makeRepo()
    try {
      writeFileSync(join(fx.root, 'health-fail'), '')
      const result = runScript(repoPath('deploy/upgrade.sh'), [], { env: upgradeEnv(fx) })
      expect(result.code).toBe(1)
      expect(fx.head()).toBe(fx.base)
      expect(readFileSync(join(fx.dir, 'version.txt'), 'utf8')).toBe('v1\n')
      expect(result.output).toContain('回退到')
      expect(result.output).toContain('健康检查失败')
      // 回退路径也要重新 install/build/restart（否则线上是半成品）
      const log = fx.log()
      expect(log.match(/pnpm install --frozen-lockfile/g)?.length).toBe(2)
      expect(log.match(/systemctl restart dsh-hub/g)?.length).toBe(2)
    } finally {
      fx.cleanup()
    }
  })

  it('构建失败：回退并重启旧版本', () => {
    const fx = makeRepo()
    try {
      writeFileSync(join(fx.root, 'fail-build'), '')
      const result = runScript(repoPath('deploy/upgrade.sh'), [], { env: upgradeEnv(fx) })
      expect(result.code).toBe(1)
      expect(fx.head()).toBe(fx.base)
      expect(result.output).toContain('步骤失败')
      expect(result.output).toContain('回退到')
    } finally {
      fx.cleanup()
    }
  })

  it('工作区有未提交改动时拒绝升级', () => {
    const fx = makeRepo()
    try {
      writeFileSync(join(fx.dir, 'dirty.txt'), 'x')
      const result = runScript(repoPath('deploy/upgrade.sh'), [], { env: upgradeEnv(fx) })
      expect(result.code).toBe(1)
      expect(result.output).toContain('未提交改动')
      expect(fx.head()).toBe(fx.base)
    } finally {
      fx.cleanup()
    }
  })

  it('生产目录不是 git 仓库时明确报错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dshhub-test-wp7a-notgit-'))
    try {
      const result = runScript(repoPath('deploy/upgrade.sh'), [], { env: { HUB_PROD_DIR: dir } })
      expect(result.code).toBe(1)
      expect(result.output).toContain('不是 git 工作区')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('deploy/README.md', () => {
  const README = repoPath('deploy/README.md')

  it('覆盖从零部署的关键步骤', () => {
    const text = readFileSync(README, 'utf8')
    for (const needle of [
      'deploy/prereq.sh',
      'deploy/nft/install.sh',
      'scripts/security-gate.sh',
      'dsh-hub.service',
      'deploy/upgrade.sh',
      'scripts/backup.sh',
      'scripts/restore-db.sh',
      'db:backup',
      'instance:stop-all',
      'doctor',
      '127.0.0.1:7700',
    ]) {
      expect(text, `README 缺少 ${needle}`).toContain(needle)
    }
  })
})

/** 让 beforeAll/afterAll 有用武之地：确认仓库路径算对了 */
beforeAll(() => {
  expect(existsSync(repoPath('deploy/nft/dshhub.nft'))).toBe(true)
  expect(existsSync(repoPath('scripts/security-gate.sh'))).toBe(true)
})
afterAll(() => {})
