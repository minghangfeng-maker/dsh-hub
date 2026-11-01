-- 122_desktop_delivery.sql —— WP25b：桌面下发与升级（D3 + 裁决 #13/#14/#16/#17）
--
-- 五块数据，各自对应 D3 的一个交付物：
--   1. desktop_delivery_counter / desktop_deliveries   「下发」= 生成新 revision（发布日志只追加，不修改）
--   2. desktop_plugin_targets / desktop_config_fragments / desktop_uninstall_targets   期望状态（按 全部/角色/用户）
--   3. desktop_channel_policies / desktop_policy_overrides / desktop_update_floor     版本策略与强更地板
--   4. desktop_plugin_artifacts                       插件桌面整包（裁决 #16：只托管允许的包，每插件保留 2 版）
--   5. desktop_releases                               安装包与 feed YAML（裁决 #13：单 feed + 匿名地板）
--
-- 三条约束是**故意的**，不要放宽：
--   * 目标作用域的 role/user_id 组合用 CHECK 锁死，NULL 只出现在它该出现的地方（partial unique index 才不会失效）；
--   * revisions 只有 INSERT（没有 UPDATE 路径），设备的 desiredRevision = 匹配行的 max，纯函数、可解释、可重放；
--   * 配置片段的 `config_json` 只存**已通过白名单校验**的内容 —— 校验在 API 层（zod 判别联合），库里不做第二套语义。

-- ── 1. revision 分配器与发布日志 ──────────────────────────────────────────────

CREATE TABLE desktop_delivery_counter (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  revision   INTEGER NOT NULL CHECK (revision >= 0),
  updated_at TEXT NOT NULL
);
INSERT INTO desktop_delivery_counter (id, revision, updated_at)
VALUES (1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- 一次「下发」= 一行。设备 revision = 作用于它的行的 max（没有行时取 1，见清单 schema 的 minimum）。
CREATE TABLE desktop_deliveries (
  revision    INTEGER PRIMARY KEY,
  scope       TEXT NOT NULL CHECK (scope IN ('all', 'role', 'user')),
  role        TEXT NOT NULL DEFAULT '' CHECK (role IN ('', 'user', 'admin')),
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('plugin', 'config', 'app', 'uninstall', 'mixed')),
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  detail_json TEXT,
  created_at  TEXT NOT NULL,
  CHECK (
    (scope = 'all'  AND role = ''                 AND user_id IS NULL) OR
    (scope = 'role' AND role IN ('user', 'admin') AND user_id IS NULL) OR
    (scope = 'user' AND role = ''                 AND user_id IS NOT NULL)
  )
);
CREATE INDEX desktop_deliveries_device ON desktop_deliveries(scope, role, user_id);

-- ── 2. 期望状态：受管插件 / 配置片段 / 卸载 ──────────────────────────────────

