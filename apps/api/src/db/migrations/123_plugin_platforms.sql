-- 123_plugin_platforms.sql —— WP32a：插件库按平台分开（docs/22 §2.1）
--
-- 三块改动，都是为了让「云上」与「桌面」两套插件库互不打架：
--   1. plugin_platforms  每个插件在**每个平台**上的设置（policy / 排序 / 配置片段 / 是否需要重启）。
--                        出现某平台的行 ⇔ 该插件在这边的库里；plugins 的旧列保留为**云上行的镜像**
--                        （旧代码读它不出错），写入一律经这张表、由服务层同步镜像列。
--   2. plugin_versions   加 platform 列，唯一键 (plugin_id, platform, version)：同名版本号可以在两平台各有一条
--                        （桌面打过补丁的整包与云上版本号从此不再互相占用）。
--   3. desktop_device_plugins.source 加 'bundled'（客户端自带插件上报，docs/22 §4.2；也用于「内置」徽标统计）。
--
-- 为什么重建 plugin_versions：UNIQUE(plugin_id, version) 是表级约束，SQLite 改不了，只能重建。
-- 它在事务里跑（迁移执行器把所有语句包在 BEGIN/COMMIT 里），而 `PRAGMA foreign_keys` 在事务内是空操作：
-- 这里改用 `PRAGMA defer_foreign_keys = ON`（事务提交时才检查外键），并把 **带 ON DELETE CASCADE 的子表行**
-- 先暂存到临时表：DROP TABLE 会做隐式 DELETE，级联会把 desktop_plugin_targets / desktop_plugin_artifacts 的行删掉。
-- 顺序必须是「新表建好 → 删旧表 → 改名 → 再灌数据」：先灌数据的话，外键在旧名字（plugin_versions_new）下
-- 不会被已经指向 plugin_versions 的子表看到，defer 掉的违规在 COMMIT 时消不掉（实测）。
-- 迁移末尾的 foreign_key_check / integrity_check 由 wp32a-migrate-rehearsal 与单测断言为空。

PRAGMA defer_foreign_keys = ON;

-- ── 1. 平台设置 ─────────────────────────────────────────────────────────────

