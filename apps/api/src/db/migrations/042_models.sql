-- 042_models.sql —— WP3：模型提供方 / per-user 密钥 / 预设（03 §1.4）

CREATE TABLE model_providers (
  id             INTEGER PRIMARY KEY,
  route_key      TEXT NOT NULL UNIQUE, -- DSH 里的 provider 路由名：小写连字符，如 'hub-relay'
  display_name   TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('pi-ai','deepseek-official')),
  api            TEXT,                 -- pi-ai：'openai-completions' | 'openai-responses' | 'anthropic-messages'
  base_url       TEXT,
  models_json    TEXT NOT NULL DEFAULT '[]', -- [{id,name,contextWindow,maxTokens,reasoningEfforts}]
  compat_json    TEXT,
  extra_json     TEXT,                 -- 其余 pi-ai 字段原样透传（headers、retryPolicy…）
  key_mode       TEXT NOT NULL CHECK (key_mode IN ('shared','per-user','none')),
  api_key_enc    TEXT,                 -- key_mode=shared 时使用（AES-256-GCM）
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE user_provider_keys (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES model_providers(id) ON DELETE CASCADE,
  api_key_enc TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, provider_id)
);
CREATE INDEX user_provider_keys_provider ON user_provider_keys(provider_id);

CREATE TABLE model_presets (
  id                 INTEGER PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  description        TEXT NOT NULL DEFAULT '',
  provider_ids_json  TEXT NOT NULL,     -- [1,2]
  default_provider   TEXT NOT NULL,     -- route_key
  default_model      TEXT NOT NULL,
  is_default         INTEGER NOT NULL DEFAULT 0,
  revision           INTEGER NOT NULL DEFAULT 1, -- 每次修改 +1，写进 managed.patch.yml 头部注释
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
-- 同 runtimes：默认预设最多一个
CREATE UNIQUE INDEX model_presets_one_default ON model_presets(is_default) WHERE is_default = 1;
