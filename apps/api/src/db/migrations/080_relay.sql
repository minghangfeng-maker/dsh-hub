-- 080_relay.sql —— WP10a：模型中转站（12 §8；迁移号段 080–099 归 relay）。
-- 表结构照 12 §8 原样；金额一律整数「微积分」（1 积分 = 1 元 = 1_000_000 微积分）。

CREATE TABLE relay_channels (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  base_url TEXT NOT NULL,
  apis_json TEXT NOT NULL,                     -- ["openai-completions","anthropic-messages"]
  priority INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 1,
  max_concurrency INTEGER NOT NULL DEFAULT 0,  -- 0 = 不限
  timeout_ms INTEGER NOT NULL DEFAULT 600000,
  proxy_url TEXT,
  headers_json TEXT,
  stream_usage INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  fail_streak INTEGER NOT NULL DEFAULT 0,      -- 熔断状态（Hub 重启后保留）
  cooldown_until TEXT,
  last_error TEXT,
  last_error_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE relay_channel_keys (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES relay_channels(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  key_enc TEXT NOT NULL,                       -- AES-256-GCM（master.key，同 api_key_enc）
  key_hash TEXT NOT NULL,                      -- sha256，用于同渠道去重
  last4 TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','disabled','auto-disabled')),
  cooldown_until TEXT,
  last_error TEXT,
  last_error_at TEXT,
  last_used_at TEXT,                           -- 节流落库（≥ 60 秒才写一次）
  created_at TEXT NOT NULL,
  UNIQUE (channel_id, key_hash)
);

CREATE TABLE relay_models (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,                   -- 对外模型名
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  visibility TEXT NOT NULL DEFAULT 'all' CHECK (visibility IN ('all','admin')),
  price_input INTEGER NOT NULL,                -- 微积分 / 百万 token
  price_output INTEGER NOT NULL,
  price_cache_read INTEGER,                    -- NULL = 同 price_input
  price_cache_write INTEGER,
  price_request INTEGER NOT NULL DEFAULT 0,    -- 每次请求固定费用（微积分）
  info_json TEXT NOT NULL DEFAULT '{}',        -- ModelInfo
  compat_json TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE relay_routes (
  id INTEGER PRIMARY KEY,
  model_id INTEGER NOT NULL REFERENCES relay_models(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES relay_channels(id) ON DELETE RESTRICT,
  upstream_model TEXT NOT NULL,
  priority INTEGER,                            -- NULL = 用渠道的
  weight INTEGER,                              -- NULL = 用渠道的
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE (model_id, channel_id, upstream_model)
);
CREATE INDEX relay_routes_channel ON relay_routes(channel_id);

CREATE TABLE relay_wallets (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance INTEGER NOT NULL DEFAULT 0,          -- 微积分，可为负
  rate_percent INTEGER NOT NULL DEFAULT 100,
  max_concurrency INTEGER,                     -- NULL = settings.relay.defaultMaxConcurrency
  daily_limit INTEGER,                         -- 微积分；NULL = 不限
  enabled INTEGER NOT NULL DEFAULT 1,
  total_spent INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE relay_keys (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('system','user')),
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,               -- sha256(明文) hex
  key_enc TEXT,                                -- 仅 system（要注入容器 env）
  preview TEXT NOT NULL,                       -- sk-dsh-ab12…9xyz
  enabled INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT,                           -- 节流落库
  created_at TEXT NOT NULL,
  revoked_at TEXT                              -- 删除 = 软删（用量记录还引用它）
);
CREATE UNIQUE INDEX relay_keys_one_system ON relay_keys(user_id) WHERE kind = 'system' AND revoked_at IS NULL;
CREATE INDEX relay_keys_user ON relay_keys(user_id);

CREATE TABLE relay_ledger (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('grant','deduct','signup')),
  amount INTEGER NOT NULL,                     -- 带符号
  balance_after INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX relay_ledger_user ON relay_ledger(user_id, created_at);

CREATE TABLE relay_usage (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id INTEGER REFERENCES relay_keys(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  upstream_model TEXT,
  channel_id INTEGER REFERENCES relay_channels(id) ON DELETE SET NULL,
  api TEXT NOT NULL,
  stream INTEGER NOT NULL,
  source TEXT NOT NULL,                        -- internal | local | public
  status TEXT NOT NULL,                        -- ok | aborted | upstream_error | client_error
  http_status INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost INTEGER NOT NULL DEFAULT 0,             -- 微积分
  estimated INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 1,
  duration_ms INTEGER,
  ttft_ms INTEGER,
  error TEXT
);
CREATE INDEX relay_usage_user_time ON relay_usage(user_id, created_at);
CREATE INDEX relay_usage_time ON relay_usage(created_at);
CREATE INDEX relay_usage_channel_time ON relay_usage(channel_id, created_at);

CREATE TABLE relay_usage_daily (
  day TEXT NOT NULL,                           -- Asia/Shanghai 日期 YYYY-MM-DD
  user_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  channel_id INTEGER NOT NULL DEFAULT 0,       -- 0 = 没走到渠道
  requests INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id, model, channel_id)
);
