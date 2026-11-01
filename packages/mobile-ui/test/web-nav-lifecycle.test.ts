/**
 * 手机网页版（WP54 / W2）：返回键的历史守卫、生命周期合并规则、键盘缩壳口径。
 *
 * 这三块都是「纯函数 + 一层浏览器监听」，这里只测纯函数部分：
 *  - `lib/platform.ts`：守卫记录长什么样、生命周期事件要不要回调；
 *  - `composables/use-keyboard-viewport.ts`：visualViewport 尺寸 → 壳高度/内边距。
 * 真实的 popstate / visibilitychange / pageshow 行为由 e2e `web-nav` 覆盖。
 */

import { describe, expect, it } from 'vitest'
import {
  LIFECYCLE_COALESCE_MS,
  isBackGuardState,
  planLifecycleEvent,
  withBackGuard,
} from '@/lib/platform'
import type { LifecycleState } from '@/lib/platform'
import { KEYBOARD_MIN_INSET, planKeyboardLayout } from '@/composables/use-keyboard-viewport'

describe('返回键的历史守卫', () => {
  it('守卫记录的 state 带上标记，且原样保留 vue-router 的记账字段', () => {
    const routerState = {
      back: '',
      current: '/c/s_mock_plan',
      forward: null,
      replaced: false,
      position: 7,
      scroll: { left: 0, top: 120 },
    }
    const guard = withBackGuard(routerState)
    expect(isBackGuardState(guard)).toBe(true)
    // URL 不变、vue-router 的 position/scroll 还在（否则它 popstate 时会把这次返回当「未知历史」）
    expect(guard.position).toBe(7)
    expect(guard.current).toBe('/c/s_mock_plan')
    expect(guard.scroll).toEqual({ left: 0, top: 120 })
  })

  it('没有历史 state（首次加载）时也能压守卫', () => {
    expect(isBackGuardState(withBackGuard(null))).toBe(true)
    expect(isBackGuardState(withBackGuard(undefined))).toBe(true)
    expect(isBackGuardState(withBackGuard('x'))).toBe(true)
  })

  it('vue-router 自己的 state、空值都不算守卫', () => {
    expect(isBackGuardState({ position: 7, current: '/' })).toBe(false)
    expect(isBackGuardState({ __dshBackGuard: 0 })).toBe(false)
    expect(isBackGuardState(null)).toBe(false)
    expect(isBackGuardState(undefined)).toBe(false)
    expect(isBackGuardState('/c/x')).toBe(false)
  })
})

describe('生命周期（前后台）事件合并', () => {
  const ACTIVE: LifecycleState = { active: true, lastNotifyAt: 1000 }

  it('状态真的变了：一定回调（切后台断开、回前台重连）', () => {
    const hidden = planLifecycleEvent(ACTIVE, { active: false, source: 'visibility', now: 2000 })
    expect(hidden.notify).toBe(true)
    expect(hidden.next.active).toBe(false)

    const shown = planLifecycleEvent(hidden.next, { active: true, source: 'visibility', now: 3000 })
    expect(shown.notify).toBe(true)
    expect(shown.next.active).toBe(true)
  })

  it('重复的 visibilitychange（状态没变）不重复回调', () => {
    expect(planLifecycleEvent(ACTIVE, { active: true, source: 'visibility', now: 5000 }).notify).toBe(
      false,
    )
    // 已经切到后台了，又来一次 hidden / pagehide：不重复断开
    const hidden: LifecycleState = { active: false, lastNotifyAt: 4000 }
    expect(planLifecycleEvent(hidden, { active: false, source: 'pagehide', now: 5000 }).notify).toBe(
      false,
    )
  })

  it('bfcache 的 pageshow(persisted) 状态没变也强制回调（链路一定断了）', () => {
    const forced = planLifecycleEvent(ACTIVE, {
      active: true,
      source: 'pageshow',
      force: true,
      now: 1000 + LIFECYCLE_COALESCE_MS,
    })
    expect(forced.notify).toBe(true)
    expect(forced.next.lastNotifyAt).toBe(1000 + LIFECYCLE_COALESCE_MS)
  })

  it('pageshow 与 visibilitychange 背靠背到来时只回调一次（合并窗口）', () => {
    // 从后台（bfcache 里）刚因为 visibilitychange 回到前台
    const hidden: LifecycleState = { active: false, lastNotifyAt: 1500 }
    const first = planLifecycleEvent(hidden, { active: true, source: 'visibility', now: 2000 })
    expect(first.notify).toBe(true)
    // 同一毫秒内 pageshow persisted 又来了：跳过
    const second = planLifecycleEvent(first.next, {
      active: true,
      source: 'pageshow',
      force: true,
      now: 2000 + LIFECYCLE_COALESCE_MS - 1,
    })
    expect(second.notify).toBe(false)
    // 过了窗口再来就算一次新的
    const third = planLifecycleEvent(second.next, {
      active: true,
      source: 'pageshow',
      force: true,
      now: 2000 + LIFECYCLE_COALESCE_MS,
    })
    expect(third.notify).toBe(true)
  })

  it('Page Lifecycle 的 freeze / resume：冻结断开、解冻强制重连', () => {
    const frozen = planLifecycleEvent(ACTIVE, { active: false, source: 'freeze', now: 9000 })
    expect(frozen.notify).toBe(true)
    const resumed = planLifecycleEvent(frozen.next, {
      active: true,
      source: 'resume',
      force: true,
      now: 9500,
    })
    expect(resumed.notify).toBe(true)
  })

  it('APK 的 native 事件走同一套：切后台再回前台各回调一次', () => {
    const away = planLifecycleEvent(ACTIVE, { active: false, source: 'native', now: 100 })
    const back = planLifecycleEvent(away.next, { active: true, source: 'native', now: 200 })
    expect([away.notify, back.notify]).toEqual([true, true])
  })
})

