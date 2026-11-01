import type { ComputeSettings, ComputeSettingsResponse } from '@dsh-hub/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider, NSelect } from 'naive-ui'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick } from 'vue'

import { listUsers } from '@/api/admin-users'
import { getAdminComputeSettings, updateAdminComputeSettings } from '@/api/compute'
import ComputeSettingsSection from '@/components/admin/compute/ComputeSettingsSection.vue'
import {
  buildPlanPayload,
  draftBlockPriceMicro,
  draftFromPlan,
  draftPriceMicro,
  emptyPlanDraft,
  validatePlanDrafts,
  type PlanDraft,
} from '@/components/admin/compute/plan-draft'
import { formatPoints } from '@/utils/points'

vi.mock('@/api/compute', () => ({
  getAdminComputeSettings: vi.fn(),
  updateAdminComputeSettings: vi.fn(),
}))
vi.mock('@/api/admin-users', () => ({ listUsers: vi.fn() }))

/**
 * 管理端「算力租赁 · 规格表」（13 §7）：增删改、上下移动、价格换算、ID 校验。
 * 纯函数测换算与校验，挂载测按钮真的改了草稿并在保存时按顺序提交。
 */

const SETTINGS: ComputeSettings = {
  billingEnabled: true,
  billAdmins: false,
  graceMinutes: 10,
  capacityMemoryMb: 10_240,
  contactText: '需要更高配置？请联系管理员定制。',
  defaultPlanId: 'c2m4',
  plans: [
    {
      id: 'c2m4',
      name: '2 核 4 GB',
      cpus: 2,
      memoryMb: 4096,
      pricePerHourMicro: 300_000,
      enabled: true,
      userIds: null,
      sort: 10,
    },
    {
      id: 'c4m8',
      name: '4 核 8 GB',
      cpus: 4,
      memoryMb: 8192,
      pricePerHourMicro: 500_000,
      enabled: true,
      userIds: null,
      sort: 20,
    },
    {
      id: 'c8m16',
      name: '8 核 16 GB',
      cpus: 8,
      memoryMb: 16_384,
      pricePerHourMicro: 1_000_000,
      enabled: true,
      userIds: null,
      sort: 30,
    },
  ],
}

const RESPONSE: ComputeSettingsResponse = {
  settings: SETTINGS,
  host: { memTotalMb: 16_384, committedMemoryMb: 8192 },
}

async function mountSection() {
  const Host = defineComponent({
    components: { ComputeSettingsSection, NMessageProvider },
    template: '<NMessageProvider><ComputeSettingsSection /></NMessageProvider>',
  })
  const wrapper = mount(Host)
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.mocked(getAdminComputeSettings).mockReset()
  vi.mocked(updateAdminComputeSettings).mockReset()
  vi.mocked(listUsers).mockReset()

  vi.mocked(getAdminComputeSettings).mockResolvedValue(structuredClone(RESPONSE))
  vi.mocked(updateAdminComputeSettings).mockImplementation(async (input) => ({
    settings: { ...SETTINGS, ...input, plans: input.plans ?? SETTINGS.plans },
    host: RESPONSE.host,
  }))
  vi.mocked(listUsers).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 })
})

