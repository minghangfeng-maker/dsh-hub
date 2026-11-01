-- ============================================================================
-- 128_mobile_platform_web.sql —— WP54a：手机平台放开到 'web'（手机网页版）
--
-- 126 迁移把 `mobile_platform` 锁在 ('android','ios')。WP54 之后同一个 App 还有第三种形态：
-- 由 Hub 同源托管的**手机网页版**（`MOBILE_WEB_BASE_PATH='/m/'`，平台报 `web`）。
-- 它走的是同一套登录 / 设备令牌 / 通道，所以必须能落进同一张台账 —— 否则网页版登录会
-- 直接撞 `CHECK` 写库失败（不是「显示不好看」，是登录 500）。
--
-- 为什么只能重建表：`mobile_platform` 的 CHECK 是**列级约束**，SQLite 没有
-- `ALTER TABLE … DROP/ALTER CONSTRAINT`；放宽枚举的唯一合法做法是「建新表 → 搬数据 → 换名」。
-- 这与 126 注释里「不要重建表」不矛盾：126 当时是要加列（纯加法就够，没必要冒险），
-- 现在是必须改约束，风险靠下面几条兜住。
--
-- ⚠ 重建 `desktop_devices` 的三个坑（都实测过，别改顺序）：
--
-- 1. **两张子表必须连同外键一起重建**，不能「先暂存、DROP 父表、再灌回子表」。
--    `desktop_device_tokens` / `desktop_device_plugins` 都是
--    `REFERENCES desktop_devices(device_id) ON DELETE CASCADE`：`DROP TABLE desktop_devices`
--    会做一次隐式 `DELETE FROM`，级联把令牌与插件清单删掉（不报错，表现是「升级后所有人
--    都要重新登录」）。所以这里先把**子表数据暂存**、把**子表整表 DROP**，父表就没有任何
--    被引用的外键了，再 DROP 父表 → 换名 → 按原 DDL 重建子表 → 灌回数据。
--
-- 2. **语句日志要临时文件**：`DROP TABLE` 的 FK 级联、以及多行 `INSERT … SELECT`，在事务内都要
--    **语句级回滚日志**，而语句日志是临时文件。SQLite 依次试 `SQLITE_TMPDIR` / `TMPDIR` /
--    `/var/tmp` / `/usr/tmp` / `/tmp`，只要**第一个存在的目录不可写**（本机 WSL 沙箱就拒写
--    `/var/tmp`），整条语句直接报 `unable to open database file`。注意：
--      * `:memory:` 库用内存日志，所以只有**文件库**（生产就是文件库）才测得到这个坑 ——
--        单测必须有一条走 `mkdtemp` 里的真文件库；
--      * 在事务内写 `PRAGMA temp_store = MEMORY` **不管用**（语句日志已经开好了）；而迁移执行器
--        把每个文件包在 BEGIN/COMMIT 里，迁移自己也来不及在事务前设置。
--        演练生产库副本时用 `SQLITE_TMPDIR=<可写目录> node --import tsx scripts/wp32a-migrate-rehearsal.ts <库>`
--        （脚本 `scripts/wp32a-migrate-rehearsal.ts` 的对账表里有设备/令牌/插件行数）。
--    这是环境问题、不是迁移本身的问题；生产/容器的临时目录可写就没有这一节。
--
-- 3. `PRAGMA foreign_keys` 在事务内是空操作，所以用 `PRAGMA defer_foreign_keys = ON`
--    （事务提交时才检查外键）：暂存 → 删表 → 重建 → 灌回期间，`desktop_device_tokens.replaced_by`
--    这种自引用也才能一次插完再校验。做法与 123_plugin_platforms.sql 一致。
--
-- 本表没有触发器（2026-10-29 查库：sqlite_master 里 type='trigger' 为空）。若将来加了触发器，
-- 重建父表或子表时必须在这里一并重建。
--
-- 迁移后 `mobile_platform` 的取值：NULL（桌面行与老手机行）/ 'android' / 'ios' / 'web'。
-- 子表 DDL 与 120 / 121 / 123 的最终形状**逐字一致**（121 的令牌表 + 123 的 'bundled' 来源），
-- 迁移测试会逐列 / 逐索引 / 逐外键比对，改动那两张表时要同步这里。
-- ============================================================================

