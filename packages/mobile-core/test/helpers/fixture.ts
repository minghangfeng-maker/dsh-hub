import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * 契约 fixtures 随包一起进仓库：`test/fixtures/mobile-v1`（通道 v1 的客户端/服务端帧）
 * 与 `test/fixtures/v2`（通道 v2 的模型目录）。
 *
 * 这些文件是**契约的样本**：Hub 侧与手机端逐字节对拍（见 `fixtures.test.ts` /
 * `catalog.test.ts`），任何一侧改了帧形状，这里都会红。要临时指向另一份副本时用
 * `DSH_FIXTURES` / `DSH_V2_FIXTURES` 覆盖（调试用，平时不要设）。
 */
export const FIXTURES_DIR = process.env.DSH_FIXTURES ?? path.resolve(HERE, '..', 'fixtures', 'mobile-v1')

export const V2_FIXTURES_DIR =
  process.env.DSH_V2_FIXTURES ?? path.resolve(HERE, '..', 'fixtures', 'v2')

export function fixtureNames(dir = FIXTURES_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
}

export function readFixture<T = unknown>(name: string, dir = FIXTURES_DIR): T {
  const raw = readFileSync(path.join(dir, name), 'utf8')
  return JSON.parse(raw) as T
}

export function fixtureServerFrames(dir = FIXTURES_DIR): Array<{ name: string; frame: any }> {
  return fixtureNames(dir)
    .filter((name) => name.startsWith('server-'))
    .map((name) => ({ name, frame: readFixture(name, dir) }))
}
