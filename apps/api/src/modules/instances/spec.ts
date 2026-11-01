import { createHash } from 'node:crypto'
import {
  CONTAINER_LABEL_MANAGED,
  CONTAINER_NAME_PREFIX,
  CONTAINER_PORT,
  DEFAULT_CONTAINER_PERMISSION_PRESET,
  type ContainerPermissionPreset,
  type Quota,
} from '@dsh-hub/shared'
import type { HubPaths } from '../../lib/paths.js'
import { DEFAULT_AUTHORITY } from './dsh-cookie.js'
import type { InstanceUserRow } from './repo.js'
import type { ContainerDriver, ContainerSpec } from './types.js'

/** 容器标签（05 §4；对账与「规格是否变了」都靠它们） */
export const LABEL_SLUG = 'dshhub.slug'
export const LABEL_USER_ID = 'dshhub.user_id'
export const LABEL_RUNTIME = 'dshhub.runtime'
export const LABEL_CONFIG_HASH = 'dshhub.config_hash'
/**
 * 环境标识（开发/测试/生产共用同一个 Docker 守护进程，11 §2）：
 * 只有 `dshhub.env` 等于本环境 `HUB_ENV_ID` 的容器才会被对账/回收/stop-all 处理。
 */
export const LABEL_ENV = 'dshhub.env'

/** 容器名前缀默认值（`HUB_CONTAINER_PREFIX` 可覆盖，例如测试用 `dshhub-test-wp2-`） */
export const DEFAULT_CONTAINER_PREFIX = CONTAINER_NAME_PREFIX
/** 缺省环境标识：**没有 `dshhub.env` 标签的旧容器按生产处理**（升级期间的向后兼容） */
export const DEFAULT_ENV_ID = 'prod'

/** 容器是否属于本环境：旧容器（无 env 标签）算生产 */
export function belongsToEnv(labels: Record<string, string>, envId: string): boolean {
  return (labels[LABEL_ENV] ?? DEFAULT_ENV_ID) === envId
}

/** 容器内固定路径（05 §4） */
export const CONTAINER_HOME = '/home/dsh'
export const CONTAINER_WORKSPACE = '/workspace'
export const CONTAINER_MANAGED = '/opt/hub/managed'
export const CONTAINER_PLUGIN_STORE = '/opt/hub/plugin-store'

/** `/tmp` tmpfs（02 §2 / S6）：读写、不执行、不允许设备与 setuid 位 */
export const TMPFS_OPTIONS = 'rw,size=512m,nosuid,nodev'

/**
 * 没有 `runtimes` 表（WP3 迁移 040+）时用的兜底镜像版本。
 * 可用 `HUB_DEFAULT_DSH_VERSION` 覆盖（例如集成测试指定本机已构建的镜像版本）。
 */
export const FALLBACK_DSH_VERSION = process.env.HUB_DEFAULT_DSH_VERSION ?? '0.2.0-rc.2'

/**
 * B 计划开关：rootless podman 下宿主连不上容器 IP，必须把 3000 发布到宿主回环（05 §4）。
 * Docker rootful 保持关闭（02 §2 的基线是「无端口发布」）。生产用 systemd 环境变量设置。
 */
export function shouldPublishPort(): boolean {
  return process.env.HUB_CONTAINER_PUBLISH_PORT === '1'
}

export function containerNameFor(slug: string, prefix: string = DEFAULT_CONTAINER_PREFIX): string {
  return `${prefix}${slug}`
}

export function imageForVersion(version: string): string {
  return `dshhub/runtime:${version}`
}

/** Docker/podman 的内置网络：不需要（也不能）由 Hub 创建（WP8b B1：冒烟容器用 `none`） */
export const BUILTIN_NETWORKS = new Set(['none', 'host', 'bridge', 'default', 'nat'])

/**
 * 一次性维护容器（`runOnce`）用 Hub 管理的用户网络时，先确保网络存在（WP8b B1）。
 *
 * 背景：用户网络只在**第一次启动实例**时由实例服务 `ensureNetwork` 创建；而「插件下发给从未
 * 启动过实例的用户」「运行时镜像冒烟」这类操作只跑一次性容器，会撞上
 * `network dshhub-users not found`。把判据放在驱动里，任何调用方（插件安装、依赖重装……）
 * 都不会再踩这个坑；`none`/`host` 等内置网络直接跳过。
 */