PRAGMA defer_foreign_keys = ON;

-- ── 1. 两张 ON DELETE CASCADE 子表：数据先暂存（类型不求人，只求原样） ───────

CREATE TABLE _wp54a_device_tokens_old AS SELECT * FROM desktop_device_tokens;
CREATE TABLE _wp54a_device_plugins_old AS SELECT * FROM desktop_device_plugins;

-- ── 2. 新父表：列、默认值、CHECK、列顺序与 120 + 126 之后的形状一一对应 ─────

CREATE TABLE desktop_devices_new (
  id                INTEGER PRIMARY KEY,

  -- 对外标识（URL / 审计 / 吊销都用它）。服务端生成：'dv_' + randomBytes(16).toString('hex')
  device_id         TEXT    NOT NULL UNIQUE
                            CHECK (device_id LIKE 'dv_%' AND length(device_id) = 35),

  -- 归属。彻底删除用户时 CASCADE（软删只吊销，见 D6 §7.2）
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- sha256('<userId>:<installId>')，原始 installId 不落库；空 = 客户端未提供
  install_key       TEXT    CHECK (install_key IS NULL OR length(install_key) = 64),

  -- 设备名：唯一的自由文本字段，≤64 字，用户可改；默认由客户端按平台生成（不含机器名）
  name              TEXT    NOT NULL DEFAULT '' CHECK (length(name) <= 64),

  -- 系统与版本：只到主版本号，不存 build / 内核 / 补丁号
  -- 'win32'/'darwin'/'linux' = Node 的 process.platform（客户端无映射表，裁决 #2）
  platform          TEXT    CHECK (platform IS NULL OR platform IN ('win32', 'darwin', 'linux')),
  os_major          TEXT    CHECK (os_major IS NULL
                                   OR (length(os_major) <= 8 AND os_major GLOB '[0-9]*')),
  arch              TEXT    CHECK (arch IS NULL OR arch IN ('x64', 'arm64', 'other')),

  app_version       TEXT    CHECK (app_version IS NULL OR length(app_version) <= 32),
  -- 更新通道：与上游统一为 nightly|latest（裁决 #17）
  app_channel       TEXT    CHECK (app_channel IS NULL OR app_channel IN ('nightly', 'latest')),
  runtime_version   TEXT    CHECK (runtime_version IS NULL OR length(runtime_version) <= 32),

  -- 下发应用结果（D3 清单）：revision 是整数，错误只存枚举码，**不存错误原文**
  applied_revision  INTEGER CHECK (applied_revision IS NULL OR applied_revision >= 0),
  applied_at        TEXT    CHECK (applied_at IS NULL OR length(applied_at) <= 32),
  apply_state       TEXT    NOT NULL DEFAULT 'unknown'
                            CHECK (apply_state IN ('unknown', 'applied', 'partial', 'pending', 'failed')),
  apply_error       TEXT    CHECK (apply_error IS NULL OR length(apply_error) <= 32),
  -- 上一次应用失败了几项（0–100）：只计数，不带任何文本
  apply_error_count INTEGER CHECK (apply_error_count IS NULL
                                   OR (apply_error_count >= 0 AND apply_error_count <= 100)),

  -- 唯一允许的 JSON 列：纯布尔/枚举的能力探测，应用层 zod 校验且序列化后 ≤256 字节
  --   {"claudeCode":true,"codex":false,"pwsh":"7"}
  capabilities_json TEXT    CHECK (capabilities_json IS NULL OR length(capabilities_json) <= 256),

  -- 时间：全部服务端时钟（deps.clock），客户端时钟只用于算偏差、不落库
  registered_at     TEXT    CHECK (registered_at IS NULL OR length(registered_at) <= 32),
  first_seen_at     TEXT    NOT NULL CHECK (length(first_seen_at) <= 32),
  last_report_at    TEXT    CHECK (last_report_at IS NULL OR length(last_report_at) <= 32),
  last_auth_at      TEXT    CHECK (last_auth_at IS NULL OR length(last_auth_at) <= 32),

  -- 吊销（不是封禁：同一台机器重新登录会拿到新令牌；封人的手段是停用账号，D6 C12）
  status            TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  revoked_at        TEXT    CHECK (revoked_at IS NULL OR length(revoked_at) <= 32),
  revoked_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  revoke_reason     TEXT    CHECK (revoke_reason IS NULL
                                   OR revoke_reason IN ('user', 'admin', 'user-deleted',
                                                        'user-disabled', 'password-change', 'expired')),

  -- 该设备专属的中转站密钥（D2 R-B / 裁决 #8）：吊销设备时一起吊销
  relay_key_id      INTEGER REFERENCES relay_keys(id) ON DELETE SET NULL,

  created_at        TEXT    NOT NULL CHECK (length(created_at) <= 32),
  updated_at        TEXT    NOT NULL CHECK (length(updated_at) <= 32),

  -- 126：设备种类。App 与桌面共用台账，kind 区分（历史行默认 'desktop'）
  kind              TEXT    NOT NULL DEFAULT 'desktop'
                            CHECK (kind IN ('desktop', 'mobile')),

  -- 126 + WP54a：手机平台。'web' = 手机网页版（Hub 同源托管，没有 APK 更新、没有强更地板）
  mobile_platform   TEXT    CHECK (mobile_platform IS NULL
                                   OR mobile_platform IN ('android', 'ios', 'web'))
);

