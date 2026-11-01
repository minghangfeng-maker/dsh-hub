-- 102_instance_probe.sql —— WP33：会话探针与休眠（docs/22 §6.3）
--
-- 探针每分钟一轮，结果落在 instances 行上（管理端列表直接读，不额外查表）：
--   probe_state      最近一轮的判定：busy / watching / unattended / unknown
--   probe_at         最近一轮探针时刻（未知状态也会写，便于看出「探了但失败」）
--   running_sessions 进行中的会话数（items[].running=true；未知为 NULL）
--   last_busy_at     最近一次「有会话进行中」
--   last_prompt_at   max(items[].updatedAt)：最近一次用户消息推进的活动时间
--   last_client_at   最近一次代理 WebSocket 断开时间（代理层内存值，每轮落库）
--
-- 全部可空：迁移前的历史行没有这些值，表示「还没探过」→ 回收按未知状态走旧规则。
ALTER TABLE instances ADD COLUMN probe_state TEXT
  CHECK (probe_state IS NULL OR probe_state IN ('busy', 'watching', 'unattended', 'unknown'));
ALTER TABLE instances ADD COLUMN probe_at TEXT;
ALTER TABLE instances ADD COLUMN running_sessions INTEGER;
ALTER TABLE instances ADD COLUMN last_busy_at TEXT;
ALTER TABLE instances ADD COLUMN last_prompt_at TEXT;
ALTER TABLE instances ADD COLUMN last_client_at TEXT;
