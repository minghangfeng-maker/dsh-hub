import { describe, expect, it } from 'vitest'
import { scanDirectory, scanText } from '../src/modules/plugins/secret-scan.js'
import { extractTarGz, findPackageJsonEntry, readTarGz } from '../src/modules/plugins/tar.js'
import { inspectTarball } from '../src/modules/plugins/sources.js'
import { makePluginTgz, makeTarGz, makeTempDir, cleanupDirs } from './helpers-wp3.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 插件包密钥扫描（06 §2.1）与极简 tar 读取。 */

function hitsOf(text: string): { rule: string; line: number }[] {
  return scanText('cordis.patch.yml', text).map((hit) => ({ rule: hit.rule, line: hit.line }))
}

describe('密钥扫描', () => {
  it('命中多种模式，且只回 {file,line,rule}', () => {
    const hits = scanText(
      'lib/config.js',
      [
        'const a = "sk-abcdefghijklmnopqrstuvwxyz123456"',
        'modelscope: ms-abcdefghijklmnopqrstuvwx',
        'hf: hf_abcdefghijklmnopqrstuvwxyz01',
        'gh: ghp_abcdefghijklmnopqrstuvwxyz0123',
        'aws: AKIAIOSFODNN7EXAMPLE',
        '-----BEGIN RSA PRIVATE KEY-----',
        'url: https://user:supersecretpass@example.com/x',
      ].join('\n'),
    )
    const rules = hits.map((hit) => hit.rule)
    expect(rules).toContain('openai-key')
    expect(rules).toContain('modelscope-token')
    expect(rules).toContain('huggingface-token')
    expect(rules).toContain('github-token')
    expect(rules).toContain('aws-access-key')
    expect(rules).toContain('private-key')
    expect(rules).toContain('basic-auth-url')
    for (const hit of hits) {
      expect(Object.keys(hit).sort()).toEqual(['file', 'line', 'rule'])
      expect(JSON.stringify(hit)).not.toContain('supersecretpass')
    }
  })

  it('赋值类命中：真密钥报，env 引用与占位符不报', () => {
    // 带 `sk-` 前缀的值先被高置信度规则命中（openai-key），不再走赋值启发式
    expect(hitsOf('apiKey: sk-live-9f3a2b7c1d4e5f6a7b8c')).toContainEqual({ rule: 'openai-key', line: 1 })
    expect(hitsOf('token: "AbCdEf0123456789AbCdEf0123456789"')).toHaveLength(1)
    // 06 §2.1 明确的误报要求
    expect(hitsOf('apiKeyEnv: FOO')).toEqual([])
    expect(hitsOf('apiKeyEnv: HUB_MK_HUB_RELAY')).toEqual([])
    expect(hitsOf('apiKey: ${MY_KEY}')).toEqual([])
    expect(hitsOf('apiKey: <your-api-key>')).toEqual([])
    expect(hitsOf('tokenEnv: $TOKEN')).toEqual([])
    expect(hitsOf('apiKey: your-api-key-here')).toEqual([])
    expect(hitsOf('password: null')).toEqual([])
    expect(hitsOf('api_key: process.env.OPENAI_API_KEY')).toEqual([])
  })

  it('D7 回归：普通赋值 / 标识符 / 中文文案 / URL / 路径 / 压缩长行都不报', () => {
    const falsePositives = [
      'const token = this.token',
      'apiKey: config.apiKey',
      'apiKey: options?.apiKey ?? null',
      'token = getToken()',
      'secret: someIdentifier',
      "message: '发送中…'",
      "label = '验证码已发送'",
      'baseURL: https://api.example.com/v1',
      'cachePath: /home/dsh/.dsh/cache',
      'token: process.env.DSH_TOKEN',
      'apiKeyEnv: HUB_MK_HUB_RELAY',
      'password: "short"',
    ]
    for (const line of falsePositives) expect(hitsOf(line), line).toEqual([])
    // 压缩/打包后的超长行只做前缀检测
    const minified = `var a=1;${'x'.repeat(2200)};token="abcdefghijklmnopqrstuvwxyz012345";`
    expect(hitsOf(minified)).toEqual([])
  })

  it('D7 回归：真实格式的假密钥仍然命中（前缀/高熵/PEM）', () => {
    expect(hitsOf('const key = "sk-abcdefghijklmnopqrstuvwxyz012345"')).toContainEqual({
      rule: 'openai-key',
      line: 1,
    })
    expect(hitsOf('token = "9f3a2b7c1d4e5f6a7b8c9d0e1f2a3b4c"')).toContainEqual({
      rule: 'secret-assignment',
      line: 1,
    })
    expect(hitsOf('-----BEGIN OPENSSH PRIVATE KEY-----')).toContainEqual({ rule: 'private-key', line: 1 })
  })

  it('只扫源码/配置类型（.js/.ts/.json/.yml/.yaml/.env），README/LICENSE 之类不扫', () => {
    const dir = makeTempDir()
    try {
      writeFileSync(join(dir, 'lib.js'), 'const a = 1')
      writeFileSync(join(dir, 'notes.md'), 'token = "sk-abcdefghijklmnopqrstuvwxyz012345"')
      const result = scanDirectory(dir)
      expect(result.hits).toEqual([])
    } finally {
      cleanupDirs([dir])
    }
  })

  it('Bearer 与 JWT', () => {
    expect(hitsOf('Authorization: Bearer abcdefghijklmnopqrstuvwxyz.123456')).toHaveLength(1)
    expect(
      hitsOf(
        't: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      ),
    ).toHaveLength(1)
  })

  it('扫描目录：跳过 node_modules 与二进制，命中 .credentials.yaml', () => {
    const dir = makeTempDir()
    try {
      mkdirSync(join(dir, 'lib'), { recursive: true })
      mkdirSync(join(dir, 'node_modules', 'evil'), { recursive: true })
      writeFileSync(join(dir, 'lib', 'a.js'), 'const key = "sk-abcdefghijklmnopqrstuvwxyz123456"')
      writeFileSync(
        join(dir, 'node_modules', 'evil', 'x.js'),
        'const key = "sk-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"',
      )
      writeFileSync(join(dir, '.credentials.yaml'), 'secret: x')
      writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3]))
      const result = scanDirectory(dir)
      const files = result.hits.map((hit) => hit.file).sort()
      expect(files).toContain('lib/a.js')
      expect(files).toContain('.credentials.yaml')
      expect(files.some((file) => file.includes('node_modules'))).toBe(false)
    } finally {
      cleanupDirs([dir])
    }
  })
})

