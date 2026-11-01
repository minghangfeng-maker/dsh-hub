import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, reactive } from 'vue'

import AddPluginDrawer from '@/components/admin/AddPluginDrawer.vue'

/**
 * 「添加插件」抽屉的上传来源：选完 .tgz 点「下一步」由服务端读包内 package.json 自动填包名；
 * 首个版本没传成功时回滚刚建的目录条目（否则再点「创建插件」会 409「已在目录里」）。
 */

const api = vi.hoisted(() => ({
  lookupPluginUpload: vi.fn(),
  lookupPlugin: vi.fn(),
  createPlugin: vi.fn(),
  deletePlugin: vi.fn(),
  uploadPluginVersion: vi.fn(),
  addPluginVersion: vi.fn(),
  updatePlugin: vi.fn(),
}))
vi.mock('@/api/admin-plugins', () => api)

const wrappers: { unmount: () => void }[] = []

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount()
  document.body.innerHTML = ''
  for (const fn of Object.values(api)) fn.mockReset()
})

const LOOKED_UP = {
  packageName: '@local/dsh-mobile',
  displayName: '@local/dsh-mobile',
  description: '手机端适配',
  homepage: null,
  versions: ['1.2.0'],
  latest: '1.2.0',
  isBundle: true,
  needsRestart: null,
}

async function mountDrawer() {
  const props = reactive<Record<string, unknown>>({ show: false })
  const created: number[] = []
  const Host = defineComponent({
    render: () =>
      h(NMessageProvider, null, {
        default: () => h(AddPluginDrawer, { ...props, onCreated: (id: number) => created.push(id) } as never),
      }),
  })
  const wrapper = mount(Host, { attachTo: document.body, global: { stubs: { RouterLink: true } } })
  props.show = true
  await nextTick()
  await flushPromises()
  wrappers.push(wrapper)
  return { created }
}

function buttonByText(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text,
  )
  expect(found, `找不到按钮「${text}」`).toBeTruthy()
  return found!
}

async function choose(source: string): Promise<void> {
  const radio = [...document.body.querySelectorAll<HTMLElement>('.n-radio-button')].find((item) =>
    item.textContent?.includes(source),
  )
  expect(radio, `找不到来源 ${source}`).toBeTruthy()
  radio!.click()
  await flushPromises()
}

async function pickFile(name = 'dsh-mobile-1.2.0.tgz'): Promise<void> {
  const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')
  expect(input).toBeTruthy()
  const file = new File(['x'], name, { type: 'application/gzip' })
  Object.defineProperty(input!, 'files', { value: [file], configurable: true })
  input!.dispatchEvent(new Event('change', { bubbles: true }))
  await flushPromises()
}

function fieldValue(placeholder: string): string {
  const element = document.body.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)
  expect(element, `找不到输入框 ${placeholder}`).toBeTruthy()
  return element!.value
}

describe('添加插件抽屉 · 上传 tgz', () => {
  it('点「下一步」读取包内 package.json，把包名/描述自动填进确认页', async () => {
    api.lookupPluginUpload.mockResolvedValue(LOOKED_UP)
    await mountDrawer()
    await choose('上传 tgz')
    await pickFile()

    buttonByText('下一步').click()
    await flushPromises()

    expect(api.lookupPluginUpload).toHaveBeenCalledTimes(1)
    const [blob, filename] = api.lookupPluginUpload.mock.calls[0] as [File, string]
    expect(filename).toBe('dsh-mobile-1.2.0.tgz')
    expect(blob.name).toBe('dsh-mobile-1.2.0.tgz')
    expect(fieldValue('dsh-email')).toBe('@local/dsh-mobile')
    expect(document.body.textContent).toContain('已读取到元数据：@local/dsh-mobile')
  })

  it('包不合法：留在第一步并显示服务端的错误，不会进确认页', async () => {
    api.lookupPluginUpload.mockRejectedValue(new Error('插件包里没有 package.json，不是合法 npm 包'))
    await mountDrawer()
    await choose('上传 tgz')
    await pickFile('broken.tgz')

    buttonByText('下一步').click()
    await flushPromises()

    expect(document.body.textContent).toContain('插件包里没有 package.json')
    expect(document.body.querySelector('input[placeholder="dsh-email"]')).toBeNull()
    expect(api.createPlugin).not.toHaveBeenCalled()
  })

  it('首个版本没传成功：回滚刚建的目录条目，再点「创建插件」不会 409', async () => {
    api.lookupPluginUpload.mockResolvedValue(LOOKED_UP)
    api.createPlugin.mockResolvedValueOnce({ id: 7 }).mockResolvedValueOnce({ id: 8 })
    api.uploadPluginVersion
      .mockRejectedValueOnce(new Error('上传的插件包 疑似密钥'))
      .mockResolvedValueOnce({ version: { id: 1 } })
    api.deletePlugin.mockResolvedValue(undefined)
    api.updatePlugin.mockResolvedValue({})
    const { created } = await mountDrawer()
    await choose('上传 tgz')
    await pickFile()
    buttonByText('下一步').click()
    await flushPromises()

    buttonByText('创建插件').click()
    await flushPromises()

    expect(api.deletePlugin).toHaveBeenCalledWith(7)
    expect(document.body.textContent).toContain('疑似密钥')
    expect(document.body.textContent).not.toContain('空条目')
    // 父页拿到两次 created：建好时一次，回滚后一次，列表都会刷新
    expect(created).toEqual([7, 7])

    buttonByText('创建插件').click()
    await flushPromises()

    expect(api.createPlugin).toHaveBeenCalledTimes(2)
    expect(api.deletePlugin).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('插件已入库')
  })

  it('回滚本身也失败时，提示管理员去插件列表手动删', async () => {
    api.lookupPluginUpload.mockResolvedValue(LOOKED_UP)
    api.createPlugin.mockResolvedValue({ id: 9 })
    api.uploadPluginVersion.mockRejectedValue(new Error('包名与目录里的不一致'))
    api.deletePlugin.mockRejectedValue(new Error('网络断了'))
    await mountDrawer()
    await choose('上传 tgz')
    await pickFile()
    buttonByText('下一步').click()
    await flushPromises()

    buttonByText('创建插件').click()
    await flushPromises()

    expect(document.body.textContent).toContain('包名与目录里的不一致')
    expect(document.body.textContent).toContain('手动删除')
  })
})
