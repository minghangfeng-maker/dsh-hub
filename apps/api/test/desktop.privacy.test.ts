import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  DESKTOP_REGISTER_KEYS,
  DESKTOP_REPORT_ALLOWLIST_SIZE,
  DESKTOP_REPORT_KEYS,
  DesktopDeviceDescriptorSchema,
  DesktopDeviceReportRequestSchema,
  DesktopSettingsSchema,
  DeviceNameSchema,
  SettingsSchema,
} from '@dsh-hub/shared'
import { createTestApp, createUser, type TestApp } from './helpers.js'

/**
 * WP25a 隐私边界与迁移约束（D6 §4.3）：
 * - 上报契约的**键集合**就是白名单（17 项），且不许出现 raw/payload/content/path/… 这类名字；
 * - 迁移 120 的 CHECK 真的拦得住自由文本 / 非法枚举 / 重复安装；
 * - 桌面模块没有文件系统与容器能力（读源码断言，失败即红）。
 */
const MODULE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'modules', 'desktop')

const FORBIDDEN_KEY_PATTERN = /raw|payload|content|prompt|log|path|hostname|username|file|dir/i

describe('上报白名单（D6 §4.1：17 项）', () => {
  it('两个 schema 的键集合恰好是文档里的 17 项，且没有危险名字', () => {
    expect(DESKTOP_REGISTER_KEYS).toEqual([
      'schemaVersion',
      'installId',
      'name',
      'platform',
      'osMajor',
      'arch',
      'appVersion',
      'appChannel',
      'runtimeVersion',
      'capabilities',
    ])
    expect(DESKTOP_REPORT_KEYS).toEqual([
      'schemaVersion',
      'reportedAt',
      'appVersion',
      'appChannel',
      'runtimeVersion',
      'appliedRevision',
      'appliedAt',
      'applyState',
      'applyErrorCode',
      'errorCount',
      'plugins',
    ])
    const all = [...new Set([...DESKTOP_REGISTER_KEYS, ...DESKTOP_REPORT_KEYS])]
    expect(DESKTOP_REPORT_ALLOWLIST_SIZE).toBe(17)
    expect(all).toHaveLength(17)
    expect(all.filter((key) => FORBIDDEN_KEY_PATTERN.test(key))).toEqual([])
  })

  it('两个请求 schema 都是 strictObject：未知键 → 识别为 unrecognized_keys', () => {
    const report = DesktopDeviceReportRequestSchema.safeParse({
      schemaVersion: 1,
      reportedAt: '2026-10-21T00:00:00.000Z',
      appliedRevision: null,
      appliedAt: null,
      applyState: 'unknown',
      applyErrorCode: null,
      token: 'secret',
    })
    expect(report.success).toBe(false)
    expect(report.error?.issues[0]?.code).toBe('unrecognized_keys')

    const descriptor = DesktopDeviceDescriptorSchema.safeParse({
      schemaVersion: 1,
      platform: 'win32',
      osMajor: '11',
      arch: 'x64',
      appVersion: '0.2.1',
      appChannel: 'nightly',
      runtimeVersion: null,
      machineName: 'DESKTOP-123',
    })
    expect(descriptor.success).toBe(false)
    expect(descriptor.error?.issues[0]?.code).toBe('unrecognized_keys')
  })

  it('设备名与能力探测：路径 / 控制字符 / 超长 / 未知键都拒', () => {
    expect(DeviceNameSchema.safeParse('Windows 11 上的 DSH').success).toBe(true)
    expect(DeviceNameSchema.safeParse('C:\\Users\\me').success).toBe(false)
    expect(DeviceNameSchema.safeParse('/home/me/dsh').success).toBe(false)
    expect(DeviceNameSchema.safeParse('a\u0007b').success).toBe(false)
    expect(DeviceNameSchema.safeParse('x'.repeat(65)).success).toBe(false)

    const base = {
      schemaVersion: 1,
      platform: 'win32',
      osMajor: '11',
      arch: 'x64',
      appVersion: '0.2.1',
      appChannel: 'latest',
      runtimeVersion: null,
    }
    expect(
      DesktopDeviceDescriptorSchema.safeParse({
        ...base,
        capabilities: { claudeCode: true, codex: false, pwsh: '7' },
      }).success,
    ).toBe(true)
    expect(
      DesktopDeviceDescriptorSchema.safeParse({
        ...base,
        capabilities: { claudeCode: true, codex: false, pwsh: '7', path: '/usr/bin' },
      }).success,
    ).toBe(false)
    // 超 256 字节
    expect(
      DesktopDeviceDescriptorSchema.safeParse({
        ...base,
        capabilities: { claudeCode: true, codex: false, pwsh: '7', pad: 'x'.repeat(300) },
      }).success,
    ).toBe(false)
  })

  it('settings.desktop 的边界与默认值（D6 §5.5）', () => {
    expect(SettingsSchema.parse(DEFAULT_SETTINGS).desktop).toEqual({
      maxDevicesPerUser: 5,
      reportIntervalSec: 60,
      minReportIntervalSec: 10,
      offlineAfterSec: 180,
      diagnosticsAllowed: false,
    })
    expect(DesktopSettingsSchema.safeParse({ ...DEFAULT_SETTINGS.desktop, reportIntervalSec: 901 }).success).toBe(
      false,
    )
    expect(DesktopSettingsSchema.safeParse({ ...DEFAULT_SETTINGS.desktop, maxDevicesPerUser: 21 }).success).toBe(
      false,
    )
  })
})

