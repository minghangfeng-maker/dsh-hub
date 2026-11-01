-- 000_infra.sql —— WP0a：所有模块都依赖的基础设施表（03 §1.1）
-- 迁移编号段：WP0a 000–001，WP1 002–019，WP2 020–039，WP3 040–059，WP4 060–079

CREATE TABLE settings (                                 -- 键值，见 03 §1.6
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_logs (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL,
  actor_id    INTEGER,                                  -- 可为空（匿名，如登录失败）
  actor_ip    TEXT,
  action      TEXT NOT NULL,                            -- 'auth.login.success' 等，见 04 §9
  target_type TEXT,                                     -- 'user' | 'instance' | 'plugin' | ...
  target_id   TEXT,
  detail_json TEXT
);
CREATE INDEX audit_at ON audit_logs(at);
CREATE INDEX audit_actor ON audit_logs(actor_id);
