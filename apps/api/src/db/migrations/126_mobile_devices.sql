-- ============================================================================
-- 126_mobile_devices.sql —— WP40a：手机 App 设备（v2 §4.1）
--
-- 手机与桌面端**共用同一张设备台账与令牌表**（`desktop_devices` /
-- `desktop_device_tokens`），这样：
--   * 用户在「我的实例 → 桌面设备」里能看到手机登录、并一键吊销（与桌面设备同一个入口）；
--   * 吊销的级联（改密 / 停用 / 删除用户 / 管理员吊销）自动覆盖手机；
--   * 手机令牌仍是「只存 sha256」，明文只在签发响应里出现一次。
--
-- 为什么只加两列、不重建表：
--   1. 原表的 `platform` CHECK 只允许 Node 的 `process.platform`（win32/darwin/linux），
--      手机是 android/ios，语义不同，所以另开 `mobile_platform`，不去放宽桌面列；
--   2. SQLite 放宽 CHECK 必须重建表，而 `desktop_device_tokens` / `desktop_device_plugins`
--      都带 `ON DELETE CASCADE` 外键指向 `device_id`，重建期间一旦级联就会删掉真实令牌；
--      `ALTER TABLE ... ADD COLUMN` 是纯加法，没有这个风险（两列都有默认值/可空）。
--
-- `kind` 默认 'desktop'：历史行全部是桌面设备，行为不变；新行由插入方显式给出。
-- 桌面设备数上限（settings.desktop.maxDevicesPerUser）只数 `kind='desktop'`，
-- 手机有自己的上限（常量 MOBILE_MAX_DEVICES_PER_USER），两者互不挤占。
-- ============================================================================

ALTER TABLE desktop_devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'desktop'
  CHECK (kind IN ('desktop', 'mobile'));

ALTER TABLE desktop_devices ADD COLUMN mobile_platform TEXT
  CHECK (mobile_platform IS NULL OR mobile_platform IN ('android', 'ios'));

-- 手机设备按 (用户, 种类, 状态) 计数与列举（登录去重、上限、吊销后重登）
CREATE INDEX desktop_devices_user_kind ON desktop_devices(user_id, kind, status);