export async function ensureSpecNetwork(
  driver: Pick<ContainerDriver, 'ensureNetwork'>,
  spec: Pick<ContainerSpec, 'network' | 'networkSubnet'>,
): Promise<void> {
  if (!spec.networkSubnet || spec.networkSubnet.length === 0) return
  if (!spec.network || BUILTIN_NETWORKS.has(spec.network)) return
  await driver.ensureNetwork(spec.network, spec.networkSubnet)
}

export interface SpecInput {
  user: InstanceUserRow
  quota: Quota
  /** 解析出的 DSH 版本（`runtimes.dsh_version`，WP3 之前是兜底版本） */
  dshVersion: string
  runtimeId: number | null
  paths: HubPaths
  npmRegistry: string
  /** 模型密钥 env（`models.containerEnv`，WP3） */
  modelEnv: Record<string, string>
  /**
   * 容器内权限预设（WP40d / docs/05 §4）：缺省完全放行。
   * 写进容器 env `DSH_PERMISSION_MODE`，DSH 0.2.1-rc.2 用它推导 sandbox 模式与审批策略。
   */
  permissionPreset?: ContainerPermissionPreset
  /** 容器名前缀（`HUB_CONTAINER_PREFIX`） */
  containerPrefix?: string
  /** 本环境标识（`HUB_ENV_ID`，写进 `dshhub.env` 标签） */
  envId?: string
}

export { DEFAULT_CONTAINER_PERMISSION_PRESET }

/**
 * 按 05 §4 生成容器规格（纯函数，config_hash 的输入就是它的产物）。
 * 安全基线（cap-drop ALL / no-new-privileges / MemorySwap / Init…）由 driver 统一施加，见 docker-driver.ts。
 */
export function buildContainerSpec(input: SpecInput): ContainerSpec {
  const { user, quota, paths } = input
  const env: Record<string, string> = {
    HOME: CONTAINER_HOME,
    DSH_HOME: `${CONTAINER_HOME}/.dsh`,
    DSH_PORT: String(CONTAINER_PORT),
    DSH_AUTHORITY: DEFAULT_AUTHORITY,
    DSH_TELEMETRY_DISABLED: '1',
    TZ: 'Asia/Shanghai',
    npm_config_registry: input.npmRegistry,
    HUB_SLUG: user.slug,
    // 容器内权限（WP40d）。C0 实测：不设这个 env，DSH 出厂是 workspace-write + ask，
    // 手机上一句「画个图」就会停在审批卡上。容器本身是隔离边界（05 §4、02 §2），
    // 所以默认 danger-full-access；管理员可在系统设置里改回 workspace-write（= ask）。
    // 注意：这个 env 参与 config_hash，改值会让现有容器在下次启动时重建（数据卷保留）。
    DSH_PERMISSION_MODE: input.permissionPreset ?? DEFAULT_CONTAINER_PERMISSION_PRESET,
    // 只读根 + `/tmp` 带 noexec 时，DSH 的原生加载器会把 .node 复制到 /tmp 再 dlopen，
    // 结果 "failed to map segment from shared object"（WP2 实测）。关掉它的缓存，
    // 直接从只读镜像路径加载即可。
    // WP45 实测：镜像里这条开关关着的代价可以忽略——DSH 启动路径根本不加载这类原生 addon，
    // 打开缓存（甚至把 `NARB_NATIVE_CACHE_DIR` 指到可写卷）一个缓存文件都不会生成、启动时间
    // 差在噪声内（±20 ms）。所以维持现状，不要为了「看起来更快」动它。
    NARB_DISABLE_NATIVE_CACHE: '1',
    // Node 的模块编译缓存（V8 code cache）：容器 stop→start 后复用。**WP45 唯一的显著启动优化**：
    // 11 bundle 的真实 profile 热启动 3245 ms → 2747 ms（−498 ms / −15%），缓存 17.5 MiB / 4989 文件，
    // 放在可写的 home 卷上所以容器重建也不丢；代价是 RSS +35 MB（实测）。
    // 容器每次「打开 DSH」都是新进程，这份缓存正是为反复冷启动准备的。
    NODE_COMPILE_CACHE: `${CONTAINER_HOME}/.dsh/cache/node-compile-cache`,
    ...input.modelEnv,
  }
  return {
    name: containerNameFor(user.slug, input.containerPrefix ?? DEFAULT_CONTAINER_PREFIX),
    image: imageForVersion(input.dshVersion),
    env,
    labels: {
      [CONTAINER_LABEL_MANAGED]: '1',
      [LABEL_ENV]: input.envId ?? DEFAULT_ENV_ID,
      [LABEL_SLUG]: user.slug,
      [LABEL_USER_ID]: String(user.id),
      [LABEL_RUNTIME]: input.dshVersion,
      [LABEL_CONFIG_HASH]: '', // create() 前由 withConfigHash 填上，保证 label 与实际规格一致
    },
    mounts: [
      { host: paths.userHome(user.slug), container: CONTAINER_HOME, readOnly: false },
      { host: paths.userWorkspace(user.slug), container: CONTAINER_WORKSPACE, readOnly: false },
      { host: paths.userManaged(user.slug), container: CONTAINER_MANAGED, readOnly: true },
      { host: paths.pluginStoreDir, container: CONTAINER_PLUGIN_STORE, readOnly: true },
    ],
    cpus: quota.cpus,
    memoryMb: quota.memoryMb,
    pidsLimit: quota.pidsLimit,
    network: 'dshhub-users', // 由调用方覆盖成 config.usersNetwork
    readOnlyRootfs: true,
    tmpfs: { '/tmp': TMPFS_OPTIONS },
    publishPort: shouldPublishPort(),
  }
}

