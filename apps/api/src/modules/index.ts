import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { AppDeps, BaseDeps } from '../context.js'
import {
  adminUsersPlugin,
  createAdminUsersService,
  createSystemService,
  publicSitePlugin,
} from './admin-users/index.js'
import type { AdminUsersService, SystemService } from './admin-users/types.js'
import { agentModesPlugin, createAgentModesService } from './agent-modes/index.js'
import type { AgentModesService } from './agent-modes/types.js'
import { authPlugin, createAuthService } from './auth/index.js'
import type { AuthService } from './auth/types.js'
import { computePlugin, createComputeService } from './compute/index.js'
// WP56b：座舱 DSH 的系统账号与容器生命周期（`/api/admin/cockpit/*` 的路由由 WP56a 注册）
import { createOpsInstance } from './cockpit/ops-instance.js'
import type { OpsInstanceService } from './cockpit/ops-instance.js'
import type { ComputeService } from './compute/types.js'
import { cockpitAdminRoutes, createCockpitServiceFactory } from './cockpit/index.js'
import type { CockpitService } from './cockpit/types.js'
import {
  adminDesktopDevicesPlugin,
  createDesktopService,
  desktopPlugin,
  meDesktopDevicesPlugin,
} from './desktop/index.js'
import type { DesktopService } from './desktop/types.js'
import {
  adminDesktopDeliveryPlugin,
  checkClientUpdatePlugin,
  createDesktopDeliveryService,
  desktopFeedPlugin,
  deviceDeliveryPlugin,
  publicDesktopDownloadPlugin,
} from './desktop-delivery/index.js'
import type { DesktopDeliveryService } from './desktop-delivery/types.js'
import { createDeliveryService, deliveryPlugins } from './deliveries/index.js'
import type { DeliveryService } from './deliveries/types.js'
import { createExportService, exportsPlugin } from './exports/index.js'
import type { ExportService } from './exports/types.js'
import { createInstanceService, instancesPlugin } from './instances/index.js'
import type { InstanceService } from './instances/types.js'
import { createJobService, jobsPlugin } from './jobs/index.js'
import type { JobService } from './jobs/types.js'
import { avatarsPlugin, createMeService, mePlugin } from './me/index.js'
import type { MeService } from './me/types.js'
import { createModelService, modelsPlugin } from './models/index.js'
import type { ModelService } from './models/types.js'
import { createPluginService, pluginsPlugin } from './plugins/index.js'
import type { PluginService } from './plugins/types.js'
import { createProxyService, proxyPlugin } from './proxy/index.js'
import {
  createCockpitAuthService,
  createMobileAsrService,
  createMobileAuthService,
  createMobileService,
  createMobileTtsService,
  mobilePlugin,
} from './mobile/index.js'
import type {
  CockpitAuthService,
  MobileAsrService,
  MobileAuthService,
  MobileService,
  MobileTtsService,
} from './mobile/index.js'
import { adminMobileAppPlugin, androidBinPlugin, createMobileAppService, publicAndroidPlugin } from './mobile-app/index.js'
import type { MobileAppService } from './mobile-app/index.js'
import type { ProxyService } from './proxy/types.js'
import {
  createRelayService,
  relayAdminPlugin,
  relayMePlugin,
  relayToolsAdminPlugin,
  relayToolsMePlugin,
  relayToolsV1Plugin,
  relayV1Plugin,
} from './relay/index.js'
import type { RelayService } from './relay/types.js'
import { createRolloutService, rolloutsPlugin } from './rollouts/index.js'
import type { RolloutService } from './rollouts/types.js'
import { createRuntimeService, runtimesPlugin } from './runtimes/index.js'
import type { RuntimeService } from './runtimes/types.js'

/**
 * 全部模块的 service 集合（模块之间只通过它互相调用，01 §4 模块边界规则）。
 * 新增模块时在这里加一行，并在 `registerModules` 里加注册行。
 */
