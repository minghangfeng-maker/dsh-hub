import { flushPromises, mount } from '@vue/test-utils'
import { NMessageProvider } from 'naive-ui'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'

import { HubApiError } from '@/api/http'
import ReauthGate from '@/components/admin/ReauthGate.vue'
import {
  ReauthCanceledError,
  cancelReauth,
  isReauthCanceled,
  requestReauth,
  resetReauthDialog,
  reauthDialog,
  resolveReauth,
  sensitive,
  withReauth,
} from '@/composables/useReauth'

/**
 * 敏感操作的二次密码确认（07 §7、04 §0.2 `REAUTH_REQUIRED`）：
 * - 服务端要 reauth → 自动弹窗 → **重试原请求**；
 * - 删除用户这类一律确认的操作 → 先确认再执行；
 * - 用户取消 → 抛 `ReauthCanceledError`，页面静默处理。
 */

function reauthRequired(): HubApiError {
  return new HubApiError('REAUTH_REQUIRED', '为了安全，请再输入一次密码', 403)
}

beforeEach(() => {
  resetReauthDialog()
})

describe('withReauth：REAUTH_REQUIRED 自动弹窗后重试', () => {
  it('第一次 403 → 弹窗 → 确认后重试成功', async () => {
    const action = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(reauthRequired())
      .mockResolvedValueOnce('done')

    const promise = withReauth(action, { title: '删除用户' })
    await flushPromises()

    expect(action).toHaveBeenCalledTimes(1)
    expect(reauthDialog.visible).toBe(true)
    expect(reauthDialog.title).toBe('删除用户')

    resolveReauth()
    await expect(promise).resolves.toBe('done')
    expect(action).toHaveBeenCalledTimes(2)
    expect(reauthDialog.visible).toBe(false)
  })

  it('取消 → ReauthCanceledError，不会重试原请求', async () => {
    const action = vi.fn<() => Promise<void>>().mockRejectedValue(reauthRequired())

    const promise = withReauth(action)
    await flushPromises()
    cancelReauth()

    await expect(promise).rejects.toBeInstanceOf(ReauthCanceledError)
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('其它错误原样抛出，不弹窗', async () => {
    const action = vi.fn<() => Promise<void>>().mockRejectedValue(new HubApiError('CONFLICT', '冲突', 409))

    await expect(withReauth(action)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(reauthDialog.visible).toBe(false)
  })

  it('重试后仍失败会抛出第二次的错误（不会无限重试）', async () => {
    const action = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(reauthRequired())
      .mockRejectedValueOnce(new HubApiError('FORBIDDEN', '没有权限', 403))

    const promise = withReauth(action)
    await flushPromises()
    resolveReauth()

    await expect(promise).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(action).toHaveBeenCalledTimes(2)
    expect(reauthDialog.visible).toBe(false)
  })
})

describe('sensitive：先确认身份再执行', () => {
  it('确认后只执行一次请求（不会因为服务端再次要求而重复弹窗）', async () => {
    const action = vi.fn<() => Promise<number>>().mockResolvedValue(7)

    const promise = sensitive(action, { title: '重置密码', confirmText: '重置' })
    await flushPromises()

    expect(action).not.toHaveBeenCalled()
    expect(reauthDialog.visible).toBe(true)
    expect(reauthDialog.confirmText).toBe('重置')

    resolveReauth()
    await expect(promise).resolves.toBe(7)
    expect(action).toHaveBeenCalledTimes(1)
    expect(reauthDialog.visible).toBe(false)
  })

  it('确认后服务端仍拒绝 → 直接把错误抛给调用方（不再弹窗）', async () => {
    const action = vi.fn<() => Promise<void>>().mockRejectedValue(reauthRequired())
    const promise = sensitive(action, { title: '删除用户' })
    await flushPromises()
    resolveReauth()

    await expect(promise).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' })
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('用户取消 → 抛取消错误，动作一次都没执行', async () => {
    const action = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const promise = sensitive(action, { title: '删除用户' })
    await flushPromises()
    cancelReauth()

    await expect(promise).rejects.toBeInstanceOf(ReauthCanceledError)
    expect(isReauthCanceled(await promise.catch((error: unknown) => error))).toBe(true)
    expect(action).not.toHaveBeenCalled()
  })

  it('重复触发时旧的等待者视为取消（避免 promise 悬挂）', async () => {
    const first = requestReauth({ title: '第一个' })
    // 立刻挂上处理器：第二次 requestReauth 会同步 reject 掉第一个
    const firstOutcome = first.then(
      () => 'resolved',
      (error: unknown) => error,
    )

    const second = requestReauth({ title: '第二个' })
    await flushPromises()

    expect(await firstOutcome).toBeInstanceOf(ReauthCanceledError)
    expect(reauthDialog.title).toBe('第二个')

    resolveReauth()
    await expect(second).resolves.toBeUndefined()
  })
})

describe('ReauthGate：弹窗壳子', () => {
  const Host = defineComponent({
    render: () => h(NMessageProvider, null, { default: () => h(ReauthGate) }),
  })

  it('打开后调 /api/auth/reauth，成功后关闭并 resolve', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    mount(Host, { attachTo: document.body })
    const promise = requestReauth({ title: '确认一下', description: '这是敏感操作' })
    await flushPromises()

    const modal = document.body.textContent ?? ''
    expect(modal).toContain('确认一下')
    expect(modal).toContain('这是敏感操作')

    const input = document.body.querySelector('input[type="password"]') as HTMLInputElement | null
    expect(input).toBeTruthy()
    if (input) {
      input.value = 'p@ssw0rd'
      input.dispatchEvent(new Event('input'))
    }
    await flushPromises()

    const buttons = [...document.body.querySelectorAll('button')]
    const confirm = buttons.find((button) => button.textContent?.includes('确认'))
    confirm?.click()
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/reauth', expect.objectContaining({ method: 'POST' }))
    await expect(promise).resolves.toBeUndefined()

    vi.unstubAllGlobals()
  })

  it('密码错误时就地提示，不关闭弹窗', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'WRONG_PASSWORD', message: '当前密码不正确' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )

    mount(Host, { attachTo: document.body })
    const promise = requestReauth({})
    await flushPromises()

    const input = document.body.querySelector('input[type="password"]') as HTMLInputElement | null
    if (input) {
      input.value = 'bad'
      input.dispatchEvent(new Event('input'))
    }
    await flushPromises()

    const buttons = [...document.body.querySelectorAll('button')]
    buttons.find((button) => button.textContent?.includes('确认'))?.click()
    await flushPromises()

    expect(document.body.textContent).toContain('当前密码不正确')
    expect(reauthDialog.visible).toBe(true)

    cancelReauth()
    await expect(promise).rejects.toBeInstanceOf(ReauthCanceledError)
    vi.unstubAllGlobals()
  })
})
