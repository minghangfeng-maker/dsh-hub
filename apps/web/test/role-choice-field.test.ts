import { mount, type VueWrapper } from '@vue/test-utils'
import { NSelect } from 'naive-ui'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import RoleChoiceField from '@/components/admin/RoleChoiceField.vue'

/**
 * 角色控件（WP13，07 §7.2）：候选 = 普通用户 + 在用标签 + 管理员 + 最后一项「＋ 新建角色…」；
 * 选它 → 下方出现自动聚焦的输入框（空名提交报「请输入角色名」）；下拉里直接打字也继续可用，
 * 且**失焦时把打了字但没回车的内容当作选中值**（WP9 的痛点是这里直接点别处会退回「普通用户」）。
 *
 * 值就是角色显示文字（`role.ts` 的 parseRoleChoice 语义），所以这些断言都用显示文字。
 */

const LABELS = [
  { label: '家人', count: 2 },
  { label: '同事', count: 0 },
]

type Field = InstanceType<typeof RoleChoiceField>
type FieldWrapper = VueWrapper<Field>

const wrappers: FieldWrapper[] = []

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  document.body.innerHTML = ''
})

function mountField(options: { value?: string; allowAdmin?: boolean } = {}) {
  const updates: string[] = []
  const wrapper = mount(RoleChoiceField, {
    props: {
      value: options.value ?? '普通用户',
      labels: LABELS,
      allowAdmin: options.allowAdmin ?? true,
      'onUpdate:value': (value: string) => {
        updates.push(value)
        void wrapper.setProps({ value })
      },
    },
    attachTo: document.body,
  }) as FieldWrapper
  wrappers.push(wrapper)
  const last = () => updates.at(-1) ?? wrapper.props('value')
  return { wrapper, updates, last }
}

/** 组件 `defineExpose({ validate })` 的方法 */
function validate(wrapper: FieldWrapper): boolean {
  return wrapper.vm.validate()
}

function selectOf(wrapper: FieldWrapper) {
  const select = wrapper.findComponent(NSelect)
  expect(select.exists(), '应有角色下拉').toBe(true)
  return select
}

function optionsOf(wrapper: FieldWrapper): { label: string; value: string }[] {
  return selectOf(wrapper).props('options') as { label: string; value: string }[]
}

/** 「＋ 新建角色…」的哨兵值（组件内部值，测试里只按 label 找它） */
function newRoleValue(wrapper: FieldWrapper): string {
  const option = optionsOf(wrapper).find((item) => item.label === '＋ 新建角色…')
  expect(option, '最后一项应是「＋ 新建角色…」').toBeTruthy()
  return option!.value
}

function inputEl(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('[data-testid="role-choice-input"] input')
}

/** 输入框里打字（NInput 的 v-model 走 input 事件） */
async function typeInCustomInput(text: string): Promise<void> {
  const input = inputEl()
  expect(input, '应有「新建角色」输入框').toBeTruthy()
  input!.value = text
  input!.dispatchEvent(new Event('input'))
  await nextTick()
}

