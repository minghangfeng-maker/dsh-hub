import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  buildManifest,
  compareSemver,
  configDigestOf,
  effectiveFragments,
  effectivePlugins,
  feedFileOf,
  manifestEtagOf,
  publicizeRelayBaseUrls,
  releaseTargetOf,
  resolveAppPolicy,
  rolloutBucketOf,
} from '../src/modules/desktop-delivery/index.js'
import type { ManifestInputs, ManifestDeviceContext } from '../src/modules/desktop-delivery/manifest.js'
import {
  carriesCodexBinary,
  findForbiddenClaudeBinary,
  hasFileNamed,
  hasPackageJson,
  scanTarGzNames,
} from '../src/modules/desktop-delivery/tar-scan.js'
import type {
  ChannelPolicyRow,
  ConfigFragmentRow,
  PluginTargetRow,
  PolicyOverrideRow,
  UninstallRow,
} from '../src/modules/desktop-delivery/repo.js'

/**
 * WP25b 纯函数测试：清单渲染（作用域优先级 / level / 灰度）、semver 比较、ETag、tar 头部扫描。
 * 这些是「错了不会报错、只会悄悄下发错东西」的地方，所以单独用不依赖数据库的样例钉住。
 */

const DEVICE: ManifestDeviceContext = {
  deviceId: 'dv_0123456789abcdef0123456789abcdef',
  userId: 7,
  role: 'user',
  appChannel: 'latest',
  platform: 'win32',
  arch: 'x64',
}

function pluginRow(overrides: Partial<PluginTargetRow> & { id: number; scope: string }): PluginTargetRow {
  return {
    plugin_id: overrides.id,
    version_id: overrides.id,
    enabled: 1,
    role: '',
    user_id: null,
    package_name: `@local/plugin-${String(overrides.id)}`,
    display_name: 'x',
    policy: 'default',
    bundle_order: 100,
    needs_restart: 1,
    config_yaml: '',
    version: '1.0.0',
    min_dsh: null,
    file_name: `plugin-${String(overrides.id)}-1.0.0.tgz`,
    bytes: 1024,
    sha256: 'a'.repeat(64),
    artifact_uploaded_at: '2026-10-21T12:00:00.000Z',
    ...overrides,
  } as PluginTargetRow
}

function fragmentRow(
  overrides: Partial<ConfigFragmentRow> & { id: number; entry_id: string },
): ConfigFragmentRow {
  return {
    mode: 'enforce',
    config_json: '{"a":1}',
    note: '',
    scope: 'all',
    role: '',
    user_id: null,
    ...overrides,
  } as ConfigFragmentRow
}

function inputs(overrides: Partial<ManifestInputs> = {}): ManifestInputs {
  return {
    now: '2026-10-21T12:00:00.000Z',
    revision: 3,
    origin: 'https://hub.test',
    device: DEVICE,
    plugins: [],
    fragments: [],
    uninstalls: [],
    channelPolicy: undefined,
    overrides: [],
    feedAvailable: false,
    ...overrides,
  }
}

