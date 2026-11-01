/**
 * 接口 → schema 名对照表（04 的每一个接口）。
 *
 * 这是**给人和测试看的清单**：`test/contract.test.ts` 会核对表里出现的每个 schema 名
 * 都真实存在于本包导出中，从而保证「04 文档里的接口都有契约」。
 * 改了 04 就要同步改这里。
 *
 * 各域把自己的条目导出成 `*_CONTRACT_MAP`（如 `DESKTOP_CONTRACT_MAP`），在 `CONTRACT_MAP` 里展开，
 * 这样「接口与它的 schema 定义」在同一个文件里，评审时不用两头对。
 */
import { DESKTOP_CONTRACT_MAP } from './api/desktop.js'
import { DESKTOP_DELIVERY_CONTRACT_MAP } from './api/desktop-delivery.js'
import { DELIVERY_CONTRACT_MAP } from './api/delivery.js'
import { PLUGIN_CONTRACT_MAP } from './api/plugins.js'
import { MOBILE_CONTRACT_MAP } from './api/mobile.js'
import { MOBILE_APP_CONTRACT_MAP } from './api/mobile-app.js'

export interface ContractEntry {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  path: string
  /** 请求体/查询串 schema 名（无请求体时省略） */
  request?: string
  /** 成功响应 schema 名（204/文件流时省略） */
  response?: string
  note?: string
}