async function flush(): Promise<void> {
  await nextTick()
  // 失焦提交延后一拍（躲开「点候选」的冲突），所以要等一个宏任务
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

describe('角色控件：没有常驻提示行（07 §2.7，WP14b）', () => {
  it('默认不显示提示行：教操作的句子不进界面，「＋ 新建角色…」自己说明能新建', () => {
    mountField()
    expect(document.querySelector('.role-choice__hint')).toBeNull()
    expect(document.body.textContent ?? '').not.toContain('下拉最后一项')
  })

  it('传了 hint 才会显示（给确实需要一句话的地方留口子）', () => {
    const wrapper = mount(RoleChoiceField, {
      props: { value: '普通用户', labels: LABELS, hint: '一句话说明' },
      attachTo: document.body,
    }) as FieldWrapper
    wrappers.push(wrapper)
    expect(document.querySelector('.role-choice__hint')?.textContent).toBe('一句话说明')
  })

  it('错误仍然显示在原地（提示行不显示也不影响校验红字）', async () => {
    const { wrapper } = mountField()
    selectOf(wrapper).vm.$emit('update:value', newRoleValue(wrapper))
    await flush()

    expect(validate(wrapper)).toBe(false)
    await nextTick()
    const error = document.querySelector('[data-testid="role-choice-error"]')
    expect(error?.textContent?.trim()).toBe('请输入角色名')
    expect(error?.getAttribute('role')).toBe('alert')
    // 有错误时不显示提示行（互斥），修好之后两边都没有
    expect(document.querySelector('.role-choice__hint')).toBeNull()
    await typeInCustomInput('朋友')
    expect(validate(wrapper)).toBe(true)
    await nextTick()
    expect(document.querySelector('[data-testid="role-choice-error"]')).toBeNull()
    expect(document.querySelector('.role-choice__hint')).toBeNull()
  })
})

describe('角色控件：候选与「＋ 新建角色…」', () => {
  it('候选 = 普通用户 + 在用标签 + 管理员 + 最后一项「＋ 新建角色…」', () => {
    const { wrapper } = mountField()
    expect(optionsOf(wrapper).map((item) => item.label)).toEqual([
      '普通用户',
      '家人',
      '同事',
      '管理员',
      '＋ 新建角色…',
    ])
  })

  it('allowAdmin=false（邀请码）：没有「管理员」，最后一项照旧', () => {
    const { wrapper } = mountField({ allowAdmin: false })
    expect(optionsOf(wrapper).map((item) => item.label)).toEqual(['普通用户', '家人', '同事', '＋ 新建角色…'])
  })

  it('选「＋ 新建角色…」→ 出现自动聚焦的输入框（maxlength = 16，占位文案），输入的名字就是值', async () => {
    const { wrapper, last } = mountField()
    selectOf(wrapper).vm.$emit('update:value', newRoleValue(wrapper))
    await flush()

    const input = inputEl()
    expect(input, '选「新建角色」后应出现输入框').toBeTruthy()
    expect(input!.maxLength).toBe(16)
    expect(input!.placeholder).toBe('输入角色名，如 家人、朋友')
    expect(document.activeElement).toBe(input)

    await typeInCustomInput('朋友')
    expect(last()).toBe('朋友')
    validate(wrapper)
    expect(last()).toBe('朋友')
  })

  it('输入框为空时 validate() 返回 false、报「请输入角色名」，值不会退回「普通用户」', async () => {
    const { wrapper, last } = mountField()
    selectOf(wrapper).vm.$emit('update:value', newRoleValue(wrapper))
    await flush()

    expect(validate(wrapper)).toBe(false)
    await nextTick()
    expect(document.querySelector('[data-testid="role-choice-error"]')?.textContent?.trim()).toBe('请输入角色名')
    expect(last()).toBe('')

    // 填上名字再校验就过了
    await typeInCustomInput('朋友')
    expect(validate(wrapper)).toBe(true)
    await nextTick()
    expect(document.querySelector('[data-testid="role-choice-error"]')).toBeNull()
  })

  it('下拉里打字后失焦：没按回车的内容也算选中值', async () => {
    const { wrapper, last } = mountField()
    selectOf(wrapper).vm.$emit('search', '同事')
    selectOf(wrapper).vm.$emit('blur')
    await flush()

    expect(last()).toBe('同事')
    expect(validate(wrapper)).toBe(true)
  })

  it('点候选（blur 之后才发 update:value）不会被「失焦即提交」冲掉', async () => {
    const { wrapper, last } = mountField()
    selectOf(wrapper).vm.$emit('search', '家')
    selectOf(wrapper).vm.$emit('blur')
    // 真实的点选：blur 先到，update:value 紧接着到
    selectOf(wrapper).vm.$emit('update:value', '家人')
    await flush()

    expect(last()).toBe('家人')
  })

  it('输入「管理员」/「普通用户」等同选对应项；前后空格去掉、超长截断', async () => {
    const { wrapper, last } = mountField()
    selectOf(wrapper).vm.$emit('update:value', newRoleValue(wrapper))
    await flush()
    await typeInCustomInput('  管理员  ')
    expect(inputEl()).toBeTruthy()
    inputEl()!.dispatchEvent(new Event('blur'))
    await flush()

    expect(last()).toBe('管理员')
    // 是已知候选 → 输入框收起来，回到下拉态
    expect(inputEl()).toBeNull()

    selectOf(wrapper).vm.$emit('update:value', newRoleValue(wrapper))
    await flush()
    await typeInCustomInput('  一二三四五六七八九十一二三四五六七  ')
    inputEl()!.dispatchEvent(new Event('blur'))
    await flush()
    expect(last()).toBe('一二三四五六七八九十一二三四五六')
  })

  it('提交前还留在下拉里的输入（还没失焦）也会被 validate() 收下', async () => {
    const { wrapper, last } = mountField()
    selectOf(wrapper).vm.$emit('search', '表姐')
    expect(validate(wrapper)).toBe(true)
    await flush()
    expect(last()).toBe('表姐')
  })
})
