import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, statfsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { HubConfig } from '../config.js'
import { openDb } from '../db/index.js'
import { createPaths } from '../lib/paths.js'
import { createContainerDriver } from '../modules/index.js'
import type { ContainerDriver } from '../modules/instances/types.js'
import { formatBytes } from './backup.js'

/**
 * `cli doctor`：部署自检（任务书交付物 4）。只读，不改任何东西。
 * 四项必需：Docker 可达、数据目录权限、磁盘余量、默认 runtime 镜像是否存在。
 * 另加两项环境提示：Node 版本、出网规则是否加载（后者需要 root 才能确认，只给 WARN/FAIL 提示）。
 */
export type DoctorStatus = 'PASS' | 'WARN' | 'FAIL'

export interface DoctorCheck {
  id: string
  status: DoctorStatus
  detail: string
  hint?: string
}

export interface DoctorOptions {
  config: HubConfig
  driver?: ContainerDriver
  /** 08 §9 的告警线：可用 < 50GB 警告、< 5GB 失败 */
  diskWarnBytes?: number
  diskFailBytes?: number
  log?: (line: string) => void
}

export interface DoctorResult {
  checks: DoctorCheck[]
  failed: number
  warned: number
}

const GB = 1024 * 1024 * 1024

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const { config } = options
  const log = options.log ?? (() => {})
  const driver = options.driver ?? createContainerDriver(config)
  const paths = createPaths(config.dataDir)
  const checks: DoctorCheck[] = []

  // 1) Node 版本（01 §3：24.x）
  const nodeMajor = Number(process.versions.node.split('.')[0])
  checks.push({
    id: 'node',
    status: nodeMajor === 24 ? 'PASS' : 'FAIL',
    detail: `node ${process.version}`,
    ...(nodeMajor === 24 ? {} : { hint: '需要 Node 24.x；容器镜像与产物都按 24 构建' }),
  })

  // 2) 数据目录：存在/可写/权限（08 §1）
  checks.push(checkDataDir(paths.root))
  checks.push(checkSecrets(paths.secretsDir))
  checks.push(checkDatabase(paths.dbFile))

  // 3) 磁盘余量（08 §9）
  checks.push(checkDisk(paths.root, options.diskWarnBytes ?? 50 * GB, options.diskFailBytes ?? 5 * GB))

  // 4) Docker 可达（08 §1）
  checks.push(await checkDocker(driver, config))

  // 5) 默认 runtime 镜像（05 §3）：有默认版本就必须镜像存在
  checks.push(await checkDefaultRuntime(driver, paths.dbFile))

  // 6) 出网规则（02 §4）：非 root 只能提示
  checks.push(checkEgressTable())

  const failed = checks.filter((c) => c.status === 'FAIL').length
  const warned = checks.filter((c) => c.status === 'WARN').length
  for (const check of checks) {
    log(`[${check.status}] ${check.id.padEnd(8)} ${check.detail}`)
    if (check.hint) log(`        └─ ${check.hint}`)
  }
  log('')
  log(
    failed > 0
      ? `自检未通过：${failed} 项 FAIL、${warned} 项 WARN`
      : `自检通过${warned > 0 ? `（${warned} 项 WARN，看一眼上面）` : ''}`,
  )
  return { checks, failed, warned }
}