describe('清单渲染（纯函数）', () => {
  it('作用域优先级：用户 > 角色 > 全部', () => {
    const rows = [
      pluginRow({ id: 1, scope: 'all', user_id: null, version: '1.0.0' }),
      pluginRow({ id: 1, scope: 'role', role: 'user', user_id: null, version: '2.0.0' }),
      pluginRow({ id: 1, scope: 'user', user_id: 7, version: '3.0.0' }),
      pluginRow({ id: 2, scope: 'role', role: 'admin', user_id: null, version: '9.9.9' }),
    ]
    const effective = effectivePlugins(rows, DEVICE)
    expect(effective).toHaveLength(1)
    expect(effective[0]!.version).toBe('3.0.0')

    const fragments = effectiveFragments(
      [
        fragmentRow({ id: 1, entry_id: 'llm-pi-ai', scope: 'all', config_json: '{"a":1}' }),
        fragmentRow({ id: 2, entry_id: 'llm-pi-ai', scope: 'role', role: 'user', config_json: '{"a":2}' }),
        fragmentRow({ id: 3, entry_id: 'llm-pi-ai', scope: 'user', user_id: 7, config_json: '{"a":3}' }),
      ],
      DEVICE,
    )
    expect(fragments).toHaveLength(1)
    expect(fragments[0]!.config_json).toBe('{"a":3}')
  })

  it('level 映射 + optional 恒 enabled=false + core 恒 true', () => {
    const rows = [
      pluginRow({ id: 1, scope: 'all', policy: 'required', enabled: 0 }),
      pluginRow({ id: 2, scope: 'all', policy: 'optional', enabled: 1 }),
      pluginRow({ id: 3, scope: 'all', policy: 'hidden', enabled: 1 }),
      pluginRow({ id: 4, scope: 'all', policy: 'default', enabled: 1 }),
    ]
    const { manifest, warnings } = buildManifest(inputs({ plugins: rows }))
    const byName = Object.fromEntries(manifest.plugins.map((plugin) => [plugin.name, plugin]))
    expect(byName['@local/plugin-1']).toMatchObject({ level: 'core', enabled: true })
    expect(byName['@local/plugin-2']).toMatchObject({ level: 'optional', enabled: false })
    expect(byName['@local/plugin-3']).toBeUndefined()
    expect(byName['@local/plugin-4']).toMatchObject({ level: 'default', enabled: true })
    expect(warnings.some((line) => line.includes('hidden'))).toBe(true)
  })

  it('缺整包的插件被跳过并告警；保留 id 的插件配置被丢弃', () => {
    const rows = [
      pluginRow({ id: 1, scope: 'all', file_name: null, sha256: null, bytes: null }),
      pluginRow({
        id: 2,
        scope: 'all',
        config_yaml: '- id: llm-pi-ai\n  config: {}\n- id: memory\n  config: {topK: 8}\n',
      }),
    ]
    const { manifest, warnings } = buildManifest(inputs({ plugins: rows }))
    expect(manifest.plugins.map((plugin) => plugin.name)).toEqual(['@local/plugin-2'])
    expect(manifest.plugins[0]!.config).toEqual([{ id: 'memory', config: { topK: 8 } }])
    expect(warnings.some((line) => line.includes('桌面整包'))).toBe(true)
    expect(warnings.some((line) => line.includes('保留条目 llm-pi-ai'))).toBe(true)
  })

  it('artifact URL / filename / 设备自检段', () => {
    const { manifest } = buildManifest(
      inputs({
        plugins: [pluginRow({ id: 5, scope: 'all', package_name: '@local/desk-memory', version: '0.1.2' })],
      }),
    )
    expect(manifest.device).toEqual({ deviceId: DEVICE.deviceId, userId: 7 })
    expect(manifest.plugins[0]!.artifact.url).toBe(
      'https://hub.test/api/desktop/plugins/@local/desk-memory/0.1.2.tgz',
    )
    expect(manifest.plugins[0]!.artifact.filename).toBe('desk-memory-0.1.2.tgz')
  })

  it('配置片段：摘要稳定、按 id 排序、卸载取并集', () => {
    const fragments = [
      fragmentRow({ id: 1, entry_id: 'llm-pi-ai', config_json: '{"a":1}' }),
      fragmentRow({ id: 2, entry_id: 'claude-pilot', mode: 'default', config_json: '{"hubMode":true}' }),
    ]
    const uninstalls: UninstallRow[] = [
      { id: 1, package_name: '@local/old-a', scope: 'all', role: '', user_id: null },
      { id: 2, package_name: '@local/old-b', scope: 'user', role: '', user_id: 7 },
      { id: 3, package_name: '@local/old-c', scope: 'user', role: '', user_id: 99 },
    ]
    const first = buildManifest(inputs({ fragments, uninstalls })).manifest
    const second = buildManifest(inputs({ fragments: [...fragments].reverse(), uninstalls })).manifest
    expect(first.config!.fragments.map((fragment) => fragment.id)).toEqual(['claude-pilot', 'llm-pi-ai'])
    expect(first.config!.digest).toBe(second.config!.digest)
    expect(first.config!.digest).toBe(configDigestOf(first.config!.fragments))
    expect(first.config!.allowlistVersion).toBe(1)
    expect(first.uninstall).toEqual(['@local/old-a', '@local/old-b'])
  })

  it('中转站内部地址改走公开 origin：只动指向内部监听器的 baseURL，路径保留', () => {
    const config = {
      providers: {
        hub: { baseURL: 'http://10.213.0.1:7710/v1', apiKeyEnv: 'HUB_MK_HUB', models: [{ id: 'm@c' }] },
        'hub-anthropic': { baseURL: 'http://10.213.0.1:7710', apiKeyEnv: 'HUB_MK_HUB' },
        other: { baseURL: 'https://api.example.com/v1' },
      },
    }
    expect(publicizeRelayBaseUrls(config, 'http://10.213.0.1:7710', 'https://hub.test/')).toEqual({
      providers: {
        hub: { baseURL: 'https://hub.test/v1', apiKeyEnv: 'HUB_MK_HUB', models: [{ id: 'm@c' }] },
        'hub-anthropic': { baseURL: 'https://hub.test', apiKeyEnv: 'HUB_MK_HUB' },
        other: { baseURL: 'https://api.example.com/v1' },
      },
    })
    // 中转站没在监听：原样返回
    expect(publicizeRelayBaseUrls(config, null, 'https://hub.test')).toBe(config)

    const fragments = [
      fragmentRow({
        id: 1,
        entry_id: 'llm-pi-ai',
        config_json: '{"providers":{"hub":{"baseURL":"http://10.213.0.1:7710/v1"}}}',
      }),
      fragmentRow({ id: 2, entry_id: 'web-deepseek-api', config_json: '{"baseURL":"http://10.213.0.1:7710/v1"}' }),
    ]
    const { manifest } = buildManifest(inputs({ fragments, relayInternalOrigin: 'http://10.213.0.1:7710' }))
    expect(JSON.stringify(manifest.config!.fragments)).not.toContain('10.213.0.1')
    expect(manifest.config!.fragments.find((fragment) => fragment.id === 'web-deepseek-api')!.config).toEqual({
      baseURL: 'https://hub.test/v1',
    })
  })

  it('app 策略：没配任何东西就不出现；配了地板就用 0.0.0 兜底', () => {
    expect(buildManifest(inputs()).manifest.app).toBeUndefined()

    const floorOnly: ChannelPolicyRow = {
      channel: 'latest',
      target_version: null,
      min_version: null,
      min_version_hard: 0,
      rollout_percent: 100,
    }
    expect(buildManifest(inputs({ channelPolicy: floorOnly })).manifest.app).toBeUndefined()

    const withTarget: ChannelPolicyRow = { ...floorOnly, target_version: '0.2.2' }
    const app = buildManifest(inputs({ channelPolicy: withTarget })).manifest.app
    expect(app).toEqual({
      channel: 'latest',
      minVersion: '0.0.0',
      minVersionHard: false,
      targetVersion: '0.2.2',
    })
  })

  it('灰度：0% 一定不命中、100% 一定命中，中间值按 deviceId 稳定分桶', () => {
    const policy: ChannelPolicyRow = {
      channel: 'latest',
      target_version: '0.2.2',
      min_version: '0.2.1',
      min_version_hard: 1,
      rollout_percent: 0,
    }
    expect(resolveAppPolicy(DEVICE, policy, []).inRollout).toBe(false)
    expect(buildManifest(inputs({ channelPolicy: policy })).manifest.app!.targetVersion).toBeUndefined()

    const full = { ...policy, rollout_percent: 100 }
    expect(resolveAppPolicy(DEVICE, full, []).inRollout).toBe(true)
    expect(buildManifest(inputs({ channelPolicy: full })).manifest.app!.minVersionHard).toBe(true)

    // 同一次判定永远一样（稳定分桶），且落在 0–99
    const bucket = rolloutBucketOf(DEVICE.deviceId)
    expect(bucket).toBeGreaterThanOrEqual(0)
    expect(bucket).toBeLessThan(100)
    expect(rolloutBucketOf(DEVICE.deviceId)).toBe(bucket)
    const threshold = { ...policy, rollout_percent: bucket + 1 }
    expect(resolveAppPolicy(DEVICE, threshold, []).inRollout).toBe(true)
    const below = { ...policy, rollout_percent: bucket }
    expect(resolveAppPolicy(DEVICE, below, []).inRollout).toBe(false)
  })

  it('版本策略覆盖：用户 > 角色 > 渠道，null 字段不参与覆盖', () => {
    const channel: ChannelPolicyRow = {
      channel: 'latest',
      target_version: '0.2.2',
      min_version: '0.2.1',
      min_version_hard: 0,
      rollout_percent: 100,
    }
    const roleOverride: PolicyOverrideRow = {
      id: 1,
      channel: 'latest',
      scope: 'role',
      role: 'user',
      user_id: null,
      target_version: '0.2.3',
      min_version: null,
      min_version_hard: null,
      rollout_percent: null,
    }
    const userOverride: PolicyOverrideRow = {
      id: 2,
      channel: 'latest',
      scope: 'user',
      role: '',
      user_id: 7,
      target_version: null,
      min_version: '0.2.0',
      min_version_hard: null,
      rollout_percent: null,
    }
    const resolved = resolveAppPolicy(DEVICE, channel, [roleOverride, userOverride])
    expect(resolved.targetVersion).toBe('0.2.3')
    expect(resolved.minVersion).toBe('0.2.0')
  })

  it('feedUrl：有发布且平台能映射时才给（mac 的 feed 文件名带 -mac）', () => {
    expect(buildManifest(inputs({ feedAvailable: true })).manifest.app!.feedUrl).toBe(
      'https://hub.test/desktop/feeds/win-x64/',
    )
    expect(
      buildManifest(inputs({ feedAvailable: true, device: { ...DEVICE, platform: 'darwin', arch: 'arm64' } }))
        .manifest.app!.feedUrl,
    ).toBe('https://hub.test/desktop/feeds/mac-arm64/')
    expect(
      buildManifest(inputs({ feedAvailable: true, device: { ...DEVICE, platform: 'linux', arch: 'x64' } }))
        .manifest.app,
    ).toBeUndefined()
    expect(feedFileOf('win-x64', 'latest')).toBe('latest.yml')
    expect(feedFileOf('mac-arm64', 'nightly')).toBe('nightly-mac.yml')
    expect(releaseTargetOf('win32', 'x64')).toBe('win-x64')
    expect(releaseTargetOf('darwin', 'x64')).toBe('mac-x64')
    expect(releaseTargetOf('linux', 'x64')).toBeNull()
  })

  it('ETag 不含 issuedAt（否则每次拉取都变）', () => {
    const first = buildManifest(inputs()).manifest
    const second = buildManifest(inputs({ now: '2026-10-22T00:00:00.000Z' })).manifest
    expect(manifestEtagOf(first)).toBe(manifestEtagOf(second))
    expect(manifestEtagOf(first)).toBe(manifestEtagOf(second))
    const changed = buildManifest(inputs({ revision: 4 })).manifest
    expect(manifestEtagOf(changed)).not.toBe(manifestEtagOf(first))
  })
})

