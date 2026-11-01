/**
 * Vitest 全局桩：jsdom 缺少 Naive UI / @vueuse/core 依赖的几个浏览器 API。
 * 只补测试环境需要的最小实现，不引第三方依赖。
 */
import { afterAll, afterEach } from 'vitest'

/**
 * Naive UI（css-render）挂载样式的 promise 是异步的：如果它在 jsdom 环境**拆除之后**才 resolve，
 * 会抛 `ReferenceError: document is not defined` 并被 Vitest 记为「Unhandled Rejection」——
 * 即使所有断言都通过，`pnpm -r test` 也会整体失败（三包并行时约 1/3 概率，WP6 第二轮踩到）。
 *
 * 对策：每个用例后让出一个宏任务；文件跑完后再等一小会儿，让挂起的样式挂载在环境还活着时收尾。
 */
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
})

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 120))
})

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

class IntersectionObserverStub {
  readonly root = null
  readonly rootMargin = ''
  readonly thresholds: readonly number[] = []
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}

/**
 * jsdom 没有 `Element.prototype.scrollIntoView`：舰桥的「定位到某张卡」会调它
 * （`cockpit.focus-canvas` / 状态条读数），不补的话会抛 TypeError 变成 Unhandled Rejection。
 */
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    writable: true,
    configurable: true,
    value: () => {},
  })
}

if (typeof globalThis.IntersectionObserver === 'undefined') {
  globalThis.IntersectionObserver = IntersectionObserverStub as unknown as typeof IntersectionObserver
}

if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        // 已废弃但 Naive UI / VueUse 仍会调用
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  })
}

// jsdom 未实现 scrollTo；vue-router 的 scrollBehavior 会调用它（否则控制台刷 "Not implemented"）
Object.defineProperty(window, 'scrollTo', {
  writable: true,
  value: () => {},
})

// jsdom 没有 2D 画布（调用会刷 "Not implemented"）；水波纹的画布涟漪拿到 null 就自动不启用
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  writable: true,
  value: () => null,
})
