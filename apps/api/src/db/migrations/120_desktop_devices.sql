-- ============================================================================
-- 120_desktop_devices.sql —— WP25a：桌面设备台账（D6 混合实例 §2；桌面域号段 120–139）
--
-- 一张设备 = 一台机器上的一次安装，**不认识硬件**：device_id 是服务端发的 128 bit 随机串
-- （裁决 #1），机器上没有可被采集的指纹（不存 MAC / 序列号 / CPU 型号 / 机器名 / 系统用户名）。
--
-- install_key = sha256('<userId>:<installId>')：同一台机器重装/重登不产生设备垃圾，
-- 而**按用户加盐**使得两台设备上的同一个 installId 无法在库里被关联到同一个人。
--
-- **列集合就是隐私白名单**（D6 §4.3 L1）：本表没有 "raw payload" 列，也没有任何可以装下
-- 会话内容 / 路径 / 文件名的列。除 name / capabilities_json 外，每个 TEXT 列都带枚举 CHECK 或长度约束，
-- 防止有人往表里加一个自由文本列。
--
-- presence（在线 / 离线）**不落库**：由 last_report_at 与 settings.desktop.offlineAfterSec 实时派生，
-- 避免「僵尸在线」与额外的超时扫描任务。
--
-- 列名按裁决 #5：platform / os_major / app_channel / last_report_at。
-- 不要新建 os / channel / last_seen_at（D3 文档里那几行是按口语写的）。
-- ============================================================================

CREATE TABLE desktop_devices (
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
  updated_at        TEXT    NOT NULL CHECK (length(updated_at) <= 32)
);

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


-- 已安装插件清单：每次上报**整表替换**（事务内 DELETE + INSERT），上限 200 行/设备。
-- 做成子表而不是 JSON 的理由：要能回答「哪些设备装着 X 插件 vN」（/admin/plugins 装机数、按插件筛设备）。
CREATE TABLE desktop_device_plugins (
  device_id     TEXT    NOT NULL REFERENCES desktop_devices(device_id) ON DELETE CASCADE,
  package_name  TEXT    NOT NULL CHECK (length(package_name) <= 128),   -- npm 包名；不含依赖 spec
  version       TEXT    NOT NULL CHECK (length(version) <= 32),        -- 安装后的真实版本（不是 ^0.16.0）
  source        TEXT    NOT NULL
                        CHECK (source IN ('hub-core', 'hub-default', 'hub-optional', 'user')),
  -- 一个枚举同时表达「开着 / 被用户关掉 / 装失败 / 已被移除」，比布尔多两个信息位
  state         TEXT    NOT NULL DEFAULT 'enabled'
                        CHECK (state IN ('enabled', 'disabled', 'failed', 'absent')),
  -- 仅 state='failed' 时有值；枚举码，≤32 字符，**不存错误原文**
  error_code    TEXT    CHECK (error_code IS NULL OR length(error_code) <= 32),
  updated_at    TEXT    NOT NULL CHECK (length(updated_at) <= 32),
  PRIMARY KEY (device_id, package_name)
);

CREATE INDEX desktop_device_plugins_pkg ON desktop_device_plugins(package_name, version);
