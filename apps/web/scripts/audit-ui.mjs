#!/usr/bin/env node
/**
 * 界面走查（07 §2.7 §2.8，WP14）：逐页、逐宽度找两类问题——
 *  1. **说明小字**：常驻在页面上的解释句（`*__hint` / `*__note` / `*__desc` / `*__subtitle` / `hub-muted`
 *     这类类名，或「≤13px、带中文标点的整句」），按页列出来供人判断删 / 改 / 收进 InfoTip；
 *  2. **不该断的断行**：标识符、数字、数字 + 单位、短标签被拆到两行（按字符逐个量位置）；
 *  另外记录整页横向滚动。只是报告工具：结果要人看，误报在报告里说明即可。
 *
 * 用法：
 *   # 1）在 apps/web 下起开发服务器（端口用本仓库 README 里写的约定，挑一个没被占用的）
 *   cd apps/web && NODE_ENV=development ./node_modules/.bin/vite --port <vite 端口> --strictPort
 *   # 2）另开一个 shell
 *   node apps/web/scripts/audit-ui.mjs --base http://127.0.0.1:<vite 端口> --cdp <CDP 端口> \
 *        [--set user|admin|all] [--only usage,models-dsh] [--widths 1440,1280,1024,390] [--shots] [--out <dir>]
 *   # 产出 <out>/audit.json 与 <out>/audit.md（默认 out = .data/ui-audit/<set>）
 *
 * 页面清单在下面 PAGES（WP23b 加了 Claude Code / Codex 两页的四个标签与下发弹窗）；弹窗类的条目用 `click`、悬浮提示用 `hover`（Playwright 选择器）在载入后触发；
 * 多步操作（点开弹窗 → 填名字 → 提交）用 `steps`：`{ click }` / `{ hover }` / `{ type: { selector, text } }` /
 * `{ files: { selector, path } }` / `{ wait: ms }`。需要更多页面 / 状态就往里加。
 * 每页还会把 `button.info-tip` 悬停一遍，把说明文字收进报告（07 §2.7 每页最多 3 个）。
 * 无头 Chrome 用 `~/.local/bin/google-chrome`（CHROME_PATH 可覆盖），代理一律 direct。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '../../..')
const CHROME = process.env.CHROME_PATH ?? join(homedir(), '.local/bin/google-chrome')

const argv = process.argv.slice(2)
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback)
const BASE = arg('--base', '')
const CDP = arg('--cdp', '')
const SET = arg('--set', 'all')
const ONLY = (arg('--only', '') ?? '').split(',').filter(Boolean)
const WIDTHS = (arg('--widths', '1440,1280,1024,390') ?? '').split(',').map(Number)
const SHOTS = argv.includes('--shots')
const OUT = resolve(arg('--out', join(REPO, '.data', 'ui-audit', SET)))

if (!BASE || !CDP) {
  console.error('需要 --base http://127.0.0.1:<vite 端口> 和 --cdp <CDP 端口>')
  process.exit(2)
}

/** 64×64 PNG：头像裁剪弹窗走查用（不需要额外的图片 fixture） */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAy0lEQVR4nO3PvSoGAABG4e8W/ERSUlLKIIMyKIsyiAWLGMQgp0SJQsjv56ZP6iuzGzh1lnd7n8EuHuAxnuElXuMdPuILvuMXDvFn1HA0P/AVn/AebxA8xxM8xD3cxk1cx1VcxkWcx1mcxkkcx7FR4ziBUziDc7iAS7iCa7iBW7iD+3iEp3iBV3iLD/iMb/iJ33+vBgECBAgQIECAAAECBAgQIECAAAECBAgQIECBAgQIECBAgQIECBAgQIECBAgQIECA/wC/rcDjVmB8h6sAAAAASUVORK5CYII='

/**
 * name / set / path（含 ?mock=）：一条页面条目。
 * `click` / `hover`：载入后要点开 / 悬停的东西（弹窗、抽屉、图表提示）；
 * `steps`：多步状态（`{ click }` / `{ hover }` / `{ type }` / `{ files }` / `{ wait }`），
 * 用来覆盖「先选一行 → 再点菜单 → 再打开弹窗」「分步进向导」这类一次点击到不了的状态。
 */