function checkDataDir(dataDir: string): DoctorCheck {
  if (!existsSync(dataDir)) {
    return {
      id: 'data',
      status: 'FAIL',
      detail: `数据目录不存在：${dataDir}`,
      hint: `sudo mkdir -p ${dataDir} && sudo chown $(id -un):$(id -gn) ${dataDir} && chmod 750 ${dataDir}`,
    }
  }
  try {
    accessSync(dataDir, constants.W_OK | constants.X_OK)
  } catch {
    return {
      id: 'data',
      status: 'FAIL',
      detail: `数据目录不可写：${dataDir}`,
      hint: `sudo chown -R $(id -un):$(id -gn) ${dataDir}`,
    }
  }
  const mode = statSync(dataDir).mode & 0o777
  const modeText = mode.toString(8).padStart(3, '0')
  if ((mode & 0o077) !== 0) {
    return {
      id: 'data',
      status: 'WARN',
      detail: `数据目录权限 ${modeText}（同组/其他用户可读，08 §1 建议 750）`,
      hint: `chmod 750 ${dataDir}`,
    }
  }
  return { id: 'data', status: 'PASS', detail: `${dataDir} 可写，权限 ${modeText}` }
}

function checkSecrets(secretsDir: string): DoctorCheck {
  const masterKey = join(secretsDir, 'master.key')
  if (!existsSync(masterKey)) {
    return {
      id: 'secrets',
      status: 'WARN',
      detail: `还没有 ${masterKey}（首次启动会自动生成；此时模型密钥无法解密）`,
    }
  }
  const mode = statSync(masterKey).mode & 0o777
  if (mode !== 0o600) {
    return {
      id: 'secrets',
      status: 'WARN',
      detail: `master.key 权限 ${mode.toString(8)}（应为 600）`,
      hint: `chmod 600 ${masterKey}`,
    }
  }
  return { id: 'secrets', status: 'PASS', detail: 'master.key 存在且权限 600' }
}

