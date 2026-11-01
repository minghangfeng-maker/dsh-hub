import { ref } from 'vue'

/**
 * Shiki 代码高亮（按需加载）。
 *
 * - 用 `shiki/core` + JavaScript 正则引擎：**不加载 onig.wasm**，离线可用，
 *   在 WebView 里也不会因为 wasm fetch 失败而挂掉；
 * - 语言包逐个动态 import，只有真的出现某种代码块才加载对应语法；
 * - 双主题（light/dark 各一份 token 颜色），切深色模式不用重新高亮。
 */

type ThemeName = 'github-light-default' | 'github-dark-default'

const cache = new Map<string, string>()
const inflight = new Set<string>()
/** 缓存有更新时 +1，Vue 计算属性依赖它自动重算 */
export const highlightVersion = ref(0)

let highlighterPromise: Promise<any> | null = null
const loadedLangs = new Set<string>()

const LANG_LOADERS: Record<string, () => Promise<any>> = {
  ts: () => import('shiki/langs/typescript.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  js: () => import('shiki/langs/javascript.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  bash: () => import('shiki/langs/shellscript.mjs'),
  sh: () => import('shiki/langs/shellscript.mjs'),
  shell: () => import('shiki/langs/shellscript.mjs'),
  zsh: () => import('shiki/langs/shellscript.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  py: () => import('shiki/langs/python.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  yml: () => import('shiki/langs/yaml.mjs'),
  md: () => import('shiki/langs/markdown.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
}

export const SUPPORTED_LANGS = Object.keys(LANG_LOADERS)

async function getHighlighter(): Promise<any> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
      ])
      const [light, dark] = await Promise.all([
        import('shiki/themes/github-light-default.mjs'),
        import('shiki/themes/github-dark-default.mjs'),
      ])
      return createHighlighterCore({
        themes: [light.default, dark.default],
        langs: [],
        engine: createJavaScriptRegexEngine(),
      })
    })()
  }
  return highlighterPromise
}

function cacheKey(lang: string, code: string): string {
  return `${lang}\u0000${code}`
}

/** 已经高亮好的 HTML；没有返回 null（调用方先显示纯文本） */
export function getHighlighted(lang: string, code: string): string | null {
  if (!lang || !code) return null
  return cache.get(cacheKey(lang, code)) ?? null
}

/**
 * 流式期间延后高亮。
 *
 * 原因（实测）：Shiki 的正则引擎按语言**首次 tokenize 时**编译，真实代码块第一次
 * `codeToHtml` 会占 100ms 级主线程任务；即使预热过小片段，真实代码仍会触发新的规则编译。
 * 把它放在流式结束之后（400ms），用户看到的流式过程就始终是纯文本 + 稳定 60fps；
 * 回复结束后再补上高亮。
 */
let deferred = false
const pendingHighlights = new Map<string, { lang: string; code: string }>()

export function setHighlightDeferred(value: boolean): void {
  if (deferred === value) return
  deferred = value
  if (!value && pendingHighlights.size > 0) {
    const pending = [...pendingHighlights.values()]
    pendingHighlights.clear()
    for (const item of pending) ensureHighlighted(item.lang, item.code)
  }
}

/** 触发一次异步高亮；同一段代码只跑一次 */
export function ensureHighlighted(lang: string, code: string): void {
  const loader = LANG_LOADERS[lang]
  if (!loader || !code) return
  const key = cacheKey(lang, code)
  if (cache.has(key) || inflight.has(key)) return
  if (code.length > 20_000) return // 超长代码块不折腾，直接留纯文本
  if (deferred) {
    pendingHighlights.set(key, { lang, code })
    return
  }

  inflight.add(key)
  void (async () => {
    try {
      const highlighter = await getHighlighter()
      if (!loadedLangs.has(lang)) {
        const mod = await loader()
        await highlighter.loadLanguage(mod.default ?? mod)
        loadedLangs.add(lang)
      }
      const startedAt = performance.now()
      const html = highlighter.codeToHtml(code, {
        lang,
        themes: { light: 'github-light-default' satisfies ThemeName, dark: 'github-dark-default' satisfies ThemeName },
        defaultColor: false,
      })
      // 诊断：只记录耗时与语言，不记录代码正文。
      ;(window as unknown as { __shikiLog?: unknown[] }).__shikiLog ??= []
      ;(window as unknown as { __shikiLog: unknown[] }).__shikiLog.push({
        lang,
        chars: code.length,
        start: Math.round(startedAt),
        dur: Math.round(performance.now() - startedAt),
      })
      cache.set(key, html)
      highlightVersion.value++
    } catch (err) {
      // 高亮失败不影响阅读：保留 markdown-it 的纯文本代码块
      console.warn('[shiki] 高亮失败，回退纯文本', lang, err)
      cache.set(key, '')
    } finally {
      inflight.delete(key)
    }
  })()
}

/**
 * 冷启动预热（首屏之后调用，避免和首帧抢主线程）。
 *
 * 除了 highlighter 本体，还预加载常用语言并真的跑一次 `codeToHtml`：
 * 首次 tokenize 会编译正则（100ms 级），如果留到流式过程中间发生，就会掉一帧。
 */
export function warmupShiki(): void {
  void (async () => {
    try {
      const highlighter = await getHighlighter()
      for (const lang of ['ts', 'python', 'bash', 'json']) {
        const loader = LANG_LOADERS[lang]
        if (!loader) continue
        if (!loadedLangs.has(lang)) {
          const mod = await loader()
          await highlighter.loadLanguage(mod.default ?? mod)
          loadedLangs.add(lang)
        }
        // 关键是这一步：Shiki 的 JS 正则引擎是**按语言**在首次 tokenize 时编译的，
        // 只 loadLanguage 不够。每个语言先真渲染一小段，避免它落在流式关键帧上。
        highlighter.codeToHtml(lang === 'python' ? 'x = 1' : 'const x = 1', {
          lang,
          themes: { light: 'github-light-default', dark: 'github-dark-default' },
          defaultColor: false,
        })
      }
    } catch {
      /* 预热失败不影响功能，代码块会回退纯文本 */
    }
  })()
}
