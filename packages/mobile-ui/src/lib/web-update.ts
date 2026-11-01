/**
 * 网页版「有新版本，点此刷新」（WP54 C7）——界面层的**唯一入口**：
 * 设置页的版本区与全局 UpdateNotice 都只认这里，不直接碰 app-update store。
 *
 * 状态来自 `stores/app-update` 的 `webUpdateAvailable`（W1：回前台 / 每 30 分钟拉一次
 * `./version.json`，与内置版本不同即为 true）；刷新 = `reloadToUpdate()`（Hub 的 index.html 是 no-store）。
 */

import { useAppUpdateStore } from '@/stores/app-update'

export interface WebUpdateHandle {
  /** 有没有可用的新版本。 */
  readonly available: boolean
  /** 刷新到新版。 */
  reload(): void
}

export function useWebUpdate(): WebUpdateHandle {
  const appUpdate = useAppUpdateStore()
  return {
    get available(): boolean {
      return appUpdate.webUpdateAvailable
    },
    reload: () => appUpdate.reloadToUpdate(),
  }
}
