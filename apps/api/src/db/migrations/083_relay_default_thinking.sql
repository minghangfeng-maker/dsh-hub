-- 083_relay_default_thinking.sql —— WP13a：模型的默认思考档位（12 §7.0 / §8）
-- 下发到用户 DSH 时，这个模型的默认档位（DSH 的 pi-ai 只能按提供方设默认档位，所以渲染时按「协议 × 档位」分路由）。
-- 可空：NULL = 不指定（由上游/模型自己的默认决定）。写入时必须在该模型 info.reasoningEfforts 里（服务层校验）。
ALTER TABLE relay_models ADD COLUMN default_thinking TEXT
  CHECK (default_thinking IS NULL OR default_thinking IN ('off','minimal','low','medium','high','xhigh','max'));