export interface Services {
  auth: AuthService
  me: MeService
  adminUsers: AdminUsersService
  system: SystemService
  instances: InstanceService
  proxy: ProxyService
  jobs: JobService
  exports: ExportService
  plugins: PluginService
  runtimes: RuntimeService
  models: ModelService
  rollouts: RolloutService
  relay: RelayService
  agentModes: AgentModesService
  compute: ComputeService
  desktop: DesktopService
  desktopDelivery: DesktopDeliveryService
  /** 移动端工作区（mobile/M1）：节点列表 + 手机通道 + 桌面出站中继 */
  mobile: MobileService
  /** 安卓 App 发布记录（WP40r）：主页下载入口、二维码、bootstrap 的 downloadUrl/latestVersionCode */
  mobileApp: MobileAppService
  /** 手机 App 设备令牌（WP40a）：登录 / 刷新 / 退出，复用桌面端的设备台账 */
  mobileAuth: MobileAuthService
  /**
   * 座舱管理员令牌（WP56b / docs/24 §3.3）：交接码换令牌、12 小时、不占手机设备名额。
   * 与 `mobileAuth` 同一套前缀与刷新接口，但存在自己的表里。
   */
  cockpitAuth: CockpitAuthService
  /** 服务端语音识别（WP49）：`POST /api/mobile/asr` 转发到本机 dsh-asr + bootstrap.voice */
  mobileAsr: MobileAsrService
  /** 朗读合成（WP50）：`POST /api/mobile/tts` 转发到本机 seki-voice + bootstrap.voice.tts */
  mobileTts: MobileTtsService
  /** 统一下发（WP28a / docs/21）：编排实例侧 rollouts 与桌面侧 desktop-delivery */
  deliveries: DeliveryService
  /**
   * 座舱 DSH（WP56b / docs/24 §5）：系统账号 `hub-ops`、容器 `dshhub-ops`、令牌轮换与
   * `/ops/*` 鉴权探针。WP56a 的 cockpit 模块从这里取 `probe`，不需要自己管容器。
   */
  cockpitOps: OpsInstanceService
  /** 管理座舱（WP56a / docs/24）：能力层、方案、画布、密钥、交接码、SSE */
  cockpit: CockpitService
}

/**
 * 每个模块的注册前缀（**并行开发约定**：别的包只改自己模块目录，不要动这里的顺序与别人前缀）。
 * 注意 instances/jobs/plugins 会注册到 `/api` 下再自己分子路径，因为它们同时服务 `/api/me/*` 与 `/api/admin/*`。
 */
export const MODULE_PREFIXES: Record<keyof Services, string> = {
  auth: '/api/auth',
  me: '/api/me',
  adminUsers: '/api/admin',
  system: '/api/admin',
  instances: '/api',
  proxy: '/',
  jobs: '/api',
  exports: '/api/me/exports',
  plugins: '/api',
  runtimes: '/api/admin/runtimes',
  models: '/api/admin/models',
  rollouts: '/api/admin/rollouts',
  relay: '/api/me/relay',
  agentModes: '/api/admin/agent-modes',
  compute: '/api',
  desktop: '/api/desktop',
  /** 下发模块的**设备侧**路由（`/manifest`、`/plugins/*`）；管理端/公开前缀见 EXTRA_PREFIXES */
  desktopDelivery: '/api/desktop',
  /** 统一下发（WP28a）：`/preview` 与 `/`（提交）；安装统计见 EXTRA_PREFIXES.deliveryStats */
  deliveries: '/api/admin/deliveries',
  /** 移动端（M1）：节点列表 + 手机通道（WS 由 service.attachUpgrade 挂载） */
  mobile: '/api/mobile',
  /** 手机 App 认证（WP40a）：与 mobile 同一个注册前缀，路由在 mobilePlugin 里一起挂 */
  mobileAuth: '/api/mobile',
  /** 座舱管理员的交接码换令牌（WP56b）：路由同样挂在 mobilePlugin 里 */
  cockpitAuth: '/api/mobile',
  /** 服务端语音识别（WP49）：与 mobile 同一个注册前缀，路由在 mobilePlugin 里一起挂 */
  mobileAsr: '/api/mobile',
  /** 朗读合成（WP50）：与 mobile 同一个注册前缀，路由在 mobilePlugin 里一起挂 */
  mobileTts: '/api/mobile',
  /** 安卓 App 发布记录管理端（WP40r）：`/api/admin/mobile/app/*`；公开前缀见 EXTRA_PREFIXES */
  mobileApp: '/api/admin/mobile',
  /** 座舱管理端前缀由 WP56a 的 `cockpitPlugin` 注册；本包只提供服务，不注册路由 */
  cockpitOps: '/api/admin/cockpit',
  /** 管理座舱（WP56a / docs/24 §3.2）：`/api/admin/cockpit/*`；`/ops/*` 走内部监听器 */
  cockpit: '/api/admin/cockpit',
}

