/**
 * 更新包下载/安装的原生接线（0.3.1）。
 *
 * 两个原生能力：
 *  1. **写文件**：`@capacitor/filesystem` 写到 `Directory.Cache/updates/…`（8.5MB 级别，
 *     分块 base64 追加写，见 lib/update-download.ts）；
 *  2. **调安装器**：本地 Capacitor 插件 `AppInstaller`（Java 实现见
 *     `apps/mobile/android/app/src/main/java/tech/dshhub/app/AppInstallerPlugin.java`），
 *     用已有 FileProvider 生成 content:// URI 交给系统安装器。
 *
 * 这里不做任何平台判断以外的决策：Web 端（没有插件）由 store 直接走「打开链接」。
 * 插件没注册进壳时 `isPluginAvailable` 返回 false —— 绝不能盲调，否则会抛未实现异常。
 */

import { Capacitor, registerPlugin } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import {
  UPDATE_APK_DIR,
  createCacheFileSink,
  updateApkPath,
  type UpdateCacheFs,
  type UpdateFileSink,
} from './update-download'
import type { AppInstallerBridge } from './update-install'

/** AppInstaller 插件的方法签名（与 Java 侧一一对应）。 */
interface AppInstallerPlugin {
  canInstall(): Promise<{ allowed?: boolean }>
  openInstallSettings(): Promise<void>
  install(options: { path: string }): Promise<void>
  openInBrowser(options: { url: string }): Promise<void>
}

const AppInstaller = registerPlugin<AppInstallerPlugin>('AppInstaller')

/** 原生安装器桥接：Web / 壳里没注册插件时返回 null（界面退到「用浏览器下载」）。 */
export function createInstallerBridge(): AppInstallerBridge | null {
  if (!Capacitor.isNativePlatform()) return null
  if (!Capacitor.isPluginAvailable('AppInstaller')) return null
  return {
    async canInstall(): Promise<boolean> {
      const result = await AppInstaller.canInstall()
      return result?.allowed === true
    },
    openInstallSettings: () => AppInstaller.openInstallSettings(),
    install: (path) => AppInstaller.install({ path }),
    openInBrowser: (url) => AppInstaller.openInBrowser({ url }),
  }
}

/** Filesystem 的窄适配（方法签名与 UpdateCacheFs 对齐，别把整个插件类型带进来）。 */
const cacheFs: UpdateCacheFs<Directory> = {
  writeFile: (options) => Filesystem.writeFile(options),
  appendFile: (options) => Filesystem.appendFile(options),
  rmdir: (options) => Filesystem.rmdir(options),
}

/** 更新包的写入 sink：`Directory.Cache/updates/…`，先清目录再分块写。 */
export function createUpdateFileSink(version: string | null | undefined): UpdateFileSink {
  return createCacheFileSink(cacheFs, {
    path: updateApkPath(version),
    dir: UPDATE_APK_DIR,
    directory: Directory.Cache,
  })
}

/** 待装安装包相对 Cache 的路径（传给 AppInstaller.install）。 */
export function updateCachedPath(version: string | null | undefined): string {
  return updateApkPath(version)
}
