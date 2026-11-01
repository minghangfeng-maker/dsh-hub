-- 101_egress.sql —— WP21：网络代理订阅（17 §7）
-- 订阅地址里通常带机场 token：加密存储，sha256 去重，另存脱敏提示用于展示。
CREATE TABLE egress_subscriptions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  url_enc TEXT NOT NULL,
  url_sha TEXT NOT NULL UNIQUE,
  url_hint TEXT NOT NULL,
  interval_hours INTEGER NOT NULL DEFAULT 12,
  enabled INTEGER NOT NULL DEFAULT 1,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