/** 组装全部 service（各包替换自己那个工厂；WP1 已实现 auth/me/admin-users） */
export function createServices(deps: BaseDeps): Services {
  // 先建空壳，再把自己（含 services）交给各工厂：模块之间只能通过 `deps.services.<x>` 互调（01 §4），
  // 而 `createServices` 的入参还没有 services —— 用同一个引用避免两段式初始化的类型体操
  const services = {} as Services
  const self: AppDeps = { ...deps, services }
  services.auth = createAuthService(self)
  services.me = createMeService(self)
  services.adminUsers = createAdminUsersService(self)
  services.system = createSystemService(self)
  services.instances = createInstanceService(self)
  services.proxy = createProxyService(self)
  services.jobs = createJobService(self)
  services.exports = createExportService(self)
  services.plugins = createPluginService(self)
  services.runtimes = createRuntimeService(self)
  services.models = createModelService(self)
  services.rollouts = createRolloutService(self)
  // relay 必须在 models 之后建：它要把 hub-relay 的桥（12 §7.7）注册进 models service
  services.relay = createRelayService(self)
  // agent-modes 依赖 relay（密钥、模型）与 models（env 桥），必须在它们之后建
  services.agentModes = createAgentModesService(self)
  // compute 依赖 relay（钱包）与 instances（生命周期）；钩子由 computePlugin 晚绑定注册（13 §4）
  services.compute = createComputeService(self)
  // 桌面端（20 / WP25a）：依赖 relay（设备密钥）与 agentModes（模式是否开通），必须在它们之后建
  services.desktop = createDesktopService(self)
  // 桌面下发（20 / WP25b）：读设备表、调 models 的模型片段渲染；必须在 desktop 之后建
  services.desktopDelivery = createDesktopDeliveryService(self)
  // 统一下发（WP28a / docs/21）：编排 rollouts（实例）与 desktop-delivery（桌面），必须在它们之后建
  services.deliveries = createDeliveryService(self)
  // 座舱 DSH（WP56b）：依赖 instances（规格覆盖钩子 + 生命周期），必须在它之后建；
  // 手机通道的 `cloud:ops` 节点要读它的状态，所以必须在 mobile 之前建
  services.cockpitOps = createOpsInstance(self)
  // 座舱管理员令牌（WP56b）：只依赖 cockpit 的交接码接缝（运行时鸭子类型取），
  // 必须比 mobileAuth 先建（mobileAuth 的解析/刷新会回落到它）
  services.cockpitAuth = createCockpitAuthService(self)
  // 手机设备令牌（WP40a）依赖 auth（同一份凭据校验）与 desktop 的设备台账/令牌表
  services.mobileAuth = createMobileAuthService(self)
  // 服务端语音识别（WP49）：只依赖配置/时钟/审计，不依赖别的模块
  services.mobileAsr = createMobileAsrService(self)
  // 朗读合成（WP50）：同样只依赖配置/时钟/审计，不依赖别的模块
  services.mobileTts = createMobileTtsService(self)
  // 移动端依赖 proxy（容器 cookie 签发）、desktop（设备台账）与 mobileAuth（ticket 复查）
  services.mobile = createMobileService(self)
  // 安卓 App 发布记录（WP40r）：只读写自己的表与数据目录，不依赖别的模块
  services.mobileApp = createMobileAppService(self)
  // 管理座舱（WP56a）：能力层要调几乎所有 service，必须最后建；探针由 deps.opsProbe 注入
  services.cockpit = createCockpitServiceFactory(self)
  return services
}

