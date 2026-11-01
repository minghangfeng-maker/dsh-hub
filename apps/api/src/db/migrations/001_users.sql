-- 001_users.sql —— WP0a：账号域核心表（03 §1.1）。DDL 严格照 03，不要在这里加 WP1 的字段
-- （invites / invite_uses 归 WP1，编号 002+）

CREATE TABLE users (
  id                   INTEGER PRIMARY KEY,
  slug                 TEXT NOT NULL UNIQUE,            -- 不可变，'u' + 7 位 [a-z0-9]
  username             TEXT NOT NULL UNIQUE,            -- 可修改，小写
  display_name         TEXT NOT NULL DEFAULT '',
  bio                  TEXT NOT NULL DEFAULT '',
  avatar_file          TEXT,                            -- avatars/ 下的文件名
  password_hash        TEXT NOT NULL,
  role                 TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','disabled')),
  must_change_password INTEGER NOT NULL DEFAULT 0,
  quota_json           TEXT,                            -- 为空则用全局默认，见 03 §1.5 Quota
  runtime_id           INTEGER,                         -- 钉住的 DSH 版本（逻辑外键 → runtimes）；为空则用默认版本
  model_preset_id      INTEGER,                         -- 逻辑外键 → model_presets；为空则用默认预设
  model_policy         TEXT NOT NULL DEFAULT 'managed' CHECK (model_policy IN ('managed','free')),
  username_changed_at  TEXT,
  last_login_at        TEXT,
  last_login_ip        TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  deleted_at           TEXT                             -- 软删除
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,                        -- sha256(token) hex
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  reauth_at    TEXT,                                    -- 最近一次二次验证密码
  ip           TEXT,
  user_agent   TEXT,
  revoked_at   TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);