-- 受管插件：level 由插件库 policy 推导（裁决 #17：hidden 不下发，所以这里不会有 hidden 行）
CREATE TABLE desktop_plugin_targets (
  id           INTEGER PRIMARY KEY,
  plugin_id    INTEGER NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  version_id   INTEGER NOT NULL REFERENCES plugin_versions(id) ON DELETE CASCADE,
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  scope        TEXT NOT NULL CHECK (scope IN ('all', 'role', 'user')),
  role         TEXT NOT NULL DEFAULT '' CHECK (role IN ('', 'user', 'admin')),
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  updated_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at   TEXT NOT NULL,
  CHECK (
    (scope = 'all'  AND role = ''                 AND user_id IS NULL) OR
    (scope = 'role' AND role IN ('user', 'admin') AND user_id IS NULL) OR
    (scope = 'user' AND role = ''                 AND user_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX desktop_plugin_targets_all ON desktop_plugin_targets(plugin_id) WHERE scope = 'all';
CREATE UNIQUE INDEX desktop_plugin_targets_role ON desktop_plugin_targets(plugin_id, role) WHERE scope = 'role';
CREATE UNIQUE INDEX desktop_plugin_targets_user ON desktop_plugin_targets(plugin_id, user_id) WHERE scope = 'user';

-- 配置片段：一个目标上同一条目只能有一条（PUT 是「整体替换该目标的集合」）
CREATE TABLE desktop_config_fragments (
  id          INTEGER PRIMARY KEY,
  entry_id    TEXT NOT NULL CHECK (length(entry_id) BETWEEN 1 AND 120),
  mode        TEXT NOT NULL CHECK (mode IN ('enforce', 'default')),
  config_json TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  scope       TEXT NOT NULL CHECK (scope IN ('all', 'role', 'user')),
  role        TEXT NOT NULL DEFAULT '' CHECK (role IN ('', 'user', 'admin')),
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TEXT NOT NULL,
  CHECK (
    (scope = 'all'  AND role = ''                 AND user_id IS NULL) OR
    (scope = 'role' AND role IN ('user', 'admin') AND user_id IS NULL) OR
    (scope = 'user' AND role = ''                 AND user_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX desktop_config_fragments_all ON desktop_config_fragments(entry_id) WHERE scope = 'all';
CREATE UNIQUE INDEX desktop_config_fragments_role ON desktop_config_fragments(entry_id, role) WHERE scope = 'role';
CREATE UNIQUE INDEX desktop_config_fragments_user ON desktop_config_fragments(entry_id, user_id) WHERE scope = 'user';

-- 明确要求卸载的受管包名（与「停止管理、保留现状」区分开，D3 §5.1）
CREATE TABLE desktop_uninstall_targets (
  id           INTEGER PRIMARY KEY,
  package_name TEXT NOT NULL CHECK (length(package_name) BETWEEN 1 AND 214),
  scope        TEXT NOT NULL CHECK (scope IN ('all', 'role', 'user')),
  role         TEXT NOT NULL DEFAULT '' CHECK (role IN ('', 'user', 'admin')),
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  updated_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at   TEXT NOT NULL,
  CHECK (
    (scope = 'all'  AND role = ''                 AND user_id IS NULL) OR
    (scope = 'role' AND role IN ('user', 'admin') AND user_id IS NULL) OR
    (scope = 'user' AND role = ''                 AND user_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX desktop_uninstall_targets_all ON desktop_uninstall_targets(package_name) WHERE scope = 'all';
CREATE UNIQUE INDEX desktop_uninstall_targets_role ON desktop_uninstall_targets(package_name, role) WHERE scope = 'role';
CREATE UNIQUE INDEX desktop_uninstall_targets_user ON desktop_uninstall_targets(package_name, user_id) WHERE scope = 'user';

-- ── 3. 版本策略与强更地板 ────────────────────────────────────────────────────

-- 渠道级策略（nightly|latest，裁决 #17）。rolloutPercent 只作用于 targetVersion：
-- 未命中的设备仍拿 minVersion（安全地板不灰度）。
CREATE TABLE desktop_channel_policies (
  channel          TEXT PRIMARY KEY CHECK (channel IN ('nightly', 'latest')),
  target_version   TEXT CHECK (target_version IS NULL OR (length(target_version) <= 128
                     AND target_version GLOB '[0-9]*.[0-9]*.[0-9]*')),
  min_version      TEXT CHECK (min_version IS NULL OR (length(min_version) <= 128
                     AND min_version GLOB '[0-9]*.[0-9]*.[0-9]*')),
  min_version_hard INTEGER NOT NULL DEFAULT 0 CHECK (min_version_hard IN (0, 1)),
  rollout_percent  INTEGER NOT NULL DEFAULT 100 CHECK (rollout_percent BETWEEN 0 AND 100),
  updated_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at       TEXT NOT NULL
);
INSERT INTO desktop_channel_policies (channel, target_version, min_version, min_version_hard, rollout_percent, updated_by, updated_at)
VALUES ('nightly', NULL, NULL, 0, 100, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
       ('latest',  NULL, NULL, 0, 100, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- 按角色/用户的覆盖（NULL 字段 = 沿用渠道级取值）
CREATE TABLE desktop_policy_overrides (
  id               INTEGER PRIMARY KEY,
  channel          TEXT NOT NULL CHECK (channel IN ('nightly', 'latest')),
  scope            TEXT NOT NULL CHECK (scope IN ('role', 'user')),
  role             TEXT NOT NULL DEFAULT '' CHECK (role IN ('', 'user', 'admin')),
  user_id          INTEGER REFERENCES users(id) ON DELETE CASCADE,
  target_version   TEXT CHECK (target_version IS NULL OR (length(target_version) <= 128
                     AND target_version GLOB '[0-9]*.[0-9]*.[0-9]*')),
  min_version      TEXT CHECK (min_version IS NULL OR (length(min_version) <= 128
                     AND min_version GLOB '[0-9]*.[0-9]*.[0-9]*')),
  min_version_hard INTEGER CHECK (min_version_hard IS NULL OR min_version_hard IN (0, 1)),
  rollout_percent  INTEGER CHECK (rollout_percent IS NULL OR rollout_percent BETWEEN 0 AND 100),
  updated_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at       TEXT NOT NULL,
  CHECK (
    (scope = 'role' AND role IN ('user', 'admin') AND user_id IS NULL) OR
    (scope = 'user' AND role = ''                 AND user_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX desktop_policy_overrides_role ON desktop_policy_overrides(channel, role) WHERE scope = 'role';
CREATE UNIQUE INDEX desktop_policy_overrides_user ON desktop_policy_overrides(channel, user_id) WHERE scope = 'user';

-- 匿名强更地板（D3 §1.4）：全局一个版本下限 + 两句纯文本文案 + 可选 https 链接
CREATE TABLE desktop_update_floor (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  min_version TEXT CHECK (min_version IS NULL OR (length(min_version) <= 128
                AND min_version GLOB '[0-9]*.[0-9]*.[0-9]*')),
  title       TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 256),
  detail      TEXT NOT NULL DEFAULT '' CHECK (length(detail) <= 16384),
  app_link    TEXT CHECK (app_link IS NULL OR (length(app_link) <= 2048 AND app_link LIKE 'https://%')),
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TEXT NOT NULL
);
INSERT INTO desktop_update_floor (id, min_version, title, detail, app_link, updated_by, updated_at)
VALUES (1, NULL,
        '需要更新 DSH Hub 桌面端',
        '当前版本已停止支持，请下载并安装新版本后继续使用。',
        NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- ── 4. 插件桌面整包（裁决 #16）──────────────────────────────────────────────

-- 每个插件版本最多一份 Hub 托管的 tgz（路径 = <HUB_DATA_DIR>/desktop-plugin-store/<file_name>）。
-- 「每插件只保留最近 2 版」由服务层在上传后执行（删行 + 删文件），这里只保证一版一份。
CREATE TABLE desktop_plugin_artifacts (
  version_id  INTEGER PRIMARY KEY REFERENCES plugin_versions(id) ON DELETE CASCADE,
  plugin_id   INTEGER NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  file_name   TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  bytes       INTEGER NOT NULL CHECK (bytes > 0 AND bytes <= 268435456),
  sha256      TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at TEXT NOT NULL
);
CREATE INDEX desktop_plugin_artifacts_plugin ON desktop_plugin_artifacts(plugin_id, uploaded_at);

-- ── 5. 安装包与 feed（裁决 #13）─────────────────────────────────────────────

-- 一条发布 = 一个 (target, channel, version) 的安装包 + 生成的 feed YAML 原文。
-- status='yanked' 的版本不再被 feed 选中，但产物**永远不删**（差分包与回滚都要它）。
CREATE TABLE desktop_releases (
  id                INTEGER PRIMARY KEY,
  target            TEXT NOT NULL CHECK (target IN ('win-x64', 'mac-x64', 'mac-arm64')),
  channel           TEXT NOT NULL CHECK (channel IN ('nightly', 'latest')),
  version           TEXT NOT NULL CHECK (length(version) <= 128 AND version GLOB '[0-9]*.[0-9]*.[0-9]*'),
  installer_file    TEXT NOT NULL CHECK (length(installer_file) BETWEEN 1 AND 200),
  installer_bytes   INTEGER NOT NULL CHECK (installer_bytes > 0),
  installer_sha512  TEXT NOT NULL,
  blockmap_file     TEXT,
  blockmap_bytes    INTEGER,
  blockmap_sha512   TEXT,
  feed_file         TEXT NOT NULL CHECK (length(feed_file) <= 64),
  yaml              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'yanked')),
  uploaded_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at       TEXT NOT NULL,
  UNIQUE (target, channel, version)
);
CREATE INDEX desktop_releases_feed ON desktop_releases(target, channel, status, uploaded_at DESC);
