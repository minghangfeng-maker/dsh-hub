import { HubError } from '../lib/errors.js'
import { createContainerDriver } from '../modules/index.js'
import type { ContainerDriver } from '../modules/instances/types.js'
import type { HubConfig } from '../config.js'

/**
 * `cli instance:stop-all`（08 §10 的应急命令）：停掉**本环境**所有 Hub 管理的容器
 * （label `dshhub.managed=1` + `dshhub.env=<HUB_ENV_ID>`；生产与开发/测试共用同一个 Docker，11 §2）。
 * 典型场景：要重启 Docker / 换网段 / 排查异常，先把用户容器全部停干净。
 *
 * 有意**不写 instances 表**：这个命令也可能在 Hub 进程没跑的时候用（那时写库反而会和
 * 正在启动的 Hub 抢锁）。Hub 下次启动的 `reconcileAll()` 会把表对齐到实际状态。
 * 用 `driver.listManaged()` 而不是记住名字，所以只碰本环境自己的容器
 * （生产 `dshhub-u*` + `dshhub.env=prod`；测试容器带别的 env 标签，绝不会被误停）。
 */
export interface StopAllOptions {
  config: HubConfig
  /** 注入驱动（测试用 FakeDriver） */
  driver?: ContainerDriver
  dryRun?: boolean
  /** 每个容器的停止超时，默认 10s（05 §4） */
  timeoutSec?: number
  log?: (line: string) => void
}

export interface StopAllResult {
  total: number
  stopped: string[]
  alreadyStopped: string[]
  failed: { name: string; reason: string }[]
}

export async function runStopAll(options: StopAllOptions): Promise<StopAllResult> {
  const log = options.log ?? (() => {})
  const timeoutSec = options.timeoutSec ?? 10
  const dryRun = options.dryRun ?? false
  const driver = options.driver ?? createContainerDriver(options.config)

  const ping = await driver.ping()
  if (!ping.ok) {
    throw new HubError('INTERNAL', `容器引擎不可达（${options.config.dockerHost}）`)
  }

  const containers = await driver.listManaged()
  const result: StopAllResult = { total: containers.length, stopped: [], alreadyStopped: [], failed: [] }
  if (containers.length === 0) {
    log(`没有本环境（${options.config.envId}）Hub 管理的容器（label dshhub.managed=1 + dshhub.env）`)
    return result
  }

  for (const container of containers) {
    if (container.state !== 'running') {
      result.alreadyStopped.push(container.name)
      log(`跳过 ${container.name}（状态 ${container.state}）`)
      continue
    }
    if (dryRun) {
      result.stopped.push(container.name)
      log(`[dry-run] 会停掉 ${container.name}`)
      continue
    }
    try {
      await driver.stop(container.name, timeoutSec)
      result.stopped.push(container.name)
      log(`已停止 ${container.name}`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      result.failed.push({ name: container.name, reason })
      log(`停止失败 ${container.name}：${reason}`)
    }
  }
  return result
}
