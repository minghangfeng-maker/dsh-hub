-- ============================================================================
-- 088_relay_usage_client_kind.sql —— WP25a：用量按**来源**打标（D6 §7.3；迁移号段 080–099 归 relay）
--
-- 为什么要新列：`relay_usage.source` 的语义是网络路径（internal|local|public，080_relay.sql:124），
-- 回答不了「这次调用是容器里的 DSH、桌面客户端，还是用户自己拿密钥调的外部工具」。
--
-- 取值由**凭据**决定，不由请求自述（客户端不能声称自己是 desktop）：
--   relay_keys.device_id 非空（桌面设备专用的密钥） → 'desktop'
--   kind='system'（容器里注入的 HUB_MK_*）        → 'docker'
--   kind='user'（用户自建密钥）                   → 'external'
--   判定不出来（默认值）                          → 'unknown'
-- 取值约束放在应用层（apps/api/src/modules/relay/service.ts 的 relayClientKind），不写 CHECK
-- （与 087 的 scope 同一习惯：取值演进不改表）。
--
-- `relay_keys.device_id`：设备专用密钥的归属（D6 §5.6-3 的方案①/②里最便宜的一种，
-- 也是「吊销设备 = 断模型」的物理依据）。桌面设备的中转站密钥与模式密钥都记这一列；
-- 用户自建密钥恒为 NULL，所以 088 之前的历史行全部保持 NULL，语义不受影响。
-- ============================================================================

ALTER TABLE relay_usage ADD COLUMN client_kind TEXT NOT NULL DEFAULT 'unknown';

CREATE INDEX relay_usage_client_kind_time ON relay_usage(client_kind, created_at);

-- 桌面设备的中转站密钥（kind='user' scope='dsh'）与两个模式的密钥（kind='user' scope=claude-code|codex）
-- 都会带这一列；吊销设备时按它一次吊销全部，且**不动**用户自建的密钥。
ALTER TABLE relay_keys ADD COLUMN device_id TEXT
  CHECK (device_id IS NULL OR (device_id LIKE 'dv_%' AND length(device_id) = 35));

CREATE INDEX relay_keys_device ON relay_keys(device_id) WHERE device_id IS NOT NULL;

-- 有意不做的事：
--   * 不给 relay_usage 加 device_id：不做「某台设备的用量」这种能追到机器的报表（D6 §7.3，最小化）。
--   * 不改 relay_usage_daily：日汇总主键 (day, user_id, model, channel_id) 不变，来源维度查询时 join。
