import { describe, expect, it } from 'vitest'
import {
  FACTORY_BUNDLES,
  applyPackageChanges,
  backupFileName,
  backupStamp,
  orderBundles,
  parsePackageJson,
  readBundles,
  readManaged,
  selectBackupsToDelete,
  serializePackageJson,
  type JsonObject,
} from '../src/modules/plugins/package-json.js'

/**
 * profile package.json 变换（06 §2.3 §2.4）：加/升级/卸载、bundles 三段排序、
 * 保留用户自装项与未知字段、幂等。
 */

const NOW = '2026-10-12T13:00:00.000Z'

function profileJson(overrides: Partial<JsonObject> = {}): JsonObject {
  return {
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...FACTORY_BUNDLES] } },
    ...overrides,
  }
}

const EMAIL = {
  packageName: 'dsh-email',
  spec: '0.16.0',
  isBundle: true,
  bundleOrder: 10,
  version: '0.16.0',
}
const LOCAL = {
  packageName: '@local/dsh-file-download',
  spec: 'file:/opt/hub/plugin-store/local-dsh-file-download-1.0.0.tgz',
  isBundle: true,
  bundleOrder: 20,
  version: '1.0.0',
}

describe('package.json 变换', () => {
  it('安装：写 dependencies（精确 spec）、bundles 末尾追加、登记 dshHub.managed', () => {
    const result = applyPackageChanges({ json: profileJson(), add: [EMAIL], now: NOW })
    expect(result.json.dependencies).toEqual({ 'dsh-email': '0.16.0' })
    expect(readBundles(result.json)).toEqual([...FACTORY_BUNDLES, 'dsh-email'])
    expect(readManaged(result.json)).toEqual({ 'dsh-email': '0.16.0' })
    expect((result.json.dshHub as { updatedAt: string }).updatedAt).toBe(NOW)
    expect(result.changed).toBe(true)
  })

  it('升级：只改 spec 与版本，不影响 bundles 顺序', () => {
    const first = applyPackageChanges({ json: profileJson(), add: [EMAIL], now: NOW }).json
    const upgraded = applyPackageChanges({
      json: first,
      add: [{ ...EMAIL, spec: '0.17.0', version: '0.17.0' }],
      now: NOW,
    })
    expect(upgraded.json.dependencies).toEqual({ 'dsh-email': '0.17.0' })
    expect(readBundles(upgraded.json)).toEqual([...FACTORY_BUNDLES, 'dsh-email'])
    expect(readManaged(upgraded.json)).toEqual({ 'dsh-email': '0.17.0' })
  })

  it('卸载：从 dependencies、bundles、dshHub.managed 三处删掉', () => {
    const installed = applyPackageChanges({ json: profileJson(), add: [EMAIL, LOCAL], now: NOW }).json
    const removed = applyPackageChanges({
      json: installed,
      remove: ['dsh-email'],
      now: NOW,
    })
    expect(removed.json.dependencies).toEqual({
      '@local/dsh-file-download': LOCAL.spec,
    })
    expect(readBundles(removed.json)).toEqual([...FACTORY_BUNDLES, '@local/dsh-file-download'])
    expect(readManaged(removed.json)).toEqual({ '@local/dsh-file-download': '1.0.0' })
  })

  it('bundles 顺序：出厂 → Hub 管理（bundle_order）→ 用户自装（原相对顺序）', () => {
    const json = profileJson({
      dependencies: { 'dsh-email': '0.16.0', 'user-plugin': '2.0.0', '@local/x': '1.0.0' },
      dshHub: { managed: { 'dsh-email': '0.16.0', '@local/x': '1.0.0' }, updatedAt: NOW },
      dsh: {
        profile: {
          bundles: [...FACTORY_BUNDLES, 'user-plugin', 'dsh-email', '@local/x', 'another-user-plugin'],
        },
      },
    })
    const result = applyPackageChanges({
      json,
      bundleOrders: { 'dsh-email': 50, '@local/x': 10 },
      now: NOW,
    })
    expect(readBundles(result.json)).toEqual([
      ...FACTORY_BUNDLES,
      '@local/x',
      'dsh-email',
      'user-plugin',
      'another-user-plugin',
    ])
    // 用户自装项原样保留（依赖与 bundles 都不动）
    expect((result.json.dependencies as Record<string, string>)['user-plugin']).toBe('2.0.0')
  })

  it('保留未知字段与顶层键顺序', () => {
    const json = profileJson({ customField: { keep: true }, extra: 'x' })
    const result = applyPackageChanges({ json, add: [EMAIL], now: NOW })
    expect(Object.keys(result.json)).toEqual([
      'name',
      'private',
      'dependencies',
      'dsh',
      'customField',
      'extra',
      'dshHub',
    ])
    expect(result.json.customField).toEqual({ keep: true })
  })

  it('幂等：同一变更应用两次结果相同（第二次不再改文件）', () => {
    const first = applyPackageChanges({ json: profileJson(), add: [EMAIL], now: NOW })
    const second = applyPackageChanges({ json: first.json, add: [EMAIL], now: '2026-10-13T00:00:00.000Z' })
    expect(serializePackageJson(second.json)).toBe(serializePackageJson(first.json))
    expect(second.changed).toBe(false)
    // 内容没变时 updatedAt 保持原值（否则每次对账都会改文件）
    expect((second.json.dshHub as { updatedAt: string }).updatedAt).toBe(NOW)
  })

  it('isBundle=false 的插件只进 dependencies，不进 bundles', () => {
    const result = applyPackageChanges({
      json: profileJson(),
      add: [{ ...EMAIL, isBundle: false }],
      now: NOW,
    })
    expect(readBundles(result.json)).toEqual([...FACTORY_BUNDLES])
    expect(readManaged(result.json)).toEqual({ 'dsh-email': '0.16.0' })
  })

  it('orderBundles 去重；同 bundle_order 时保持原相对顺序', () => {
    const ordered = orderBundles({
      bundles: ['b', 'a', 'b', ...FACTORY_BUNDLES],
      managed: { a: '1', b: '1' },
      bundleOrders: {},
    })
    expect(ordered).toEqual([...FACTORY_BUNDLES, 'b', 'a'])
  })

  it('备份轮转：只保留最近 3 份，按文件名（定宽时间戳）排序', () => {
    const files = [
      backupFileName(backupStamp(new Date('2026-10-12T10:00:00.000Z'))),
      backupFileName(backupStamp(new Date('2026-10-12T11:00:00.000Z'))),
      backupFileName(backupStamp(new Date('2026-10-12T12:00:00.000Z'))),
      backupFileName(backupStamp(new Date('2026-10-12T13:00:00.000Z'))),
      'package.json',
      'pnpm-lock.yaml',
    ]
    const toDelete = selectBackupsToDelete(files, 3)
    expect(toDelete).toEqual(['package.json.hub-bak-20261012T100000000Z'])
  })

  it('parsePackageJson 拒绝非法 JSON / 非对象', () => {
    expect(() => parsePackageJson('[]')).toThrow(/顶层不是对象/u)
    expect(() => parsePackageJson('{oops')).toThrow(/不是合法 JSON/u)
  })
})
