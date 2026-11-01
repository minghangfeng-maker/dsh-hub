import { defineConfig, presetIcons, presetUno } from 'unocss'

/**
 * UnoCSS 配置（07 §1 / §2）。
 *
 * - 只启用 presetUno + presetIcons（`@iconify-json/ph`），presetAttributify 按 07 §1 关闭；
 * - `theme` 把设计令牌映射成语义类（`bg-primary-soft`、`text-2`、`rounded-card`、`shadow-soft`…）。
 *   值统一用 `var(--c-*)` / `var(--radius-*)` 引用 tokens.css：令牌是唯一事实来源，
 *   第二期接暗色主题时只改令牌即可，不必动组件里的原子类（07 §2.1 暗色预留）；
 * - 显式声明内容扫描范围，把独立入口 wake.html 也纳入。
 */
export default defineConfig({
  presets: [
    presetUno(),
    presetIcons({
      scale: 1.1,
      extraProperties: {
        display: 'inline-block',
        'vertical-align': 'middle',
      },
    }),
  ],
  theme: {
    colors: {
      // 主色（DeepSeek 蓝）：DEFAULT / hover / press / soft
      primary: {
        DEFAULT: 'var(--c-primary)',
        hover: 'var(--c-primary-hover)',
        press: 'var(--c-primary-press)',
        soft: 'var(--c-primary-soft)',
      },
      // 点缀色：水青蓝 / 紫罗兰（令牌名沿用 sakura）/ 琥珀 / 珊瑚红 / 水绿
      sky: { DEFAULT: 'var(--c-sky)', soft: 'var(--c-sky-soft)' },
      sakura: { DEFAULT: 'var(--c-sakura)', soft: 'var(--c-sakura-soft)' },
      butter: { DEFAULT: 'var(--c-butter)', soft: 'var(--c-butter-soft)' },
      danger: { DEFAULT: 'var(--c-danger)', soft: 'var(--c-danger-soft)' },
      success: { DEFAULT: 'var(--c-success)', soft: 'var(--c-success-soft)' },
      warning: 'var(--c-warning)',
      // 面与线
      bg: 'var(--c-bg)',
      surface: { DEFAULT: 'var(--c-surface)', glass: 'var(--c-surface-glass)' },
      border: 'var(--c-border)',
      // 文本层级：07 §2 的命名是 text / text-2 / text-3（用 1 补齐一级，三档才整齐）
      '1': 'var(--c-text)',
      '2': 'var(--c-text-2)',
      '3': 'var(--c-text-3)',
      // 实例状态色（07 §2.1）
      running: 'var(--c-status-running)',
      starting: 'var(--c-status-starting)',
      stopping: 'var(--c-status-stopping)',
      stopped: 'var(--c-status-stopped)',
      absent: 'var(--c-status-absent)',
      error: 'var(--c-status-error)',
    },
    borderRadius: {
      card: 'var(--radius-card)',
      control: 'var(--radius-control)',
      pill: 'var(--radius-pill)',
    },
    boxShadow: {
      soft: 'var(--shadow-card)',
      hover: 'var(--shadow-hover)',
    },
    fontFamily: {
      sans: 'var(--font-sans)',
      mono: 'var(--font-mono)',
    },
  },
  content: {
    filesystem: ['index.html', 'wake.html', 'src/**/*.{vue,ts}'],
    pipeline: {
      // 默认不扫 .ts，这里按 WP0a 要求显式补上
      include: [/\.vue($|\?)/, /\.ts($|\?)/, /\.html($|\?)/],
    },
  },
  shortcuts: [
    // 页面容器（用户端 1120px 居中；管理端用 global.css 的 .hub-container--admin）
    ['hub-page', 'mx-auto w-full max-w-[1120px] px-4 py-6 md:px-8 md:py-8'],
    // 卡片：与 global.css 的 .hub-card 同款视觉，方便模板里直接用
    [
      'hub-card',
      'rounded-card border border-solid border-[color:var(--c-border)] bg-[var(--c-surface)] p-6 shadow-soft',
    ],
    ['hub-card-hover', 'transition duration-180 hover:-translate-y-2px hover:shadow-hover'],
    // 标题 / 副标题
    ['hub-title', 'text-[24px] font-semibold leading-[1.6] text-1'],
    ['hub-subtitle', 'text-[14px] leading-[1.6] text-2'],
    ['hub-muted', 'text-[13px] leading-[1.6] text-3'],
    // 胶囊标签
    ['hub-chip', 'inline-block rounded-pill bg-primary-soft px-3 py-1 text-[13px] text-2'],
    // 导航项（顶栏 / 侧边栏通用）
    [
      'hub-nav-item',
      'flex items-center gap-2 rounded-[10px] px-3 py-2 text-[14px] text-2 transition-colors duration-180 hover:bg-primary-soft hover:text-primary-press',
    ],
    ['hub-nav-item-active', 'bg-primary-soft font-semibold text-primary-press'],
    // 链接与轻量按钮（Naive 覆盖不到的纯文本层级）
    ['hub-link', 'text-primary-press transition-colors duration-180 hover:text-primary-hover'],
    [
      'hub-btn-ghost',
      'inline-flex items-center gap-1.5 rounded-control px-3 py-1.5 text-[13px] text-2 transition duration-180 hover:bg-primary-soft hover:text-primary-press active:scale-[.98]',
    ],
  ],
})