const PAGES = [
  // ── 认证页（不登录；假数据关掉，接口失败也要能看） ──
  { name: 'login', set: 'user', path: '/login?mock=0' },
  { name: 'register', set: 'user', path: '/register?mock=0' },
  { name: 'force-password', set: 'user', path: '/me/password?mock=1' },
  { name: 'not-found', set: 'user', path: '/no-such-page?mock=1' },
  // ── 用户端：各实例状态（弹窗 / 状态条 / 空状态） ──
  { name: 'home', set: 'user', path: '/home?mock=1' },
  { name: 'home-stopped', set: 'user', path: '/home?mock=stopped' },
  { name: 'home-empty', set: 'user', path: '/home?mock=empty' },
  { name: 'home-absent', set: 'user', path: '/home?mock=absent' },
  { name: 'home-starting', set: 'user', path: '/home?mock=starting' },
  { name: 'home-stopping', set: 'user', path: '/home?mock=stopping' },
  { name: 'home-error', set: 'user', path: '/home?mock=error' },
  { name: 'home-capacity', set: 'user', path: '/home?mock=capacity' },
  { name: 'home-exporting', set: 'user', path: '/home?mock=exporting' },
  { name: 'home-plugins', set: 'user', path: '/home?mock=plugins' },
  {
    name: 'home-announcement',
    set: 'user',
    path: '/home?mock=1',
    steps: [{ click: 'button:has-text("跳过")' }, { click: 'button[aria-label="查看公告"]' }],
  },
  {
    name: 'me-account-menu',
    set: 'user',
    path: '/me?mock=1&tab=profile',
    click: 'button.user-header__account',
  },
  { name: 'usage', set: 'user', path: '/usage?mock=1' },
  { name: 'usage-relay-off', set: 'user', path: '/usage?mock=relay-off' },
  { name: 'me-profile', set: 'user', path: '/me?mock=1&tab=profile' },
  { name: 'me-security', set: 'user', path: '/me?mock=1&tab=security' },
  { name: 'me-plugins', set: 'user', path: '/me?mock=1&tab=plugins' },
  { name: 'me-plugins-pending', set: 'user', path: '/me?mock=plugins&tab=plugins' },
  { name: 'me-exports', set: 'user', path: '/me?mock=1&tab=exports' },
  { name: 'me-exports-empty', set: 'user', path: '/me?mock=empty&tab=exports' },
  { name: 'me-exports-running', set: 'user', path: '/me?mock=exporting&tab=exports' },
  {
    name: 'me-avatar-crop',
    set: 'user',
    path: '/me?mock=1&tab=profile',
    steps: [
      {
        files: {
          selector: '[data-testid="avatar-input"]',
          name: 'avatar.png',
          mimeType: 'image/png',
          base64: TINY_PNG,
        },
      },
    ],
  },
  // ── 「积分与用量」WP24（19 §1 §2）：五块改版后的筛选 / 图形 / 空状态 / 记录标签 ──
  // 19 D3：外接（新建密钥 / 接入说明）已隐藏，等 SHOW_EXTERNAL_ACCESS 恢复后再加回对应用例。
  { name: 'usage-empty', set: 'user', path: '/usage?mock=usage-empty' },
  { name: 'usage-stack', set: 'user', path: '/usage?mock=1&chart=stack' },
  { name: 'usage-merge', set: 'user', path: '/usage?mock=1&merge=1' },
  { name: 'usage-scope-claude', set: 'user', path: '/usage?mock=1&scope=claude-code' },
  {
    name: 'usage-custom-range',
    set: 'user',
    path: '/usage?mock=1&range=custom&from=2026-09-25&to=2026-10-15',
  },
  { name: 'usage-line-tip', set: 'user', path: '/usage?mock=1', hover: '.model-chart__hit >> nth=28' },
  { name: 'usage-records-tools', set: 'user', path: '/usage?mock=1&log=tools' },
  { name: 'usage-records-compute', set: 'user', path: '/usage?mock=1&log=compute' },
  // ── 管理端（WP14b；这里保留原有条目，方便两边共用一份脚本） ──
  { name: 'admin-overview', set: 'admin', path: '/admin?mock=admin' },
  { name: 'users', set: 'admin', path: '/admin/users?mock=admin' },
  {
    name: 'users-create',
    set: 'admin',
    path: '/admin/users?mock=admin',
    click: 'button:has-text("新建用户")',
  },
  { name: 'user-overview', set: 'admin', path: '/admin/users/2?mock=admin&tab=overview' },
  { name: 'user-environment', set: 'admin', path: '/admin/users/2?mock=admin&tab=environment' },
  { name: 'user-plugins', set: 'admin', path: '/admin/users/2?mock=admin&tab=plugins' },
  { name: 'user-security', set: 'admin', path: '/admin/users/2?mock=admin&tab=security' },
  { name: 'user-audit', set: 'admin', path: '/admin/users/2?mock=admin&tab=audit' },
  { name: 'instances', set: 'admin', path: '/admin/instances?mock=admin' },
  { name: 'plugins', set: 'admin', path: '/admin/plugins?mock=admin' },
  { name: 'plugin-detail', set: 'admin', path: '/admin/plugins/1?mock=admin' },
  { name: 'runtimes', set: 'admin', path: '/admin/runtimes?mock=admin' },
  { name: 'models-overview', set: 'admin', path: '/admin/models?mock=admin&tab=overview' },
  { name: 'models-channels', set: 'admin', path: '/admin/models?mock=admin&tab=channels' },
  {
    name: 'models-add-channel',
    set: 'admin',
    path: '/admin/models?mock=admin&tab=channels',
    click: 'button:has-text("添加渠道")',
  },
  { name: 'models-models', set: 'admin', path: '/admin/models?mock=admin&tab=models' },
  { name: 'models-price', set: 'admin', path: '/admin/models?mock=admin&tab=models&edit=1' },
  { name: 'models-dsh', set: 'admin', path: '/admin/models?mock=admin&tab=dsh' },
  { name: 'models-wallets', set: 'admin', path: '/admin/models?mock=admin&tab=wallets' },
  { name: 'models-usage', set: 'admin', path: '/admin/models?mock=admin&tab=usage' },
  { name: 'models-settings', set: 'admin', path: '/admin/models?mock=admin&tab=settings' },
  // WP23b Claude Code / Codex 管理（18 §6）：两个页面各四个标签 + 下发确认弹窗
  { name: 'claude-code-deliver', set: 'admin', path: '/admin/claude-code?mock=agent-modes&tab=deliver' },
  {
    name: 'claude-code-deliver-dialog',
    set: 'admin',
    path: '/admin/claude-code?mock=agent-modes&tab=deliver',
    click: '[data-testid="agent-mode-deliver"]',
  },
  { name: 'claude-code-channels', set: 'admin', path: '/admin/claude-code?mock=agent-modes&tab=channels' },
  {
    name: 'claude-code-add-channel',
    set: 'admin',
    path: '/admin/claude-code?mock=agent-modes&tab=channels',
    click: 'button:has-text("添加渠道")',
  },
  { name: 'claude-code-models', set: 'admin', path: '/admin/claude-code?mock=agent-modes&tab=models' },
  { name: 'claude-code-usage', set: 'admin', path: '/admin/claude-code?mock=agent-modes&tab=usage' },
  { name: 'codex-deliver', set: 'admin', path: '/admin/codex?mock=agent-modes&tab=deliver' },
  { name: 'codex-channels', set: 'admin', path: '/admin/codex?mock=agent-modes&tab=channels' },
  { name: 'codex-models', set: 'admin', path: '/admin/codex?mock=agent-modes&tab=models' },
  { name: 'codex-usage', set: 'admin', path: '/admin/codex?mock=agent-modes&tab=usage' },
  { name: 'rollout-wizard', set: 'admin', path: '/admin/rollouts?mock=delivery&items=plugin:1,plugin:3' },
  { name: 'jobs', set: 'admin', path: '/admin/jobs?mock=admin' },
  { name: 'job-detail', set: 'admin', path: '/admin/jobs/1042?mock=admin' },
  { name: 'invites', set: 'admin', path: '/admin/invites?mock=admin' },
  {
    name: 'invites-create',
    set: 'admin',
    path: '/admin/invites?mock=admin',
    click: 'button:has-text("生成邀请码")',
  },
  { name: 'settings', set: 'admin', path: '/admin/settings?mock=admin' },
  { name: 'audit', set: 'admin', path: '/admin/audit?mock=admin' },
  // ── 管理端：页面初始状态之外的状态（WP14b 补） ──
  // 抽屉 / 弹窗
  {
    name: 'channels-drawer',
    set: 'admin',
    path: '/admin/models?mock=admin&tab=channels',
    click: 'tbody tr >> nth=0 >> button:has-text("编辑")',
  },
  {
    name: 'channels-test',
    set: 'admin',
    path: '/admin/models?mock=admin&tab=channels',
    click: 'tbody tr >> nth=0 >> button:has-text("测试")',
  },
  {
    name: 'models-picker',
    set: 'admin',
    path: '/admin/models?mock=admin&tab=models',
    click: '[data-testid="add-model"]',
  },
  {
    name: 'models-catalog',
    set: 'admin',
    path: '/admin/models?mock=admin&tab=models',
    click: '[data-testid="models-catalog"]',
  },
  {
    name: 'wallets-adjust',
    set: 'admin',
    path: '/admin/models?mock=admin&tab=wallets',
    click: 'button:has-text("加 / 扣积分")',
  },
  {
    name: 'wallets-settings',
    set: 'admin',
    path: '/admin/models?mock=admin&tab=wallets',
    click: 'button:has-text("设置")',
  },
  {
    name: 'plugins-add',
    set: 'admin',
    path: '/admin/plugins?mock=admin',
    click: 'button:has-text("添加插件")',
  },
  {
    name: 'invites-role',
    set: 'admin',
    path: '/admin/invites?mock=admin',
    steps: [{ click: 'button[aria-label$="更多操作"]' }, { click: 'text=修改角色' }],
  },
  // 批量操作条 / 行操作菜单 / 二次确认
  { name: 'users-batch', set: 'admin', path: '/admin/users?mock=admin', click: 'thead .n-checkbox' },
  {
    name: 'users-more-menu',
    set: 'admin',
    path: '/admin/users?mock=admin',
    click: 'button[aria-label$="更多操作"]',
  },
  {
    name: 'users-delete-confirm',
    set: 'admin',
    path: '/admin/users?mock=admin',
    steps: [{ click: 'button[aria-label$="更多操作"]' }, { click: 'text=删除用户' }],
  },
  {
    name: 'channels-delete-confirm',
    set: 'admin',
    path: '/admin/models?mock=admin&tab=channels',
    click: 'tbody tr >> nth=0 >> button:has-text("删除")',
  },
  {
    name: 'user-security-revoke-confirm',
    set: 'admin',
    path: '/admin/users/2?mock=admin&tab=security',
    click: 'button:has-text("强制下线全部会话")',
  },
  // 下发向导的每一步（kind=models 不用先选插件，能看到后面的步骤）
  {
    name: 'wizard-target',
    set: 'admin',
    path: '/admin/rollouts?mock=delivery&items=plugin:1&targets=installed',
    steps: [{ click: '[data-testid="delivery-next"]' }],
  },
  {
    name: 'wizard-strategy',
    set: 'admin',
    path: '/admin/rollouts?mock=delivery&items=plugin:1,models',
    steps: [{ click: '[data-testid="delivery-next"]' }, { click: '[data-testid="delivery-next"]' }],
  },
  {
    name: 'wizard-preview',
    set: 'admin',
    path: '/admin/rollouts?mock=delivery&platforms=instance,desktop&items=plugin:1,plugin:3&targets=installed',
    steps: [
      { click: '[data-testid="delivery-next"]' },
      { click: '[data-testid="delivery-next"]' },
      { click: '[data-testid="delivery-next"]' },
    ],
  },
  {
    name: 'wizard-plugin-empty',
    set: 'admin',
    path: '/admin/rollouts?mock=delivery',
    click: '[data-testid="delivery-next"]',
  },
  // 任务详情的各种状态
  { name: 'job-detail-partial', set: 'admin', path: '/admin/jobs/1040?mock=admin' },
  { name: 'job-detail-succeeded', set: 'admin', path: '/admin/jobs/1039?mock=admin' },
  { name: 'job-detail-paused', set: 'admin', path: '/admin/jobs/1038?mock=admin' },
  // 键盘 / 悬浮：InfoTip 打开后的浮层
  {
    name: 'models-dsh-tip',
    set: 'admin',
    path: '/admin/models?mock=admin&tab=dsh',
    click: '.info-tip >> nth=0',
  },
  {
    name: 'users-create-tip',
    set: 'admin',
    path: '/admin/users?mock=admin',
    steps: [{ click: 'button:has-text("新建用户")' }],
  },
  // ── 桌面端（WP25c）：授权页四种状态 / 隐私说明 / 下载占位 / 工作台设备条 / 管理端台账 ──
  { name: 'desktop-authorize', set: 'user', path: '/desktop/authorize?mock=desktop&req=req_wp25c' },
  { name: 'desktop-authorize-done', set: 'user', path: '/desktop/authorize?mock=desktop-done&req=req_done' },
  {
    name: 'desktop-authorize-expired',
    set: 'user',
    path: '/desktop/authorize?mock=desktop-expired&req=req_expired',
  },
  {
    name: 'desktop-authorize-limit',
    set: 'user',
    path: '/desktop/authorize?mock=desktop-limit&req=req_limit',
  },
  { name: 'desktop-privacy', set: 'user', path: '/desktop/privacy?mock=1' },
  { name: 'desktop-download', set: 'user', path: '/desktop/download?mock=1' },
  { name: 'home-desktop', set: 'user', path: '/home?mock=desktop' },
  { name: 'home-desktop-empty', set: 'user', path: '/home?mock=desktop-empty' },
  { name: 'instances-desktop', set: 'admin', path: '/admin/instances?mock=admin&tab=desktop' },
  {
    name: 'instances-desktop-revoked',
    set: 'admin',
    path: '/admin/instances?mock=admin&tab=desktop&presence=revoked',
  },
  // ── WP25f：设备详情抽屉 / 批量吊销结果 / 改名行内编辑 / 必须改密的授权页 ──
  { name: 'desktop-authorize-password', set: 'user', path: '/desktop/authorize?mock=desktop-password&req=req_pw' },
  {
    // 首次进工作台会弹「欢迎三步」引导（挡住整页）→ 先点「跳过」，再点设备卡上的「改名」
    name: 'home-desktop-rename',
    set: 'user',
    path: '/home?mock=desktop',
    steps: [
      { click: '.welcome-guide__footer button:first-child' },
      { click: '[data-testid="desktop-device-rename"]' },
    ],
  },
  {
    name: 'instances-desktop-detail',
    set: 'admin',
    path: '/admin/instances?mock=admin&tab=desktop',
    steps: [{ click: '[data-testid="admin-desktop-devices"] .n-data-table-tbody tr:first-child td:nth-child(3)' }, { wait: 500 }],
  },
  {
    name: 'instances-desktop-batch',
    set: 'admin',
    path: '/admin/instances?mock=admin-batch&tab=desktop',
    steps: [
      { click: '[data-testid="admin-desktop-devices"] .n-data-table-th .n-checkbox' },
      { wait: 200 },
      { click: '[data-testid="admin-desktop-batch-revoke"]' },
      { wait: 300 },
      { click: '.n-popconfirm__action button:last-child' },
      { wait: 800 },
    ],
  },
  // ── 插件库多选批量（WP28c，docs/21 §1.2）：「已安装」列 / 批量条 / 统计失败态 / 详情页两个按钮 ──
  { name: 'plugins-bulk', set: 'admin', path: '/admin/plugins?mock=plugins-bulk' },
  {
    name: 'plugins-bulk-selected',
    set: 'admin',
    path: '/admin/plugins?mock=plugins-bulk',
    steps: [
      { click: '[aria-label="选择 邮件助手"]' },
      { click: '[aria-label="选择 旧版便签"]' },
      { click: '[aria-label="选择 记忆库"]' },
      { wait: 200 },
    ],
  },
  { name: 'plugins-bulk-stats-failed', set: 'admin', path: '/admin/plugins?mock=plugins-bulk&stats=fail' },
  {
    name: 'plugins-bulk-page2',
    set: 'admin',
    path: '/admin/plugins?mock=plugins-bulk',
    steps: [
      { click: '[aria-label="选择 邮件助手"]' },
      { click: '.n-pagination-item:nth-child(2)' },
      { wait: 200 },
    ],
  },
  // ── WP28b 统一下发向导（四个步骤 / 已安装目标 / 警告 / 截断 / 只选桌面端）──
  {
    name: 'delivery-items',
    set: 'admin',
    path: '/admin/rollouts?mock=delivery&platforms=instance,desktop&items=plugin:1,plugin:3,plugin:4,models&targets=installed',
  },
  {
    name: 'delivery-targets',
    set: 'admin',
    path: '/admin/rollouts?mock=delivery&platforms=instance,desktop&items=plugin:1,plugin:3,plugin:4,models&targets=installed',
    steps: [{ click: '[data-testid="delivery-next"]' }],
  },
  {
    name: 'delivery-targets-advanced',
    set: 'admin',
    path: '/admin/rollouts?mock=delivery&platforms=instance,desktop&items=plugin:1&targets=all',
    steps: [
      { click: '[data-testid="delivery-next"]' },
      { click: '[data-testid="delivery-advanced"] .n-collapse-item__header' },
      { wait: 300 },
    ],
  },
  {
    name: 'delivery-strategy',
    set: 'admin',
    path: '/admin/rollouts?mock=delivery&platforms=instance,desktop&items=plugin:1,plugin:3&targets=installed',
    steps: [{ click: '[data-testid="delivery-next"]' }, { click: '[data-testid="delivery-next"]' }],
  },
  {
    name: 'delivery-preview',
    set: 'admin',
    path: '/admin/rollouts?mock=delivery&platforms=instance,desktop&items=plugin:1,plugin:3,plugin:4&targets=installed',
    steps: [
      { click: '[data-testid="delivery-next"]' },
      { click: '[data-testid="delivery-next"]' },
      { click: '[data-testid="delivery-next"]' },
    ],
  },
  {
    name: 'delivery-preview-desktop',
    set: 'admin',
    path: '/admin/rollouts?mock=delivery-desktop-only&platforms=desktop&items=plugin:1',
    steps: [{ click: '[data-testid="delivery-next"]' }, { click: '[data-testid="delivery-next"]' }],
  },
  {
    name: 'delivery-preview-warnings',
    set: 'admin',
    path: '/admin/rollouts?mock=delivery-warnings&platforms=instance,desktop&items=plugin:4,runtime:2&targets=all',
    steps: [
      { click: '[data-testid="delivery-next"]' },
      { click: '[data-testid="delivery-next"]' },
      { click: '[data-testid="delivery-next"]' },
    ],
  },
  {
    name: 'delivery-preview-truncated',
    set: 'admin',
    path: '/admin/rollouts?mock=delivery-truncated&platforms=instance&items=plugin:1&targets=all',
    steps: [
      { click: '[data-testid="delivery-next"]' },
      { click: '[data-testid="delivery-next"]' },
      { click: '[data-testid="delivery-next"]' },
    ],
  },
  // ── WP32b：平台切换后的桌面侧（docs/22 §1）──
  { name: 'wp32b-instances-desktop', set: 'admin', path: '/admin/instances?mock=admin-desktop&platform=desktop' },
  { name: 'wp32b-plugins-cloud', set: 'admin', path: '/admin/plugins?mock=admin-desktop' },
  { name: 'wp32b-plugins-desktop', set: 'admin', path: '/admin/plugins?mock=admin-desktop&platform=desktop' },
  { name: 'wp32b-plugin-detail-desktop', set: 'admin', path: '/admin/plugins/3?mock=admin-desktop&platform=desktop' },
  { name: 'wp32b-runtimes-desktop', set: 'admin', path: '/admin/runtimes?mock=admin-desktop&platform=desktop' },
  { name: 'wp32b-jobs-desktop', set: 'admin', path: '/admin/jobs?mock=admin-desktop&platform=desktop' },
  // docs/22 / WP32c：模型配置按平台、Claude Code / Codex 与网络代理的桌面侧、向导的两平台版本
  {
    name: 'models-dsh-desktop',
    set: 'admin',
    path: '/admin/models?mock=admin&tab=dsh&platform=desktop',
  },
  {
    name: 'models-usage-desktop',
    set: 'admin',
    path: '/admin/models?mock=admin&tab=usage&platform=desktop',
  },
  {
    name: 'claude-desktop',
    set: 'admin',
    path: '/admin/claude-code?mock=agent-modes&platform=desktop',
  },
  {
    name: 'codex-desktop',
    set: 'admin',
    path: '/admin/codex?mock=agent-modes&platform=desktop',
  },
  {
    name: 'delivery-two-platforms',
    set: 'admin',
    path: '/admin/rollouts?mock=delivery&platforms=instance,desktop&items=plugin:1,plugin:3,plugin:4',
  },
  {
    name: 'delivery-desktop-from-model',
    set: 'admin',
    path: '/admin/rollouts?mock=delivery&platforms=desktop&items=models',
  },
]