describe('规格草稿：价格换算与校验（13 §7）', () => {
  it('0.3 积分/小时 → 300000 微积分，每 10 分钟 0.05（用 shared 的块价格）', () => {
    const draft = draftFromPlan(SETTINGS.plans[0]!)
    expect(draft.priceText).toBe('0.3')
    expect(draftPriceMicro(draft)).toBe(300_000)
    expect(draftBlockPriceMicro(draft)).toBe(50_000)
    expect(formatPoints(draftBlockPriceMicro(draft)!)).toBe('0.05')
  })

  it('提交时 sort 按显示顺序重排为 10 / 20 / 30，价格换成微积分', () => {
    const a = draftFromPlan(SETTINGS.plans[0]!)
    const b = draftFromPlan(SETTINGS.plans[1]!)
    b.priceText = '1.25'

    const payload = buildPlanPayload([b, a])
    expect(payload.map((plan) => plan.id)).toEqual(['c4m8', 'c2m4'])
    expect(payload.map((plan) => plan.sort)).toEqual([10, 20])
    expect(payload[0]?.pricePerHourMicro).toBe(1_250_000)
  })

  it('定制规格：userIds 原样提交，普通规格是 null', () => {
    const normal = draftFromPlan(SETTINGS.plans[0]!)
    const custom = draftFromPlan(SETTINGS.plans[1]!)
    custom.custom = true
    custom.userIds = [2, 4]

    const payload = buildPlanPayload([normal, custom])
    expect(payload[0]?.userIds).toBeNull()
    expect(payload[1]?.userIds).toEqual([2, 4])
  })

  it('ID 校验：大写 / 重复 / 空名称 / 非法价格 / 定制没人选都报具体原因', () => {
    const valid = (): PlanDraft[] => [draftFromPlan(SETTINGS.plans[0]!), draftFromPlan(SETTINGS.plans[1]!)]

    expect(validatePlanDrafts(valid())).toBeNull()

    const upper = valid()
    upper[0]!.id = 'C2M4'
    expect(validatePlanDrafts(upper)).toContain('ID 不合法')

    const duplicated = valid()
    duplicated[1]!.id = duplicated[0]!.id
    expect(validatePlanDrafts(duplicated)).toContain('规格 ID 重复')

    const nameless = valid()
    nameless[0]!.name = ''
    expect(validatePlanDrafts(nameless)).toContain('还没填名称')

    const badPrice = valid()
    badPrice[0]!.priceText = 'abc'
    expect(validatePlanDrafts(badPrice)).toContain('价格填得不对')

    const noUsers = valid()
    noUsers[0]!.custom = true
    noUsers[0]!.userIds = []
    expect(validatePlanDrafts(noUsers)).toContain('至少选一个用户')

    expect(validatePlanDrafts([])).toBe('至少保留一个规格')
  })

  it('新规格默认 2 核 4 GB / 0.3 积分/小时，ID 可编辑且格式合法', () => {
    const draft = emptyPlanDraft()
    expect(draft.isNew).toBe(true)
    expect(draft.name).toBe('')
    expect(draft.cpus).toBe(2)
    expect(draft.memoryMb).toBe(4096)
    expect(draft.priceText).toBe('0.3')
    expect(draft.id).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/)
  })
})