function checkDatabase(dbFile: string): DoctorCheck {
  if (!existsSync(dbFile)) {
    return {
      id: 'db',
      status: 'WARN',
      detail: `还没有 ${dbFile}（首次启动会自动迁移）`,
    }
  }
  try {
    const db = openDb(dbFile, { readOnly: true })
    try {
      const integrity = db.get<{ integrity_check: string }>('PRAGMA integrity_check')
      const users = db.get<{ n: number }>('SELECT count(*) AS n FROM users')
      if (integrity?.integrity_check !== 'ok') {
        return {
          id: 'db',
          status: 'FAIL',
          detail: `hub.db 完整性检查失败：${integrity?.integrity_check ?? '未知'}`,
          hint: 'scripts/restore-db.sh --list   # 从备份恢复（10 §G1）',
        }
      }
      return { id: 'db', status: 'PASS', detail: `hub.db 正常，${users?.n ?? 0} 个用户` }
    } finally {
      db.close()
    }
  } catch (error) {
    return {
      id: 'db',
      status: 'FAIL',
      detail: `打不开 hub.db：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function checkDisk(dir: string, warnBytes: number, failBytes: number): DoctorCheck {
  let available: number
  try {
    const fsStat = statfsSync(dir)
    available = Number(fsStat.bavail) * Number(fsStat.bsize)
  } catch (error) {
    return {
      id: 'disk',
      status: 'WARN',
      detail: `读不到磁盘余量：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (available < failBytes) {
    return {
      id: 'disk',
      status: 'FAIL',
      detail: `磁盘可用 ${formatBytes(available)}（< ${formatBytes(failBytes)}）`,
      hint: '清理 /srv/dsh-hub 下的导出与旧镜像：docker image prune（不要动别的项目的镜像）',
    }
  }
  if (available < warnBytes) {
    return {
      id: 'disk',
      status: 'WARN',
      detail: `磁盘可用 ${formatBytes(available)}（< ${formatBytes(warnBytes)}，08 §9 的告警线）`,
      hint: '清理导出文件：删除 <HUB_DATA_DIR>/exports 下过期目录',
    }
  }
  return { id: 'disk', status: 'PASS', detail: `磁盘可用 ${formatBytes(available)}` }
}

async function checkDocker(driver: ContainerDriver, config: HubConfig): Promise<DoctorCheck> {
  if (config.containerDriver === 'fake') {
    return {
      id: 'docker',
      status: 'WARN',
      detail: 'HUB_CONTAINER_DRIVER=fake（测试驱动，不会真的起容器）',
    }
  }
  try {
    const ping = await driver.ping()
    if (!ping.ok) {
      return {
        id: 'docker',
        status: 'FAIL',
        detail: `容器引擎不可达：${config.dockerHost}`,
        hint: 'docker info；若 docker 命令本身正常，说明实例域（WP2）的 Docker 驱动还没合并进这个分支',
      }
    }
    return {
      id: 'docker',
      status: 'PASS',
      detail: `Docker 可达（${ping.version ?? '未知版本'}，${config.dockerHost}）`,
    }
  } catch (error) {
    return {
      id: 'docker',
      status: 'FAIL',
      detail: `容器驱动不可用：${error instanceof Error ? error.message : String(error)}`,
      hint: 'docker info；若提示接口未实现，说明实例域（WP2）还没合并进这个分支',
    }
  }
}

async function checkDefaultRuntime(driver: ContainerDriver, dbFile: string): Promise<DoctorCheck> {
  if (!existsSync(dbFile)) {
    return { id: 'runtime', status: 'WARN', detail: '没有 hub.db，读不到默认 DSH 版本' }
  }
  let image: string | undefined
  let tableMissing = false
  try {
    const db = openDb(dbFile, { readOnly: true })
    try {
      const table = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='runtimes'",
      )
      if (!table) {
        tableMissing = true
      } else {
        const row = db.get<{ image: string }>(
          "SELECT image FROM runtimes WHERE is_default = 1 AND status = 'ready' LIMIT 1",
        )
        image = row?.image
      }
    } finally {
      db.close()
    }
  } catch (error) {
    return {
      id: 'runtime',
      status: 'WARN',
      detail: `读 runtimes 表失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (tableMissing) {
    return {
      id: 'runtime',
      status: 'WARN',
      detail: 'runtimes 表还不存在（插件/版本模块 WP3 的迁移没应用）',
      hint: '合并 WP3 后重启 Hub，或在管理后台「DSH 版本」构建镜像',
    }
  }
  if (!image) {
    return {
      id: 'runtime',
      status: 'WARN',
      detail: '还没有默认 DSH 版本（用户无法启动实例）',
      hint: '打开 /admin →「DSH 版本」构建一个 dshhub/runtime:<版本> 并设为默认',
    }
  }
  try {
    const exists = await driver.imageExists(image)
    return exists
      ? { id: 'runtime', status: 'PASS', detail: `默认镜像存在：${image}` }
      : {
          id: 'runtime',
          status: 'FAIL',
          detail: `默认镜像不存在：${image}`,
          hint: 'docker images | grep dshhub/runtime；缺失就在管理后台重新构建',
        }
  } catch (error) {
    return {
      id: 'runtime',
      status: 'WARN',
      detail: `无法检查镜像 ${image}：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function checkEgressTable(): DoctorCheck {
  const result = spawnSync('nft', ['list', 'table', 'inet', 'dshhub'], { encoding: 'utf8' })
  if (result.error) {
    return {
      id: 'egress',
      status: 'WARN',
      detail: `没装 nftables（${result.error.message}）`,
      hint: 'sudo apt install nftables && sudo deploy/nft/install.sh',
    }
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.status === 0 && output.includes('table inet dshhub')) {
    return { id: 'egress', status: 'PASS', detail: 'table inet dshhub 已加载（02 §4）' }
  }
  if (process.getuid?.() !== 0) {
    return {
      id: 'egress',
      status: 'WARN',
      detail: '无法确认出网规则（读 nft 需要 root）',
      hint: 'sudo nft list table inet dshhub   # 看不到就 sudo deploy/nft/install.sh',
    }
  }
  return {
    id: 'egress',
    status: 'FAIL',
    detail: 'table inet dshhub 未加载 —— 容器可以访问家庭局域网（02 §4）',
    hint: 'sudo deploy/nft/install.sh',
  }
}
