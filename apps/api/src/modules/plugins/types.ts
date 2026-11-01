import type {
  AddPluginPlatformRequest,
  AddPluginVersionRequest,
  AdminPluginRow,
  CreatePluginRequest,
  MyPluginsResponse,
  PluginCard,
  PluginLookupQuery,
  PluginLookupResponse,
  PluginPlatform,
  PluginUserMatrixItem,
  PluginVersion,
  UpdatePluginPlatformRequest,
  UpdatePluginRequest,
  UserPluginRow,
} from '@dsh-hub/shared'
import type { RequestMeta } from '../../context.js'

/** 单用户插件变更集（06 §2.4） */
export interface PluginChanges {
  add: PluginVersion[]
  remove: PluginCard[]
}

export interface InstallForUserOptions {
  restart: 'now' | 'next-start'
  /** 任务日志回调（jobs 引擎的 TaskContext.log） */
  onLog?: (line: string) => void
  signal?: AbortSignal
  /** 写进 `user_plugins.source`（下发=admin / 用户自助=user / bootstrap=policy） */
  source?: 'admin' | 'user' | 'policy'
}

export interface UploadedPluginFile {
  data: Buffer
  filename: string
  mimetype: string
}

/**
 * 插件服务（04 §3.2 §4.5、06 §2；WP3 实现）。
 * 目录（plugins/plugin_versions）与用户期望状态（user_plugins）都由这里管；
 * 安装执行器（06 §2.4）改 profile package.json → 调 `dsh plugin add|remove` → 必要时重启 DSH。
 */
export interface PluginService {
  /** 某个平台库里的插件（缺省云上）：policy / 版本 / 统计都按该平台 */
  listCatalog(platform?: PluginPlatform): Promise<AdminPluginRow[]>
  /** 单个插件的完整目录行（PATCH/POST 的响应体；缺省云上视图） */
  getCatalogRow(pluginId: number, platform?: PluginPlatform): Promise<AdminPluginRow>
  createPlugin(input: CreatePluginRequest, actorId: number | null, meta: RequestMeta): Promise<AdminPluginRow>
  updatePlugin(
    pluginId: number,
    input: UpdatePluginRequest,
    actorId: number | null,
    meta: RequestMeta,
  ): Promise<AdminPluginRow>
  deletePlugin(pluginId: number, actorId: number | null, meta: RequestMeta): Promise<void>
  /** 把已有插件加入另一个平台的库（docs/22 §2.2） */
  addPlatform(
    pluginId: number,
    input: AddPluginPlatformRequest,
    actorId: number | null,
    meta: RequestMeta,
  ): Promise<AdminPluginRow>
  /** 只改某个平台的设置 */
  updatePlatform(
    pluginId: number,
    platform: PluginPlatform,
    input: UpdatePluginPlatformRequest,
    actorId: number | null,
    meta: RequestMeta,
  ): Promise<AdminPluginRow>
  /** 从某个平台的库里移出插件；`force` 同时撤销桌面目标（需要二次密码，由路由保证） */
  removePlatform(
    pluginId: number,
    platform: PluginPlatform,
    opts: { force: boolean },
    actorId: number | null,
    meta: RequestMeta,
  ): Promise<void>
  /** 目录查询：npm 元数据 / tarball / 本地目录 package.json */
  lookup(query: PluginLookupQuery): Promise<PluginLookupResponse>
  /** 上传 .tgz 的元数据预读：只读包内 package.json，不入库（添加插件抽屉第 ② 步自动填名用） */
  lookupUpload(file: UploadedPluginFile): Promise<PluginLookupResponse>
  /** JSON 形式新增版本（npm / tarball / local） */
  addVersion(
    pluginId: number,
    input: AddPluginVersionRequest,
    meta: RequestMeta,
    actorId?: number | null,
  ): Promise<PluginVersion>
  /** multipart 上传 `.tgz`（sourceType=upload）；桌面平台 = 创建桌面版本 */
  addUploadedVersion(
    pluginId: number,
    file: UploadedPluginFile,
    meta: RequestMeta,
    actorId?: number | null,
    platform?: PluginPlatform,
  ): Promise<PluginVersion>
  removeVersion(pluginId: number, versionId: number, actorId: number | null, meta: RequestMeta): Promise<void>
  /** 管理端：某插件的全量用户矩阵（04 §10.1；`row=null` = 从未安装） */
  listUsersOfPlugin(pluginId: number): Promise<PluginUserMatrixItem[]>
  /** 管理端用户详情的 `plugins` 字段（04 §4.2；WP1 留的 TODO） */
  listUserPluginRows(userId: number): Promise<UserPluginRow[]>
  /** 用户自助列表（04 §3.2；不展示 hidden） */
  listForUser(userId: number): Promise<MyPluginsResponse>
  /** 单用户安装/卸载（内部用；用户自助与下发任务都走它） */
  installForUser(userId: number, changes: PluginChanges, opts: InstallForUserOptions): Promise<void>
  /** 新用户 bootstrap：required + default 插件（06 §2.5） */
  bootstrapUser(userId: number, opts: InstallForUserOptions): Promise<void>
  /** required 插件对账补装（06 §2.2） */
  reconcileUser(userId: number, opts?: Partial<InstallForUserOptions>): Promise<{ changed: number }>
  /** 用户自助安装/卸载 → 单用户 job（04 §3.2） */
  requestToggle(userId: number, pluginId: number, action: 'install' | 'uninstall'): Promise<{ jobId: number }>
  /** 等该用户的后台对账结束（测试/关停用） */
  waitForReconcile(userId: number): Promise<void>
  /** 实例就绪后排队一次后台对账（plugins 模块在事件总线上触发） */
  scheduleReconcile(userId: number): void
}
