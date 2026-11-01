# 04 API 接口契约

> 前后端唯一契约。所有请求/响应的 zod schema 放在 `packages/shared/src/api/*.ts`，前端 API 客户端与后端路由共用。
> 本文与 shared 包不一致时，**以本文为准并修 shared 包**；要改契约，先改本文（在 PR 说明里写清楚）。

## 0. 通用约定

| 项 | 规则 |
| --- | --- |
| 前缀 | `/api` |
| 编码 | `application/json; charset=utf-8`；上传用 `multipart/form-data` |
| 鉴权 | cookie `hub_sid`；未登录 → `401 UNAUTHENTICATED`；无权限 → `403 FORBIDDEN` |
| CSRF | 非 GET：JSON 请求体或 `X-Hub-Csrf: 1` 头（上传）；`Origin` 校验，见 02 §5 |
| 时间 | ISO-8601 UTC 字符串 |
| 分页 | 请求 `?page=1&pageSize=20`（pageSize ≤ 100）；响应 `{ items, total, page, pageSize }` |
| 错误 | `{"error":{"code":"USERNAME_TAKEN","message":"用户名已被占用","details":{...}}}`；`message` 是给人看的中文 |
| 校验失败 | `400 VALIDATION_FAILED`，`details.fields = { username: '只能包含小写字母、数字、- 和 _' }` |
| 限流 | `429 RATE_LIMITED`，`details.retryAfterSec` |
| 缓存 | 所有 `/api` 响应 `Cache-Control: no-store` |
| SSE | `text/event-stream`；事件 `event: <name>\ndata: <json>\n\n`；每 20 秒发 `: ping` |

### 0.1 公共类型（shared）

```ts
type Role = 'user' | 'admin'
type UserStatus = 'pending' | 'active' | 'disabled'
type InstanceStatus = 'absent' | 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

interface UserPublic {            // 当前用户看自己
  id: number; slug: string; username: string; displayName: string; bio: string
  avatarUrl: string | null        // '/api/avatars/12-ab12cd34ef56.webp'
  role: Role; status: UserStatus; mustChangePassword: boolean
  createdAt: string; lastLoginAt: string | null
  usernameChangedAt: string | null // 30 天改名限制的提示依据（WP5b 需求）
}
interface UserAdminView extends UserPublic {
  roleLabel: string               // 普通用户的自定义角色名；'' = 「普通用户」，管理员恒为 ''（只给管理端看）
  quota: Quota; quotaIsDefault: boolean
  runtimeId: number | null; modelPresetId: number | null; modelPolicy: 'managed' | 'free'
  instance: InstanceSummary; lastLoginIp: string | null; deletedAt: string | null
}
interface InstanceSummary {
  status: InstanceStatus; runtimeVersion: string | null
  startedAt: string | null; lastActiveAt: string | null
  needsRecreate: boolean          // config_hash 与期望不一致
  error: string | null
  openUrl: string                 // '/dsh/<用户名>/'（WP16；slug 只在内部用于容器名/数据目录）
}
interface InstanceStats { cpuPercent: number; memoryBytes: number; memoryLimitBytes: number; pids: number; diskBytes: number | null; diskLimitBytes: number }
```

### 0.2 错误码表

| code | HTTP | 含义 |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | 未登录或会话过期 |
| `FORBIDDEN` | 403 | 无权限 |
| `REAUTH_REQUIRED` | 403 | 敏感操作需要二次输入密码 |
| `MUST_CHANGE_PASSWORD` | 403 | 必须先改密码（除改密、登出、me 外的接口都返回它） |
| `NOT_FOUND` | 404 | 资源不存在 |
| `VALIDATION_FAILED` | 400 | 参数不合法 |
| `RATE_LIMITED` | 429 | 限流 |
| `INVALID_CREDENTIALS` | 401 | 用户名或密码错误（不区分哪个错） |
| `ACCOUNT_LOCKED` | 423 | 连续失败被临时锁定，`details.retryAfterSec` |
| `ACCOUNT_DISABLED` | 403 | 账号被停用 |
| `ACCOUNT_PENDING` | 403 | 等待管理员审批 |
| `REGISTRATION_CLOSED` | 403 | 注册已关闭 |
| `INVITE_INVALID` | 400 | 邀请码无效/过期/用尽 |
| `USERNAME_TAKEN` | 409 | |
| `USERNAME_RESERVED` | 400 | |
| `USERNAME_CHANGE_TOO_SOON` | 429 | 30 天内只能改一次用户名 |
| `WEAK_PASSWORD` | 400 | `details.reasons: string[]` |
| `WRONG_PASSWORD` | 400 | 改密时当前密码错误 |
| `USER_LIMIT_REACHED` | 403 | 达到 `maxUsers` |
| `CAPACITY_FULL` | 503 | 同时运行实例达上限，`details.running/max` |
| `INSTANCE_BUSY` | 409 | 实例正有任务（下发/重建）在进行 |
| `INSTANCE_START_FAILED` | 500 | `details.logTail` |
| `RUNTIME_NOT_READY` | 409 | 指定 DSH 版本镜像未就绪 |
| `DISK_QUOTA_EXCEEDED` | 403 | 磁盘用量超过配额，拒绝启动实例，`details: {usedBytes, limitBytes}` |
| `GONE` | 410 | 有时效的操作已过期（如 DeepSeek 登录尝试，14 §6.1；桌面登录请求过期也是它 + `details.loginCode='expired'`） |
| `DEVICE_TOKEN_INVALID` | 401 | 桌面设备令牌无效：不存在 / 已吊销 / 已过期 / 设备被吊销 / 用户不可用（20 / WP25a） |
| `DEVICE_LIMIT_REACHED` | 409 | 桌面设备数达到 `settings.desktop.maxDevicesPerUser`，`details.devices` 带已占用的设备 |
| `INSUFFICIENT_POINTS` | 402 | 算力计费开启时积分不足 1 块（13 §3），`details: {balanceMicro, blockPriceMicro}` |
| `EXPORT_LIMIT` | 429 | 导出次数超限 |
| `EXPORT_TOO_LARGE` | 413 | |
| `PAYLOAD_TOO_LARGE` | 413 | |
| `UNSUPPORTED_MEDIA` | 415 | |
| `CONFLICT` | 409 | 通用冲突（如重复名称） |
| `UPSTREAM_ERROR` | 502 | npm/镜像仓库/模型端点等外部失败 |
| `INTERNAL` | 500 | 未分类错误 |

## 1. 公共

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/public/site` | `{ name, tagline, announcement, announcementLevel, registrationMode, requireApproval, caCertUrl: string \| null }`（`caCertUrl` 恒为 null：2026-10-15 起用 Let's Encrypt 证书，没有根证书要装，00 D20） |
| GET | `/api/health` | `{ ok, version, db, docker }`（仅回环监听器返回细节，网关上只返回 `{ok}`） |
| GET | `/ca.crt` | ~~自签根证书下载~~——2026-10-15 作废（改用 Let's Encrypt 证书，00 D20），返回 404 或移除 |

## 2. 认证 `/api/auth`

| 方法 | 路径 | 请求 | 响应 | 备注 |
| --- | --- | --- | --- | --- |
| POST | `/register` | `{ username, password, displayName?, inviteCode? }` | `201 { user: UserPublic, sessionStarted: boolean }` | `requireApproval` 时 `status=pending`、`sessionStarted=false`；用邀请码注册时用户的 `role_label` = 该码此刻的 `role_label`（快照，之后改码不影响已注册用户；`role` 恒为 `user`） |
| GET | `/check-username?username=` | — | `{ available: boolean, reason?: 'taken'|'reserved'|'invalid' }` | 注册页实时校验，限流 30 次/分钟 |
| POST | `/login` | `{ username, password, remember?: boolean }` | `{ user: UserPublic }` | `remember=false` → 会话 cookie 无 Max-Age |
| POST | `/logout` | — | `204` | |
| GET | `/me` | — | `{ user: UserPublic, instance: InstanceSummary }` | 前端启动时调用 |
| POST | `/reauth` | `{ password }` | `204` | 刷新会话的 `reauth_at` |

## 3. 个人中心 `/api/me`

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| PATCH | `/api/me` | `{ username?, displayName?, bio? }`（bio ≤ 200 字） | `{ user }` |
| POST | `/api/me/avatar` | multipart `file`（png/jpeg/webp，≤ 1MB，前端已裁剪为 512×512） | `{ user }` |
| DELETE | `/api/me/avatar` | — | `{ user }` |
| GET | `/api/avatars/:file` | — | 图片；`Cache-Control: public, max-age=31536000, immutable`（文件名含哈希） |
| POST | `/api/me/password` | `{ currentPassword, newPassword }` | `204`；吊销其他会话 |
| GET | `/api/me/sessions` | — | `{ items: [{ id, current, createdAt, lastSeenAt, ip, userAgent, device: '桌面 Chrome' }] }` |
| DELETE | `/api/me/sessions/:id` | — | `204` |
| POST | `/api/me/sessions/revoke-others` | — | `{ revoked: number }` |

### 3.1 我的 DSH

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/me/instance` | — | `{ instance: InstanceSummary, quota: Quota, stats: InstanceStats | null, modelSummary: { preset: string, defaultModel: string, providers: string[], policy: 'managed' \| 'free' } }` |
| POST | `/api/me/instance/start` | 可选 `{ planId? }`（13 §6） | `202 { instance }`；已在运行直接 `200`；计费开启且积分不足 `402 INSUFFICIENT_POINTS` |
| POST | `/api/me/instance/stop` | — | `202 { instance }` |
| POST | `/api/me/instance/restart` | — | `202 { instance }`；若 `needsRecreate` 则重建 |
| GET | `/api/me/instance/events` | — | SSE：`event: status` `{ instance, phase?: 'pulling'|'creating'|'booting'|'bootstrapping'|'ready', message? }` |