/** 在页面里跑：返回 { hints, wraps, overflow }。只看可见元素；弹窗打开时只看弹窗与页面主体都算。 */
function auditInPage() {
  const visible = (el) => {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return false
    const style = getComputedStyle(el)
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05
  }
  const where = (el) => {
    const parts = []
    let node = el
    for (let depth = 0; node && node.nodeType === 1 && depth < 4; depth += 1, node = node.parentElement) {
      let part = node.tagName.toLowerCase()
      const classes = [...node.classList].filter((c) => !c.startsWith('n-') || depth === 0).slice(0, 2)
      if (classes.length) part += `.${classes.join('.')}`
      const testId = node.getAttribute('data-testid')
      if (testId) part += `[data-testid=${testId}]`
      parts.unshift(part)
    }
    return parts.join(' > ')
  }
  const clean = (text) => text.replace(/\s+/g, ' ').trim()

  /** 一组矩形分几行：竖直方向重叠过半算同一行（大小字号混排时 top 会差几像素） */
  const countLines = (rects) => {
    const lines = []
    for (const rect of [...rects]
      .filter((r) => r.width >= 1 && r.height >= 1)
      .sort((a, b) => a.top - b.top)) {
      const line = lines.find((l) => {
        const overlap = Math.min(l.bottom, rect.bottom) - Math.max(l.top, rect.top)
        return overlap > 0.5 * Math.min(l.bottom - l.top, rect.height)
      })
      if (line) {
        line.top = Math.min(line.top, rect.top)
        line.bottom = Math.max(line.bottom, rect.bottom)
      } else lines.push({ top: rect.top, bottom: rect.bottom })
    }
    return lines.length
  }

  const SKIP =
    'textarea, pre, .cm-editor, .yaml-editor, script, style, svg, [aria-hidden="true"], .log-viewer'
  // 「标签 / 按钮 / 列标题」的容器白名单：写成 `[class*="tag"]` 会误伤 `stagger-item` 这类类名
  const NO_WRAP_CONTAINER =
    'th, button, .n-button, .n-tag, .n-tabs-tab, .n-statistic-value, .mini-tag, .hub-chip, [class*="-pill"], [class$="__tag"], [class$="-tag"]'
  const TOKEN = /[A-Za-z0-9._\-/:@#%,+]/
  const UNIT = /[万亿千kKMWB%积个次天]/

  // ── 1. 说明小字 ──
  const hints = []
  const seenHint = new Set()
  const HINT_SELECTOR =
    '[class*="__hint"], [class*="__note"], [class*="__desc"], [class*="__subtitle"], [class*="__sub "], .hub-muted, .n-alert'
  const candidates = new Set(document.querySelectorAll(HINT_SELECTOR))
  for (const el of document.querySelectorAll('p, span, div, small, li')) {
    if (el.children.length > 3) continue
    const text = clean(el.textContent ?? '')
    if (text.length < 14 || !/[一-鿿]/.test(text) || !/[，。；：（、]/.test(text)) continue
    const style = getComputedStyle(el)
    if (
      Number.parseFloat(style.fontSize) <= 13 &&
      !el.closest('td, th, .n-data-table, .n-form-item-feedback--error')
    )
      candidates.add(el)
  }
  for (const el of candidates) {
    if (!visible(el) || el.closest(SKIP)) continue
    // 只留最外层：祖先也命中时跳过
    let parent = el.parentElement
    let nested = false
    while (parent) {
      if (candidates.has(parent) && visible(parent)) nested = true
      parent = parent.parentElement
    }
    if (nested) continue
    const text = clean(el.textContent ?? '')
    if (!text || seenHint.has(text)) continue
    seenHint.add(text)
    hints.push({
      kind: el.classList.contains('n-alert') ? 'alert' : 'hint',
      text: text.slice(0, 160),
      where: where(el),
    })
  }

  // ── 2. 不该断的断行 ──
  const wraps = []
  const seenWrap = new Set()
  const report = (el, text, reason) => {
    const key = `${reason}|${text}`
    if (seenWrap.has(key)) return
    seenWrap.add(key)
    wraps.push({ reason, text: text.slice(0, 120), where: where(el) })
  }
  const range = document.createRange()

  // 2a. 文本节点内部：逐字量位置，找换行点，看断点两边
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.data
    if (!text.trim()) continue
    const el = node.parentElement
    if (!el || el.closest(SKIP) || !visible(el)) continue
    range.selectNodeContents(node)
    if (countLines(range.getClientRects()) < 2) continue
    let previous = null
    for (let i = 0; i < text.length; i += 1) {
      range.setStart(node, i)
      range.setEnd(node, i + 1)
      const rect = range.getBoundingClientRect()
      if (rect.width < 0.5 || /\s/.test(text[i])) continue
      if (previous && rect.top >= previous.rect.bottom - 2) {
        const before = text[previous.index]
        const after = text[i]
        const trimmed = clean(text)
        const reason =
          TOKEN.test(before) && TOKEN.test(after)
            ? '标识符 / 数字被拆开'
            : /\d/.test(before) && UNIT.test(after)
              ? '数字与单位分到两行'
              : trimmed.length <= 12
                ? '短文字换行'
                : el.closest(NO_WRAP_CONTAINER)
                  ? '标签 / 按钮 / 列标题换行'
                  : null
        if (reason) report(el, trimmed, reason)
      }
      previous = { index: i, rect }
    }
  }

  // 2b. 小元素整体：≤24 字的「值 + 单位」「标签 + 值」被拆到两行（跨多个子元素的情况）
  const blockish = (child) => {
    const display = getComputedStyle(child).display
    if (!/^(block|flex|grid|table|list-item|flow-root)/.test(display)) return false
    const parent = child.parentElement && getComputedStyle(child.parentElement)
    // 横排 flex 的子项会被块化，但视觉上还是一行里的片段
    return !(parent && /flex/.test(parent.display) && !/column/.test(parent.flexDirection))
  }
  for (const el of document.querySelectorAll('body *')) {
    if (el.children.length === 0 || el.closest(SKIP) || !visible(el)) continue
    const text = clean(el.textContent ?? '')
    if (text.length < 2 || text.length > 24) continue
    const style = getComputedStyle(el)
    if (/column/.test(style.flexDirection) && /flex/.test(style.display)) continue
    if ([...el.querySelectorAll('*')].some(blockish)) continue
    // 只量文字本身（子元素的边框盒、下划线之类的装饰不算行）
    const rects = []
    const texts = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let node = texts.nextNode(); node; node = texts.nextNode()) {
      if (!node.data.trim()) continue
      range.selectNodeContents(node)
      rects.push(...range.getClientRects())
    }
    if (countLines(rects) >= 2) report(el, text, '短内容分成两行')
  }

  return {
    hints,
    wraps,
    overflow: { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth },
  }
}

