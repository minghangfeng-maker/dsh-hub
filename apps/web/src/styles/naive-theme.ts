import type { GlobalThemeOverrides } from 'naive-ui'

/**
 * Naive UI 主题覆盖（原样实现 docs/07-前端设计.md §2.4）。
 *
 * 为什么这里写死颜色值：Naive UI 的主题系统只接受具体值，不能用 CSS 变量；
 * 这些值必须与 src/styles/tokens.css 保持一致（令牌是唯一事实来源）。
 */
export const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#4D6BFE',
    primaryColorHover: '#4262F0',
    primaryColorPressed: '#2F49D6',
    primaryColorSuppl: '#4262F0',
    infoColor: '#3DB4F5',
    warningColor: '#F5B841',
    errorColor: '#F27A7A',
    successColor: '#1FBF8F',
    borderRadius: '12px',
    borderRadiusSmall: '8px',
    fontFamily: '"HarmonyOS Sans SC","PingFang SC","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif',
    textColorBase: '#1A2238',
    textColor2: '#56627F',
    textColor3: '#8793B0',
    borderColor: '#E1E8F7',
    dividerColor: '#EAEFFA',
    bodyColor: '#F5F8FF',
    cardColor: '#FFFFFF',
  },
  Card: { borderRadius: '16px', paddingMedium: '24px' },
  Button: { borderRadiusMedium: '12px', heightMedium: '38px', fontWeight: '500' },
  Input: { borderRadius: '12px', heightMedium: '40px' },
  DataTable: { thColor: '#F6F8FF', tdColorHover: '#F1F4FF', borderRadius: '12px' },
  Tag: { borderRadius: '999px' },
  Menu: {
    itemColorActive: '#EEF2FF',
    itemTextColorActive: '#2F49D6',
    itemIconColorActive: '#2F49D6',
    borderRadius: '10px',
  },
}
