import { describe, expect, it } from 'vitest'
import {
  CGROUP_ROOT,
  cgroupDirsFor,
  computeCpuPercent,
  parseCpuUsageUsec,
  parseMemoryStat,
  readCgroupSnapshot,
  statsFromCgroup,
} from '../src/modules/instances/docker-driver.js'

/**
 * WP45：`/api/me/instance` 等首屏接口原来每调一次就 `GET /containers/{id}/stats?stream=false`，
 * Docker 要先攒 1 秒采样窗口（实测 `docker stats --no-stream` 1.0–2.0 s）。改成直读 cgroup v2：
 * `memory.current` / `memory.max` / `pids.current` / `cpu.stat` 一次几百微秒。
 * 这里锁住解析与换算口径（与 Docker 的 `(cpuDelta/systemDelta)*onlineCpus*100` 等价）。
 */

describe('cgroup 路径', () => {
  it('先试 systemd cgroup 驱动布局，再试 cgroupfs 布局', () => {
    expect(cgroupDirsFor('abc123')).toEqual([
      `${CGROUP_ROOT}/system.slice/docker-abc123.scope`,
      `${CGROUP_ROOT}/docker/abc123`,
    ])
  })

  it('读不到容器 cgroup → null（调用方回退 Docker Engine 统计接口）', async () => {
    expect(await readCgroupSnapshot('no-such-container-id')).toBeNull()
  })
})

describe('parseMemoryStat / parseCpuUsageUsec', () => {
  it('memory.stat 只取 inactive_file（Docker 的 workingSet 口径要减掉它）', () => {
    const text = [
      'anon 5000',
      'file 9000',
      'inactive_file 1234',
      'active_file 2222',
      'inactive_file 9999',
    ].join('\n')
    // 后出现的同名字段覆盖前面的（cgroup 不会重复，这里只是证明解析取最后一条）
    expect(parseMemoryStat(text)).toEqual({ inactiveFile: 9999 })
    expect(parseMemoryStat('anon 1\n')).toEqual({ inactiveFile: 0 })
    expect(parseMemoryStat('')).toEqual({ inactiveFile: 0 })
  })

  it('cpu.stat 取 usage_usec（累计微秒）', () => {
    const text = 'usage_usec 14370012\nuser_usec 10913114\nsystem_usec 3456898\nnr_periods 0\n'
    expect(parseCpuUsageUsec(text)).toBe(14370012)
    expect(parseCpuUsageUsec('user_usec 1\n')).toBe(0)
  })
})

describe('computeCpuPercent（与 Docker stats 同口径：100% = 一个核跑满）', () => {
  it('1 秒窗口内用了 1 秒 CPU → 100%', () => {
    expect(computeCpuPercent({ atMs: 1_000, usageUsec: 0 }, { atMs: 2_000, usageUsec: 1_000_000 })).toBe(100)
  })

  it('1 秒窗口内用了 2 秒 CPU → 200%（多核）', () => {
    expect(computeCpuPercent({ atMs: 1_000, usageUsec: 0 }, { atMs: 2_000, usageUsec: 2_000_000 })).toBe(200)
  })

  it('没有上一次采样 / 窗口太短 / 用量没涨 → 0（不抖出离谱数字）', () => {
    const now = { atMs: 2_000, usageUsec: 5_000 }
    expect(computeCpuPercent(undefined, now)).toBe(0)
    expect(computeCpuPercent({ atMs: 1_990, usageUsec: 0 }, now)).toBe(0)
    expect(computeCpuPercent({ atMs: 1_000, usageUsec: 9_000 }, now)).toBe(0)
  })
})

describe('statsFromCgroup', () => {
  it('memoryBytes = memory.current − inactive_file；limit/pids 直读', () => {
    const stats = statsFromCgroup(
      {
        memCurrent: 400 * 1024 * 1024,
        memMax: 8 * 1024 * 1024 * 1024,
        pidsCurrent: 14,
        cpuUsageUsec: 1_000,
        inactiveFile: 100 * 1024 * 1024,
      },
      undefined,
    )
    expect(stats).toMatchObject({
      cpuPercent: 0,
      memoryBytes: 300 * 1024 * 1024,
      memoryLimitBytes: 8 * 1024 * 1024 * 1024,
      pids: 14,
    })
  })

  it('memory.max = max（不限）时给 0，由上层退回配额', () => {
    const stats = statsFromCgroup(
      { memCurrent: 1, memMax: 0, pidsCurrent: 1, cpuUsageUsec: 0, inactiveFile: 0 },
      undefined,
    )
    expect(stats.memoryLimitBytes).toBe(0)
  })
})
