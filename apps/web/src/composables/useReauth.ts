import { reactive } from 'vue'

import { isHubApiError } from '@/api/http'

/**
 * 二次密码确认（04 §0.2 `REAUTH_REQUIRED`）。
 *
 * 敏感操作有两种触发方式：
 * 1. **预先确认**（删除用户、重置密码、下发任务…）：先弹窗，确认后再发请求 —— {@link sensitive}；
 * 2. **服务端要求**（请求已发出、服务端返回 `REAUTH_REQUIRED`）：自动弹出后**重试原请求**
 *    —— {@link withReauth}（07 §7 的「REAUTH_REQUIRED 时自动弹出后重试原请求」）。
 *
 * 弹窗状态放在模块级：页面上任意位置（行内菜单、批量条、抽屉）都能触发，
 * 由 `components/admin/ReauthGate.vue` 统一渲染（挂在 `AdminPage` 里）。
 */
export interface ReauthOptions {
  title?: string
  description?: string
  confirmText?: string
  type?: 'primary' | 'error' | 'warning'
}

interface ReauthDialogState extends ReauthOptions {
  visible: boolean
  resolve: (() => void) | null
  reject: ((reason?: unknown) => void) | null
}

/** 用户主动取消（点了取消 / 关掉弹窗），调用方通常直接忽略。 */
export class ReauthCanceledError extends Error {
  constructor() {
    super('已取消二次确认')
    this.name = 'ReauthCanceledError'
  }
}

export function isReauthCanceled(error: unknown): boolean {
  return error instanceof ReauthCanceledError
}

export const reauthDialog = reactive<ReauthDialogState>({
  visible: false,
  title: undefined,
  description: undefined,
  confirmText: undefined,
  type: undefined,
  resolve: null,
  reject: null,
})

/** 弹出二次密码确认框，确认后 resolve，取消则 reject {@link ReauthCanceledError}。 */
export function requestReauth(options: ReauthOptions = {}): Promise<void> {
  // 同一时刻只留一个弹窗：旧的在等待者视为取消，避免 promise 悬挂
  reauthDialog.reject?.(new ReauthCanceledError())

  return new Promise<void>((resolve, reject) => {
    reauthDialog.visible = true
    reauthDialog.title = options.title
    reauthDialog.description = options.description
    reauthDialog.confirmText = options.confirmText
    reauthDialog.type = options.type
    reauthDialog.resolve = resolve
    reauthDialog.reject = reject
  })
}

function settle(kind: 'confirm' | 'cancel'): void {
  const { resolve, reject } = reauthDialog
  reauthDialog.visible = false
  reauthDialog.resolve = null
  reauthDialog.reject = null

  if (kind === 'confirm') resolve?.()
  else reject?.(new ReauthCanceledError())
}

/** `ConfirmPasswordDialog` 的 `@confirm`。 */
export function resolveReauth(): void {
  settle('confirm')
}

/** `ConfirmPasswordDialog` 的 `@cancel`（或遮罩关闭）。 */
export function cancelReauth(): void {
  settle('cancel')
}

/**
 * 执行敏感请求：若服务端回 `REAUTH_REQUIRED`，弹窗确认后**重试一次**原请求。
 * 其它错误原样抛出。
 */
export async function withReauth<T>(action: () => Promise<T>, options: ReauthOptions = {}): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (!isHubApiError(error) || error.code !== 'REAUTH_REQUIRED') throw error
    await requestReauth({ description: '这个操作比较敏感，为了确认是你本人。', ...options })
    return action()
  }
}

/**
 * 先确认身份再执行（删除用户这类「一律要输密码」的操作）。
 *
 * 已经确认过一次就不再自动弹第二次：万一服务端仍然拒绝（例如会话的 reauth 已过期），
 * 错误直接抛给调用方展示，避免「弹窗 → 失败 → 再弹窗」的死循环。
 */
export async function sensitive<T>(action: () => Promise<T>, options: ReauthOptions = {}): Promise<T> {
  await requestReauth(options)
  return action()
}

/** 测试用：把弹窗状态恢复初始（不影响正在等待的 promise）。 */
export function resetReauthDialog(): void {
  reauthDialog.visible = false
  reauthDialog.resolve = null
  reauthDialog.reject = null
}