CREATE TABLE plugin_platforms (
  plugin_id     INTEGER NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL CHECK (platform IN ('cloud', 'desktop')),
  policy        TEXT NOT NULL DEFAULT 'optional'
                CHECK (policy IN ('required', 'default', 'optional', 'hidden')),
  bundle_order  INTEGER NOT NULL DEFAULT 100,
  config_yaml   TEXT NOT NULL DEFAULT '',
  needs_restart INTEGER NOT NULL DEFAULT 1 CHECK (needs_restart IN (0, 1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (plugin_id, platform)
);
-- 桌面清单要按平台的 policy + 排序取行
CREATE INDEX plugin_platforms_platform ON plugin_platforms(platform, policy, bundle_order, plugin_id);

-- 迁移数据：所有现有插件都进云上库（policy 等照抄原来的列）
INSERT INTO plugin_platforms (plugin_id, platform, policy, bundle_order, config_yaml, needs_restart, created_at, updated_at)
SELECT id, 'cloud', policy, bundle_order, config_yaml, needs_restart, created_at, updated_at FROM plugins;

-- ── 2. plugin_versions 平台化（重建表）──────────────────────────────────────

-- 现有的行与两个会被级联删除的子表先暂存（临时表，迁移结束前删掉）
CREATE TABLE _wp32a_versions_old AS SELECT * FROM plugin_versions;
CREATE TABLE _wp32a_targets_old AS SELECT * FROM desktop_plugin_targets;
CREATE TABLE _wp32a_artifacts_old AS SELECT * FROM desktop_plugin_artifacts;

CREATE TABLE plugin_versions_new (
  id          INTEGER PRIMARY KEY,
  plugin_id   INTEGER NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  platform    TEXT NOT NULL DEFAULT 'cloud' CHECK (platform IN ('cloud', 'desktop')),
  version     TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('npm','tarball','local','upload')),
  source_ref  TEXT NOT NULL,
  spec        TEXT NOT NULL,
  store_file  TEXT,
  sha256      TEXT,
  min_dsh     TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (plugin_id, platform, version)
);

DROP TABLE plugin_versions;
ALTER TABLE plugin_versions_new RENAME TO plugin_versions;
CREATE INDEX plugin_versions_plugin ON plugin_versions(plugin_id, platform, id);
-- 桌面侧取「这个插件的最新桌面版本」与整包校验
CREATE INDEX plugin_versions_platform ON plugin_versions(platform, plugin_id, id);

-- 所有现有版本 → 云上（id 一个都不动，user_plugins 的引用继续有效）
INSERT INTO plugin_versions (id, plugin_id, platform, version, source_type, source_ref, spec, store_file, sha256, min_dsh, created_at)
SELECT id, plugin_id, 'cloud', version, source_type, source_ref, spec, store_file, sha256, min_dsh, created_at
  FROM _wp32a_versions_old;

-- ── 3. 有桌面整包的版本 → 复制一条 desktop 行，把整包/目标改指向新行 ────────

INSERT INTO plugin_versions (plugin_id, platform, version, source_type, source_ref, spec, store_file, sha256, min_dsh, created_at)
SELECT v.plugin_id, 'desktop', v.version, v.source_type, v.source_ref, v.spec, v.store_file, v.sha256, v.min_dsh, v.created_at
  FROM _wp32a_artifacts_old a
  JOIN _wp32a_versions_old v ON v.id = a.version_id;

-- DROP TABLE 的隐式 DELETE 把两个子表的行级联删掉了，这里按「同名同插件」的桌面版本 id 灌回去
INSERT INTO desktop_plugin_artifacts (version_id, plugin_id, file_name, bytes, sha256, uploaded_by, uploaded_at)
SELECT nv.id, a.plugin_id, a.file_name, a.bytes, a.sha256, a.uploaded_by, a.uploaded_at
  FROM _wp32a_artifacts_old a
  JOIN _wp32a_versions_old ov ON ov.id = a.version_id
  JOIN plugin_versions nv
         ON nv.platform = 'desktop' AND nv.plugin_id = ov.plugin_id AND nv.version = ov.version;

-- 旧的受管目标（全部指向带整包的版本）改指向桌面版本
INSERT INTO desktop_plugin_targets (id, plugin_id, version_id, enabled, scope, role, user_id, updated_by, updated_at)
SELECT t.id, t.plugin_id, nv.id, t.enabled, t.scope, t.role, t.user_id, t.updated_by, t.updated_at
  FROM _wp32a_targets_old t
  JOIN _wp32a_versions_old ov ON ov.id = t.version_id
  JOIN plugin_versions nv
         ON nv.platform = 'desktop' AND nv.plugin_id = ov.plugin_id AND nv.version = ov.version;

-- 已经有桌面整包的插件 → 建桌面平台行（policy 照抄原 policy；hidden 仍是 hidden，不下发）
INSERT INTO plugin_platforms (plugin_id, platform, policy, bundle_order, config_yaml, needs_restart, created_at, updated_at)
SELECT DISTINCT p.id, 'desktop', p.policy, p.bundle_order, p.config_yaml, p.needs_restart, p.created_at, p.updated_at
  FROM plugins p
  JOIN _wp32a_artifacts_old a ON a.plugin_id = p.id;

-- 没有任何桌面整包的插件**不建桌面行** → 从此不再出现在桌面清单里（修 P1：dsh-mobile 不再推给桌面）

DROP TABLE _wp32a_versions_old;
DROP TABLE _wp32a_targets_old;
DROP TABLE _wp32a_artifacts_old;

-- ── 4. 设备上报的插件来源加 'bundled'（客户端自带，docs/22 §4.2）────────────

CREATE TABLE desktop_device_plugins_new (
  device_id     TEXT    NOT NULL REFERENCES desktop_devices(device_id) ON DELETE CASCADE,
  package_name  TEXT    NOT NULL CHECK (length(package_name) <= 128),
  version       TEXT    NOT NULL CHECK (length(version) <= 32),
  source        TEXT    NOT NULL
                        CHECK (source IN ('hub-core', 'hub-default', 'hub-optional', 'user', 'bundled')),
  state         TEXT    NOT NULL DEFAULT 'enabled'
                        CHECK (state IN ('enabled', 'disabled', 'failed', 'absent')),
  error_code    TEXT    CHECK (error_code IS NULL OR length(error_code) <= 32),
  updated_at    TEXT    NOT NULL CHECK (length(updated_at) <= 32),
  PRIMARY KEY (device_id, package_name)
);

INSERT INTO desktop_device_plugins_new (device_id, package_name, version, source, state, error_code, updated_at)
SELECT device_id, package_name, version, source, state, error_code, updated_at FROM desktop_device_plugins;

DROP TABLE desktop_device_plugins;
ALTER TABLE desktop_device_plugins_new RENAME TO desktop_device_plugins;
CREATE INDEX desktop_device_plugins_pkg ON desktop_device_plugins(package_name, version);
