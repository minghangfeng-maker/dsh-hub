-- 041_plugins.sql —— WP3：插件目录 / 版本 / 用户期望状态（03 §1.4）

CREATE TABLE plugins (
  id            INTEGER PRIMARY KEY,
  package_name  TEXT NOT NULL UNIQUE,  -- npm 包名，如 'dsh-email'、'@local/dsh-file-download'
  display_name  TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  icon          TEXT,                  -- 图标（ph 图标名或 data URL）
  homepage      TEXT,
  policy        TEXT NOT NULL DEFAULT 'optional'
                CHECK (policy IN ('required','default','optional','hidden')),
  is_bundle     INTEGER NOT NULL DEFAULT 1, -- 是否加入 dsh.profile.bundles
  bundle_order  INTEGER NOT NULL DEFAULT 100,
  config_yaml   TEXT NOT NULL DEFAULT '', -- 管理员下发的 patch 条目数组，渲染进 managed.patch.yml
  needs_restart INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
-- 用户自助列表按 policy 过滤；bootstrap/reconcile 按 policy 捞
CREATE INDEX plugins_policy ON plugins(policy, bundle_order, id);

CREATE TABLE plugin_versions (
  id           INTEGER PRIMARY KEY,
  plugin_id    INTEGER NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  version      TEXT NOT NULL,
  source_type  TEXT NOT NULL CHECK (source_type IN ('npm','tarball','local','upload')),
  source_ref   TEXT NOT NULL,          -- npm: 'dsh-email@0.16.0'；tarball: URL；local: 宿主目录；upload: 原文件名
  spec         TEXT NOT NULL,          -- 写进 package.json 的依赖说明
  store_file   TEXT,                   -- plugin-store/ 下的 tgz（local/upload 才有）
  sha256       TEXT,
  min_dsh      TEXT,                   -- 兼容的最低 DSH 版本（可空）
  created_at   TEXT NOT NULL,
  UNIQUE (plugin_id, version)
);
CREATE INDEX plugin_versions_plugin ON plugin_versions(plugin_id, id);

CREATE TABLE user_plugins (               -- 「期望状态 + 实际状态」
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plugin_id      INTEGER NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  desired        TEXT NOT NULL CHECK (desired IN ('installed','absent')),
  desired_version_id INTEGER REFERENCES plugin_versions(id),
  actual_version_id  INTEGER REFERENCES plugin_versions(id), -- 为空 = 未安装
  state          TEXT NOT NULL CHECK (state IN ('synced','pending','failed')),
  source         TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('admin','user','policy')),
  error          TEXT,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, plugin_id)
);
-- 管理端「某插件在每个用户上的状态」与 rollout 的目标解析
CREATE INDEX user_plugins_plugin ON user_plugins(plugin_id, state);
CREATE INDEX user_plugins_desired ON user_plugins(user_id, desired, state);
