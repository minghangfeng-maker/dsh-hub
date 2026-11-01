-- 040_runtimes.sql —— WP3：DSH 版本（运行时镜像）目录（03 §1.4 runtimes）
-- 迁移编号段：WP0a 000–001，WP1 002–019，WP2 020–039，WP3 040–059，WP4 060–079
--
-- `build_job_id` 指向 WP4 的 `jobs`（060 才建）——按 03 §1 的约定只做**逻辑外键**，
-- 不写 REFERENCES，避免迁移编号顺序耦合（040 先于 060 执行）。

CREATE TABLE runtimes (
  id           INTEGER PRIMARY KEY,
  dsh_version  TEXT NOT NULL UNIQUE,   -- '0.2.0-rc.2'
  image        TEXT NOT NULL,          -- 'dshhub/runtime:0.2.0-rc.2'
  status       TEXT NOT NULL CHECK (status IN ('building','ready','failed','retired')),
  is_default   INTEGER NOT NULL DEFAULT 0,
  image_id     TEXT,
  size_bytes   INTEGER,
  build_job_id INTEGER,                -- 逻辑外键 → jobs(id)
  notes        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);

-- `is_default` 唯一：部分索引只约束「默认那一行」，避免 SQLite 不支持带条件的唯一约束以外的写法
CREATE UNIQUE INDEX runtimes_one_default ON runtimes(is_default) WHERE is_default = 1;
CREATE INDEX runtimes_status ON runtimes(status, id);