describe('键盘（visualViewport）→ 壳高度', () => {
  const metrics = (over: Partial<Parameters<typeof planKeyboardLayout>[0]> = {}) => ({
    innerHeight: 915,
    visualHeight: 915,
    visualOffsetTop: 0,
    scale: 1,
    ...over,
  })

  it('没有键盘：不缩壳、不留内边距', () => {
    const plan = planKeyboardLayout(metrics(), true)
    expect(plan).toEqual({ blocked: 0, keyboard: false, appHeight: null, kbInset: 0 })
  })

  it('网页版 + 无 interactive-widget meta：visualViewport 缩小 → 壳缩到看得见的高度', () => {
    const plan = planKeyboardLayout(metrics({ visualHeight: 915 - 300 }), true)
    expect(plan.keyboard).toBe(true)
    expect(plan.blocked).toBe(300)
    expect(plan.appHeight).toBe(615)
    // 缩壳已经让开了键盘，不能再叠加 .composer 的 padding
    expect(plan.kbInset).toBe(0)
  })

  it('网页版 + 有 resizes-content meta：innerHeight 自己缩了 → 不额外动布局', () => {
    const plan = planKeyboardLayout(metrics({ innerHeight: 615, visualHeight: 615 }), true)
    expect(plan.blocked).toBe(0)
    expect(plan.keyboard).toBe(false)
    expect(plan.appHeight).toBeNull()
  })

  it('visualViewport 被顶上去（offsetTop）时按「底部被挡住多少」算', () => {
    const plan = planKeyboardLayout(metrics({ visualOffsetTop: 100, visualHeight: 500 }), true)
    expect(plan.blocked).toBe(315)
    expect(plan.appHeight).toBe(600)
  })

  it('双指缩放（scale ≠ 1）时不按键盘处理：缩放后的可见高度不能当布局高度', () => {
    const plan = planKeyboardLayout(metrics({ visualHeight: 900, scale: 1.8 }), true)
    expect(plan.keyboard).toBe(false)
    expect(plan.appHeight).toBeNull()
  })

  it('浏览器工具栏那种小差异（< 80px）不动布局', () => {
    const small = planKeyboardLayout(metrics({ visualHeight: 915 - (KEYBOARD_MIN_INSET - 1) }), true)
    expect(small.keyboard).toBe(false)
    expect(small.appHeight).toBeNull()
    const enough = planKeyboardLayout(metrics({ visualHeight: 915 - KEYBOARD_MIN_INSET }), true)
    expect(enough.keyboard).toBe(true)
  })

  it('APK 口径不变：只用 --kb-inset 兜底，永远不缩壳', () => {
    const plan = planKeyboardLayout(metrics({ visualHeight: 615 }), false)
    expect(plan).toEqual({ blocked: 300, keyboard: false, appHeight: null, kbInset: 300 })
  })
})