export const CONTRACT_MAP: ContractEntry[] = [
  // ── 04 §1 公共 ──
  { method: 'GET', path: '/api/public/site', response: 'PublicSiteResponseSchema' },
  {
    method: 'GET',
    path: '/api/health',
    response: 'HealthResponseSchema',
    note: '网关上是 HealthLiteResponseSchema',
  },
  { method: 'GET', path: '/ca.crt', note: '文件流，无 schema' },

  // ── 04 §2 认证 ──
  {
    method: 'POST',
    path: '/api/auth/register',
    request: 'RegisterRequestSchema',
    response: 'RegisterResponseSchema',
  },
  {
    method: 'GET',
    path: '/api/auth/check-username',
    request: 'CheckUsernameQuerySchema',
    response: 'CheckUsernameResponseSchema',
  },
  { method: 'POST', path: '/api/auth/login', request: 'LoginRequestSchema', response: 'LoginResponseSchema' },
  { method: 'POST', path: '/api/auth/logout', note: '204' },
  { method: 'GET', path: '/api/auth/me', response: 'AuthMeResponseSchema' },
  { method: 'POST', path: '/api/auth/reauth', request: 'ReauthRequestSchema', note: '204' },

  // ── 04 §3 个人中心 ──
  { method: 'PATCH', path: '/api/me', request: 'UpdateMeRequestSchema', response: 'UpdateMeResponseSchema' },
  { method: 'POST', path: '/api/me/avatar', response: 'UpdateMeResponseSchema', note: 'multipart file' },
  { method: 'DELETE', path: '/api/me/avatar', response: 'UpdateMeResponseSchema' },
  { method: 'GET', path: '/api/avatars/:file', note: '图片流' },
  { method: 'POST', path: '/api/me/password', request: 'ChangePasswordRequestSchema', note: '204' },
  { method: 'GET', path: '/api/me/sessions', response: 'SessionListResponseSchema' },
  { method: 'DELETE', path: '/api/me/sessions/:id', note: '204' },
  {
    method: 'POST',
    path: '/api/me/sessions/revoke-others',
    response: 'RevokeOthersResponseSchema',
  },
  { method: 'GET', path: '/api/me/instance', response: 'MyInstanceResponseSchema' },
  {
    method: 'POST',
    path: '/api/me/instance/start',
    request: 'InstanceStartRequestSchema',
    response: 'InstanceActionResponseSchema',
    note: '202；请求体可省略（13 §4）；积分不足 402 INSUFFICIENT_POINTS',
  },
  { method: 'POST', path: '/api/me/instance/stop', response: 'InstanceActionResponseSchema', note: '202' },
  { method: 'POST', path: '/api/me/instance/restart', response: 'InstanceActionResponseSchema', note: '202' },
  {
    method: 'GET',
    path: '/api/me/instance/events',
    response: 'InstanceStatusEventSchema',
    note: 'SSE status',
  },
  { method: 'GET', path: '/api/me/plugins', response: 'MyPluginsResponseSchema' },
  {
    method: 'POST',
    path: '/api/me/plugins/:pluginId/install',
    response: 'PluginToggleResponseSchema',
    note: '202 {jobId}',
  },
  {
    method: 'POST',
    path: '/api/me/plugins/:pluginId/uninstall',
    response: 'PluginToggleResponseSchema',
    note: '202 {jobId}',
  },
  {
    method: 'GET',
    path: '/api/me/exports/estimate',
    request: 'ExportEstimateQuerySchema',
    response: 'ExportEstimateResponseSchema',
  },
  {
    method: 'POST',
    path: '/api/me/exports',
    request: 'CreateExportRequestSchema',
    response: 'CreateExportResponseSchema',
  },
  { method: 'GET', path: '/api/me/exports', response: 'ExportListResponseSchema' },
  {
    method: 'GET',
    path: '/api/me/exports/:id/events',
    response: 'ExportProgressEventSchema',
    note: 'SSE progress/done/failed',
  },
  { method: 'GET', path: '/api/me/exports/:id/download', note: '文件流，支持 Range' },
  { method: 'DELETE', path: '/api/me/exports/:id', note: '204' },

  // ── 04 §4.1 概览 ──
  { method: 'GET', path: '/api/admin/overview', response: 'AdminOverviewResponseSchema' },

  // ── 04 §4.2 用户 ──
  {
    method: 'GET',
    path: '/api/admin/users',
    request: 'UserListQuerySchema',
    response: 'UserListResponseSchema',
  },
  {
    method: 'POST',
    path: '/api/admin/users',
    request: 'CreateUserRequestSchema',
    response: 'CreateUserResponseSchema',
  },
  { method: 'GET', path: '/api/admin/users/:id', response: 'UserDetailResponseSchema' },
  {
    method: 'PATCH',
    path: '/api/admin/users/:id',
    request: 'UpdateUserRequestSchema',
    response: 'AdminUserResponseSchema',
  },
  { method: 'POST', path: '/api/admin/users/:id/approve', response: 'AdminUserResponseSchema' },
  { method: 'POST', path: '/api/admin/users/:id/reset-password', response: 'ResetPasswordResponseSchema' },
  { method: 'POST', path: '/api/admin/users/:id/revoke-sessions', response: 'RevokeSessionsResponseSchema' },
  { method: 'DELETE', path: '/api/admin/users/:id', request: 'DeleteUserQuerySchema' },
  {
    method: 'GET',
    path: '/api/admin/users/deleted',
    request: 'DeletedUserListQuerySchema',
    response: 'DeletedUserListResponseSchema',
    note: '回收站（仅未彻底删除的；按删除时间倒序）',
  },
  {
    method: 'POST',
    path: '/api/admin/users/:id/restore',
    request: 'RestoreUserRequestSchema',
    response: 'AdminUserResponseSchema',
    note: '需 reauth，7 天内可恢复；原用户名被占用时可指定新用户名',
  },
  {
    method: 'POST',
    path: '/api/admin/users/:id/purge',
    note: '需 reauth，204；彻底删除回收站数据',
  },

  // ── 04 §4.3 实例 ──
  { method: 'GET', path: '/api/admin/instances', response: 'AdminInstanceListResponseSchema' },
  {
    method: 'POST',
    path: '/api/admin/instances/:userId/:action',
    response: 'InstanceActionResponseSchema',
    note: 'action ∈ start / stop / restart / recreate，202',
  },
  {
    method: 'GET',
    path: '/api/admin/instances/:userId/logs',
    request: 'InstanceLogsQuerySchema',
    response: 'InstanceLogsResponseSchema',
  },
  {
    method: 'GET',
    path: '/api/admin/instances/:userId/logs/stream',
    response: 'InstanceLogLineEventSchema',
    note: 'SSE line',
  },

  // ── 04 §4.4 邀请码与设置 ──
  {
    method: 'GET',
    path: '/api/admin/invites',
    request: 'InviteListQuerySchema',
    response: 'InviteListResponseSchema',
  },
  {
    method: 'POST',
    path: '/api/admin/invites',
    request: 'CreateInvitesRequestSchema',
    response: 'CreateInvitesResponseSchema',
  },
  {
    method: 'PATCH',
    path: '/api/admin/invites/:id',
    request: 'UpdateInviteRequestSchema',
    response: 'InviteResponseSchema',
  },
  { method: 'DELETE', path: '/api/admin/invites/:id', note: '204' },
  { method: 'GET', path: '/api/admin/settings', response: 'SettingsResponseSchema' },
  {
    method: 'PATCH',
    path: '/api/admin/settings',
    request: 'UpdateSettingsRequestSchema',
    response: 'SettingsResponseSchema',
  },
  {
    method: 'GET',
    path: '/api/admin/audit',
    request: 'AuditListQuerySchema',
    response: 'AuditListResponseSchema',
  },

  // ── 04 §4.5 插件 ──
  { method: 'GET', path: '/api/admin/plugins', response: 'AdminPluginListResponseSchema' },
  {
    method: 'GET',
    path: '/api/admin/plugins/lookup',
    request: 'PluginLookupQuerySchema',
    response: 'PluginLookupResponseSchema',
  },
  {
    method: 'POST',
    path: '/api/admin/plugins/lookup',
    response: 'PluginLookupResponseSchema',
    note: 'multipart file（上传 .tgz 预读 package.json）',
  },
  {
    method: 'POST',
    path: '/api/admin/plugins',
    request: 'CreatePluginRequestSchema',
    response: 'AdminPluginRowSchema',
  },
  {
    method: 'PATCH',
    path: '/api/admin/plugins/:id',
    request: 'UpdatePluginRequestSchema',
    response: 'AdminPluginRowSchema',
  },
  { method: 'DELETE', path: '/api/admin/plugins/:id', note: '204' },
  {
    method: 'POST',
    path: '/api/admin/plugins/:id/versions',
    request: 'AddPluginVersionRequestSchema',
    response: 'AddPluginVersionResponseSchema',
  },
  { method: 'DELETE', path: '/api/admin/plugins/:id/versions/:versionId', note: '204' },
  { method: 'GET', path: '/api/admin/plugins/:id/users', response: 'PluginUsersResponseSchema' },

  // ── 04 §4.6 DSH 版本 ──
  { method: 'GET', path: '/api/admin/runtimes', response: 'RuntimeListResponseSchema' },
  { method: 'GET', path: '/api/admin/runtimes/available', response: 'AvailableRuntimesResponseSchema' },
  {
    method: 'POST',
    path: '/api/admin/runtimes',
    request: 'CreateRuntimeRequestSchema',
    response: 'CreateRuntimeResponseSchema',
  },
  {
    method: 'PATCH',
    path: '/api/admin/runtimes/:id',
    request: 'UpdateRuntimeRequestSchema',
    response: 'AdminRuntimeRowSchema',
  },
  { method: 'DELETE', path: '/api/admin/runtimes/:id', note: '204' },

  // ── 04 §4.7 模型 ──
  { method: 'GET', path: '/api/admin/models/providers', response: 'ModelProviderListResponseSchema' },
  {
    method: 'POST',
    path: '/api/admin/models/providers',
    request: 'CreateProviderRequestSchema',
    response: 'ProviderResponseSchema',
  },
  {
    method: 'PATCH',
    path: '/api/admin/models/providers/:id',
    request: 'UpdateProviderRequestSchema',
    response: 'ProviderResponseSchema',
  },
  { method: 'DELETE', path: '/api/admin/models/providers/:id', note: '204' },
  { method: 'POST', path: '/api/admin/models/providers/:id/test', response: 'TestProviderResponseSchema' },
  {
    method: 'POST',
    path: '/api/admin/models/discover',
    request: 'DiscoverModelsRequestSchema',
    response: 'DiscoverModelsResponseSchema',
  },
  { method: 'GET', path: '/api/admin/models/catalog', response: 'CatalogResponseSchema' },
  {
    method: 'PUT',
    path: '/api/admin/models/catalog',
    request: 'SaveCatalogRequestSchema',
    response: 'CatalogResponseSchema',
  },
  { method: 'DELETE', path: '/api/admin/models/catalog/:key', note: '204' },
  {
    method: 'POST',
    path: '/api/admin/models/catalog/match',
    request: 'MatchModelsRequestSchema',
    response: 'MatchModelsResponseSchema',
  },
  {
    method: 'PUT',
    path: '/api/admin/models/providers/:id/user-keys/:userId',
    request: 'SetUserProviderKeyRequestSchema',
    note: '204',
  },
  { method: 'DELETE', path: '/api/admin/models/providers/:id/user-keys/:userId', note: '204' },
  { method: 'GET', path: '/api/admin/models/presets', response: 'ModelPresetListResponseSchema' },
  {
    method: 'POST',
    path: '/api/admin/models/presets',
    request: 'CreatePresetRequestSchema',
    response: 'PresetResponseSchema',
  },
  {
    method: 'PATCH',
    path: '/api/admin/models/presets/:id',
    request: 'UpdatePresetRequestSchema',
    response: 'PresetResponseSchema',
  },
  { method: 'DELETE', path: '/api/admin/models/presets/:id', note: '204' },
  {
    method: 'GET',
    path: '/api/admin/models/presets/:id/preview',
    request: 'PresetPreviewQuerySchema',
    response: 'PresetPreviewResponseSchema',
  },

  // ── 04 §4.8 下发任务与任务中心 ──
  {
    method: 'POST',
    path: '/api/admin/rollouts/preview',
    request: 'RolloutPreviewRequestSchema',
    response: 'RolloutPreviewResponseSchema',
  },
  {
    method: 'POST',
    path: '/api/admin/rollouts',
    request: 'RolloutRequestSchema',
    response: 'RolloutCreatedResponseSchema',
  },
  {
    method: 'GET',
    path: '/api/admin/jobs',
    request: 'JobListQuerySchema',
    response: 'JobListResponseSchema',
  },
  { method: 'GET', path: '/api/admin/jobs/:id', response: 'JobDetailResponseSchema' },
  { method: 'GET', path: '/api/admin/jobs/:id/tasks/:taskId/log', response: 'JobTaskLogResponseSchema' },
  { method: 'GET', path: '/api/admin/jobs/:id/events', response: 'JobEventSchema', note: 'SSE job/task/log' },
  {
    method: 'POST',
    path: '/api/admin/jobs/:id/:action',
    note: 'action ∈ pause / resume / cancel / retry-failed（JobActionSchema）',
  },

  // ── 12 §9 模型中转站：用户端 ──
  { method: 'GET', path: '/api/me/relay', response: 'MyRelayResponseSchema' },
  {
    method: 'GET',
    path: '/api/me/relay/usage',
    request: 'RelayUsageStatsQuerySchema',
    response: 'RelayUsageStatsResponseSchema',
  },
  {
    method: 'GET',
    path: '/api/me/relay/logs',
    request: 'RelayUsageLogQuerySchema',
    response: 'RelayUsageLogResponseSchema',
    note: '只看自己；userId/channelId 参数忽略',
  },
  {
    method: 'GET',
    path: '/api/me/relay/ledger',
    request: 'RelayLedgerQuerySchema',
    response: 'RelayLedgerListResponseSchema',
  },
  { method: 'GET', path: '/api/me/relay/keys', response: 'RelayKeyListResponseSchema' },
  {
    method: 'POST',
    path: '/api/me/relay/keys',
    request: 'CreateRelayKeyRequestSchema',
    response: 'RelayKeySecretResponseSchema',
  },
  {
    method: 'PATCH',
    path: '/api/me/relay/keys/:id',
    request: 'UpdateRelayKeyRequestSchema',
    response: 'RelayKeyResponseSchema',
  },
  { method: 'DELETE', path: '/api/me/relay/keys/:id', note: '204；system 密钥不能删（VALIDATION_FAILED）' },
  {
    method: 'POST',
    path: '/api/me/relay/keys/:id/rotate',
    response: 'RelayKeySecretResponseSchema',
    note: '只用于 system 密钥',
  },

  // ── 12 §9 模型中转站：管理端 ──
  { method: 'GET', path: '/api/admin/relay/overview', response: 'RelayOverviewResponseSchema' },
  // WP12：下发到 DSH（12 §7）
  { method: 'GET', path: '/api/admin/relay/dsh', response: 'RelayDshResponseSchema' },
  {
    method: 'PUT',
    path: '/api/admin/relay/dsh',
    request: 'UpdateRelayDshRequestSchema',
    response: 'RelayDshResponseSchema',
  },
  { method: 'GET', path: '/api/admin/relay/settings', response: 'RelaySettingsResponseSchema' },
  {
    method: 'PATCH',
    path: '/api/admin/relay/settings',
    request: 'UpdateRelaySettingsRequestSchema',
    response: 'RelaySettingsResponseSchema',
  },
  { method: 'GET', path: '/api/admin/relay/channels', response: 'RelayChannelListResponseSchema' },
  {
    method: 'POST',
    path: '/api/admin/relay/channels',
    request: 'CreateRelayChannelRequestSchema',
    response: 'RelayChannelResponseSchema',
  },
  {
    method: 'PATCH',
    path: '/api/admin/relay/channels/:id',
    request: 'UpdateRelayChannelRequestSchema',
    response: 'RelayChannelResponseSchema',
  },
  { method: 'DELETE', path: '/api/admin/relay/channels/:id', note: '204；有模型路由引用 → CONFLICT' },
  {
    method: 'POST',
    path: '/api/admin/relay/channels/:id/test',
    response: 'TestRelayChannelResponseSchema',
  },
  {
    method: 'POST',
    path: '/api/admin/relay/channels/:id/discover',
    response: 'DiscoverRelayChannelResponseSchema',
  },
  {
    method: 'POST',
    path: '/api/admin/relay/channels/:id/keys',
    request: 'AddRelayChannelKeysRequestSchema',
    response: 'AddRelayChannelKeysResponseSchema',
  },
  {
    method: 'PATCH',
    path: '/api/admin/relay/channels/:id/keys/:keyId',
    request: 'UpdateRelayChannelKeyRequestSchema',
    response: 'RelayChannelResponseSchema',
  },
  {
    method: 'DELETE',
    path: '/api/admin/relay/channels/:id/keys/:keyId',
    response: 'RelayChannelResponseSchema',
  },
  { method: 'GET', path: '/api/admin/relay/models', response: 'RelayModelListResponseSchema' },
  {
    method: 'POST',
    path: '/api/admin/relay/models',
    request: 'CreateRelayModelRequestSchema',
    response: 'RelayModelResponseSchema',
  },
  {
    method: 'PATCH',
    path: '/api/admin/relay/models/:id',
    request: 'UpdateRelayModelRequestSchema',
    response: 'RelayModelResponseSchema',
  },
  { method: 'DELETE', path: '/api/admin/relay/models/:id', note: '204' },
  {
    method: 'POST',
    path: '/api/admin/relay/models/import',
    request: 'ImportRelayModelsRequestSchema',
    response: 'ImportRelayModelsResponseSchema',
  },
  {
    method: 'GET',
    path: '/api/admin/relay/wallets',
    request: 'RelayWalletListQuerySchema',
    response: 'RelayWalletListResponseSchema',
  },
  { method: 'GET', path: '/api/admin/relay/wallets/:userId', response: 'RelayWalletResponseSchema' },
  {
    method: 'PATCH',
    path: '/api/admin/relay/wallets/:userId',
    request: 'UpdateRelayWalletRequestSchema',
    response: 'RelayWalletResponseSchema',
  },
  {
    method: 'POST',
    path: '/api/admin/relay/wallets/:userId/adjust',
    request: 'AdjustRelayWalletRequestSchema',
    response: 'RelayWalletResponseSchema',
  },
  {
    method: 'GET',
    path: '/api/admin/relay/ledger',
    request: 'RelayLedgerQuerySchema',
    response: 'RelayLedgerListResponseSchema',
  },
  {
    method: 'GET',
    path: '/api/admin/relay/usage',
    request: 'RelayUsageStatsQuerySchema',
    response: 'RelayUsageStatsResponseSchema',
  },
  {
    method: 'GET',
    path: '/api/admin/relay/logs',
    request: 'RelayUsageLogQuerySchema',
    response: 'RelayUsageLogResponseSchema',
  },

  // ── 12 §4 中转站对外接口（OpenAI / Anthropic 兼容；错误体是各自厂商格式，不是 HubError）──
  { method: 'GET', path: '/v1/models', note: '同时满足 OpenAI 与 Anthropic 的列表格式' },
  { method: 'POST', path: '/v1/chat/completions', note: 'openai-completions 透传 + 计费' },
  { method: 'POST', path: '/v1/responses', note: 'openai-responses 透传 + 计费' },
  { method: 'POST', path: '/v1/messages', note: 'anthropic-messages 透传 + 计费' },
  { method: 'POST', path: '/v1/messages/count_tokens', note: '透传，不计费' },

  // ── 13 §6 算力租赁（WP17）──
  { method: 'GET', path: '/api/me/compute', response: 'MyComputeResponseSchema' },
  {
    method: 'PUT',
    path: '/api/me/compute/plan',
    request: 'SelectComputePlanRequestSchema',
    response: 'SelectComputePlanResponseSchema',
    note: '运行中换规格 = 重建 + 新租约；积分不足 402',
  },
  {
    method: 'GET',
    path: '/api/me/compute/leases',
    request: 'ComputeLeaseQuerySchema',
    response: 'ComputeLeaseListResponseSchema',
    note: '只看自己的；忽略 userId',
  },
  { method: 'GET', path: '/api/admin/compute/settings', response: 'ComputeSettingsResponseSchema' },
  {
    method: 'PATCH',
    path: '/api/admin/compute/settings',
    request: 'UpdateComputeSettingsRequestSchema',
    response: 'ComputeSettingsResponseSchema',
    note: '审计 compute.settings.update',
  },
  {
    method: 'GET',
    path: '/api/admin/compute/leases',
    request: 'ComputeLeaseQuerySchema',
    response: 'ComputeLeaseListResponseSchema',
  },

  // ── 14 §3 搜索 / 抓取池（WP18）──
  {
    method: 'POST',
    path: '/v1/tools/search',
    note: 'DeepSeek Search API 格式；sk-dsh- 密钥；免费次数用完按次扣积分',
  },
  { method: 'POST', path: '/v1/tools/fetch', note: 'DeepSeek Fetch API 格式' },
  { method: 'GET', path: '/api/me/tools', response: 'MyToolsResponseSchema' },
  {
    method: 'GET',
    path: '/api/me/tools/usage',
    request: 'ToolUsageQuerySchema',
    response: 'ToolUsageListResponseSchema',
    note: '只看自己；channelName/upstreamCostMicro 为 null',
  },
  { method: 'GET', path: '/api/admin/tools/settings', response: 'ToolSettingsResponseSchema' },
  {
    method: 'PATCH',
    path: '/api/admin/tools/settings',
    request: 'UpdateToolSettingsRequestSchema',
    response: 'ToolSettingsResponseSchema',
  },
  { method: 'GET', path: '/api/admin/tools/overview', response: 'ToolOverviewResponseSchema' },
  { method: 'GET', path: '/api/admin/tools/channels', response: 'ToolChannelListResponseSchema' },
  {
    method: 'POST',
    path: '/api/admin/tools/channels',
    request: 'CreateToolChannelRequestSchema',
    response: 'ToolChannelResponseSchema',
  },
  {
    method: 'PATCH',
    path: '/api/admin/tools/channels/:id',
    request: 'UpdateToolChannelRequestSchema',
    response: 'ToolChannelResponseSchema',
  },
  { method: 'DELETE', path: '/api/admin/tools/channels/:id', note: '204' },
  {
    method: 'POST',
    path: '/api/admin/tools/channels/:id/test',
    response: 'TestToolChannelResponseSchema',
  },
  {
    method: 'POST',
    path: '/api/admin/tools/channels/:id/keys',
    request: 'AddToolChannelKeysRequestSchema',
    response: 'AddToolChannelKeysResponseSchema',
  },
  {
    method: 'PATCH',
    path: '/api/admin/tools/channels/:id/keys/:keyId',
    request: 'UpdateToolChannelKeyRequestSchema',
    response: 'ToolChannelResponseSchema',
  },
  { method: 'DELETE', path: '/api/admin/tools/channels/:id/keys/:keyId', note: '204' },
  {
    method: 'GET',
    path: '/api/admin/tools/usage',
    request: 'ToolUsageQuerySchema',
    response: 'ToolUsageListResponseSchema',
  },

  // ── 19 「积分与用量」改版（WP24）──
  // /api/me/relay/usage 与 /api/admin/relay/usage 的响应加可选 dailyByModel[]（天 × 模型，只给有用量的格子）。无新接口。

  // ── 18 Claude Code 与 Codex 管理（WP23）──
  // 渠道 / 模型沿用 /api/admin/relay/channels、/models：GET 加 ?scope=（RelayScopeQuerySchema，缺省 dsh），新建请求带 scope；
  // /api/admin/relay/usage、/logs 与 /api/me/relay/usage、/logs 加可选 scope 筛选；/api/me/relay 加 agentModes[]。
  {
    method: 'GET',
    path: '/api/admin/agent-modes/:mode',
    response: 'AgentModeStateResponseSchema',
    note: ':mode = claude-code | codex，其它 → 404',
  },
  {
    method: 'PUT',
    path: '/api/admin/agent-modes/:mode',
    request: 'UpdateAgentModeRequestSchema',
    response: 'AgentModeStateResponseSchema',
    note: '审计 agent-mode.update；模型/倍率/显示名即时生效，enabled/targets 要下发',
  },
  {
    method: 'POST',
    path: '/api/admin/agent-modes/:mode/deliver',
    request: 'DeliverAgentModeRequestSchema',
    response: 'JobRefSchema',
    note: '202；需要二次密码；任务类型 rollout.agent-mode；审计 agent-mode.deliver',
  },
  {
    method: 'GET',
    path: '/v1/hub/agent-mode',
    response: 'AgentModeClientConfigSchema',
    note: '插件用；只认 claude-code / codex 作用域的 sk-dsh- 密钥（dsh 密钥 404，未开放 403）',
  },

  // ── 20 桌面端：登录与混合实例（WP25a）──
  // 设备令牌（`dsh_dev_…`，库里只存 sha256）只做控制面：登录态 / 角色与积分 / 设备上报 / 清单拉取；
  // 模型请求一律用每设备一把的 `sk-dsh-…`（裁决 #8）。`/api/desktop/*` 不校验 Origin（裁决 #6）。
  ...DESKTOP_CONTRACT_MAP,

  // ── 20 桌面端：下发与升级（WP25b，D3）──
  // 清单是声明式期望状态（`GET /api/desktop/manifest`，ETag/304，无副作用）；
  // 「下发」只写期望状态 + 生成新 revision，设备下次心跳拿到 desiredRevision 后自己来拉。
  ...DESKTOP_DELIVERY_CONTRACT_MAP,
  // 统一下发（docs/21）：实例与桌面端同一入口、可选「已安装用户」、一次多个插件
  ...DELIVERY_CONTRACT_MAP,
  // 插件库平台化（docs/22 §2.2，WP32a）：`?platform=` / `:id/platforms/:platform`
  ...PLUGIN_CONTRACT_MAP,

  // ── 23 移动端工作区（mobile/M1）：节点列表 + 两条 WS（帧契约在 api/mobile.ts）──
  ...MOBILE_CONTRACT_MAP,
  ...MOBILE_APP_CONTRACT_MAP,
]

/** 渲染成 markdown 表格（进度报告与文档可直接用） */
export function renderContractTable(): string {
  const rows = CONTRACT_MAP.map(
    (e) =>
      `| ${e.method} | \`${e.path}\` | ${e.request ? `\`${e.request}\`` : '—'} | ${
        e.response ? `\`${e.response}\`` : '—'
      } | ${e.note ?? ''} |`,
  )
  return [
    '| 方法 | 路径 | 请求 schema | 响应 schema | 备注 |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n')
}