-- ── 3. 搬数据：列名写全（不写 `SELECT *`，列顺序变了也不会错位） ─────────────

INSERT INTO desktop_devices_new (id, device_id, user_id, install_key, name, platform, os_major, arch,
                                 app_version, app_channel, runtime_version,
                                 applied_revision, applied_at, apply_state, apply_error, apply_error_count,
                                 capabilities_json, registered_at, first_seen_at, last_report_at, last_auth_at,
                                 status, revoked_at, revoked_by, revoke_reason, relay_key_id,
                                 created_at, updated_at, kind, mobile_platform)
SELECT id, device_id, user_id, install_key, name, platform, os_major, arch,
       app_version, app_channel, runtime_version,
       applied_revision, applied_at, apply_state, apply_error, apply_error_count,
       capabilities_json, registered_at, first_seen_at, last_report_at, last_auth_at,
       status, revoked_at, revoked_by, revoke_reason, relay_key_id,
       created_at, updated_at, kind, mobile_platform
  FROM desktop_devices;

-- ── 4. 子表整表 DROP（数据已在第 1 步暂存）→ 父表 DROP（此时没有任何外键指向它） ──

DROP TABLE desktop_device_plugins;
DROP TABLE desktop_device_tokens;
DROP TABLE desktop_devices;

-- 换名放在「删旧」之后：先改名的话子表外键名对不上，defer 掉的违规在 COMMIT 时消不掉
ALTER TABLE desktop_devices_new RENAME TO desktop_devices;

-- ── 5. 父表索引原样重建（120 的 4 个 + 126 的 1 个） ─────────────────────────

-- 同一用户 + 同一安装，只允许一条**有效**记录；吊销后可以再建新行（历史保留）
CREATE UNIQUE INDEX desktop_devices_install_active
  ON desktop_devices(user_id, install_key)
  WHERE status = 'active' AND install_key IS NOT NULL;

-- 用户端「我的设备」、设备数上限计数（只数 active）
CREATE INDEX desktop_devices_user_status ON desktop_devices(user_id, status);

-- 管理端列表默认按「最近在线」倒序 + presence 派生
CREATE INDEX desktop_devices_last_report ON desktop_devices(last_report_at);

-- 管理端按平台 / 客户端版本筛选（灰度、Windows 专属问题排查）
CREATE INDEX desktop_devices_platform ON desktop_devices(platform, app_version);

-- 手机设备按 (用户, 种类, 状态) 计数与列举（登录去重、上限、吊销后重登）
CREATE INDEX desktop_devices_user_kind ON desktop_devices(user_id, kind, status);

-- ── 6. 子表按原 DDL 重建（121 的令牌表 + 123 的插件清单） ───────────────────

