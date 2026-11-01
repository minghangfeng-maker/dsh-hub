import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * 读 `src/lib/app-info.ts` 里的 `APP_VERSION`，让 `version.json` 与打进包里的版本号
 * **同一个来源**（版本号只有那一处字面量，别在构建脚本里再抄一份）。
 *
 * 读不到就直接让构建失败：宁可构建报错，也不要产出一个版本号对不上的 `version.json`
 * —— 那样网页版会一直提示「有新版本」（C7 的对比是 version + build）。
 */
function readAppVersion(): string {
  const source = readFileSync(new URL('./src/lib/app-info.ts', import.meta.url), 'utf8')
  const matched = /export const APP_VERSION = '([^']+)'/.exec(source)
  if (!matched?.[1]) {
    throw new Error('vite.config.ts: 在 src/lib/app-info.ts 里找不到 `export const APP_VERSION = \'…\'`')
  }
  return matched[1]
}

/** git 短 sha（没有 git / 不在仓库里时用 dev，不抛错）。 */
function readGitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'dev'
  }
}

/**
 * 网页版产物里的 `version.json`（WP54 / 契约 C7）：
 * `{"version":"0.4.11","build":"<git短sha>","builtAt":"<ISO>"}`。
 *
 * 客户端（`stores/app-update.ts`）回前台 / 每 30 分钟拉一次 `./version.json`（no-store），
 * 与构建期注入的 `BUILD_INFO` 不同就提示「有新版本，点此刷新」。所以这个文件必须与
 * 打进 bundle 的值**逐字节一致**（同一个 `buildInfo` 对象同时给 define 和这里用）。
 */
function webVersionPlugin(buildInfo: { version: string; build: string; builtAt: string }): Plugin {
  return {
    name: 'dsh-web-version-json',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: `${JSON.stringify(buildInfo)}\n`,
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // 构建参数里的 Hub 地址（scripts/build-apk.sh 与 scripts/release/build-release.sh 用环境变量传）。
  const env = loadEnv(mode, process.cwd(), '')
  //
  // `__DSH_MOCK_HUB__` = **构建期常量**：只有 `VITE_HUB_ORIGIN=mock` 的构建（mock APK）是 true。
  // 正式构建里它被替换成字面量 `false`，`instance.ts` 的 `new MockHub(...)` 分支整块删掉，
  // 900 行的 mock Hub（core/src/mock/mock-hub.ts）随之被 tree-shake —— 0.2.17 之前它被打进
  // 了正式 APK（运行期判断折不掉，见 core/src/factory.ts 的注释与 scripts/verify-no-mock.sh）。
  const mockHubBuild = (env.VITE_HUB_ORIGIN ?? '') === 'mock'
  //
  // `__DSH_VOICE_DEMO_ENABLED__` = 假语音桥（截图/联调用）的开关：只有显式
  // `VITE_VOICE_DEMO=1` 的构建才有，正式构建里被折成 false、整段代码删掉。
  // 不能用 `import.meta.env.DEV` 判断：build-apk.sh 把 NODE_ENV 设成 development，
  // 正式构建里 DEV 也会是 true。
  const voiceDemo = (env.VITE_VOICE_DEMO ?? '') === '1'
  //
  // `__DSH_WEB__` = 手机网页版构建（WP54）：`VITE_TARGET=web`。同一套界面由 Hub 同源托管在 `/m/`，
  // 入口取页面自己的 origin（不走多入口切换），没有 APK 更新 / 原生插件。APK 构建里折成 false。
  const webBuild = (env.VITE_TARGET ?? '') === 'web'
  //
  // 构建信息（两个构建都注入；只有网页版会读）。`builtAt` 每次构建都变，`build` 是 git 短 sha。
  const buildInfo = {
    version: readAppVersion(),
    build: readGitSha(),
    builtAt: new Date().toISOString(),
  }

  return {
    // Capacitor 用 https://localhost 提供本地文件，相对路径最稳（hash 路由 + './'）。
    // 网页版由 Hub 托管在 `/m/`，同样是相对路径：不依赖挂载目录（契约 C2）。
    base: './',
    plugins: webBuild ? [vue(), webVersionPlugin(buildInfo)] : [vue()],
    define: {
      __DSH_MOCK_HUB__: JSON.stringify(mockHubBuild),
      __DSH_VOICE_DEMO_ENABLED__: JSON.stringify(voiceDemo),
      __DSH_WEB__: JSON.stringify(webBuild),
      __DSH_BUILD_SHA__: JSON.stringify(buildInfo.build),
      __DSH_BUILD_TIME__: JSON.stringify(buildInfo.builtAt),
    },
    resolve: {
      alias: {
        '@dsh-hub/mobile-core': fileURLToPath(new URL('../mobile-core/src/index.ts', import.meta.url)),
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    build: {
      target: 'es2020',
      // 网页版单独一个目录：不要覆盖 APK 用的 dist（两个产物会互相踩）。
      outDir: webBuild ? 'dist-web' : 'dist',
      emptyOutDir: true,
      chunkSizeWarningLimit: 4096,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('shiki') || id.includes('oniguruma')) return 'shiki'
            if (id.includes('katex')) return 'katex'
            if (id.includes('markdown-it')) return 'markdown-it'
            return undefined
          },
        },
      },
    },
    server: {
      host: '0.0.0.0',
      port: 5242,
      strictPort: true,
    },
  }
})