### 3.2 我的插件（用户自助，仅 `policy=optional` 且配额允许）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/me/plugins` | `{ items: [{ plugin: PluginCard, installed: boolean, version: string|null, state, canToggle: boolean }] }` |
| POST | `/api/me/plugins/:pluginId/install` | 创建单用户任务，`202 { jobId }` |
| POST | `/api/me/plugins/:pluginId/uninstall` | 同上 |

### 3.3 数据导出

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/me/exports/estimate` | `?parts=workspace,sessions` | `{ parts: { workspace: { bytes, files }, … }, totalBytes }`（du 估算，缓存 60s） |
| POST | `/api/me/exports` | `{ parts: ('workspace'|'sessions'|'settings'|'profile-plugins')[], format: 'zip'|'tar.gz' }` | `202 { export: ExportItem }` |
| GET | `/api/me/exports` | — | `{ items: ExportItem[] }`（最近 20 条） |
| GET | `/api/me/exports/:id/events` | — | SSE：`progress { bytesWritten, filesDone, filesTotal }`、`done { export }`、`failed { error }` |
| GET | `/api/me/exports/:id/download` | — | 文件流；`Content-Disposition: attachment; filename*=UTF-8''…`；支持 `Range` |
| DELETE | `/api/me/exports/:id` | — | `204` |

`parts` 含义：`workspace` = `/workspace` 全部；`sessions` = `.dsh/sessions` + `.dsh/attachments`；
`settings` = profile 的 `cordis.patch.yml` + `package.json` + `.dsh/storages`（**不含** `.credentials.yaml`、`.env`）；
`profile-plugins` = 用户自装插件清单（`package.json` 依赖列表，便于在别处复原）。

### 3.4 我的桌面设备（网页会话；20 / WP25a–WP25e，§11 有完整口径）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/me/desktop-devices` | `{ items: DesktopDevice[], limit: { max, used } }`；**含已吊销的**（带 `revokedAt`），`used` 只数 active |
| PATCH | `/api/me/desktop-devices/:deviceId` | `{ name }`（`DeviceNameSchema`：≤64 字、禁控制字符与路径分隔符）→ `{ device }`；写审计 `desktop.rename`；**别人的设备 404 而不是 403**（不给枚举留信号）；同名不写审计 |
| DELETE | `/api/me/desktop-devices/:deviceId` | `204`；吊销设备 = 设备行 + 全部令牌 + 全部设备密钥，写审计 `desktop.revoke` |

## 4. 管理端 `/api/admin`（`role=admin`）

### 4.1 概览

`GET /api/admin/overview` →
```ts
{ users: { total, active, pending, disabled, newToday },
  instances: { running, max, starting, error },
  host: { cpuCount, load1, load5, memTotal, memAvailable, diskTotal, diskFree, dockerOk, dockerVersion },
  jobs: { running, queued, failedLast24h },
  runtime: { defaultVersion, versions: number },
  recent: { registrations: UserAdminView[], audit: AuditItem[] },
  desktop?: { total, online, revoked, stale } }   // WP25e，纯加法（老客户端/前端假数据可以没有）
```

`desktop` 的口径**与设备台账同一实现**（`countDevicesOverview()`，04 §11.4）：
- `online` = `status='active'` 且 `last_report_at >= now - settings.desktop.offlineAfterSec`（默认 180 秒）；
- `revoked` = `status='revoked'`（含改密/停用/删除的级联吊销）；
- `stale` = 还活着但当前不在线（**含从没上报过的**）；
- 三者互补：`total = online + stale + revoked`（有单测与冒烟钉住）。
- 桌面台账读不通时**整个键省略**（不让概览页 500）。

### 4.2 用户

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/users` | `?q=&status=&role=&roleLabel=&instance=running&page=&pageSize=&sort=createdAt:desc` → 分页 `UserAdminView`；`roleLabel` 只匹配该标签的普通用户；**不含已删除用户**（回收站见下一行）。管理端「状态」筛选选「已删除」时前端改调下行接口 |
| GET | `/api/admin/users/role-labels` | 在用的角色标签 → `{ items: [{ label, count }] }`：普通用户（未删除）的标签 ∪ 邀请码上的标签，`count` = 用户人数（只出现在邀请码上的为 0）；按人数倒序、同数按标签名；不含空标签。新建用户/邀请码的候选项 |
| GET | `/api/admin/users/deleted` | `?q=&page=&pageSize=` → 分页 `DeletedUserItem`（**回收站**：`deleted_at` 非空且未彻底删除，按删除时间倒序）。`username` 是**删除时的用户名**（不是现在的墓碑名）；`deletedFromStatus` 删除前状态；`dataInTrash` 数据目录是否还在 `trash/`；`restorableUntil = deletedAt + 7 天`；`daysLeft` 向上取整，`<=0` = 已过期只能彻底删除 |
| POST | `/api/admin/users` | `{ username, password?, displayName?, role?, roleLabel? }`；不给密码则生成临时密码 → `{ user, tempPassword? }`。`roleLabel` ≤ 16 字，仅 `role=user` 生效（管理员存空串）；`'普通用户'` 视为空串，`'管理员'` 是保留名 → `VALIDATION_FAILED`。删除用户的用户名**立即释放**，可立刻用来建新用户（新旧用户完全独立） |
| GET | `/api/admin/users/:id` | `{ user: UserAdminView, plugins: UserPluginRow[], providerKeys: [{ providerId, routeKey, displayName, set: boolean, last4: string \| null }], sessions: number, recentAudit: AuditItem[] }`；`UserPluginRow` 带 `packageName`、`displayName`（WP6 需求，WP3 实现）；已删除用户 → 404 |
| PATCH | `/api/admin/users/:id` | `{ displayName?, role?, roleLabel?, status?, quota?: Partial<Quota> | null, runtimeId?: number|null, modelPresetId?: number|null, modelPolicy? }`；`quota:null` = 恢复默认；升为管理员时自动清空 `roleLabel`，角色或标签变化记 `user.role.change`（detail `{ from, to, fromLabel, toLabel }`） |
| POST | `/api/admin/users/:id/approve` | pending → active |
| POST | `/api/admin/users/:id/reset-password` | **需 reauth** → `{ tempPassword }` |
| POST | `/api/admin/users/:id/revoke-sessions` | `{ revoked }` |
| POST | `/api/admin/users/:id/restore` | **需 reauth**；回收站用户恢复（7 天内）→ `{ user }`。body `{ username? }`：不给用删除时原名；原名已被新用户占用时传新用户名。`trash/` 数据目录搬回 `users/<slug>`；恢复后状态回到 `deletedFromStatus`（存量为空按 active）。超期/已彻底删除 → `CONFLICT` |
| POST | `/api/admin/users/:id/purge` | **需 reauth**，204；彻底删除回收站用户：删除 `trash/` 数据、`purged_at` 置位，不再出现在回收站（用户名删除时已释放） |
| DELETE | `/api/admin/users/:id` | **需 reauth**；`?purge=false`（默认）：停并删容器、数据移入 `trash/`（7 天）、**用户名立即释放**、进回收站；`?purge=true`：立即彻底删除数据，不进回收站。不能删自己 |

### 4.3 实例

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/instances` | `[{ user: {id,slug,username,displayName,avatarUrl}, instance: InstanceSummary, stats: InstanceStats|null, statsAt: string|null, probe: InstanceProbe|null }]`。**WP33 起 stats 不内联**：只读后台采样器的缓存（15 s 一轮、并发 ≤ 4），`statsAt` 是样本时刻；`probe` = 会话探针（`state: busy|watching|unattended|unknown`、`runningSessions`、`openClients`、`lastPromptAt`、`lastBusyAt`、`lastClientAt`、`idleSince`、`stopAt`），停止的实例为 null |
| GET | `/api/admin/instances/stats` | `[{ userId, stats: InstanceStats|null, statsAt: string|null }]`；只读缓存快照，前端每 10 s 轮询填资源列（缺样本时后台补一轮，接口不等 docker stats） |
| POST | `/api/admin/instances/:userId/{start|stop|restart|recreate}` | `202 { instance }` |
| GET | `/api/admin/instances/:userId/logs` | `?tail=300` → `{ text }`（已脱敏） |
| GET | `/api/admin/instances/:userId/logs/stream` | SSE `event: line` |