describe('tar 读取 / npm 包校验', () => {
  it('读条目、找 package.json、校验 name/version', () => {
    const buffer = makeTarGz([
      { name: 'package/package.json', content: '{"name":"@local/x","version":"1.0.0"}' },
      { name: 'package/lib/index.js', content: 'export const a = 1\n' },
    ])
    const entries = readTarGz(buffer)
    expect(entries.map((entry) => entry.name)).toEqual(['package/package.json', 'package/lib/index.js'])
    const manifest = findPackageJsonEntry(entries)
    expect(manifest?.name).toBe('package/package.json')
    const validated = inspectTarball(makePluginTgz({ name: '@local/x', version: '2.1.0' }))
    expect(validated.packageJson.name).toBe('@local/x')
    expect(validated.packageJson.version).toBe('2.1.0')
    expect(validated.files.map((file) => file.path)).toEqual(['cordis.patch.yml'])
  })

  it('缺 package.json / 非法 JSON 会拒绝', () => {
    expect(() => inspectTarball(makeTarGz([{ name: 'package/a.txt', content: 'x' }]))).toThrow(
      /没有 package.json/u,
    )
    expect(() => inspectTarball(makeTarGz([{ name: 'package/package.json', content: '{oops' }]))).toThrow(
      /不是合法 JSON/u,
    )
  })

  it('解包拒绝路径穿越与符号链接', () => {
    const dir = makeTempDir()
    try {
      const buffer = makeTarGz([
        { name: 'package/package.json', content: '{"name":"x","version":"1.0.0"}' },
        { name: 'package/../../escape.txt', content: 'nope' },
      ])
      expect(() => extractTarGz(buffer, dir)).toThrow(/路径越界/u)
    } finally {
      cleanupDirs([dir])
    }
  })

  it('gzip 坏数据报 VALIDATION_FAILED', () => {
    expect(() => readTarGz(Buffer.from('not a tarball'))).toThrow(/不是合法的 .tgz/u)
  })
})
