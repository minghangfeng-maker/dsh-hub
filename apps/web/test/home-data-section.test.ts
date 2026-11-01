import type { ExportEstimateResponse, ExportItem } from '@dsh-hub/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'

import HomeDataSection from '@/components/user/home/HomeDataSection.vue'
import { createExport, estimateExport, listExports, removeExport } from '@/api/exports'

vi.mock('@/api/exports', () => ({
  createExport: vi.fn(),
  estimateExport: vi.fn(),
  listExports: vi.fn(),
  removeExport: vi.fn(),
  exportDownloadUrl: (id: number) => `/api/me/exports/${id}/download`,
  exportEventsUrl: (id: number) => `/api/me/exports/${id}/events`,
}))

/**
 * 工作台「我的数据」（16 §7）：四个横排勾选块 + 一行操作（格式 / 预计大小 / 开始打包）
 * + 嵌入进度 + 紧凑历史表（默认 3 条，可展开）。接口全部 mock，不连后端。
 */

function exportItem(
  id: number,
  status: ExportItem['status'] = 'ready',
  overrides: Partial<ExportItem> = {},
): ExportItem {
  return {
    id,
    parts: ['workspace', 'sessions'],
    format: 'zip',
    status,
    fileName: status === 'ready' ? `dsh-littletao-${id}.zip` : null,
    sizeBytes: status === 'ready' ? 1_234_000_000 : null,
    sha256: null,
    createdAt: `2026-10-1${id}T08:00:00.000Z`,
    expiresAt: status === 'ready' ? '2026-10-20T08:00:00.000Z' : null,
    downloaded: false,
    error: null,
    progress: null,
    ...overrides,
  }
}

const ESTIMATE: ExportEstimateResponse = {
  parts: {
    workspace: { bytes: 6_100_000_000, files: 2841 },
    sessions: { bytes: 268_000_000, files: 214 },
    settings: { bytes: 2_400_000, files: 36 },
    'profile-plugins': { bytes: 48_000, files: 2 },
  },
  totalBytes: 6_370_448_000,
}

function mountSection() {
  const Host = defineComponent({
    components: { HomeDataSection, NMessageProvider },
    template: '<NMessageProvider><HomeDataSection /></NMessageProvider>',
  })
  return mount(Host, { attachTo: document.body })
}

async function settle(wrapper: ReturnType<typeof mount>): Promise<void> {
  await flushPromises()
  await flushPromises()
  await wrapper.vm.$nextTick()
}

beforeEach(() => {
  vi.mocked(createExport).mockReset()
  vi.mocked(estimateExport).mockReset()
  vi.mocked(listExports).mockReset()
  vi.mocked(removeExport).mockReset()
})

describe('工作台「我的数据」（16 §7）', () => {
  it('四个横排勾选块显示大小与文件数；头部「上次导出」带下载；历史默认 3 条可展开', async () => {
    vi.mocked(estimateExport).mockResolvedValue(ESTIMATE)
    vi.mocked(listExports).mockResolvedValue({
      items: [exportItem(4, 'failed'), exportItem(3), exportItem(2), exportItem(1)],
    })

    const wrapper = mountSection()
    await settle(wrapper)

    expect(wrapper.text()).toContain('我的数据')
    expect(wrapper.text()).toContain('打包内容')
    // 四块都在，大小与文件数在勾选块里
    for (const part of ['workspace', 'sessions', 'settings', 'profile-plugins']) {
      expect(wrapper.find(`[data-testid="export-part-${part}"]`).exists()).toBe(true)
    }
    expect(wrapper.get('[data-testid="export-part-workspace"]').text()).toContain('5.7 GB')
    expect(wrapper.get('[data-testid="export-part-workspace"]').text()).toContain('2841 个文件')

    // 头部：最近一次可下载的导出（失败的不算）
    expect(wrapper.get('[data-testid="last-export"]').text()).toContain('下载')
    expect(wrapper.get('[data-testid="last-export"]').text()).toContain('1.1 GB')

    // 历史默认 3 条；点「查看全部」展开到 4 条
    expect(wrapper.findAll('[data-testid="export-row"]')).toHaveLength(3)
    await wrapper.get('[data-testid="export-show-all"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="export-row"]')).toHaveLength(4)
    expect(wrapper.text()).toContain('收起')
    wrapper.unmount()
  })

  it('勾选内容 → 选格式 → 开始打包：提交的 parts / format 正确，新导出出现在历史里', async () => {
    vi.mocked(estimateExport).mockResolvedValue(ESTIMATE)
    vi.mocked(listExports).mockResolvedValue({ items: [] })
    vi.mocked(createExport).mockResolvedValue({
      export: exportItem(9, 'running', { parts: ['workspace'], format: 'tar.gz' }),
    })

    const wrapper = mountSection()
    await settle(wrapper)

    // 默认勾了工作区 + 会话；取消会话，只打包工作区
    await wrapper.get('[data-testid="export-part-sessions"]').find('.n-checkbox').trigger('click')
    // 格式换成 tar.gz
    const tar = wrapper.findAll('.n-radio').find((item) => item.text().includes('tar.gz'))!
    await tar.trigger('click')

    await wrapper.get('[data-testid="export-submit"]').trigger('click')
    await settle(wrapper)

    expect(createExport).toHaveBeenCalledWith({ parts: ['workspace'], format: 'tar.gz' })
    expect(wrapper.findAll('[data-testid="export-row"]')).toHaveLength(1)
    // 进行中的导出会显示嵌入进度（复用 ExportProgressCard 的逻辑）
    expect(wrapper.find('[data-testid="export-progress"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('一个都不勾时不能提交；没有历史时给一句空状态', async () => {
    vi.mocked(estimateExport).mockResolvedValue(ESTIMATE)
    vi.mocked(listExports).mockResolvedValue({ items: [] })

    const wrapper = mountSection()
    await settle(wrapper)

    expect(wrapper.text()).toContain('还没有导出过')
    for (const part of ['workspace', 'sessions']) {
      await wrapper.get(`[data-testid="export-part-${part}"]`).find('.n-checkbox').trigger('click')
    }
    expect(wrapper.get('[data-testid="export-submit"]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('至少勾选一项内容')
    wrapper.unmount()
  })
})
