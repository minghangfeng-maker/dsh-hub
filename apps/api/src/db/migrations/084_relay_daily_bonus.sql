-- 084_relay_daily_bonus.sql —— WP17a：每日赠送（13 §2、§5；迁移号段 080–099 归 relay）。
--
-- relay_ledger.type 的 CHECK 要加 daily/expire/compute。SQLite 改不了 CHECK，只能重建表：
-- 先建新表 → 原样搬数据（id / amount / balance_after 一个都不动）→ 删旧表 → 改名 → 重建索引。
-- 迁移执行器把整个文件包在一个事务里，且连接开着 foreign_keys=ON；relay_ledger 是 users 的子表、
-- 没有别的表引用它，所以 DROP/RENAME 不会触发外键级联或断开引用。

ALTER TABLE relay_wallets ADD COLUMN daily_bonus_left INTEGER NOT NULL DEFAULT 0;
ALTER TABLE relay_wallets ADD COLUMN daily_bonus_day TEXT;               -- 'YYYY-MM-DD'（Asia/Shanghai）

CREATE TABLE relay_ledger_new (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('grant','deduct','signup','daily','expire','compute')),
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

INSERT INTO relay_ledger_new (id, user_id, type, amount, balance_after, note, actor_id, created_at)
SELECT id, user_id, type, amount, balance_after, note, actor_id, created_at FROM relay_ledger;

DROP TABLE relay_ledger;
ALTER TABLE relay_ledger_new RENAME TO relay_ledger;
CREATE INDEX relay_ledger_user ON relay_ledger(user_id, created_at);
