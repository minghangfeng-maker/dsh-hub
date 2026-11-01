-- 100_compute.sql —— WP17a：算力租赁（13 §5；迁移号段 100–119 归 compute）。
-- 金额一律整数「微积分」；租约开租时快照规格与价格，之后改价/改规格不影响进行中的租约。

CREATE TABLE compute_leases (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  plan_name TEXT NOT NULL,
  cpus REAL NOT NULL,
  memory_mb INTEGER NOT NULL,
  price_per_hour INTEGER NOT NULL,           -- 微积分
  block_price INTEGER NOT NULL,              -- 微积分
  billed INTEGER NOT NULL,                   -- 0 = 免费租约
  start_reason TEXT NOT NULL,
  started_at TEXT NOT NULL,
  paid_until TEXT,                           -- 免费租约 NULL
  grace_until TEXT,
  ended_at TEXT,
  end_reason TEXT CHECK (end_reason IN ('user','admin','idle','insufficient','crash','plan-change','billing-off','system')),
  blocks INTEGER NOT NULL DEFAULT 0,
  charged INTEGER NOT NULL DEFAULT 0,        -- 微积分
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 每个用户最多一条进行中的租约（13 §1）
CREATE UNIQUE INDEX compute_leases_one_active ON compute_leases(user_id) WHERE ended_at IS NULL;
CREATE INDEX compute_leases_user ON compute_leases(user_id, started_at);

CREATE TABLE compute_prefs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