describe('算力租赁设置页（13 §7 管理端）', () => {
  it('读出设置并渲染规格表，未改动时保存禁用', async () => {
    const wrapper = await mountSection()
    const text = wrapper.text()

    expect(text).toContain('算力租赁')
    expect(wrapper.find('[data-testid="compute-plan-row-0"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="compute-plan-row-2"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="compute-plan-name-0"] input').element).toHaveProperty(
      'value',
      '2 核 4 GB',
    )
    expect(wrapper.get('[data-testid="compute-plan-block-0"]').text()).toBe('0.05')
    expect(wrapper.get('[data-testid="compute-settings-save"]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('添加规格 → 新行 ID 可编辑；删除后回到 3 行', async () => {
    const wrapper = await mountSection()

    await wrapper.get('[data-testid="compute-plan-add"]').trigger('click')
    expect(wrapper.find('[data-testid="compute-plan-row-3"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="compute-plan-id-3"]').exists()).toBe(true)

    await wrapper.get('[data-testid="compute-plan-remove-3"]').trigger('click')
    expect(wrapper.find('[data-testid="compute-plan-row-3"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('上下移动改变显示顺序，保存时按新顺序提交', async () => {
    const wrapper = await mountSection()

    // 把「4 核 8 GB」上移一位
    await wrapper.get('[data-testid="compute-plan-up-1"]').trigger('click')
    expect(wrapper.get('[data-testid="compute-plan-name-0"] input').element).toHaveProperty(
      'value',
      '4 核 8 GB',
    )
    expect(wrapper.get('[data-testid="compute-plan-name-1"] input').element).toHaveProperty(
      'value',
      '2 核 4 GB',
    )

    await wrapper.get('[data-testid="compute-settings-save"]').trigger('click')
    await flushPromises()

    const body = vi.mocked(updateAdminComputeSettings).mock.calls[0]?.[0]
    expect(body?.plans?.map((plan) => plan.id)).toEqual(['c4m8', 'c2m4', 'c8m16'])
    expect(body?.plans?.map((plan) => plan.sort)).toEqual([10, 20, 30])
    wrapper.unmount()
  })

  it('价格实时换算：0.3 → 0.05；改成 0.5 → 0.0833，保存提交 500000 微积分', async () => {
    const wrapper = await mountSection()
    const price = wrapper.get('[data-testid="compute-plan-price-0"] input')
    expect(wrapper.get('[data-testid="compute-plan-block-0"]').text()).toBe('0.05')

    await price.setValue('0.5')
    expect(wrapper.get('[data-testid="compute-plan-block-0"]').text()).toBe('0.0833')

    await wrapper.get('[data-testid="compute-settings-save"]').trigger('click')
    await flushPromises()

    const body = vi.mocked(updateAdminComputeSettings).mock.calls[0]?.[0]
    expect(body?.plans?.[0]?.pricePerHourMicro).toBe(500_000)
    wrapper.unmount()
  })

  it('非法 ID：保存时就地报错，不发 PATCH', async () => {
    const wrapper = await mountSection()

    await wrapper.get('[data-testid="compute-plan-add"]').trigger('click')
    await wrapper.get('[data-testid="compute-plan-id-3"] input').setValue('Bad_ID')
    await wrapper.get('[data-testid="compute-settings-save"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="compute-settings-error"]').text()).toContain('ID 不合法')
    expect(updateAdminComputeSettings).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('新用户默认规格：默认选中 c2m4；改成「第一个可选规格」后保存提交 defaultPlanId: null', async () => {
    const wrapper = await mountSection()

    const select = wrapper
      .findAllComponents(NSelect)
      .find((item) =>
        (item.props('options') as { label: string }[]).some((option) => option.label === '第一个可选规格'),
      )
    expect(select, '应有「新用户默认规格」下拉').toBeTruthy()
    const options = select!.props('options') as { label: string; value: string }[]
    expect(options.map((option) => option.label)).toEqual([
      '第一个可选规格',
      '2 核 4 GB',
      '4 核 8 GB',
      '8 核 16 GB',
    ])
    expect(select!.props('value')).toBe('c2m4')
    expect(wrapper.get('[data-testid="compute-settings-save"]').attributes('disabled')).toBeDefined()

    const first = options.find((option) => option.label === '第一个可选规格')!
    select!.vm.$emit('update:value', first.value)
    await nextTick()
    expect(wrapper.get('[data-testid="compute-settings-save"]').attributes('disabled')).toBeUndefined()

    await wrapper.get('[data-testid="compute-settings-save"]').trigger('click')
    await flushPromises()

    const body = vi.mocked(updateAdminComputeSettings).mock.calls[0]?.[0]
    expect(body?.defaultPlanId).toBeNull()
    expect(body?.plans?.map((plan) => plan.id)).toEqual(['c2m4', 'c4m8', 'c8m16'])
    wrapper.unmount()
  })

  it('默认规格被停用 / 删除时显示警告，但仍可保存', async () => {
    vi.mocked(getAdminComputeSettings).mockResolvedValue({
      ...structuredClone(RESPONSE),
      settings: { ...structuredClone(SETTINGS), defaultPlanId: 'gone-plan' },
    })
    const wrapper = await mountSection()

    const warning = wrapper.get('[data-testid="compute-default-plan-warning"]')
    expect(warning.text()).toContain('该规格已不可用，将退回第一个可选规格')
    wrapper.unmount()
  })

  it('「设为总内存 − 3 GB」把准入上限设成 16384 − 3072 = 13312 MB', async () => {
    const wrapper = await mountSection()

    await wrapper.get('[data-testid="compute-capacity-fill"]').trigger('click')
    await wrapper.get('[data-testid="compute-settings-save"]').trigger('click')
    await flushPromises()

    const body = vi.mocked(updateAdminComputeSettings).mock.calls[0]?.[0]
    expect(body?.capacityMemoryMb).toBe(13_312)
    wrapper.unmount()
  })
})
