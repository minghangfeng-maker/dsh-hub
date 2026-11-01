-- 124_model_preset_platform.sql —— WP32a：模型配置（系统预设）按平台分开（docs/22 §3）
--
-- 云上与桌面各有一套「模型配置」：可下发模型的勾选、默认模型、默认思考档位互不影响。
-- 渠道 / 模型与价格 / 积分 / 用量 / 中转设置仍然共用（一个中转站、一套计费）。
--
-- 两处改动：
--   1. model_presets 加 platform，唯一键从「全局 name」改成「每平台一个 name」、
--      默认预设唯一性从「全局一个」改成「每平台一个」。name 的唯一性是表内约束，改不了只能重建；
--      model_presets 没有别的表用外键引用它（users.model_preset_id 是逻辑外键），重建是安全的。
--   2. 从当前云上默认预设复制出桌面默认预设（policy/默认模型/提供方一份照抄）。
--
-- 「桌面基线」——用桌面默认预设渲染 llm-pi-ai / agent-default-model 写进 desktop_config_fragments 并生成新 revision
-- ——需要渲染器（要读中转站路由、提供方、密钥引用），SQL 里做不了，改成**服务启动时幂等补齐**
-- （models 服务的 `ensureDesktopModelBaseline`，见 docs/22 §3）。

CREATE TABLE model_presets_new (
  id                 INTEGER PRIMARY KEY,
  platform           TEXT NOT NULL DEFAULT 'cloud' CHECK (platform IN ('cloud', 'desktop')),
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  provider_ids_json  TEXT NOT NULL,
  default_provider   TEXT NOT NULL,
  default_model      TEXT NOT NULL,
  is_default         INTEGER NOT NULL DEFAULT 0,
  revision           INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (platform, name)
);

INSERT INTO model_presets_new (id, platform, name, description, provider_ids_json, default_provider,
                               default_model, is_default, revision, created_at, updated_at)
SELECT id, 'cloud', name, description, provider_ids_json, default_provider,
       default_model, is_default, revision, created_at, updated_at
  FROM model_presets;

DROP TABLE model_presets;
ALTER TABLE model_presets_new RENAME TO model_presets;

-- 每个平台最多一个默认预设
CREATE UNIQUE INDEX model_presets_one_default ON model_presets(platform) WHERE is_default = 1;
CREATE INDEX model_presets_platform ON model_presets(platform, id);

-- 桌面默认预设：从云上默认预设复制（名字带「（桌面）」后缀，两套预设各自可被管理员改名）
INSERT INTO model_presets (platform, name, description, provider_ids_json, default_provider,
                           default_model, is_default, revision, created_at, updated_at)
SELECT 'desktop', 'Hub 中转站（桌面）', description, provider_ids_json, default_provider,
       default_model, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM model_presets
 WHERE platform = 'cloud' AND is_default = 1
   AND NOT EXISTS (SELECT 1 FROM model_presets WHERE platform = 'desktop' AND is_default = 1)
 LIMIT 1;