CREATE TABLE desktop_device_tokens (
  -- sha256(明文令牌) hex：与 sessions.id 同纪律，比对时再哈希请求里的令牌
  id             TEXT    PRIMARY KEY CHECK (length(id) = 64),

  device_id      TEXT    NOT NULL REFERENCES desktop_devices(device_id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  created_at     TEXT    NOT NULL CHECK (length(created_at) <= 32),
  last_used_at   TEXT    NOT NULL CHECK (length(last_used_at) <= 32),
  -- 绝对到期（created_at + 90 天）；滑动续期改的是 renewed_at，不改这条
  expires_at     TEXT    NOT NULL CHECK (length(expires_at) <= 32),
  renewed_at     TEXT    CHECK (renewed_at IS NULL OR length(renewed_at) <= 32),

  revoked_at     TEXT    CHECK (revoked_at IS NULL OR length(revoked_at) <= 32),
  revoked_reason TEXT    CHECK (revoked_reason IS NULL
                                OR revoked_reason IN ('logout', 'rotated', 'device-revoked',
                                                      'password-change', 'user-disabled',
                                                      'user-deleted', 'expired')),
  -- 轮换链：旧行指向新行（新行先插入，旧行再更新）
  replaced_by    TEXT    REFERENCES desktop_device_tokens(id) ON DELETE SET NULL,

  -- 签发时的请求元信息（排障用；不含任何请求体）
  ip             TEXT    CHECK (ip IS NULL OR length(ip) <= 64),
  user_agent     TEXT    CHECK (user_agent IS NULL OR length(user_agent) <= 512),
  app_version    TEXT    CHECK (app_version IS NULL OR length(app_version) <= 32)
);

CREATE INDEX desktop_device_tokens_device ON desktop_device_tokens(device_id);
CREATE INDEX desktop_device_tokens_user ON desktop_device_tokens(user_id);
-- 清理任务/过期判定：只扫还活着的行
CREATE INDEX desktop_device_tokens_expires ON desktop_device_tokens(expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE desktop_device_plugins (
  device_id     TEXT    NOT NULL REFERENCES desktop_devices(device_id) ON DELETE CASCADE,
  package_name  TEXT    NOT NULL CHECK (length(package_name) <= 128),   -- npm 包名；不含依赖 spec
  version       TEXT    NOT NULL CHECK (length(version) <= 32),        -- 安装后的真实版本（不是 ^0.16.0）
  source        TEXT    NOT NULL
                        CHECK (source IN ('hub-core', 'hub-default', 'hub-optional', 'user', 'bundled')),
  -- 一个枚举同时表达「开着 / 被用户关掉 / 装失败 / 已被移除」，比布尔多两个信息位
  state         TEXT    NOT NULL DEFAULT 'enabled'
                        CHECK (state IN ('enabled', 'disabled', 'failed', 'absent')),
  -- 仅 state='failed' 时有值；枚举码，≤32 字符，**不存错误原文**
  error_code    TEXT    CHECK (error_code IS NULL OR length(error_code) <= 32),
  updated_at    TEXT    NOT NULL CHECK (length(updated_at) <= 32),
  PRIMARY KEY (device_id, package_name)
);

CREATE INDEX desktop_device_plugins_pkg ON desktop_device_plugins(package_name, version);

-- ── 7. 子表数据放回（令牌行一个不丢 = 已经在用的手机不需要重新登录） ─────────

INSERT INTO desktop_device_tokens (id, device_id, user_id, created_at, last_used_at, expires_at, renewed_at,
                                  revoked_at, revoked_reason, replaced_by, ip, user_agent, app_version)
SELECT id, device_id, user_id, created_at, last_used_at, expires_at, renewed_at,
       revoked_at, revoked_reason, replaced_by, ip, user_agent, app_version
  FROM _wp54a_device_tokens_old;

INSERT INTO desktop_device_plugins (device_id, package_name, version, source, state, error_code, updated_at)
SELECT device_id, package_name, version, source, state, error_code, updated_at
  FROM _wp54a_device_plugins_old;

DROP TABLE _wp54a_device_tokens_old;
DROP TABLE _wp54a_device_plugins_old;
