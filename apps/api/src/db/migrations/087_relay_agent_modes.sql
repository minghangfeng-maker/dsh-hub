-- 087_relay_agent_modes.sql —— WP23a：Claude Code 与 Codex 管理（18 §2；迁移号段 080–099 归 relay）。
-- 三个作用域共用中转站的渠道 / 对外模型 / 密钥 / 用量表：
--   dsh         原中转站（「模型」页）
--   claude-code Claude Code 对话模式
--   codex       Codex 对话模式
-- 作用域建好后不能改（改作用域等于换一个东西，删了重建）；取值约束在应用层（RelayScopeSchema），不写 CHECK。

ALTER TABLE relay_channels ADD COLUMN scope TEXT NOT NULL DEFAULT 'dsh';
ALTER TABLE relay_models   ADD COLUMN scope TEXT NOT NULL DEFAULT 'dsh';

-- system 密钥从「每人一把」变成「每人每作用域一把」；user 密钥（自建）永远是 dsh。
ALTER TABLE relay_keys ADD COLUMN scope TEXT NOT NULL DEFAULT 'dsh';
DROP INDEX relay_keys_one_system;
CREATE UNIQUE INDEX relay_keys_one_system ON relay_keys(user_id, scope)
  WHERE kind = 'system' AND revoked_at IS NULL;

-- 用量来源与模式倍率快照（dsh 为 1.0 = 1000，快照 NULL）。
ALTER TABLE relay_usage ADD COLUMN scope TEXT NOT NULL DEFAULT 'dsh';
ALTER TABLE relay_usage ADD COLUMN mode_rate_permille INTEGER;
CREATE INDEX relay_usage_scope_time ON relay_usage(scope, created_at);

-- 日汇总：主键不变（模型名全局唯一，同一模型只属于一个作用域），加列方便按来源汇总。
ALTER TABLE relay_usage_daily ADD COLUMN scope TEXT NOT NULL DEFAULT 'dsh';
