import type { HubConfig } from '../config.js'
import type { HubDb } from '../db/index.js'
import { HubError } from '../lib/errors.js'
import { createContainerDriver } from '../modules/index.js'
import { imageForVersion } from '../modules/instances/spec.js'
import type { ContainerDriver } from '../modules/instances/types.js'
import { parseDshVersion, smokeSpec } from '../modules/runtimes/build.js'
import {
  clearDefaultRuntimes,
  getRuntimeRowByVersion,
  insertRuntimeRow,
  updateRuntimeRow,
} from '../modules/runtimes/repo.js'

/**
 * `cli runtime:adopt <dshVersion> [--default]`（WP8b P1）：
 * 把本机**已经存在**的 `dshhub/runtime:<版本>` 镜像登记为 ready 的运行时，不重新构建。
 *
 * 首次部署不必等分钟级的镜像构建：本机（或 registry）已有镜像时，一条命令就能让用户启动实例。
 * 校验两件事：① 镜像存在；② 冒烟测试 `dsh --version` 与版本号一致（与 `runtime.build` 的判据相同，
 * 冒烟容器用 `NetworkMode: none` + 只读根 + tmpfs `/tmp`，见 `smokeSpec`）。
 *
 * 幂等：同版本重复执行只更新元信息（并可补设默认），不会重复插行。
 */
export interface AdoptRuntimeOptions {
  config: HubConfig
  db: HubDb
  dshVersion: string
  /** 设为默认版本（唯一默认由 `clearDefaultRuntimes` + 部分唯一索引保证） */
  makeDefault?: boolean
  /**
   * 允许「镜像 tag 的版本号」与「镜像里 `dsh --version`」不一致时继续登记。
   *
   * 只为一个既有场景存在：打了构建后缀的镜像（`dshhub/runtime:0.2.1-rc.2-chat1`，见 WP40d）
   * 里面装的仍是 `0.2.1-rc.2`。默认仍然严格（版本不符直接失败），因为这条校验能挡住
   * 「tag 写 A、镜像里是 B」这种真正的错；开了之后会在日志里留一条醒目警告。
   */
  allowVersionMismatch?: boolean
  /** 注入驱动（测试用 FakeDriver） */
  driver?: ContainerDriver
  log?: (line: string) => void
  /** 可注入时钟（测试用）；默认系统时间 */
  now?: () => string
}

export interface AdoptRuntimeResult {
  runtimeId: number
  dshVersion: string
  image: string
  isDefault: boolean
  /** true = 新建行；false = 复用/更新已有行 */
  created: boolean
  imageId: string | null
  sizeBytes: number | null
  /** 冒烟测试 `dsh --version` 的原始输出（已 trim） */
  smokeOutput: string
}

/** 与 `service.create()` 相同的版本号形状校验 */
export const RUNTIME_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/u

export async function runAdoptRuntime(options: AdoptRuntimeOptions): Promise<AdoptRuntimeResult> {
  const log = options.log ?? ((): void => {})
  const now = options.now ?? ((): string => new Date().toISOString())
  const version = options.dshVersion.trim()
  if (!RUNTIME_VERSION_RE.test(version)) {
    throw new HubError('VALIDATION_FAILED', `版本号格式不合法：${version}`, {
      fields: { dshVersion: '格式不合法' },
    })
  }
  const image = imageForVersion(version)
  const driver = options.driver ?? createContainerDriver(options.config)

  const ping = await driver.ping()
  if (!ping.ok) {
    throw new HubError('INTERNAL', `容器引擎不可达（${options.config.dockerHost}）`)
  }
  if (!(await driver.imageExists(image))) {
    throw new HubError('NOT_FOUND', `本机没有镜像 ${image}`, { image })
  }
  log(`找到镜像 ${image}，开始冒烟测试：dsh --version`)

  const smoke = await driver.runOnce(smokeSpec(options.config, image, version), ['dsh', '--version'], {
    timeoutMs: 120_000,
    onOutput: (chunk) => log(chunk.trimEnd()),
  })
  if (smoke.exitCode !== 0) {
    throw new HubError(
      'UPSTREAM_ERROR',
      `冒烟测试失败（dsh --version 退出码 ${String(smoke.exitCode)}）：${smoke.output.trim().slice(0, 200)}`,
    )
  }
  const actual = parseDshVersion(smoke.output)
  if (actual && actual !== version) {
    if (options.allowVersionMismatch !== true) {
      throw new HubError(
        'UPSTREAM_ERROR',
        `镜像里的 dsh 版本是 ${actual}，与 ${version} 不一致（带构建后缀的镜像请加 --allow-version-mismatch）`,
        { expected: version, actual },
      )
    }
    log(`警告：镜像里的 dsh 版本是 ${actual}，与版本号 ${version} 不一致；按 --allow-version-mismatch 继续登记`)
  }
  if (!actual) log('警告：无法从 dsh --version 输出解析版本号，按通过处理')

  const info = typeof driver.imageInfo === 'function' ? await driver.imageInfo(image) : null
  const existing = getRuntimeRowByVersion(options.db, version)
  const runtimeId =
    existing?.id ??
    insertRuntimeRow(options.db, {
      dshVersion: version,
      image,
      status: 'ready',
      notes: '',
      at: now(),
    })
  updateRuntimeRow(options.db, runtimeId, {
    status: 'ready',
    imageId: info?.imageId ?? existing?.image_id ?? null,
    sizeBytes: info?.sizeBytes ?? existing?.size_bytes ?? null,
    notes: existing?.status === 'failed' ? '' : (existing?.notes ?? ''),
  })
  let isDefault = existing?.is_default === 1
  if (options.makeDefault) {
    options.db.tx(() => {
      clearDefaultRuntimes(options.db)
      updateRuntimeRow(options.db, runtimeId, { isDefault: true, status: 'ready' })
    })
    isDefault = true
  }

  log(
    `已登记 ${image} 为 ready 运行时（#${String(runtimeId)}` +
      `${info ? `，镜像 ${info.imageId.slice(0, 19)}，${String(Math.round(info.sizeBytes / 1024 / 1024))}MB` : ''}）` +
      `${isDefault ? '，并设为默认版本' : ''}`,
  )
  return {
    runtimeId,
    dshVersion: version,
    image,
    isDefault,
    created: existing === undefined,
    imageId: info?.imageId ?? null,
    sizeBytes: info?.sizeBytes ?? null,
    smokeOutput: smoke.output.trim(),
  }
}