const { chromium } = await import(join(REPO, 'e2e/node_modules/playwright-core/index.mjs'))

/** 把页面上的 InfoTip 悬停一遍，收下它们的说明文字（07 §2.7：每页最多 3 个） */
async function collectInfoTips(page) {
  const tips = page.locator('button.info-tip')
  const count = await tips.count()
  const found = []
  for (let index = 0; index < Math.min(count, 5); index += 1) {
    const tip = tips.nth(index)
    try {
      if (!(await tip.isVisible())) continue
      await tip.hover({ timeout: 3_000 })
      await page.waitForTimeout(260)
      const text = await page.evaluate(() => {
        const body = [...document.querySelectorAll('.info-tip__body')].at(-1)
        return body ? (body.textContent ?? '').replace(/\s+/g, ' ').trim() : ''
      })
      const label = await tip.getAttribute('aria-label')
      if (text) found.push(`${label}：${text}`)
    } catch {
      // 悬停失败（元素被遮住等）就跳过，不影响整页结果
    }
  }
  if (found.length) {
    // 收完把指针挪开，并等浮层真的退场，别让说明被算成页面上的常驻小字
    await page.mouse.move(2, 2)
    await page
      .waitForFunction(() => document.querySelectorAll('.info-tip__body').length === 0, { timeout: 2_000 })
      .catch(() => null)
  }
  return found
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-proxy-server',
    '--no-first-run',
    '--disable-gpu',
    '--hide-scrollbars',
    `--remote-debugging-port=${CDP}`,
  ],
})

