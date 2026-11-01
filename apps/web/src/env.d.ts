/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent
  export default component
}

// UnoCSS 的虚拟样式入口由 unocss/vite 在编译期提供，unocss 未自带该模块的类型声明
declare module 'virtual:uno.css'