describe('semver 比较', () => {
  it('主次修补 + 预发布', () => {
    expect(compareSemver('0.2.1', '0.2.1')).toBe(0)
    expect(compareSemver('0.2.0', '0.2.1')).toBe(-1)
    expect(compareSemver('0.3.0', '0.2.9')).toBe(1)
    expect(compareSemver('0.2.1-rc.1', '0.2.1')).toBe(-1)
    expect(compareSemver('0.2.1-rc.10', '0.2.1-rc.2')).toBe(1)
    expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1)
    expect(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(-1)
    expect(compareSemver('1.0.0+build.1', '1.0.0')).toBe(0)
  })
})

describe('tar 头部扫描（裁决 #16 的检查基础）', () => {
  function tarHeader(name: string, size: number, prefix = ''): Buffer {
    const header = Buffer.alloc(512)
    Buffer.from(name, 'utf8').copy(header, 0)
    header.write('0000644\0', 100, 8, 'utf8')
    header.write('0000000\0', 108, 8, 'utf8')
    header.write('0000000\0', 116, 8, 'utf8')
    header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8')
    header.write('00000000000\0', 136, 12, 'utf8')
    header.write('        ', 148, 8, 'utf8')
    header.write('0', 156, 1, 'utf8')
    header.write('ustar\0', 257, 6, 'utf8')
    header.write('00', 263, 2, 'utf8')
    Buffer.from(prefix, 'utf8').copy(header, 345)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')
    return header
  }

  function tarWith(entries: { name: string; content: string; prefix?: string }[]): Buffer {
    const blocks: Buffer[] = []
    for (const entry of entries) {
      const data = Buffer.from(entry.content, 'utf8')
      blocks.push(tarHeader(entry.name, data.byteLength, entry.prefix ?? ''))
      blocks.push(data)
      const padding = (512 - (data.byteLength % 512)) % 512
      if (padding > 0) blocks.push(Buffer.alloc(padding))
    }
    blocks.push(Buffer.alloc(1024))
    return gzipSync(Buffer.concat(blocks))
  }

  function withTempPackage(buffer: Buffer, run: (file: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'dshhub-wp25b-tar-'))
    const file = join(dir, 'pkg.tgz')
    writeFileSync(file, buffer)
    return run(file).finally(() => rmSync(dir, { recursive: true, force: true }))
  }

  it('读出条目名（含 prefix 长路径）且不缓冲文件数据', async () => {
    await withTempPackage(
      tarWith([
        { name: 'package/package.json', content: '{"name":"x","version":"1.0.0"}' },
        {
          name: 'claude-agent-sdk-win32-x64/package.json',
          prefix: 'package/node_modules/@anthropic-ai',
          content: '{"name":"y"}',
        },
      ]),
      async (file) => {
        const scanned = await scanTarGzNames(file)
        expect(scanned.names).toContain('package/package.json')
        expect(scanned.names).toContain(
          'package/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/package.json',
        )
        expect(hasPackageJson(scanned.names)).toBe(true)
        expect(findForbiddenClaudeBinary(scanned.names)).toBe(
          'package/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/package.json',
        )
        expect(carriesCodexBinary(scanned.names)).toBe(false)
      },
    )
  })

  it('禁运清单：claude 的平台包、pnpm 风格目录、裸二进制都命中；claude-pilot 名字不误伤', () => {
    expect(findForbiddenClaudeBinary(['package/@anthropic-ai/claude-agent-sdk/index.js'])).not.toBeNull()
    expect(findForbiddenClaudeBinary(['package/@anthropic-ai+claude-agent-sdk-win32-x64/x'])).not.toBeNull()
    expect(findForbiddenClaudeBinary(['package/bin/claude'])).not.toBeNull()
    expect(findForbiddenClaudeBinary(['package/vendor/claude.exe'])).not.toBeNull()
    expect(findForbiddenClaudeBinary(['package/lib/claude-pilot.js'])).toBeNull()
  })

  it('codex 二进制识别与 LICENSE/NOTICE 检查', () => {
    expect(carriesCodexBinary(['package/node_modules/@openai/codex-win32-x64/package.json'])).toBe(true)
    expect(carriesCodexBinary(['package/vendor/codex'])).toBe(true)
    expect(carriesCodexBinary(['package/lib/codex-pilot.js'])).toBe(false)
    expect(hasFileNamed(['package/LICENSE', 'package/README.md'], ['LICENSE', 'NOTICE'])).toBe(true)
    expect(hasFileNamed(['package/LICENSE'], ['LICENSE', 'NOTICE'])).toBe(true)
    expect(hasFileNamed(['package/README.md'], ['LICENSE', 'NOTICE'])).toBe(false)
  })

  it('不是 gzip 的字节 → VALIDATION_FAILED', async () => {
    await withTempPackage(Buffer.from('not a gzip at all'), async (file) => {
      await expect(scanTarGzNames(file)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    })
  })
})