/**
 * 不在 `Services` 里的附加前缀（WP1 的头像与公共站点信息）：
 * 它们没有独立的 service，只是同一模块挂在另一个前缀下的路由。
 */
export const EXTRA_PREFIXES = {
  avatars: '/api/avatars',
  publicSite: '/api/public',
  /** 中转站管理端（12 §9）：与 `/api/me/relay` 同一个 service，两个注册前缀 */
  relayAdmin: '/api/admin/relay',
  /** 搜索 / 抓取池（14 §3.2；WP18a）：service 挂在 `relay.tools` 上，两个注册前缀 */
  toolsAdmin: '/api/admin/tools',
  toolsMe: '/api/me/tools',
  /** 桌面设备（WP25a）：同一个 service，用户端与管理端两个注册前缀 */
  meDesktopDevices: '/api/me/desktop-devices',
  adminDesktopDevices: '/api/admin/desktop-devices',
  /** 桌面下发管理端（WP25b）：`/api/admin/desktop/*` */
  adminDesktopDelivery: '/api/admin/desktop',
  /** 升级 feed 与安装包（WP25b，匿名）：`/desktop/feeds/*`、`/desktop/bin/*` */
  desktopFeeds: '/desktop',
  /** 匿名强更地板（WP25b）：`/api/v0/check_client_update` */
  desktopUpdate: '/api/v0',
  /** 统一下发的安装统计（WP28a）：`/api/admin/plugins/install-stats` */
  deliveryStats: '/api/admin',
  /** 公开主页的 Windows 安装包信息（WP36，匿名）：`/api/public/desktop/download` */
  publicDesktopDownload: '/api/public',
  /** 公开主页的安卓 APK 与二维码（WP40r，匿名）：`/api/public/android/*` */
  publicAndroid: '/api/public',
  /** 安卓 APK 字节流（WP40r，匿名长缓存）：`/android/bin/:file` */
  androidBin: '/android',
} as const

interface ModuleRegistration {
  name: string
  prefix: string
  plugin: FastifyPluginAsync
}

/**
 * 按固定顺序注册全部模块。顺序只影响 404/重复路由的判定，不代表依赖关系；
 * 保留 `/api` 前缀的模块（instances/jobs/plugins）放最后，避免它们的通配路由遮住别的模块。
 */
