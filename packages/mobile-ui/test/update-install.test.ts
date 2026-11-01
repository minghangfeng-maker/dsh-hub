/**
 * 调起系统安装器的流程（0.3.1）。
 *
 * 真机要点：Android 8+ 第一次装「未知来源」的包，`canInstall()` 是 false，
 * 必须先打开系统设置让用户允许，**不能**直接调安装器（会被系统拒绝且没有提示）。
 * 用户从设置页回到 App 后（appStateChange），再查一次权限并调起安装器。
 */

import { describe, expect, it } from 'vitest'
import { PendingInstall, installUpdate, type AppInstallerBridge } from '@/lib/update-install'

const APK = 'updates/dsh-hub-app-0.3.1.apk'

interface FakeBridge {
  bridge: AppInstallerBridge
  calls: string[]
}

function fakeBridge(options: {
  allowed: boolean | (() => boolean | Promise<boolean>)
  failSettings?: boolean
  failInstall?: boolean
}): FakeBridge {
  const calls: string[] = []
  const allowed = async (): Promise<boolean> =>
    typeof options.allowed === 'function' ? await options.allowed() : options.allowed
  const bridge: AppInstallerBridge = {
    async canInstall() {
      calls.push('canInstall')
      return await allowed()
    },
    async openInstallSettings() {
      calls.push('openInstallSettings')
      if (options.failSettings) throw new Error('no settings activity')
    },
    async install(path: string) {
      calls.push(`install:${path}`)
      if (options.failInstall) throw new Error('no installer')
    },
    async openInBrowser(url: string) {
      calls.push(`openInBrowser:${url}`)
    },
  }
  return { bridge, calls }
}

describe('installUpdate', () => {
  it('已有权限：直接调起安装器', async () => {
    const fake = fakeBridge({ allowed: true })
    const outcome = await installUpdate(fake.bridge, APK)

    expect(outcome).toBe('installer-opened')
    expect(fake.calls).toEqual(['canInstall', `install:${APK}`])
  })

  it('没有权限：先去系统设置页，不碰安装器', async () => {
    const fake = fakeBridge({ allowed: false })
    const outcome = await installUpdate(fake.bridge, APK)

    expect(outcome).toBe('needs-permission')
    expect(fake.calls).toEqual(['canInstall', 'openInstallSettings'])
  })

  it('canInstall 自己抛错（插件没注册）：不吞，交给上层转成界面文案', async () => {
    const bridge: AppInstallerBridge = {
      async canInstall() {
        throw new Error('"AppInstaller" plugin is not implemented on android')
      },
      async openInstallSettings() {},
      async install() {},
      async openInBrowser() {},
    }
    await expect(installUpdate(bridge, APK)).rejects.toThrow('not implemented')
  })

  it('打开设置失败也要抛出（别假装已经引导用户去了）', async () => {
    const fake = fakeBridge({ allowed: false, failSettings: true })
    await expect(installUpdate(fake.bridge, APK)).rejects.toThrow('no settings activity')
    expect(fake.calls).toEqual(['canInstall', 'openInstallSettings'])
  })
})

describe('PendingInstall（回到前台续装）', () => {
  it('没授权就一直等：不重复打开设置页，也不调安装器', async () => {
    let allowed = false
    const fake = fakeBridge({ allowed: () => allowed })
    const pending = new PendingInstall(fake.bridge)
    pending.arm(APK)

    expect(await pending.onForeground()).toBe('needs-permission')
    expect(await pending.onForeground()).toBe('needs-permission')
    expect(fake.calls).toEqual(['canInstall', 'canInstall'])
    expect(pending.pendingPath).toBe(APK)

    // 用户在系统设置里允许了，回到 App → 自动调起安装器（只一次）
    allowed = true
    expect(await pending.onForeground()).toBe('installer-opened')
    expect(fake.calls).toEqual(['canInstall', 'canInstall', 'canInstall', `install:${APK}`])
    expect(pending.pendingPath).toBeNull()

    // 装完之后再回前台：什么都不做（不会反复弹安装器）
    expect(await pending.onForeground()).toBe('none')
    expect(fake.calls).toHaveLength(4)
  })

  it('没有待装包时 onForeground 是 no-op', async () => {
    const fake = fakeBridge({ allowed: true })
    const pending = new PendingInstall(fake.bridge)
    expect(await pending.onForeground()).toBe('none')
    expect(fake.calls).toEqual([])
  })

  it('clear() 之后不再续装（用户点了「稍后」/重新下载）', async () => {
    const fake = fakeBridge({ allowed: true })
    const pending = new PendingInstall(fake.bridge)
    pending.arm(APK)
    pending.clear()
    expect(await pending.onForeground()).toBe('none')
    expect(fake.calls).toEqual([])
  })

  it('并发回前台（两次 appStateChange）只安装一次', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let canInstallCalls = 0
    const calls: string[] = []
    const bridge: AppInstallerBridge = {
      async canInstall() {
        canInstallCalls += 1
        await gate
        return true
      },
      async openInstallSettings() {},
      async install(path: string) {
        calls.push(`install:${path}`)
      },
      async openInBrowser() {},
    }
    const pending = new PendingInstall(bridge)
    pending.arm(APK)

    const first = pending.onForeground()
    const second = pending.onForeground()
    release!()

    expect(await first).toBe('installer-opened')
    expect(await second).toBe('none')
    expect(canInstallCalls).toBe(1)
    expect(calls).toEqual([`install:${APK}`])
  })
})
