-- 081_relay_channel_rate.sql —— WP11a：渠道倍率与计费快照（12 §8，迁移号段 080–099 归 relay）。
-- 费用 = 模型价格算出的费用 × 渠道倍率（千分比），钱包倍率再乘一次（12 §6.2）。
-- 老库升级后已有渠道倍率为 1000（×1.0），计费结果与升级前一致；老用量行没有快照，保持 NULL。

ALTER TABLE relay_channels ADD COLUMN rate_permille INTEGER NOT NULL DEFAULT 1000
  CHECK (rate_permille BETWEEN 0 AND 100000);                -- 渠道倍率，千分比（1000 = ×1.0，最大 ×100）
ALTER TABLE relay_usage ADD COLUMN channel_rate_permille INTEGER;  -- 计费时的渠道倍率快照；没走到渠道 = NULL
