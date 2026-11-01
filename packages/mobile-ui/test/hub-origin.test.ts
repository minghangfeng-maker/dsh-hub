/**
 * 多入口的展示辅助：标签、主机名、顺序、延迟文案。
 *
 * 网络检测页要「标出当前在用哪个」，靠的就是这几个纯函数。
 * 地名标签来自构建参数 `VITE_HUB_ORIGIN_LABELS`（开源版不写死任何地名）；没配就是主机名。
 */

import { describe, expect, it } from 'vitest'
import {
  formatLatency,
  originHost,
  originLabel,
  originRank,
  originResultText,
} from '../src/lib/hub-origin'

const PRIMARY = 'https://hub.example.com:8123'
const BACKUP = 'https://backup.example.com'

describe('入口标签', () => {
  it('没配 VITE_HUB_ORIGIN_LABELS：一律显示主机名（默认形态）', () => {
    expect(originLabel(PRIMARY, {})).toBe('hub.example.com:8123')
    expect(originLabel(BACKUP, {})).toBe('backup.example.com')
    expect(originLabel('http://127.0.0.1:5401', {})).toBe('127.0.0.1:5401')
    // 末尾斜杠归一后再查表
    expect(originLabel(`${BACKUP}/`, {})).toBe('backup.example.com')
  })

  it('配了标签：按 origin 查表，没配的仍然显示主机名', () => {
    const labels = { [PRIMARY]: '主站', [BACKUP]: '备用' }
    expect(originLabel(PRIMARY, labels)).toBe('主站')
    expect(originLabel(BACKUP, labels)).toBe('备用')
    expect(originLabel('http://127.0.0.1:5401', labels)).toBe('127.0.0.1:5401')
  })

  it('originHost 去掉协议与末尾斜杠（保留端口）', () => {
    expect(originHost(PRIMARY)).toBe('hub.example.com:8123')
    expect(originHost(`${BACKUP}/`)).toBe('backup.example.com')
    expect(originHost('mock')).toBe('mock')
  })

  it('originRank：第一个是首选、其余备用', () => {
    expect(originRank([PRIMARY, BACKUP], PRIMARY)).toBe('首选')
    expect(originRank([PRIMARY, BACKUP], BACKUP)).toBe('备用')
    expect(originRank([PRIMARY], BACKUP)).toBeNull()
  })
})

describe('结果文案', () => {
  it('延迟：1 秒以内毫秒，以上秒（一位小数），非法值空串', () => {
    expect(formatLatency(86)).toBe('86ms')
    expect(formatLatency(1_240)).toBe('1.2s')
    expect(formatLatency(null)).toBe('')
    expect(formatLatency(-1)).toBe('')
    expect(formatLatency(Number.NaN)).toBe('')
  })

  it('通了给延迟；拦截页单独说；其它给失败原因', () => {
    expect(
      originResultText({ ok: true, ms: 120, bodyHint: null, errorText: '网络错误' }),
    ).toBe('120ms')
    expect(
      originResultText({ ok: false, ms: 240, bodyHint: 'icp', errorText: '被系统拦截' }),
    ).toBe('被拦截页挡住')
    expect(
      originResultText({ ok: false, ms: 900, bodyHint: null, errorText: '域名解析失败' }),
    ).toBe('域名解析失败')
    expect(originResultText({ ok: false, ms: 0, bodyHint: null, errorText: '' })).toBe('连不上')
  })
})
