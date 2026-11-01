import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * 部署脚本自测（TLS 证书与 systemd 单元）：
 * - issue-cert.sh / renew.sh：假 acme.sh，dry-run 打出正确的 acme.sh 参数；
 * - 单元文件与示例配置的关键字段。
 *
 * 全部在 /tmp 的临时目录里跑，**不碰真实的 /etc、~/.config**。
 */
const REPO = fileURLToPath(new URL('../../../', import.meta.url))

interface RunResult {
  code: number
  output: string
}

function runScript(
  script: string,
  args: string[] = [],
  opts: { env?: Record<string, string>; cwd?: string } = {},
): RunResult {
  const result = spawnSync('bash', [join(REPO, script), ...args], {
    cwd: opts.cwd ?? REPO,
    env: { ...process.env, ...opts.env },
    encoding: 'utf8',
  })
  return { code: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix = 'dshhub-test-wp7b-deploy-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** 写一个假命令（脚本内容由调用方给），返回路径 */
function fakeBin(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

/** 假 systemctl：把所有调用追加到 $SYSTEMCTL_LOG，is-active 一律成功 */
function fakeSystemctl(dir: string): string {
  return fakeBin(
    dir,
    'systemctl',
    `printf '%s\\n' "$*" >>"\${SYSTEMCTL_LOG:-/dev/null}"
if [ "\${1:-}" = "is-active" ]; then exit 0; fi
if [ "\${1:-}" = "-v" ] || [ "\${1:-}" = "--version" ]; then echo "systemd 255"; exit 0; fi
exit 0`,
  )
}

// ── 证书脚本 ────────────────────────────────────────────────────────────────

describe('deploy/tls/issue-cert.sh 与 renew.sh', () => {
  function setup(envBody: string): Record<string, string> {
    const dir = tempDir()
    const binDir = join(dir, 'bin')
    const systemdDir = join(dir, 'systemd')
    mkdirSync(systemdDir, { recursive: true })
    const acme = fakeBin(binDir, 'acme.sh', 'echo "acme.sh called: $*"')
    const acmeEnv = join(dir, 'acme.env')
    writeFileSync(acmeEnv, envBody)
    // 假的「已升级」生产副本：issue-cert.sh 要求它已带 TLS 网关（认 SIGHUP）
    const prodDir = join(dir, 'prod')
    mkdirSync(join(prodDir, 'apps', 'api', 'dist', 'server'), { recursive: true })
    writeFileSync(join(prodDir, 'apps', 'api', 'dist', 'server', 'tls.js'), '')
    return {
      HUB_PROD_DIR: prodDir,
      ACME_SH: acme,
      ACME_HOME: join(dir, 'acme-home'),
      HUB_ACME_ENV: acmeEnv,
      HUB_DATA_DIR: join(dir, 'data'),
      HUB_SYSTEMD_USER_DIR: systemdDir,
      HUB_SYSTEMCTL: fakeSystemctl(binDir),
      SYSTEMCTL_LOG: join(dir, 'systemctl.log'),
    }
  }

  const goodEnv = [
    'HUB_HOST=hub.example.com',
    'ACME_DNS=dns_ali',
    'Ali_Key=FAKE-ALI-KEY',
    'Ali_Secret=FAKE-ALI-SECRET',
    '',
  ].join('\n')

  it('dry-run：参数含 --server letsencrypt / --keylength ec-256 / --dns，且不打印凭据', () => {
    const env = setup(goodEnv)
    const result = runScript('deploy/tls/issue-cert.sh', ['--staging'], { env })
    expect(result.code).toBe(0)
    // staging 要换 server（--server letsencrypt 会盖掉 --staging）
    expect(result.output).toContain('--server letsencrypt_test')
    expect(result.output).not.toContain('--staging')
    expect(result.output).toContain('--keylength ec-256')
    expect(result.output).toContain('--dns dns_ali')
    expect(result.output).toContain('-d hub.example.com')
    expect(result.output).toContain('--install-cert')
    expect(result.output).toContain('dsh-hub-cert.timer')
    // 凭据只经环境变量传给 acme.sh，绝不出现在输出里
    expect(result.output).not.toContain('FAKE-ALI-KEY')
    expect(result.output).not.toContain('FAKE-ALI-SECRET')
    // dry-run 不落盘
    expect(existsSync(join(env.HUB_DATA_DIR!, 'secrets', 'tls', 'privkey.pem'))).toBe(false)
  })

  it('生产副本还是旧版 Hub（不认 SIGHUP）→ 中止，提示先 upgrade.sh', () => {
    const env = setup(goodEnv)
    const result = runScript('deploy/tls/issue-cert.sh', ['--apply'], {
      env: { ...env, HUB_PROD_DIR: join(env.HUB_DATA_DIR!, 'old-prod') },
    })
    expect(result.code).toBe(1)
    expect(result.output).toContain('upgrade.sh')
    expect(result.output).not.toContain('acme.sh called')
  })

  it('正式签用 --server letsencrypt；设了 ACME_PROXY 只给 acme.sh 加代理', () => {
    const env = setup(`${goodEnv}ACME_PROXY=http://127.0.0.1:17899\n`)
    const result = runScript('deploy/tls/issue-cert.sh', [], { env })
    expect(result.code).toBe(0)
    expect(result.output).toMatch(/--server letsencrypt(?!_test)/)
    expect(result.output).toContain('https_proxy=http://127.0.0.1:17899')
  })

  it('凭据缺失时中止，并指出缺哪个变量', () => {
    const env = setup('HUB_HOST=hub.example.com\nACME_DNS=dns_ali\nAli_Key=\n')
    const result = runScript('deploy/tls/issue-cert.sh', [], { env })
    expect(result.code).toBe(1)
    expect(result.output).toContain('Ali_Key')
  })

  it('没装 acme.sh 时打印 gitee 镜像的安装命令', () => {
    const env = setup(goodEnv)
    const result = runScript('deploy/tls/issue-cert.sh', [], {
      env: { ...env, ACME_SH: join(env.HUB_DATA_DIR!, 'not-installed.sh') },
    })
    expect(result.code).toBe(1)
    expect(result.output).toContain('gitee.com/neilpang/acme.sh')
  })

  it('renew.sh --dry-run 打出 acme.sh --cron', () => {
    const env = setup(goodEnv)
    const result = runScript('deploy/tls/renew.sh', ['--dry-run'], { env })
    expect(result.code).toBe(0)
    expect(result.output).toContain('--cron')
    expect(result.output).not.toContain('FAKE-ALI-SECRET')
  })
})

// ── 单元文件与示例配置 ──────────────────────────────────────────────────────

describe('单元文件与示例配置', () => {
  function read(rel: string): string {
    return readFileSync(join(REPO, rel), 'utf8')
  }

  it('dsh-hub.service 读仓库外的 hub.env，且阶段二注释指向 hub.env.example', () => {
    const unit = read('deploy/systemd/dsh-hub.service')
    expect(unit).toContain('EnvironmentFile=-%h/.config/dsh-hub/hub.env')
    expect(unit).toContain('HUB_TLS_PORT=0')
    expect(unit).toContain('UnsetEnvironment=http_proxy')
  })


  it('dsh-hub-cert.timer：每天一次、RandomizedDelaySec=1h、Persistent=true', () => {
    const timer = read('deploy/systemd/dsh-hub-cert.timer')
    expect(timer).toContain('OnCalendar=*-*-* 04:30:00')
    expect(timer).toContain('RandomizedDelaySec=1h')
    expect(timer).toContain('Persistent=true')
    expect(timer).toContain('Unit=dsh-hub-cert.service')
    const service = read('deploy/systemd/dsh-hub-cert.service')
    expect(service).toContain('ExecStart=%h/dsh-hub-prod/deploy/tls/renew.sh')
    expect(service).toContain('Type=oneshot')
  })


  it('hub.env.example 与 acme.env.example 的关键项', () => {
    const hubEnv = read('deploy/hub.env.example')
    expect(hubEnv).toContain('HUB_PUBLIC_ORIGIN=https://hub.example.com')
    // 非标准端口的写法只出现在注释里的例子中
    expect(hubEnv).toContain('hub.example.com:8443')
    expect(hubEnv).toContain('HUB_TLS_PORT=7443')
    expect(hubEnv).toContain('HUB_PROXY_PROTOCOL=true')
    expect(hubEnv).toContain('HUB_HSTS_MAX_AGE=86400')

    const acmeEnv = read('deploy/tls/acme.env.example')
    expect(acmeEnv).toContain('HUB_HOST=hub.example.com')
    expect(acmeEnv).toContain('ACME_DNS=dns_ali')
    expect(acmeEnv).toContain('Ali_Key=')
    expect(acmeEnv).toContain('CF_Token')
    expect(acmeEnv).toContain('DP_Id')
    expect(acmeEnv).toMatch(/子账号|权限/u)
  })

})