export async function registerModules(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const registrations: ModuleRegistration[] = [
    { name: 'auth', prefix: MODULE_PREFIXES.auth, plugin: authPlugin(deps) },
    { name: 'me', prefix: MODULE_PREFIXES.me, plugin: mePlugin(deps) },
    { name: 'avatars', prefix: EXTRA_PREFIXES.avatars, plugin: avatarsPlugin(deps) },
    { name: 'publicSite', prefix: EXTRA_PREFIXES.publicSite, plugin: publicSitePlugin(deps) },
    {
      name: 'publicDesktopDownload',
      prefix: EXTRA_PREFIXES.publicDesktopDownload,
      plugin: publicDesktopDownloadPlugin(deps),
    },
    {
      name: 'publicAndroid',
      prefix: EXTRA_PREFIXES.publicAndroid,
      plugin: publicAndroidPlugin(deps),
    },
    { name: 'androidBin', prefix: EXTRA_PREFIXES.androidBin, plugin: androidBinPlugin(deps) },
    {
      name: 'adminMobileApp',
      prefix: MODULE_PREFIXES.mobileApp,
      plugin: adminMobileAppPlugin(deps),
    },
    { name: 'adminUsers', prefix: MODULE_PREFIXES.adminUsers, plugin: adminUsersPlugin(deps) },
    { name: 'cockpit', prefix: MODULE_PREFIXES.cockpit, plugin: cockpitAdminRoutes(deps) },
    { name: 'exports', prefix: MODULE_PREFIXES.exports, plugin: exportsPlugin(deps) },
    { name: 'runtimes', prefix: MODULE_PREFIXES.runtimes, plugin: runtimesPlugin(deps) },
    { name: 'models', prefix: MODULE_PREFIXES.models, plugin: modelsPlugin(deps) },
    { name: 'rollouts', prefix: MODULE_PREFIXES.rollouts, plugin: rolloutsPlugin(deps) },
    { name: 'relay', prefix: MODULE_PREFIXES.relay, plugin: relayMePlugin(deps) },
    { name: 'relayAdmin', prefix: EXTRA_PREFIXES.relayAdmin, plugin: relayAdminPlugin(deps) },
    { name: 'relayV1', prefix: '/', plugin: relayV1Plugin(deps) },
    { name: 'relayToolsV1', prefix: '/', plugin: relayToolsV1Plugin(deps) },
    { name: 'relayToolsAdmin', prefix: EXTRA_PREFIXES.toolsAdmin, plugin: relayToolsAdminPlugin(deps) },
    { name: 'relayToolsMe', prefix: EXTRA_PREFIXES.toolsMe, plugin: relayToolsMePlugin(deps) },
    { name: 'agentModes', prefix: MODULE_PREFIXES.agentModes, plugin: agentModesPlugin(deps) },
    { name: 'compute', prefix: MODULE_PREFIXES.compute, plugin: computePlugin(deps) },
    { name: 'desktop', prefix: MODULE_PREFIXES.desktop, plugin: desktopPlugin(deps) },
    {
      name: 'desktopDelivery',
      prefix: MODULE_PREFIXES.desktopDelivery,
      plugin: deviceDeliveryPlugin(deps),
    },
    {
      name: 'adminDesktopDelivery',
      prefix: EXTRA_PREFIXES.adminDesktopDelivery,
      plugin: adminDesktopDeliveryPlugin(deps),
    },
    {
      name: 'deliveries',
      prefix: MODULE_PREFIXES.deliveries,
      plugin: deliveryPlugins(deps).deliveries,
    },
    {
      name: 'mobile',
      prefix: MODULE_PREFIXES.mobile,
      plugin: mobilePlugin(deps),
    },
    {
      name: 'deliveryStats',
      prefix: EXTRA_PREFIXES.deliveryStats,
      plugin: deliveryPlugins(deps).installStats,
    },
    { name: 'desktopFeeds', prefix: EXTRA_PREFIXES.desktopFeeds, plugin: desktopFeedPlugin(deps) },
    { name: 'desktopUpdate', prefix: EXTRA_PREFIXES.desktopUpdate, plugin: checkClientUpdatePlugin(deps) },
    {
      name: 'meDesktopDevices',
      prefix: EXTRA_PREFIXES.meDesktopDevices,
      plugin: meDesktopDevicesPlugin(deps),
    },
    {
      name: 'adminDesktopDevices',
      prefix: EXTRA_PREFIXES.adminDesktopDevices,
      plugin: adminDesktopDevicesPlugin(deps),
    },
    { name: 'instances', prefix: MODULE_PREFIXES.instances, plugin: instancesPlugin(deps) },
    { name: 'jobs', prefix: MODULE_PREFIXES.jobs, plugin: jobsPlugin(deps) },
    { name: 'plugins', prefix: MODULE_PREFIXES.plugins, plugin: pluginsPlugin(deps) },
    { name: 'proxy', prefix: MODULE_PREFIXES.proxy, plugin: proxyPlugin(deps) },
  ]
  for (const registration of registrations) {
    await app.register(registration.plugin, { prefix: registration.prefix })
  }
}

export { createRelayService } from './relay/index.js'
export { createAgentModesService, agentModesPlugin } from './agent-modes/index.js'
export type { AgentModesService } from './agent-modes/types.js'
export { createComputeService } from './compute/index.js'
export type { ComputeService } from './compute/types.js'
export { registerCockpitOpsRoutes } from './cockpit/index.js'
export type { CockpitService } from './cockpit/types.js'
export { startRelayInternalListener } from './relay/internal-listener.js'
export type { RelayInternalListenerHandle } from './relay/internal-listener.js'
export { createContainerDriver } from './instances/index.js'
export { FakeDriver } from './instances/fake-driver.js'
export type { ContainerDriver, ContainerInfo, ContainerSpec, InstanceService } from './instances/types.js'