describe('迁移 120 / 121 的约束真的生效', () => {
  let ctx: TestApp
  let userId: number

  beforeEach(async () => {
    ctx = await createTestApp()
    userId = (await createUser(ctx.app)).id
  })

  function insertDevice(deviceId: string, extra: Record<string, unknown> = {}): void {
    const at = '2026-10-21T00:00:00.000Z'
    const values = {
      device_id: deviceId,
      user_id: userId,
      install_key: null,
      name: 'Windows 11 上的 DSH',
      platform: 'win32',
      os_major: '11',
      arch: 'x64',
      app_version: '0.2.1',
      app_channel: 'latest',
      runtime_version: null,
      apply_state: 'unknown',
      first_seen_at: at,
      created_at: at,
      updated_at: at,
      ...extra,
    }
    const columns = Object.keys(values)
    ctx.app.deps.db.run(
      `INSERT INTO desktop_devices (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      ...(Object.values(values) as (string | number | null)[]),
    )
  }

  const DEVICE_ID = `dv_${'a'.repeat(32)}`

  it('device_id / platform / apply_state / name 的长度与枚举受 CHECK 约束', () => {
    const db = ctx.app.deps.db
    expect(() => insertDevice('not-a-device-id')).toThrow()
    expect(() => insertDevice(DEVICE_ID, { platform: 'windows' })).toThrow()
    expect(() => insertDevice(DEVICE_ID, { apply_state: 'installed' })).toThrow()
    expect(() => insertDevice(DEVICE_ID, { name: 'x'.repeat(65) })).toThrow()
    expect(() => insertDevice(DEVICE_ID, { app_channel: 'stable' })).toThrow()
    expect(() => insertDevice(DEVICE_ID, { capabilities_json: 'x'.repeat(300) })).toThrow()
    expect(() => insertDevice(DEVICE_ID, { revoke_reason: 'banana' })).toThrow()
    // 合法一行
    expect(() => insertDevice(DEVICE_ID)).not.toThrow()
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_devices')!.n).toBe(1)
  })

  it('同一用户 + 同一 install_key 只允许一条 active；吊销后可以再建', () => {
    const db = ctx.app.deps.db
    const installKey = 'b'.repeat(64)
    insertDevice(DEVICE_ID, { install_key: installKey })
    expect(() => insertDevice(`dv_${'c'.repeat(32)}`, { install_key: installKey })).toThrow()
    db.run(
      `UPDATE desktop_devices SET status = 'revoked', revoked_at = ?, revoke_reason = 'user'
        WHERE device_id = ?`,
      '2026-10-21T01:00:00.000Z',
      DEVICE_ID,
    )
    expect(() =>
      insertDevice(`dv_${'c'.repeat(32)}`, { install_key: installKey }),
    ).not.toThrow()
    // 另一个用户可以用同一个 install_key（按用户加盐后本来就不会相同，这里只是确认索引按 user 分）
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_devices')!.n).toBe(2)
  })

  it('插件与令牌随设备级联删除；令牌主键必须是 64 位哈希', () => {
    const db = ctx.app.deps.db
    insertDevice(DEVICE_ID)
    db.run(
      `INSERT INTO desktop_device_plugins (device_id, package_name, version, source, state, updated_at)
       VALUES (?, 'dsh-email', '0.16.0', 'user', 'enabled', ?)`,
      DEVICE_ID,
      '2026-10-21T00:00:00.000Z',
    )
    db.run(
      `INSERT INTO desktop_device_tokens (id, device_id, user_id, created_at, last_used_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'd'.repeat(64),
      DEVICE_ID,
      userId,
      '2026-10-21T00:00:00.000Z',
      '2026-10-21T00:00:00.000Z',
      '2026-10-21T00:00:00.000Z',
    )
    expect(() =>
      db.run(
        `INSERT INTO desktop_device_tokens (id, device_id, user_id, created_at, last_used_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        'short',
        DEVICE_ID,
        userId,
        '2026-10-21T00:00:00.000Z',
        '2026-10-21T00:00:00.000Z',
        '2026-10-21T00:00:00.000Z',
      ),
    ).toThrow()
    expect(() =>
      db.run(
        `INSERT INTO desktop_device_plugins (device_id, package_name, version, source, state, updated_at)
         VALUES (?, 'x', '1.0.0', 'user', 'broken', ?)`,
        DEVICE_ID,
        '2026-10-21T00:00:00.000Z',
      ),
    ).toThrow()

    db.run('DELETE FROM desktop_devices WHERE device_id = ?', DEVICE_ID)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_device_plugins')!.n).toBe(0)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM desktop_device_tokens')!.n).toBe(0)
  })

  it('088：relay_usage.client_kind 默认 unknown；relay_keys.device_id 只收 dv_ 形状', () => {
    const db = ctx.app.deps.db
    db.run(
      `INSERT INTO relay_usage (request_id, created_at, user_id, model, api, stream, source, status)
       VALUES ('r1', ?, ?, 'm', 'openai-completions', 0, 'local', 'ok')`,
      '2026-10-21T00:00:00.000Z',
      userId,
    )
    expect(
      db.get<{ client_kind: string }>('SELECT client_kind FROM relay_usage WHERE request_id = ?', 'r1')!
        .client_kind,
    ).toBe('unknown')
    expect(() =>
      db.run(
        `INSERT INTO relay_keys (user_id, scope, kind, name, key_hash, preview, created_at, device_id)
         VALUES (?, 'dsh', 'user', 'x', 'h1', 'p', ?, 'not-a-device')`,
        userId,
        '2026-10-21T00:00:00.000Z',
      ),
    ).toThrow()
  })
})

describe('桌面模块没有文件 / 容器能力（D6 §4.3 L1-6 的源码守卫）', () => {
  const FORBIDDEN = [
    'deps.driver',
    'runOnce',
    'child_process',
    'execSync',
    'followLogs',
    'readFileSync',
    'statSync',
    'writeFileSync',
    'createReadStream',
  ]

  /** 去掉注释再扫描：文档里明确写着「本模块不 import deps.driver」，那不是调用 */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  }

  it('模块源码里不出现容器 / 文件系统调用', () => {
    const files = readdirSync(MODULE_DIR).filter((file) => file.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(4)
    const hits: string[] = []
    for (const file of files) {
      const source = stripComments(readFileSync(join(MODULE_DIR, file), 'utf8'))
      for (const needle of FORBIDDEN) {
        if (source.includes(needle)) hits.push(`${file}: ${needle}`)
      }
    }
    expect(hits).toEqual([])
  })
})