mkdirSync(OUT, { recursive: true })
const results = []
const pages = PAGES.filter(
  (p) => (SET === 'all' || p.set === SET) && (ONLY.length === 0 || ONLY.includes(p.name)),
)

try {
  for (const entry of pages) {
    for (const width of WIDTHS) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
        proxy: { server: 'direct://', bypass: '*' },
      })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      let result
      let infotips = []
      try {
        await page.goto(`${BASE}${entry.path}`, { waitUntil: 'networkidle', timeout: 30_000 })
        await page.waitForTimeout(400)
        const steps = entry.steps ?? [
          ...(entry.click ? [{ click: entry.click }] : []),
          ...(entry.hover ? [{ hover: entry.hover }] : []),
        ]
        for (const step of steps) {
          if (step.click) {
            await page.locator(step.click).first().click({ timeout: 5_000 })
            await page.waitForTimeout(500)
          }
          if (step.hover) {
            await page.locator(step.hover).first().hover({ timeout: 5_000 })
            await page.waitForTimeout(300)
          }
          if (step.hoverTallest) {
            // 悬停最高的一根柱子（图表峰值），不依赖日期推算
            const index = await page.evaluate((selector) => {
              const columns = [...document.querySelectorAll(selector)]
              let best = 0
              let height = -1
              columns.forEach((column, at) => {
                const bar = column.querySelector('.daily-chart__bar')
                const value = bar ? bar.getBoundingClientRect().height : 0
                if (value > height) {
                  height = value
                  best = at
                }
              })
              return best
            }, step.hoverTallest)
            await page.locator(`${step.hoverTallest} >> nth=${index}`).hover({ timeout: 5_000 })
            await page.waitForTimeout(300)
          }
          if (step.type) {
            await page.locator(step.type.selector).first().fill(step.type.text, { timeout: 5_000 })
            await page.waitForTimeout(200)
          }
          if (step.files) {
            await page
              .locator(step.files.selector)
              .first()
              .setInputFiles(
                {
                  name: step.files.name,
                  mimeType: step.files.mimeType,
                  buffer: Buffer.from(step.files.base64, 'base64'),
                },
                { timeout: 5_000 },
              )
            await page.waitForTimeout(600)
          }
          if (step.wait) await page.waitForTimeout(step.wait)
        }
        infotips = await collectInfoTips(page)
        result = await page.evaluate(auditInPage)
        if (SHOTS) await page.screenshot({ path: join(OUT, `${entry.name}-${width}.png`), fullPage: true })
      } catch (error) {
        result = {
          hints: [],
          wraps: [],
          overflow: null,
          failed: String(error?.message ?? error).split('\n')[0],
        }
      }
      results.push({ page: entry.name, path: entry.path, width, ...result, infotips, errors })
      const overflow = result.overflow && result.overflow.scrollWidth > result.overflow.innerWidth
      console.log(
        `${entry.name.padEnd(22)} ${String(width).padStart(4)}  小字 ${String(result.hints.length).padStart(2)}  InfoTip ${String(infotips.length).padStart(2)}  断行 ${String(result.wraps.length).padStart(2)}${overflow ? '  横向滚动' : ''}${result.failed ? `  失败：${result.failed}` : ''}`,
      )
      await context.close()
    }
  }
} finally {
  await browser.close()
}