### 4.4 邀请码与设置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/invites` | 分页；含 `uses: [{userId, username, usedAt}]`、`roleLabel` |
| POST | `/api/admin/invites` | `{ count?: 1-50, maxUses, expiresAt?, note, roleLabel? }` → `{ items }`；`roleLabel` 规则同用户（≤16 字，`'普通用户'` = 空串，`'管理员'` 保留 → `VALIDATION_FAILED`） |
| PATCH | `/api/admin/invites/:id` | `{ disabled?, note?, maxUses?, expiresAt?, roleLabel? }`；改角色只影响之后用此码注册的人 |
| DELETE | `/api/admin/invites/:id` | 仅未使用过的可删 |
| GET | `/api/admin/settings` | 全部 settings 键 |
| PATCH | `/api/admin/settings` | 部分更新（按键整体替换，zod 校验） |
| GET | `/api/admin/audit` | `?actorId=&action=&actionPrefix=&targetType=&targetId=&from=&to=&page=&pageSize=`；`action` 精确匹配一个动作（写成 `desktop.*` 时按前缀，既有行为），`actionPrefix` 是显式前缀（WP25e：`actionPrefix=desktop.` 一次拿到全部桌面动作，`%`/`_` 会被转义）；两者同时给出时都要满足 |

### 4.5 插件

```ts
interface PluginCard { id; packageName; displayName; description; icon; homepage; policy; isBundle; bundleOrder; needsRestart; latestVersion: string|null }
interface PluginVersion { id; version; sourceType; sourceRef; spec; sha256; minDsh; createdAt }
```

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/plugins` | `[{ ...PluginCard, platform, versions: PluginVersion[], stats: { installed, pending, failed }, platforms: { cloud?, desktop? }, desktopStats? }]`；**WP32a** `?platform=cloud\|desktop`（缺省 cloud）只返回该平台库里的插件，policy/版本/统计都按该平台。桌面视图多给 `desktopStats`（`{ devices, users, outdated, bundledDevices }`，与 install-stats 的 desktop 同口径，较旧按桌面最新版本算）；`stats` 仍是实例侧的期望/实际状态 |
| GET | `/api/admin/plugins/lookup` | `?source=npm&name=dsh-email` → npm 元数据（版本列表、描述、是否含 `dsh.bundle`）；`?source=local&path=/path/to/plugin` → 读 package.json |
| POST | `/api/admin/plugins/lookup` | multipart 字段 `file`（.tgz，≤ 50MB）→ 只读包内 package.json，返回与 GET 同形的元数据（包名/描述/版本/是否 bundle），**不入库、不扫密钥**；添加插件抽屉选完文件后调它自动填包名 |
| POST | `/api/admin/plugins` | `{ packageName, displayName, description?, icon?, policy, isBundle, bundleOrder?, configYaml?, needsRestart?, platform? }`（**WP32a** `platform` 缺省 cloud） |
| PATCH | `/api/admin/plugins/:id` | 同上部分字段；`configYaml` 先做 YAML 语法 + 结构校验（必须是 patch 条目数组）。**WP32a** 带 `platform` 时只改该平台的设置（不带 = 云上，行为不变） |
| DELETE | `/api/admin/plugins/:id` | 仍有用户安装时拒绝（`CONFLICT`），需先下发卸载 |
| POST | `/api/admin/plugins/:id/versions` | JSON `{ sourceType:'npm', version }` / `{ sourceType:'tarball', url, version }` / `{ sourceType:'local', path }`；或 multipart 上传 `.tgz`（`sourceType=upload`）→ `201 { version }`（local/upload 会打包/校验并入仓库）。**WP32a** `?platform=desktop`（multipart 只认查询串）：上传整包 = **创建桌面版本**并登记桌面整包，传完即可下发；JSON 三种来源只收云上 |
| DELETE | `/api/admin/plugins/:id/versions/:versionId` | 无用户使用时可删 |
| GET | `/api/admin/plugins/:id/users` | 每个用户的安装状态 |
| GET | `/api/admin/plugins/install-stats` | **WP28a** 每个插件在实例与桌面端的安装人数（`{ items: [{ pluginId, instance: { users, outdated }, desktop: { devices, users, outdated, bundledDevices }, latestVersion, desktopLatestVersion }] }`；`instance.outdated` 按**云上**最新版本、`desktop.outdated` 按**桌面**最新版本，两平台版本独立）；一条 SQL（不 N+1），插件库为空时 `items=[]`。**WP32a** 桌面侧多给 `bundledDevices`（上报 `source=bundled` 的设备数，「内置」徽标）+ `latestVersion` 按云上版本 |
| POST | `/api/admin/plugins/:id/platforms` | **WP32a** `{ platform, policy?, bundleOrder?, configYaml?, needsRestart? }` → `{ plugin }`：把已有插件加入另一个平台的库（重复 → 409） |
| PATCH | `/api/admin/plugins/:id/platforms/:platform` | **WP32a** 只改这个平台的设置 → `{ plugin }` |
| DELETE | `/api/admin/plugins/:id/platforms/:platform` | **WP32a** 204。有该平台的下发目标或已装记录 → 409；`?force=1` 同时撤销桌面目标，需要二次密码（`REAUTH_REQUIRED`） |

### 4.6 DSH 版本（运行时镜像）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/runtimes` | `[{ id, dshVersion, image, status, isDefault, sizeBytes, usersOnIt, createdAt, notes }]` |
| GET | `/api/admin/runtimes/available` | 从 npm 镜像查 `@deepseek-ai/dsh` 可用版本 `{ versions: string[], latest, next }` |
| POST | `/api/admin/runtimes` | `{ dshVersion, notes? }` → 创建 `runtime.build` 任务 → `202 { runtime, jobId }` |
| PATCH | `/api/admin/runtimes/:id` | `{ isDefault?: true, notes?, status?: 'retired' }` |
| DELETE | `/api/admin/runtimes/:id` | 无用户使用且非默认时删除镜像 |

