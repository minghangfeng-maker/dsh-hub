-- 044_provider_relay.sql —— WP10a：模型提供方新增「Hub 中转站」类型（12 §7）。
-- 为什么加列而不是改 kind 的 CHECK：SQLite 改 CHECK 要重建表，风险大；库里仍存 kind='pi-ai'，
-- 靠 is_relay=1 标记，repo 层映射成 DTO 的 kind='hub-relay'。

ALTER TABLE model_providers ADD COLUMN is_relay INTEGER NOT NULL DEFAULT 0;
