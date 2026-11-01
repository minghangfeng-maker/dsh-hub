-- 002_invites.sql —— WP1：邀请码（03 §1.1）。DDL 严格照 03，字段顺序一致
-- 迁移编号段：WP0a 000–001，WP1 002–019，WP2 020–039，WP3 040–059，WP4 060–079

CREATE TABLE invites (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,                     -- 12 位，大写字母数字，去掉易混字符
  note        TEXT NOT NULL DEFAULT '',
  max_uses    INTEGER NOT NULL DEFAULT 1,
  used_count  INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT,
  disabled    INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL
);

CREATE TABLE invite_uses (
  invite_id INTEGER NOT NULL REFERENCES invites(id),
  user_id   INTEGER NOT NULL REFERENCES users(id),
  used_at   TEXT NOT NULL,
  PRIMARY KEY (invite_id, user_id)
);

CREATE INDEX invite_uses_user ON invite_uses(user_id);
CREATE INDEX invites_created ON invites(created_at);
