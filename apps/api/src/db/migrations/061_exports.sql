-- 061_exports.sql —— WP4：数据导出（03 §1.3 exports）

CREATE TABLE exports (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id       INTEGER REFERENCES jobs(id),
  parts_json   TEXT NOT NULL,          -- ["workspace","sessions","settings"]
  format       TEXT NOT NULL CHECK (format IN ('zip','tar.gz')),
  status       TEXT NOT NULL CHECK (status IN ('queued','running','ready','failed','expired')),
  file_name    TEXT,                   -- 下载时的文件名：dsh-<username>-20261012-2130.zip
  size_bytes   INTEGER,
  sha256       TEXT,
  created_at   TEXT NOT NULL,
  expires_at   TEXT,
  downloaded   INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);
CREATE INDEX exports_user ON exports(user_id, id);
-- 过期清理定时器按 (status, expires_at) 扫描
CREATE INDEX exports_expiry ON exports(status, expires_at);