### 4.7 模型

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/models/providers` | 列表；`apiKey` 只给 `{ set: boolean, last4 }` |
| POST | `/api/admin/models/providers` | `{ routeKey, displayName, kind, api?, baseUrl?, models, compat?, extra?, keyMode, apiKey? }`；**改密钥需 reauth** |
| PATCH | `/api/admin/models/providers/:id` | 部分更新 |
| DELETE | `/api/admin/models/providers/:id` | 被预设引用时拒绝 |
| POST | `/api/admin/models/providers/:id/test` | 用存储的密钥请求 `GET {baseUrl}/models`（或 anthropic 对应接口）→ `{ ok, latencyMs, models?: string[], error? }` |
| POST | `/api/admin/models/discover` | `{ api, baseUrl, apiKey }` → `{ models: [{id,name,contextWindow?,maxTokens?,input?,reasoningEfforts?,infoSource?,matchedId?}] }`（不落库）。参数优先级：端点列表自己报的 > 自定义模型库 > 内置模型库；`infoSource` = `upstream｜custom｜builtin`，缺省表示没匹配上需要手填 |
| GET | `/api/admin/models/catalog` | 模型信息库：`{ custom: [{key,id,name?,contextWindow?,maxTokens?,input?,reasoningEfforts?,updatedAt}], builtin: { count, source } }`（内置库只给概况，不下发全表） |
| PUT | `/api/admin/models/catalog` | `{ entries: [{id,name?,contextWindow?,maxTokens?,input?,reasoningEfforts?}] }`（1–100 条）批量新增 / 覆盖自定义条目，键 = 规范化后的模型名；档位非法、只有 `off`、没填任何信息 → 400；返回最新的库 |
| DELETE | `/api/admin/models/catalog/:key` | 删一条自定义条目（`key` 是规范化后的匹配键），204 |
| POST | `/api/admin/models/catalog/match` | `{ ids: string[] }`（≤500）→ `{ matches: [{id,source: custom｜builtin,matchedId,name?,contextWindow?,maxTokens?,input?,reasoningEfforts?}] }`，只返回命中的 |
| PUT | `/api/admin/models/providers/:id/user-keys/:userId` | `{ apiKey }`（per-user 模式）；DELETE 同路径删除 |
| GET | `/api/admin/models/presets` | 列表，含 `usersOnIt`。**WP32a** `?platform=cloud\|desktop`（缺省 cloud）：每个平台一套预设 |
| POST | `/api/admin/models/presets` | `{ name, description?, providerIds, defaultProvider, defaultModel, isDefault?, platform? }`（**WP32a** `platform` 缺省 cloud；预设名只在平台内唯一；桌面平台的第一个预设自动成为桌面默认） |
| PATCH | `/api/admin/models/presets/:id` | 部分更新（revision+1） |
| DELETE | `/api/admin/models/presets/:id` | 被用户引用或为默认时拒绝 |
| GET | `/api/admin/models/presets/:id/preview?userId=` | 返回为该用户渲染出的 `managed.patch.yml`（密钥以 env 名出现，不含明文） |

### 4.8 下发任务与任务中心

```ts
type Targets = { all: true } | { userIds: number[] } | { filter: { status?: UserStatus; runtimeId?: number; presetId?: number; pluginId?: number } }
type Strategy = { concurrency: number /*1-8, 默认 3*/; canary: number /*0-5, 默认 1*/; maxFailureRatio: number /*0-1, 默认 0.2*/; restart: 'now' | 'next-start' /*默认 now*/ }
```

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/rollouts/preview` | 同下请求体 → `{ targets: [{userId, username, current, after, willRestart}], total }`（不执行） |
| POST | `/api/admin/rollouts` | **需 reauth**；`{ kind:'plugin', action:'install'|'upgrade'|'uninstall'|'apply-config', pluginId, versionId?, targets, strategy }` / `{ kind:'runtime', runtimeId, targets, strategy }` / `{ kind:'models', presetId?, targets, strategy }`（重渲染 managed 并按需重建）→ `202 { jobId }` |
| GET | `/api/admin/jobs` | `?type=&status=&page=` |
| GET | `/api/admin/jobs/:id` | `{ job, tasks: [{ id, seq, userId, username, status, attempt, startedAt, finishedAt, error }] }` |
| GET | `/api/admin/jobs/:id/tasks/:taskId/log` | `{ text }` |
| GET | `/api/admin/jobs/:id/events` | SSE：`job { job }`、`task { task }`、`log { taskId, chunk }` |
| POST | `/api/admin/jobs/:id/{pause|resume|cancel|retry-failed}` | |

### 4.9 模型中转站（2026-10-16，WP10a）

`/api/me/relay*`、`/api/admin/relay/*` 与对外的 `/v1/*` 见 **12 §4、§9**；schema 在 `packages/shared/src/api/relay.ts`，`contract-map.ts` 已登记。
`/v1/*` 不是 Hub 的 REST 风格：按 OpenAI / Anthropic 格式回错误，鉴权用 `sk-dsh-…` 密钥而不是会话 cookie，不受 §0 的 CSRF/Origin 规则约束。
模型提供方 `kind` 新增 `hub-relay`（12 §7）。审计动作新增 `relay.*`（12 §9）。

**2026-10-16 契约变更（WP11）**：渠道加 `ratePermille`（创建缺省 1000）；路由 DTO 加 `channelRatePermille`；用量记录加 `channelRatePermille`（可空，用户端也返回）；
`import` 的 `price` 改为可选（省略 = 全 0）；`MyRelayModel` 加 `channelRate`（min/max 千分比，可空）；告警新增 `models-unpriced`。
另修一个通用问题：zod 4 的 `.partial()` 会给缺省字段填 `.default()`，`UpdateRelayChannelRequestSchema` 与 `UpdateProviderRequestSchema` 改成显式可选，
**所有 PATCH 只改请求里给出的字段**（`packages/shared/test/partial-defaults.test.ts` 钉住）。

**2026-10-16 契约变更（WP12）**：新增 `GET/PUT /api/admin/relay/dsh`（`RelayDshResponseSchema`、`UpdateRelayDshRequestSchema`）与常量 `RELAY_DSH_API_PREFERENCE`；
审计动作新增 `relay.dsh.update`。用户 DSH 的模型改由系统预设自动维护（12 §7.0），模型下发仍走 `POST /api/admin/rollouts`（kind=models，不带 presetId）。

### 4.10 算力租赁（2026-10-18，WP17）

`/api/me/compute*`、`/api/admin/compute/*` 见 **13 §6**；schema 在 `packages/shared/src/api/compute.ts`，`contract-map.ts` 已登记。
同时的增量：`RelaySettings.dailyBonusMicro`、`RelayLedgerType` 加 `daily`/`expire`/`compute`、`RelayWallet.dailyBonusLeftMicro?`、`AdminInstanceRow.lease?`、错误码 `INSUFFICIENT_POINTS`。
审计动作新增 `compute.settings.update`、`compute.lease.start`、`compute.lease.end`；`instance.stop` 的 reason 新增 `insufficient`。

### 4.11 搜索 / 抓取池与 DeepSeek 登录（2026-10-18，WP18）

`/v1/tools/*`、`/api/me/tools*`、`/api/admin/tools/*` 见 **14 §3**；schema 在 `packages/shared/src/api/tools.ts`，`contract-map.ts` 已登记。
审计动作新增 `tools.settings.update`、`tools.channel.create|update|delete`、`tools.key.add|update|delete|auto-disable`、`deepseek.login`、`deepseek.logout`。

### 4.12 桌面端：设备台账与下发（2026-10-21 ~ 10-22，WP25a–WP25e）

