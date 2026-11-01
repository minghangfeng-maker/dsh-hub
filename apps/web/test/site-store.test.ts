import type { PublicSiteResponse } from '@dsh-hub/shared'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchPublicSite } from '@/api/site'
import { FALLBACK_SITE, useSiteStore } from '@/stores/site'

/**
 * `GET /api/public/site` 的容错（04 §1 + 07 §5.1）。
 *
 * 关键点：`caCertUrl` 是「有没有自签证书」的开关 —— 阶段一本地 http 时服务端给 `null`/空串，
 * 前端必须把它归一成空串（不显示证书提示），而且**不能**因为这一个字段让整份站点信息退回兜底值。
 */
const SITE: PublicSiteResponse = {
  name: 'DSH Hub',
  tagline: '你的云上 AI 工作台',
  announcement: '',
  announcementLevel: 'info',
  registrationMode: 'invite',
  requireApproval: false,
  caCertUrl: '/ca.crt',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('站点信息里的 caCertUrl', () => {
  it('非空地址原样保留（阶段二 TLS 生效时提示安装证书）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(SITE)))

    const site = await fetchPublicSite()
    expect(site.caCertUrl).toBe('/ca.crt')
  })

  it('null → 归一成空串，且站点其它字段照常生效', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...SITE, name: 'Mint Hub', caCertUrl: null })))

    const site = await fetchPublicSite()
    expect(site.caCertUrl).toBe('')
    expect(site.name).toBe('Mint Hub')
  })

  it('字段缺失 → 空串（不抛契约错误）', async () => {
    const { caCertUrl: _omitted, ...withoutCert } = SITE
    vi.stubGlobal('fetch', vi.fn(async () => json(withoutCert)))

    const site = await fetchPublicSite()
    expect(site.caCertUrl).toBe('')
  })

  it('接口不可用 → store 退回兜底值，兜底值也不带证书地址（避免误提示）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    setActivePinia(createPinia())
    const store = useSiteStore()

    await store.load()

    expect(store.loadFailed).toBe(true)
    expect(store.site.name).toBe(FALLBACK_SITE.name)
    expect(store.site.caCertUrl).toBe('')
    expect(store.registrationOpen).toBe(true)
  })
})