writeFileSync(join(OUT, 'audit.json'), `${JSON.stringify(results, null, 2)}\n`)

// ── markdown：总表 + 每页去重后的明细（小字跨宽度去重；断行标上出现的宽度） ──
const lines = [`# 界面走查（${SET}）`, '', `宽度 ${WIDTHS.join(' / ')}；${new Date().toISOString()}`, '']
lines.push('| 页面 | 小字（条） | InfoTip | 断行（宽度:条） | 横向滚动 |', '| --- | --- | --- | --- | --- |')
for (const entry of pages) {
  const rows = results.filter((r) => r.page === entry.name)
  const hintCount = new Set(rows.flatMap((r) => r.hints.map((h) => h.text))).size
  const tipCount = new Set(rows.flatMap((r) => r.infotips)).size
  const wrapCells =
    rows
      .filter((r) => r.wraps.length)
      .map((r) => `${r.width}:${r.wraps.length}`)
      .join(' ') || '0'
  const overflow =
    rows
      .filter((r) => r.overflow && r.overflow.scrollWidth > r.overflow.innerWidth)
      .map((r) => r.width)
      .join(' ') || '—'
  const failed = rows.some((r) => r.failed) ? '（有失败）' : ''
  lines.push(`| ${entry.name}${failed} | ${hintCount} | ${tipCount} | ${wrapCells} | ${overflow} |`)
}
for (const entry of pages) {
  const rows = results.filter((r) => r.page === entry.name)
  const hintMap = new Map()
  for (const row of rows) for (const hint of row.hints) hintMap.set(hint.text, hint)
  const tipSet = new Set(rows.flatMap((r) => r.infotips))
  const wrapMap = new Map()
  for (const row of rows)
    for (const wrap of row.wraps) {
      const key = `${wrap.reason}|${wrap.text}`
      const item = wrapMap.get(key) ?? { ...wrap, widths: [] }
      item.widths.push(row.width)
      wrapMap.set(key, item)
    }
  if (!hintMap.size && !wrapMap.size && !tipSet.size && !rows.some((r) => r.failed || r.errors.length))
    continue
  lines.push(
    '',
    `## ${entry.name}  \`${entry.path}\`${entry.click ? `（点开 \`${entry.click}\`）` : ''}${entry.hover ? `（悬停 \`${entry.hover}\`）` : ''}`,
    '',
  )
  for (const row of rows.filter((r) => r.failed)) lines.push(`- **载入失败（${row.width}）**：${row.failed}`)
  for (const row of rows.filter((r) => r.errors.length))
    lines.push(`- **页面报错（${row.width}）**：${row.errors.join('；')}`)
  if (tipSet.size) {
    lines.push('', 'InfoTip：', '')
    for (const tip of tipSet) lines.push(`- ${tip}`)
  }
  if (hintMap.size) {
    lines.push('', '小字：', '')
    for (const hint of hintMap.values()) lines.push(`- [${hint.kind}] ${hint.text}  \`${hint.where}\``)
  }
  if (wrapMap.size) {
    lines.push('', '断行：', '')
    for (const wrap of wrapMap.values())
      lines.push(`- ${wrap.reason}（${wrap.widths.join('/')}）：「${wrap.text}」  \`${wrap.where}\``)
  }
}
writeFileSync(join(OUT, 'audit.md'), `${lines.join('\n')}\n`)
console.log(`\n报告：${join(OUT, 'audit.md')}`)
