-- 130_cockpit_ops.sql —— WP56b：座舱 DSH 的进程内凭据与座舱管理员令牌
--
-- 为什么需要两张表（docs/24 §3.3、§5）：
--
-- 1. `cockpit_ops_instance`：Hub 与座舱容器（`dshhub-ops`）之间的**唯一**信任关系。
--    座舱令牌写在容器 env `DSHHUB_OPS_TOKEN` 里，Hub 侧只存 sha256 —— 重启 Hub 之后
--    容器还在跑，Hub 必须还能校验它发来的令牌，所以哈希要落库（明文不落库）。
--    同一行记容器最后一次启动的 IP：`/ops/*` 要求「令牌对得上 **且** 来源 IP 等于这一行」，
--    容器重启换 IP 后旧 IP 立即失效（每次启动由 Hub 回写）。
--    `id = 1` 的 CHECK 把这张表钉成单行（座舱只有一个）。
--
-- 2. `cockpit_admin_tokens`：管理员浏览器 -> 座舱 iframe 的令牌对（access / refresh）。
--    与手机设备令牌**同一套前缀与校验口径**（`dshm_at_` / `dshm_rt_`，库里只存 sha256），
--    但**不进 `desktop_devices` / `desktop_device_tokens`**：座舱令牌不占手机设备名额
--    （10 台上限）、不出现在「我的设备」里、吊销只影响座舱。有效期 12 小时绝对过期。
--
-- 只做加法：不改既有表（`users.is_system` 由 129_cockpit.sql 负责）。

CREATE TABLE cockpit_ops_instance (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  -- sha256(令牌原文)：Hub 只校验，不解密、不打印；容器 env 里那份才是原文
  token_hash     TEXT    NOT NULL CHECK (length(token_hash) = 64),
  container_name TEXT    NOT NULL DEFAULT '' CHECK (length(container_name) <= 64),
  -- 座舱容器最后一次启动的 IP（`10.219.*` 或生产用户网段）；空 = 还没起来过
  container_ip   TEXT    CHECK (container_ip IS NULL OR length(container_ip) <= 45),
  updated_at     TEXT    NOT NULL
);

CREATE TABLE cockpit_admin_tokens (
  -- sha256(令牌原文) hex：与 desktop_device_tokens 同一纪律（明文只在签发响应里出现一次）
  id             TEXT PRIMARY KEY CHECK (length(id) = 64),
  admin_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT    NOT NULL CHECK (kind IN ('access', 'refresh')),
  created_at     TEXT    NOT NULL,
  expires_at     TEXT    NOT NULL,
  revoked_at     TEXT,
  revoked_reason TEXT    CHECK (revoked_reason IS NULL
                                OR revoked_reason IN ('rotated', 'logout', 'demoted', 'deleted', 'expired'))
);

CREATE INDEX cockpit_admin_tokens_admin ON cockpit_admin_tokens(admin_id);
CREATE INDEX cockpit_admin_tokens_expiry ON cockpit_admin_tokens(expires_at);

-- 座舱会话的发起人（docs/24 §6）：多个管理员共享同一个座舱容器 = 同一份会话列表，
-- 列表里要能看出「这条会话是谁开的」。Hub 在通道里登记：
--   管理员新建会话（服务端 frame `created`）或首次往某个会话发消息（客户端 frame `send`）时写入。
-- 存 username / display_name 快照而不是只存 admin_id：管理员改名/删除之后，
-- 会话列表里那一行仍然显示「当时是谁开的」（历史事实，不该跟着账号改）。
-- 普通节点（cloud:self / 桌面）的会话不写这张表，也就不带 initiator 字段。
CREATE TABLE cockpit_session_initiators (
  session_id   TEXT    PRIMARY KEY CHECK (length(session_id) BETWEEN 1 AND 200),
  admin_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username     TEXT    NOT NULL CHECK (length(username) BETWEEN 1 AND 64),
  display_name TEXT    CHECK (display_name IS NULL OR length(display_name) <= 64),
  created_at   TEXT    NOT NULL
);

CREATE INDEX cockpit_session_initiators_admin ON cockpit_session_initiators(admin_id);
