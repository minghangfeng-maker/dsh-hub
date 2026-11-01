/**
 * Vue 单文件组件的模块声明。
 *
 * 没有 vue-tsc 时（`tsc --noEmit`）也需要能解析 `import X from './X.vue'`；
 * 模板内部的类型检查交给 IDE / vue-tsc，不阻塞 `pnpm typecheck`。
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
