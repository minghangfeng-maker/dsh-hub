-- 020_instances.sql —— WP2：实例域（03 §1.2）
-- 迁移编号段：WP0a 000–001，WP1 002–019，WP2 020–039，WP3 040–059，WP4 060–079

CREATE TABLE instances (
  user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  container_id    TEXT,
  container_name  TEXT NOT NULL,                        -- 'dshhub-' || slug
  runtime_id      INTEGER,                              -- 当前容器实际使用的版本（逻辑外键 → runtimes）
  image           TEXT,
  status          TEXT NOT NULL DEFAULT 'absent'
                  CHECK (status IN ('absent','stopped','starting','running','stopping','error')),
  ip              TEXT,
  authority       TEXT,                                 -- Hub 发给 DSH 的 Host，统一 '127.0.0.1:3000'（05 F4/F14）
  config_hash     TEXT,                                 -- 创建容器时的规格哈希（镜像+配额+env 键+managed 版本）
  started_at      TEXT,
  last_active_at  TEXT,
  start_reason    TEXT,                                 -- 'user' | 'admin' | 'rollout' | 'login'
  bootstrapped_at TEXT,                                 -- 首次插件安装完成时间
  error           TEXT,
  updated_at      TEXT NOT NULL
);

-- 对账/空闲回收/容量统计都是按状态扫全表（表很小，索引只为省一次全表扫描）
CREATE INDEX instances_status ON instances(status);
