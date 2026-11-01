-- 085_relay_tools.sql —— WP18a：搜索 / 抓取池（14 §4；迁移号段 080–099 归 relay）。
-- 不复用模型渠道表：计费语义不同（按次、免费额度），密钥冷却原因也不同（exhausted 额度用完）。
-- 金额一律整数「微积分」（1 积分 = 1 元 = 1_000_000 微积分）。

CREATE TABLE relay_tool_channels (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('deepseek','tavily')),
  name TEXT NOT NULL UNIQUE,
  base_url TEXT NOT NULL,
  tools_json TEXT NOT NULL,                    -- ["search","fetch"]
  priority INTEGER NOT NULL DEFAULT 0,         -- 大的优先
  weight INTEGER NOT NULL DEFAULT 1,
  timeout_ms INTEGER NOT NULL DEFAULT 30000,
  proxy_url TEXT,
  search_cost INTEGER NOT NULL DEFAULT 0,      -- 微积分，我方上游成本估算（只用于毛利统计）
  fetch_cost INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  fail_streak INTEGER NOT NULL DEFAULT 0,      -- 熔断状态（Hub 重启后保留）
  cooldown_until TEXT,
  last_error TEXT,
  last_error_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE relay_tool_keys (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES relay_tool_channels(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  key_enc TEXT NOT NULL,                       -- AES-256-GCM（master.key）
  key_hash TEXT NOT NULL,                      -- sha256，同渠道去重
  last4 TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','disabled','auto-disabled')),
  cooldown_until TEXT,
  cooldown_reason TEXT CHECK (cooldown_reason IN ('rate-limit','exhausted','error')),
  last_error TEXT,
  last_error_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (channel_id, key_hash)
);

CREATE TABLE relay_tool_usage (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id INTEGER,                              -- 用户 sk-dsh 密钥（逻辑引用 relay_keys，不设外键免得删密钥丢历史）
  tool TEXT NOT NULL CHECK (tool IN ('search','fetch')),
  status TEXT NOT NULL CHECK (status IN ('ok','client_error','upstream_error','rejected')),
  free INTEGER NOT NULL DEFAULT 0,
  cost INTEGER NOT NULL DEFAULT 0,
  channel_id INTEGER,                          -- 最后一个候选（逻辑引用 relay_tool_channels）
  tool_key_id INTEGER,
  upstream_cost INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '',            -- 搜索词前 64 字 / URL 前 200 字
  error TEXT,
  month TEXT NOT NULL,                         -- 'YYYY-MM'（Asia/Shanghai）
  created_at TEXT NOT NULL
);
CREATE INDEX relay_tool_usage_user_month ON relay_tool_usage(user_id, month);
CREATE INDEX relay_tool_usage_created ON relay_tool_usage(created_at);
CREATE INDEX relay_tool_usage_tool_key_month ON relay_tool_usage(tool_key_id, month);
