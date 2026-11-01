import type {
  AdminRuntimeRow,
  AvailableRuntimesResponse,
  CreateRuntimeRequest,
  CreateRuntimeResponse,
} from '@dsh-hub/shared'
import type { RequestMeta } from '../../context.js'

/** 单用户升级结果（06 §3） */
export interface UpgradeUserResult {
  ok: boolean
  /** 失败时是否已用旧镜像回滚 */
  rolledBack: boolean
  /** 用户被钉在别的版本、本次没动（`ok=true`） */
  skipped?: boolean
  error?: string
}

/**
 * DSH 版本（运行时镜像）服务（04 §4.6、06 §3；WP3 实现）。
 * 版本 = 镜像 tag `dshhub/runtime:<dsh_version>`；构建是 `runtime.build` 任务。
 */
export interface RuntimeService {
  list(): Promise<AdminRuntimeRow[]>
  /** 单个版本的目录行（PATCH 的响应体） */
  get(runtimeId: number): Promise<AdminRuntimeRow>
  /** 从 npmmirror 查 `@deepseek-ai/dsh` 可用版本（缓存 10 分钟） */
  available(): Promise<AvailableRuntimesResponse>
  /** 建 runtime 行（building）+ `runtime.build` 任务 */
  create(input: CreateRuntimeRequest, actorId: number, meta: RequestMeta): Promise<CreateRuntimeResponse>
  setDefault(runtimeId: number, actorId: number, meta: RequestMeta): Promise<AdminRuntimeRow>
  retire(runtimeId: number, actorId: number, meta: RequestMeta): Promise<AdminRuntimeRow>
  /** 只改备注（PATCH 的部分更新语义） */
  updateNotes(runtimeId: number, notes: string, actorId: number, meta: RequestMeta): Promise<AdminRuntimeRow>
  remove(runtimeId: number, actorId: number, meta: RequestMeta): Promise<void>
  /** 默认版本（users.runtime_id 为空时用它） */
  defaultRuntime(): Promise<AdminRuntimeRow | null>
  /** 下发升级用：重建该用户容器到指定版本，失败回滚 */
  upgradeUser(
    userId: number,
    runtimeId: number,
    opts?: { onLog?: (line: string) => void },
  ): Promise<UpgradeUserResult>
  /**
   * 启动对账（WP8b B2）：把「构建任务已不在跑」的遗留 `building` 行置为 `failed`，
   * 返回被修正的 runtime id。
   */
  reconcileStaleBuilds(): Promise<number[]>
}