设备侧与公开端点见 **§11**（分组、鉴权与 Origin 免检口径都在那里）。管理端：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/desktop-devices` | `?q=&presence=&revoked=active\|revoked\|all&userId=&platform=&appVersion=&page=&pageSize=` → 分页 `DesktopDeviceAdminItem`（`user` + `device` + `pluginCount`） |
| GET | `/api/admin/desktop-devices/:deviceId` | **WP25e** 详情：`{ user, device, plugins[], pluginCount, audit[] }`；`audit` 是最近 20 条 `targetType='desktop.device'` 的审计，**不含 `actorIp`**；**不含**任何原始上报、令牌、installKey（隐私边界只在白名单内，单测断言「响应里没有 IP」）；设备不存在 404 |
| POST | `/api/admin/desktop-devices/:deviceId/revoke` | 吊销单台（令牌 + 设备密钥）→ `{ device }`，审计 `desktop.admin-revoke` |
| POST | `/api/admin/desktop-devices/revoke` | **WP25e** 批量吊销（**需 reauth**）：`{ deviceIds: string[] }`（1–50，重复项去重）→ `{ items: [{ deviceId, outcome: revoked\|already_revoked\|not_found\|failed, device }], revoked, skipped }`；逐台独立（某台不存在/已吊销/单台出错不影响其余，`revoked + skipped = items.length`），**每台一条审计**（`detail.result` 标出逐台结果） |
| GET | `/api/admin/desktop/delivery` | 期望状态全貌（受管插件 / 配置片段 / 卸载 / 版本策略 / 渲染告警） |
| PUT | `/api/admin/desktop/plugins`、`DELETE` 同路径 | 下发/撤回受管插件 → `{ revision, affectedDevices }` |
| PUT | `/api/admin/desktop/config` | 整体替换某目标的配置片段（白名单外 400） |
| PUT | `/api/admin/desktop/app` | 渠道/角色/用户的版本策略（目标版本、最低版本、灰度百分比） |
| PUT | `/api/admin/desktop/uninstall` | 卸载条目 |
| GET | `/api/admin/desktop/artifacts` | 已上传的插件桌面整包（每插件保留最近 2 版） |
| POST | `/api/admin/desktop/plugins/:pluginId/versions/:versionId/package` | 上传插件整包（multipart `file`）；claude 二进制包一律 400（裁决 #16） |
| GET | `/api/admin/desktop/config/model-preset` | `?userId=`（**WP25e 起可选**）→ `{ userId, fragments: [llm-pi-ai, agent-default-model], warnings }`；不带 `userId` = **系统预设**（默认预设 + 管理员可见性 = hub 路由的全部可下发模型与默认），响应 `userId: null` |
| POST | `/api/admin/desktop/releases` | 上传安装包 + blockmap（multipart `installer`/`blockmap` + 字段 `target`/`channel`/`version`）→ 生成 feed YAML |
| GET | `/api/admin/desktop/releases` | 发布记录（含已撤回的） |
| POST | `/api/admin/desktop/releases/rollback` | 回滚到上一版（yank 新版本，不删产物） |
| GET/PUT | `/api/admin/desktop/update-floor` | 全局强更地板（登录前就生效；不走 `/api/admin/settings`，要写专门的审计） |

审计动作（§7）：`desktop.login`、`desktop.revoke`、`desktop.rename`、`desktop.admin-revoke`、`desktop.agent-mode-key`、
`desktop.deliver`、`desktop.release.publish`、`desktop.release.rollback`、`desktop.update-floor.set`、
`desktop.plugin-package.upload`、`desktop.tokens.cleanup`。

清单版本规则：未下发时返回 revision 1，首次下发从 2 起，后续递增，避免客户端已应用空清单后跳过首次下发。
生效的卸载条目是 all / role / user 的并集，并从插件安装列表中排除同名包；下载鉴权使用同一结果，卸载后旧签名立即失效。
同一作用域重新下发该插件会清除对应卸载条目；其它作用域的卸载条目仍然生效。旧桌面接口和统一下发接口保持一致。

### 4.13 统一下发（2026-10-22，WP28a；docs/21 是语义说明）

一个入口同时面向**实例**（Docker 容器里的 DSH）与**桌面端**（用户电脑上的 DSH Hub 桌面端）。契约在
`packages/shared/src/api/delivery.ts`（`DeliveryRequestSchema`；**不改旧接口**，旧 `rollouts` / `desktop/*` 全部照常可用）。

```ts
type DeliveryRequest = {
  platforms: ('instance'|'desktop')[]            // 1–2 个
  items: ({ kind:'plugin', pluginId, versionId? } | { kind:'models', presetId? } | { kind:'runtime', runtimeId })[]  // 1–20 个
  action: 'install'|'upgrade'|'uninstall'|'apply-config'
  targets: { mode:'all' } | { mode:'users', userIds } | { mode:'role', role } | { mode:'installed', outdatedOnly }
  strategy?: Strategy                            // 只影响实例侧；桌面侧按心跳拉清单
}
```

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/deliveries/preview` | **只读**（不建任务、不写期望状态、不产生 revision）→ `DeliveryPreviewResponse`。行 = 内容项 × 目标：实例按用户；桌面**一台设备一行**（`deviceId`/`deviceName` 仅桌面非空）。`current/after/needsRestart/skipReason`，`summary.instance{willRun,skipped,users}` / `summary.desktop{willRun,skipped,users,devices}`，`warnings[]`，行数上限 **2000**（超出 `truncated=true`，执行仍按完整清单） |
| POST | `/api/admin/deliveries` | **需 reauth** → `202 DeliveryCreatedResponse`：实例侧**每个内容项一个 job**（`{ jobs: [{ jobId, itemLabel }] }`，复用 rollouts 的执行引擎）；桌面侧**整次提交一个事务、一个新 revision**（`{ desktop: { revision, users, devices } \| null }`）；因预检不满足整项跳过 → `skippedItems: [{ itemLabel, platform, reason }]`。两个平台都没有可执行项 → `400 VALIDATION_FAILED` |
| GET | `/api/admin/plugins/install-stats` | 见 §4.5；插件库页的「已安装」列与批量下发的人数提示 |

口径（与 docs/21 §2 一致，实现在 `modules/deliveries/resolve.ts`，**预览与提交共用同一份解析**）：

- `targets.mode`：`all` / `users` / `role` 在实例侧沿用 rollouts 的目标解析（金丝雀排序、已删除排除）；
  桌面侧 = 至少有一台有效（未吊销）设备的用户。`installed` 按内容项各自解析：
  `plugin` = 实例 `user_plugins.desired='installed'` / 桌面设备上报里含该包；`models` = 实例「模型托管且生效预设含启用的 hub-relay 提供方」/ 桌面「已登录的有效设备」。
  `outdatedOnly=true` 只保留版本低于本次下发版本的（semver；解析不出版本的按「较旧」处理并在 `current` 里写明）。
- `skipReason !== null` 的行**提交时也不会执行**（预览说的「会执行」= 真正下发的目标）：待审批 / 停用的用户、
  已吊销的设备（只有显式 `users` 目标才会列出来并标注）、「已是该版本」（实际版本与期望都已是目标）、
  DSH 版本低于插件 `minDsh`、已钉在别的 DSH 版本。
- 桌面侧写入：`plugin` → 受管插件目标（`uninstall` 写卸载条目）；`models` → **读出该目标现有片段，只替换
  `llm-pi-ai` / `agent-default-model` 两条**（保留其它片段与原有的 `enforce`/`default` 模式；来源 = 系统预设或
  `presetId`）。`installed`/`users` 解析成 `scope=user` 的目标（同目标同插件覆盖）。
- `installed` 的结果在提交那一刻落成明确清单（之后新装的人不会被追加）。后台重复提交相同请求**不去重**
  （与旧接口一致）：每次都会生成新 job / 新 revision。
- 部分失败：桌面侧事务失败 → 整个桌面侧回滚且**不创建** revision，实例侧已建的 job 保留，
  错误 `message` 写明哪边失败、`details.instanceJobs` 给出保留的任务。
- 审计 `delivery.create`：平台、内容项（类型 + id + 版本）、动作、目标模式、解析人数（>50 人只记前 50 + 总数）、
  job 列表与桌面 revision；失败/无可执行项也会落一条（`detail.outcome` = `desktop-failed` / `nothing-to-run`）。
- **实现约束**：`desktop_deliveries.revision` 是主键（一次提交只能一行发布日志）。`users`/`installed` 解析出
  **多人**时发布行的 scope 记 `all`（这样所有被点到的设备都会跳到这个 revision；实际用户清单在 `detail` 里），
  只解析出一个人时精确到 `scope=user`。

## 5. 代理 `/dsh/<用户名>/*`

非 `/api` 前缀，见 05 §5。只接受该用户名本人的会话，或**管理员**的会话（可进任何未删除用户的实例，写审计 `instance.admin.open`）（未登录 302 `/login?next=…`；普通用户越权、用户名不存在、已删除同样 404）；
容器未运行时返回「唤醒页」HTML。`GET /dsh/<用户名>`（无斜杠）301 到带斜杠的地址。
旧的 `/u/<slug>/*` 保留 301 到 `/dsh/<用户名>/…`（未登录 302 登录；登录后校验会话属于该 slug 的主人，否则 404；WS 升级直接 404）。

## 6. 前端路由兜底

除 `/api/*`、`/dsh/*`、`/u/*`、`/ca.crt`、`/assets/*` 外的 GET 请求一律返回 SPA 的 `index.html`（`Cache-Control: no-cache`）；
`/assets/*` 带哈希，`immutable` 一年。`/dsh` 与 `/dsh/` 也永远不被 SPA 兜底吞掉。

## 7. 审计动作（`action` 取值）

`auth.register`、`auth.login.success`、`auth.login.failure`、`auth.logout`、`auth.password.change`、
`user.create`、`user.update`、`user.username.change`、`user.avatar.change`、`user.approve`、`user.disable`、`user.enable`、
`user.role.change`、`user.quota.change`、`user.password.reset`、`user.delete`、`user.restore`、`user.purge`、`user.sessions.revoke`、
`instance.start`、`instance.stop`、`instance.restart`、`instance.recreate`、`instance.error`、`instance.admin.open`（管理员进入别人的实例）、
`invite.create`、`invite.update`、`invite.delete`、`settings.update`、
`plugin.create`、`plugin.update`、`plugin.delete`、`plugin.version.add`、`plugin.version.delete`、
`runtime.build`、`runtime.default`、`runtime.retire`、`runtime.delete`、
`model.provider.create|update|delete|key.change`、`model.preset.create|update|delete`、
`rollout.create`、`job.cancel`、`job.retry`、`export.create`、`export.download`、
`desktop.login`、`desktop.revoke`（用户自助）、`desktop.admin-revoke`（管理端，批量时每台一条 + `detail.batch`）、
`desktop.rename`、`desktop.agent-mode-key`、`desktop.tokens.cleanup`（过期令牌清理的汇总，无操作者）、
`desktop.deliver`、`desktop.plugin-package.upload`、`desktop.release.publish`、`desktop.release.rollback`、
`desktop.update-floor.set`（20 / WP25a–WP25e）、
`delivery.create`（统一下发，21 / WP28a；detail 里带平台/内容项/目标模式/解析人数/任务与 revision）。

## 8. 契约补充（WP0a 实现时定稿，2026-10-12 编排者确认）

| # | 位置 | 定稿 |
| --- | --- | --- |
| 1 | `GET /api/health` | `db: 'ok'\|'error'`；`docker: 'ok'\|'error'\|'disabled'`（`HUB_CONTAINER_DRIVER=fake` 时为 disabled）；网关精简版只返回 `{ok}`（`HealthLiteResponseSchema`） |
| 2 | `POST/PATCH /api/admin/plugins` 响应 | `AdminPluginRowSchema` = PluginCard + `configYaml` + `versions` + `stats` |
| 3 | `GET /api/admin/plugins/lookup` 响应 | `{packageName, displayName, description, homepage, versions[], latest, isBundle, needsRestart}` |
| 4 | `GET /api/admin/models/presets/:id/preview` | `{ userId, content, warnings[] }` |
| 5 | `ExportItem` | 增加 `progress: {bytesWritten, filesDone, filesTotal} \| null` |
| 6 | `UserPublic` | `displayName ≤ 32`、`bio ≤ 200` |
| 7 | `JobSummary` | 增加 `createdByUsername` |
| 8 | settings 各键上限 | site.name ≤ 64、tagline ≤ 120、announcement ≤ 2000、maxUsers ≤ 1000、maxRunning ≤ 200、ttlHours ≤ 720、adminSessionHours ≤ 168 等（以 shared 为准） |
| 9 | `DELETE /api/admin/users/:id?purge` | `false`（默认）= 移入 `trash/` 保留 7 天、**用户名立即释放**（改成 `<原名>#del<id>`，原名存 `deleted_username`）并进回收站；`true` = 立即彻底删除、不进回收站 |
| 9a | `POST /api/admin/users/:id/restore` / `:id/purge`、`GET /api/admin/users/deleted` | 2026-10-20 用户确认新增：回收站 7 天内可恢复、原名被占用时可改名恢复、可彻底删除；过期条目由后台清理任务自动彻底删除 |
| 10 | 非 GET 的空请求体 | 允许；带 `content-type: application/json` 而 body 为空时解析为 `undefined`；无 content-type 且 `Content-Length: 0` 不算有请求体（不要求 JSON） |
| 11 | CSRF 的 `Origin` | 有 `Origin` 时：经 7443 的公网请求必须等于 `HUB_PUBLIC_ORIGIN`；经 7700 的本机请求还可以是任意 `localhost`/`127.0.0.1`/`[::1]` 源。**没有** `Origin` 的请求放行（非浏览器客户端） |
| 12 | `MUST_CHANGE_PASSWORD` 白名单 | 04 §0.2 白名单 + `/api/health`、`/api/public/*` |
| 13 | `ContainerDriver` | 增加可选 `dispose?()` |

机器可读的「接口 → schema」对照表在 `packages/shared/src/contract-map.ts`（有测试保证与导出一致）。
`lib/password.ts`、`lib/session.ts` 留在 `apps/api/src/lib/`（多个模块共用）。

## 9. 契约补充（WP4 定稿，2026-10-12 编排者确认）

| # | 位置 | 定稿 |
| --- | --- | --- |
| 1 | `ExportItem` | 增加 `sha256: string \| null` |
| 2 | `GET /api/me/exports/:id/download` | 200/206 响应都带 `X-Hub-Sha256`（整包哈希）；包内 `manifest.json` 不含整包哈希（自引用），以 `archiveSha256Source: "download-header:X-Hub-Sha256"` 说明 |
| 3 | 下载文件名 | 保持 ASCII `dsh-<username>-<时间>.zip`（RFC 5987 编码能力已具备，暂不改中文名） |
| 4 | `JobHandler` | 增加可选 `maxConcurrent?()`（导出按 `capacity.maxConcurrentExports` 限并发）；每任务参数放 `plan()` 返回的 `payload`，`runTask` 优先读 `task.payload` |
| 5 | `restart: 'next-start'` | 引擎只透传，由 WP3 的执行器落实 |
| 6 | 概览 `jobs.failedLast24h` | 24 小时内 `finished_at` 且状态为 `failed` 或 `partial` 的 job 数，WP1 调 `deps.services.jobs.overviewCounts()` 填充 |

## 10. 契约补充（WP3/WP5b/WP6 反馈，2026-10-13 编排者确认）

| # | 位置 | 定稿 |
| --- | --- | --- |
| 1 | `GET /api/admin/plugins/:id/users` | 返回**全量**未删除用户：`{ items: [{ user: { id, slug, username, displayName, avatarUrl, status }, row: UserPluginRow \| null }] }`（`row=null` 表示从未安装） |
| 2 | `UserPluginRow` | 增加 `packageName`、`displayName` |
| 3 | `GET /api/admin/users/:id` | 增加 `providerKeys: [{ providerId, routeKey, displayName, keyMode, set: boolean, last4: string \| null }]`（列出所有 `key_mode=per-user` 的提供方） |
| 4 | `GET /api/me/instance` 的 `modelSummary` | 增加 `policy: 'managed' \| 'free'` |
| 5 | `kind:'runtime'` 下发 | 目标版本**是默认版本**时把用户的 `runtime_id` 置空（跟随默认）；非默认版本时写入 `runtime_id`（钉住） |
| 6 | `kind:'models'` 下发 | `presetId` 省略 = 不改变用户的预设，只按最新提供方/预设配置重新渲染并按需重启/重建 |
| 7 | 插件上传上限 | 50MB（shared 常量与文档一致） |
| 8 | 创建类接口 | `POST /api/admin/plugins`、`POST .../versions` 返回 201 |
| 9 | `GET /api/admin/overview` | `instances` 用 `instances.counts()`、`host` 用 `instances.hostSnapshot()` 填充（不再是占位） |

## 11. 桌面端（WP25a–WP25e，2026-10-22）

Hub「混合实例」的桌面半边（20 §2/§5）：客户端的登录、会话、设备上报、期望状态下发与升级。
**Hub 不碰用户数据**：设备侧端点只有拉取（pull）与上报，没有远程执行、没有文件/会话读取（02 §5 有安全口径，
03 §1.4e 有表结构，桌面端设计裁决（未随开源版发布） 是最高优先级的裁决）。

### 11.1 四套鉴权与 Origin 免检口径

| 前缀 | 鉴权 | CSRF / Origin | 备注 |
| --- | --- | --- | --- |
| `/api/desktop/auth/start`、`/auth/token` | **免登录** | 同 §0（非 GET 必须 JSON） | `start` 按**真实客户端 IP** 限流 10 次/10 分钟（§11.5） |
| `/api/desktop/*`（其余） | 设备令牌 `Authorization: Bearer dsh_dev_…`；**插件整包下载**另外接受清单里的每设备签名（§11.7） | **不校验 Origin**（裁决 #6：Electron 渲染层带 `Origin: dsh-app://app`），仍必须 JSON | 设备令牌**只做控制面** |
| `/api/me/desktop-devices*` | 网页会话 cookie | 校验（§0 第 11 条） | 用户看/改名/吊销自己的设备 |
| `/api/admin/desktop-devices*`、`/api/admin/desktop/*` | 管理员会话 cookie | 校验 | 台账、批量吊销、下发与升级 |
| `/desktop/feeds/*`、`/desktop/bin/*`、`/api/v0/check_client_update` | **免登录** | 不校验 | electron-updater 匿名取件；只有版本号与哈希 |

**设备令牌能访问的面**（`modules/desktop/policy.ts`，显式写死）：`/api/desktop/*` 全部 **+ 只读** GET
`/api/me/relay`、`/api/me/relay/{usage,logs,ledger,keys}`、`/api/me/desktop-devices`；
其余（含全部 `/api/admin/*` 与**所有写接口**）→ 403 `FORBIDDEN`。
无效 / 过期 / 已吊销 / 设备被吊销 / 用户不可用 → 401 `DEVICE_TOKEN_INVALID`。

### 11.2 登录（PKCE S256 + 回环）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/desktop/auth/start` | `{ codeChallenge(S256 43 位), codeChallengeMethod:'S256', state(20–64), redirectUri(只接受 http://127.0.0.1\\|localhost\\|[::1]:<1-65535>), locale?, device }` → `{ requestId, authorizeUrl:'<hub>/desktop/authorize?req=…', expiresAt }`；pending 只在内存，TTL 10 分钟 |
| GET | `/api/desktop/auth/requests/:id` | 授权页取数（网页会话）：设备名/平台/主版本/架构/客户端版本与通道、当前账号、`deviceCount`/`deviceLimit`、权限清单、`status` |
| POST | `/api/desktop/auth/requests/:id/approve`、`/deny` | 网页会话 + CSRF；允许 → `redirectUri?code=<43 位>&state=…`，拒绝 → `redirectUri?error=access_denied&state=…`；重复处理 409 |
| POST | `/api/desktop/auth/token` | `{ code, codeVerifier }` → `{ token, expiresAt, absoluteExpiresAt, user, wallet, device, relay, hub }`；code 一次性 60 秒、失败 5 次销毁；**同一 `installId` 重新登录复用设备行**（只轮换令牌与设备中转站密钥，不占设备名额，WP25e 交付物 8） |
| POST | `/api/desktop/auth/refresh` | Bearer；续期即轮换（旧令牌立刻 401） |
| POST | `/api/desktop/auth/logout` | Bearer；只吊销当前令牌（设备行与密钥保留） |

登录阶段的机器可读原因在 `details.loginCode`（客户端按它本地化，**不要把中文 message 当协议**）：
`code_invalid` / `pkce_mismatch` / `access_denied` / `expired`（410）/ `device_limit_reached`（409，`details.devices` 带占用列表）/
`account_blocked`（账号被停用/待审批）/ **`password_change_required`**（WP25e：管理员重置过密码，必须先**在网页端**改密；
与 `account_blocked` 分开，两者的下一步完全不同）。

### 11.3 设备与会话（Bearer）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/desktop/session` | `{ user: {username, displayName, role, roleLabel}, wallet, device: {deviceId, name} }`；带 `ETag`，命中 `If-None-Match` 回 304 |
| POST | `/api/desktop/devices/report` | 心跳 + 应用结果（**strictObject 白名单 17 项**，未知字段 → 400；`plugins` 省略 = 保持上次，`[]` = 现在一个都没装）→ `{ serverTime, reportIntervalSec(≤900), presence, desiredRevision }`；比 `settings.desktop.minReportIntervalSec`（≥10 秒）更密 → 429 |
| POST | `/api/desktop/agent-mode-key` | `{ mode:'claude-code'\\|'codex' }` → 该设备自己的 `sk-dsh-…`（裁决 #11）；模式没开通 → 403 |
| GET | `/api/desktop/manifest` | 期望状态清单（插件 + 配置片段 + 版本地板）；`ETag`/304、`Cache-Control: no-store`、**无副作用** |
| GET | `/api/desktop/plugins/:name/:version.tgz` | 插件整包下载；响应头带 `X-Checksum-Sha256` 与字节数。鉴权：Bearer 设备令牌 **或** 清单里渲染的每设备签名 `?d=&sig=`（§11.7） |

**上报的白名单键集合**（`DESKTOP_REPORT_KEYS` / `DESKTOP_REGISTER_KEYS`，并集 17 项）就是隐私边界：
`device` 描述 10 项（schemaVersion / installId / name / platform / osMajor / arch / appVersion / appChannel /
runtimeVersion / capabilities）+ 上报 11 项（其中 4 项共用）。**不接受**自由文本错误、原始日志、路径、会话内容。

### 11.4 设备台账的派生口径（WP25e 交付物 4）

- `presence` **不落库**，每次读时派生：`status='revoked'` → `revoked`；
  `last_report_at >= now - settings.desktop.offlineAfterSec` → `online`；否则 `offline`（从没上报过也是 offline）。
- 概览的 `desktop`（§4.1）：`online` 用同一判定，`stale` = active 且不在线，`total = online + stale + revoked`。
- 改名只改 `desktop_devices.name`（唯一的自由文本列，`DeviceNameSchema` 校验），审计 `desktop.rename` 记 `{from, to}`。

### 11.5 `auth/start` 的限流键（WP25e 交付物 10）

Hub 的**真实客户端 IP** 从 7443 TLS 网关的 **PROXY v1** 头来（公网入口的四层代理添加、隧道原样透传，
`server/listeners.ts` 的 `readProxyV1Header` → `applyProxiedRemoteAddress` 改写 `socket.remoteAddress`）；
`trustProxy: false` 下 `req.ip` 就是它，**任何 `X-Forwarded-*` 都不采信**（02 §5）。
所以限流键现在是：

1. 经 7700 的本机请求且 IP 是回环 → **不计数**（与 `auth` 的 `consumeIpLimit` 同一口径，02 §5「回环豁免只对 7700 生效」）；
2. 公网请求 → 按真实 IP（10 次 / 10 分钟）；
3. 公网请求但 IP 仍是回环（PROXY UNKNOWN 的兜底：隧道出口没带真实地址）→ 退化成 `IP + sha256(installId)` 分桶，
   避免全网共用一个 10 次窗口（没带 `installId` 时仍共用，宁可误伤不放开）。

### 11.6 公开 feed 与强更地板（匿名）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/desktop/feeds/<target>/<channel>.yml` | electron-updater 的 generic 清单（`no-store`），只有版本号与哈希 |
| GET | `/desktop/bin/<target>/<file>` | 安装包 / blockmap（不可变路径 + 一年强缓存） |
| GET | `/api/v0/check_client_update` | 匿名强更地板，逐字照 D3 §1.4（`biz_code 0` / 错误码 `40005`） |

### 11.7 插件整包的签名取件地址（WP31）

**背景**：桌面端（`hub-connector`）取整包是 `fetch(artifact.url, { redirect: 'error' })` —— **不带任何头**，
而下载接口原来只认 Bearer 设备令牌 → 401，**任何桌面插件下发都会失败**。已发出的安装包不能假设能重打，
所以服务端让「不带令牌的下载」也能成功，但不把私有插件包变成匿名公开。

清单里每个插件的 `artifact.url`（其余部分不变）：

```
<origin>/api/desktop/plugins/<包名>/<版本>.tgz?d=<deviceId>&sig=<签名>
```

| 项 | 口径 |
| --- | --- |
| 签名 | `base64url(HMAC-SHA256(签名密钥, "deviceId\|包名\|版本\|整包sha256"))`，43 字符；签名密钥 = `HMAC-SHA256(主密钥, "desktop-artifact-sign:v1")`（运行时派生，不落盘） |
| 稳定性 | **不含过期时间/随机数**：同一台设备 + 同一个整包 → URL 永远一样，清单 ETag 不会抖（否则每次拉取都「变了」，304 永远不命中） |
| 响应头 | 不变：`X-Checksum-Sha256`、`Content-Length`、`Content-Disposition`、`ETag: "sha256-…"`、`Cache-Control: private, no-store` |
| 限流 | 按 `deviceId` 计（60 次/分，与 Bearer 路径共用同一计数器）；放在验签之后，无效请求不消耗别人的配额 |
| 401 条件 | 设备不存在/已吊销、用户已删除/停用、签名不对（改包名/版本/设备 id/sha256 都算）、这个 (包名, 版本) 不在**该设备的当前清单**里（撤回下发即时生效）；统一 `DEVICE_TOKEN_INVALID`，不区分原因 |
| 兼容 | 带 Bearer 的旧客户端照常可用（优先走 Bearer，签名可同时出现）；不带 Bearer 且不带签名 → 401 |
| 边界 | 签名**只**在这个下载端点上被接受：`/api/desktop/manifest`、`/api/desktop/session`、上报、设备密钥等仍只认 Bearer；`/desktop/feeds/*`、`/desktop/bin/*` 本来就是匿名，不动 |

客户端：**原样使用**清单里的 URL 即可，不需要自己算签名、也不要把整个 URL 写进日志（里面有 `sig`）。
分享链接/复制地址这类功能只在管理端与已登录网页里做（`sig` 拿到也没用：它只对那台设备有效）。
签名查询串的两个参数名在共享契约里是常量 `DESKTOP_ARTIFACT_SIGN_DEVICE_PARAM='d'` /
`DESKTOP_ARTIFACT_SIGN_SIGNATURE_PARAM='sig'`（`packages/shared/src/api/desktop-delivery.ts`，WP31 只做加法）。

### 11.8 插件与模型按平台（2026-10-22，WP32a；docs/22 是语义说明）

**口径**：所有带 `platform` 的接口/查询参数**缺省 = `cloud`**，旧调用行为不变。插件库、插件版本、
模型配置（系统预设）按平台各一套；渠道、模型与价格、积分、用量、中转设置仍然共用。

| 接口 | 变化 |
| --- | --- |
| `GET /api/admin/plugins?platform=` | 只返回该平台库里的插件；`policy` / `versions` / `stats` 都按该平台。行里新增 `platform` 与 `platforms.{cloud?,desktop?}`（各平台的 policy/排序/配置片段/是否需要重启） |
| `POST /api/admin/plugins` | 可带 `platform`（缺省 cloud）：把新插件直接建在桌面库 |
| `PATCH /api/admin/plugins/:id` | 可带 `platform`：只改该平台的设置（显示名/描述/图标/isBundle 两平台共用） |
| `POST /api/admin/plugins/:id/platforms` | 把已有插件加入另一个平台的库 |
| `PATCH /api/admin/plugins/:id/platforms/:platform` | 只改该平台的设置 |
| `DELETE /api/admin/plugins/:id/platforms/:platform` | 204；有该平台的下发目标或已装记录 → 409；`?force=1` 同时撤销桌面目标并要二次密码 |
| `POST /api/admin/plugins/:id/versions?platform=` | multipart 上传到 `desktop` = 创建桌面版本并登记整包（传完即可下发）；同名版本号可以在两个平台各有一条 |
| `GET /api/admin/plugins/install-stats` | 桌面侧多给 `bundledDevices`（上报 `source=bundled` 的设备数） |
| `GET/PUT /api/admin/relay/dsh?platform=` | 读写该平台的「下发到 DSH」：勾选集合、默认路由、系统预设都按平台。响应多一个 `platform` 字段 |
| `GET /api/admin/models/presets?platform=` | 只列该平台的预设；`ModelPreset` 多一个 `platform` 字段 |

**桌面清单**：插件行的 `level` 取**桌面平台**的 policy（`required→core`、`default→default`、`optional→optional`、
`hidden` 不下发），云上设为 `required` 不再等于桌面必装。

**统一下发**：`DeliveryItem(kind='plugin')` 的 `versionId` = 云上版本、`desktopVersionId` = 桌面版本，
各自缺省 = 该平台最新；插件不在某平台库里、桌面缺整包、该版本只在另一个平台 → 该平台进 `skippedItems` 并写明原因。
旧请求（只给 `versionId`、两平台都选）：桌面侧取桌面最新，并在预览 `warnings` 里说明。

**桌面模型基线**：迁移 124 在 SQL 里渲染不出片段，改成服务侧幂等补齐 —— 启动时、以及管理员**第一次**保存
桌面「模型配置」时，若 `desktop_config_fragments` 里 `scope=all` 还没有 `llm-pi-ai` / `agent-default-model`，
就用桌面默认预设渲染写入并生成一个新 revision。之后保存配置**不改清单**（和云上一样要统一下发 models）。

**设备上报**：`source` 新增 `bundled`（客户端自带插件，docs/22 §4.2）。

另有三个给联调补的可选加法（第二轮）：

| 接口 | 变化 |
| --- | --- |
| `GET /api/admin/relay/usage`、`GET /api/admin/relay/logs` | 新增可选 `clientKind=docker\|desktop\|external\|unknown`（`relay_usage.client_kind` 的口径）：日志按它过滤；统计在给了它时**回落到明细表**聚合（日汇总表没有这一列），不改变不带它时的结果。桌面视图默认带 `desktop` |
| `POST /api/admin/deliveries/preview` | 响应新增 `skippedItems`（与 `POST /api/admin/deliveries` 同形同口径）：整项被预检跳过时预览就能看到原因 |
| `GET /api/admin/relay/dsh?platform=desktop` | 响应新增 `lastDelivery: { revision, at, by } \| null`：最近一次写入桌面模型片段的清单版本（统一下发 models / 桌面模型基线 / 直接改配置片段）；`by` 是操作者用户名，系统写入为 `null`；云上不给这个键 |

## 12. 管理座舱（WP56，2026-10-29）

### 12.1 座舱 DSH → Hub：`/ops/*`（**只挂内部监听器** 7710，主端口没有这些路由）
鉴权：`Authorization: Bearer <座舱令牌>` **且** 来源 IP == 当前座舱容器 IP；任一不符 → 401 + 审计 `cockpit.ops-denied`。
限流 120 次/分；pending 方案 ≤ 20；每会话画布卡 ≤ 60。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/ops/context` | 版本、各域数量摘要、策略（autoExecuteR1）、今天日期与时区 |
| GET | `/ops/catalog?q=&area=` | 能力目录（id / title / description 关键词匹配） |
| POST | `/ops/call` | `{sessionId, capability, args, title?, rationale?}` 或 `{sessionId, steps[], title, rationale}` → `OpsCallResult` |
| GET | `/ops/proposals/:id?waitSec=0..60` | 长轮询方案状态 |
| POST | `/ops/canvas` | `{sessionId,title,spec,placement?,size?}` → `CanvasItem` |
| PATCH | `/ops/canvas/:id` | 改本会话、`origin='dsh'` 的卡 |
| POST | `/ops/secret-requests` | `{sessionId,purpose,capability,field}` |
| GET | `/ops/secret-requests/:id?waitSec=` | 填好返回 `{status:'filled',secretRef}`（**不返回值**） |

数据量：`data` 序列化后 ≤ 64 KB（超出截断 + `hint`），表格行 ≤ 2000。

### 12.2 管理员浏览器 → Hub：`/api/admin/cockpit/*`（cookie 会话 + `role=admin`；写操作要 `X-Hub-Csrf`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/state` | `OpsStatus` + 待处理方案数 + 能力目录（未运行时会后台拉起座舱） |
| GET | `/events` | SSE：`canvas.upsert/remove`、`proposal.upsert`、`secret.request`、`ops.status`、`strip.update` |
| GET | `/status-strip` | 状态条数字（Hub 数据，不依赖模型） |
| POST | `/ops-instance/start` · `/restart` | 起/重启座舱容器（R1，直接执行） |
| PUT | `/settings` | `{model?, autoExecuteR1?}`（改 `autoExecuteR1` 需 reauth） |
| POST | `/handoff` | 一次性交接码（60 秒、绑定当前管理员） |
| GET | `/board` · `/canvas?sessionId=` | 态势板 / 某会话的画布 |
| PATCH/DELETE | `/canvas/:id` | 钉住、排序、换舷、关闭 |
| POST | `/source` | 用管理员身份跑一次数据源（只允许 `dataSource=true` 的 R0） |
| GET | `/proposals?status=&sessionId=` | 方案列表 |
| POST | `/proposals/:id/approve` · `/reject` | 批准即执行（异步，状态经 SSE 推；R3 要 reauth） |
| POST/DELETE | `/secret-requests/:id` | 填值（204）/ 取消 |

### 12.3 手机通道侧
`POST /api/mobile/auth/cockpit-exchange {code}` → 与手机登录同形的令牌对，额外 `scope:'cockpit'`、`platform:'web'`，
12 小时绝对过期。`scope=cockpit` 的令牌：`/api/mobile/nodes` 只返回 `cloud:ops`；`bootstrap` 只给通道需要的字段；
其余手机接口 403（TTS/ASR 除外）。
**同一个请求同时带 cookie 与 Bearer 时，Bearer 优先**（同源 iframe，见 02 §8.5）。

### 12.4 错误码
`UNAUTHENTICATED`（座舱令牌/IP 不符）、`VALIDATION_FAILED`（能力参数不合法）、`NOT_FOUND`（能力/方案不存在）、
`RATE_LIMITED`（/ops 超过 120 次/分）、`REAUTH_REQUIRED`（R3 批准前要输密码）、`CONFLICT`（方案已过期/已决定）。
