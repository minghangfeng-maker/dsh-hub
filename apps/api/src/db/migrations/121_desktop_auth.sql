-- ============================================================================
-- 121_desktop_auth.sql —— WP25a：桌面设备令牌（D2 §4 / D6 §5.1；桌面域号段 120–139）
--
-- 依赖 120_desktop_devices.sql（外键指向 desktop_devices(device_id)）。
--
-- 三条纪律：
-- 1. **只存哈希**：主键 `id` = sha256(令牌明文) hex，与 `sessions.id` 同一做法（02 §5）；
--    明文只在 `POST /api/desktop/auth/token` 的响应里出现一次。
-- 2. **令牌有效期 = 滑动 30 天 + 绝对 90 天**：`expires_at` 是**当前**到期时间，
--    每次使用（节流 1 小时）续成 min(now + 30 天, created_at + 90 天)，所以它天然不会越过绝对上限；
--    `renewed_at` 记录最近一次滑动时间。
-- 3. **续期即轮换**：`POST /api/desktop/auth/refresh` 吊销旧行（revoked_reason='rotated'）并签发新行，
--    `replaced_by` 指向新行，保留轮换链。没有独立的 refresh token。
--
-- 吊销原因与设备表同一套口径，加 logout / rotated：
--   logout（设备自己登出）| rotated（续期轮换）| device-revoked（设备被吊销，用户或管理员）
--   | password-change | user-disabled | user-deleted | expired
-- ============================================================================

CREATE TABLE desktop_device_tokens (
  -- sha256(明文令牌) hex：与 sessions.id 同纪律，比对时再哈希请求里的令牌
  id             TEXT    PRIMARY KEY CHECK (length(id) = 64),

  device_id      TEXT    NOT NULL REFERENCES desktop_devices(device_id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  created_at     TEXT    NOT NULL CHECK (length(created_at) <= 32),
  last_used_at   TEXT    NOT NULL CHECK (length(last_used_at) <= 32),
  -- 绝对到期（created_at + 90 天）；滑动续期改的是 renewed_at，不改这条
  expires_at     TEXT    NOT NULL CHECK (length(expires_at) <= 32),
  renewed_at     TEXT    CHECK (renewed_at IS NULL OR length(renewed_at) <= 32),

  revoked_at     TEXT    CHECK (revoked_at IS NULL OR length(revoked_at) <= 32),
  revoked_reason TEXT    CHECK (revoked_reason IS NULL
                                OR revoked_reason IN ('logout', 'rotated', 'device-revoked',
                                                      'password-change', 'user-disabled',
                                                      'user-deleted', 'expired')),
  -- 轮换链：旧行指向新行（新行先插入，旧行再更新）
  replaced_by    TEXT    REFERENCES desktop_device_tokens(id) ON DELETE SET NULL,

  -- 签发时的请求元信息（排障用；不含任何请求体）
  ip             TEXT    CHECK (ip IS NULL OR length(ip) <= 64),
  user_agent     TEXT    CHECK (user_agent IS NULL OR length(user_agent) <= 512),
  app_version    TEXT    CHECK (app_version IS NULL OR length(app_version) <= 32)
);

CREATE INDEX desktop_device_tokens_device ON desktop_device_tokens(device_id);
CREATE INDEX desktop_device_tokens_user ON desktop_device_tokens(user_id);
-- 清理任务/过期判定：只扫还活着的行
CREATE INDEX desktop_device_tokens_expires ON desktop_device_tokens(expires_at)
  WHERE revoked_at IS NULL;