/** 规格哈希（05 §4 的公式：镜像 + 配额 + 只读根 + env 键值 + 挂载；与 label 里的一致才算「没变」） */
export function computeConfigHash(spec: ContainerSpec): string {
  const envDigest = createHash('sha256')
    .update(
      Object.entries(spec.env)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
    )
    .digest('hex')
  const mounts = spec.mounts
    .map((mount) => `${mount.host}:${mount.container}:${mount.readOnly ? 'ro' : 'rw'}`)
    .sort()
    .join('\n')
  return createHash('sha256')
    .update(
      [
        `image=${spec.image}`,
        `cpus=${String(spec.cpus)}`,
        `memoryMb=${String(spec.memoryMb)}`,
        `pidsLimit=${String(spec.pidsLimit)}`,
        `readOnlyRootfs=${String(spec.readOnlyRootfs)}`,
        `env=${envDigest}`,
        `mounts=${mounts}`,
      ].join('\n'),
    )
    .digest('hex')
}

/** 把算好的哈希写进 label 与 env 之外的地方（create 前调用） */
export function withConfigHash(spec: ContainerSpec): ContainerSpec {
  const hash = computeConfigHash(spec)
  return { ...spec, labels: { ...spec.labels, [LABEL_CONFIG_HASH]: hash } }
}

/**
 * 兜底 `managed.patch.yml`（WP3 的 `models.renderManaged` 尚不可用时写它）。
 * **必须是顶层 YAML 数组**：DSH 的 `loadOverlayPatches` 对非数组直接 fatal
 * （`must be a top-level YAML array of loader patch entries`）——只写注释会解析成 null 而启动失败，
 * 这是 WP2 真容器集成测试抓到的（05 F17）。
 * 按 05 §6，这里也**总是**带上 `workspace-controller`，让默认工作区落在 `/workspace`。
 */
export const FALLBACK_MANAGED_PATCH = `# 由 DSH Hub 生成（占位）：模型与插件配置由管理端下发后写入本文件。
# 当前还没有可用的模型预设，只固定默认工作区根（05 §6 / 06 §4.3）。
- id: workspace-controller
  config:
    documentsDirectory: /workspace
`
