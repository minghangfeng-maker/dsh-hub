-- 060_jobs.sql —— WP4：任务域（03 §1.3 jobs / job_tasks）
-- 迁移编号段：WP4 060–079。jobs 表必须先建：WP3 的 runtimes.build_job_id 逻辑外键指向它。

CREATE TABLE jobs (
  id           INTEGER PRIMARY KEY,
  type         TEXT NOT NULL,         -- 'export' | 'runtime.build' | 'rollout.plugin' | 'rollout.runtime' | 'rollout.models' | 'instance.recreate'
  title        TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('queued','running','paused','succeeded','failed','partial','canceled')),
  params_json  TEXT NOT NULL,
  strategy_json TEXT,                 -- {concurrency, canary, maxFailureRatio, restart}
  total        INTEGER NOT NULL DEFAULT 0,
  done         INTEGER NOT NULL DEFAULT 0,
  failed       INTEGER NOT NULL DEFAULT 0,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT,
  error        TEXT
);
-- 调度循环按状态捞活跃 job，概览页按状态计数
CREATE INDEX jobs_status ON jobs(status, id);

CREATE TABLE job_tasks (
  id          INTEGER PRIMARY KEY,
  job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,       -- 执行顺序（金丝雀排前面）
  user_id     INTEGER REFERENCES users(id),
  status      TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','skipped','canceled')),
  attempt     INTEGER NOT NULL DEFAULT 0,
  log         TEXT NOT NULL DEFAULT '', -- 追加写，单条上限 256KB（超出截断头部）
  -- 03 §1.3 未列出，但 plan() 产出的每任务参数必须持久化（否则重启后无法复原）；见进度报告「契约变更」
  payload_json TEXT,
  result_json TEXT,
  started_at  TEXT,
  finished_at TEXT,
  error       TEXT
);
CREATE INDEX job_tasks_job ON job_tasks(job_id, seq);
CREATE INDEX job_tasks_status ON job_tasks(status, job_id);
