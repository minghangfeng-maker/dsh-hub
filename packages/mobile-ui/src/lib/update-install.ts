/**
 * 调起系统安装器（0.3.1）。
 *
 * Android 8+ 装「未知来源」的包，要先在系统设置里给本应用「安装未知应用」的权限
 * （`REQUEST_INSTALL_PACKAGES` + `canRequestPackageInstalls()`）。流程：
 *
 *   下载完成 → canInstall() → 不允许就先 openInstallSettings() 并记住待装的包
 *            → 用户回到 App（前台）再查一次 → 允许了就直接调起安装器。
 *
 * 这个文件只依赖一个窄接口（原生侧实现见 apps/mobile/.../AppInstallerPlugin.java，
 * 接线见 lib/app-update-native.ts），所以可以用假 bridge 单测（test/update-install）。
 */

/** 原生安装器插件的能力（JS 侧视角）。 */
export interface AppInstallerBridge {
  /** Android 8+：是否已允许本应用安装未知来源的应用。 */
  canInstall(): Promise<boolean>
  /** 打开「安装未知应用」→ 本应用的系统设置页。 */
  openInstallSettings(): Promise<void>
  /** 用 FileProvider 生成 content:// URI 并调起系统安装器；path 相对 Cache。 */
  install(path: string): Promise<void>
  /** 兜底：交给系统默认浏览器打开下载地址（不是 Custom Tab）。 */
  openInBrowser(url: string): Promise<void>
}

export type InstallOutcome = 'installer-opened' | 'needs-permission'

/**
 * 下载完成后调安装器：没权限就先去设置页。
 *
 * 注意这里**不**吞异常：插件没注册/系统没有安装器时由调用方（store）转成界面文案。
 */
export async function installUpdate(
  bridge: AppInstallerBridge,
  path: string,
): Promise<InstallOutcome> {
  if (!(await bridge.canInstall())) {
    await bridge.openInstallSettings()
    return 'needs-permission'
  }
  await bridge.install(path)
  return 'installer-opened'
}

export type PendingInstallOutcome = 'none' | InstallOutcome

/**
 * 「等用户去系统设置授权」的待装安装包。
 *
 * 只做一件事：回到前台时再查一次权限，允许了就调起安装器（且**只调一次**）。
 * 用户还没授权时保持 pending，但**不**每次都把他踢回设置页（那样会陷入循环）。
 */
export class PendingInstall {
  private path: string | null = null
  private busy = false

  constructor(
    private readonly bridge: AppInstallerBridge,
    private readonly onEvent: (name: string, detail: string) => void = () => {},
  ) {}

  /** 记住待装的安装包（相对 Cache 的路径）。 */
  arm(path: string): void {
    this.path = path
    this.onEvent('update:pending', 'armed')
  }

  /** 放弃这次待装（用户点了「稍后」/重新下载）。 */
  clear(): void {
    this.path = null
  }

  get pendingPath(): string | null {
    return this.path
  }

  /**
   * 回到前台：还等着安装就再试一次。
   *
   * 返回值：`none`（没有待装）、`installer-opened`（已调起安装器）、
   * `needs-permission`（用户还没允许，继续等）。
   */
  async onForeground(): Promise<PendingInstallOutcome> {
    if (this.path === null) return 'none'
    if (this.busy) return 'none'
    const path = this.path
    this.busy = true
    try {
      if (!(await this.bridge.canInstall())) {
        this.onEvent('update:pending', 'still-blocked')
        return 'needs-permission'
      }
      await this.bridge.install(path)
      this.path = null
      this.onEvent('update:pending', 'installed')
      return 'installer-opened'
    } finally {
      this.busy = false
    }
  }
}
