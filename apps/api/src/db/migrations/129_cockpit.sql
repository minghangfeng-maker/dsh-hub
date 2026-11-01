-- ============================================================================
-- 129_cockpit.sql —— WP56a 管理座舱（docs/24 §3.5）
--
-- 只做加法：users 加一列 `is_system`，另建 4 张 cockpit_* 表。不改任何既有列/约束，
-- 也不搬数据（所以没有 128 那种重建表的风险）。
--
--   users.is_system      系统账号（hub-ops）。=1 的账号不能登录、不出现在用户列表与统计、
--                        不计入名额、不扣积分；账号本身由 WP56b 建（本迁移只加列）。
--   cockpit_proposals    方案（DSH 提、管理员批）；steps_json 里存 args 与 Hub 计算的 preview
--   cockpit_canvas_items 画布卡（DSH 与 Hub 都写）
--   cockpit_secrets      密钥请求（值用 lib/crypto 的 AES-GCM 加密；15 分钟未用即删）
--   cockpit_handoff_codes 一次性交接码（只存 sha256，60 秒有效）
--
-- 与文档的差异：
--   * `cockpit_canvas_items` 的 `order` 列改名为 `sort_order` —— `ORDER` 是 SQLite 关键字，
--     列名带引号会在所有 SQL 里都要求引号，容易写漏；语义不变（repo 层映射回 `order`）。
--   * `cockpit_secrets` 多了 `expires_at` / `filled_at` / `status`：文档列的四个字段不够表达
--     「15 分钟过期 / 已填 / 已取消 / 已用完」，否则只能在应用层靠 created_at 现算。
--   * `cockpit_proposals` 的 `outcome_json` 不设长度约束（多步方案的每一步结果都可能很长，
--     API 层已按 64 KB 截断）。
-- ============================================================================

-- ── 0. 系统账号标记（docs/24 §3.5） ────────────────────────────────────────

ALTER TABLE users ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0;

-- 只有极少数行是系统账号，部分索引足够
CREATE INDEX users_is_system ON users(is_system) WHERE is_system = 1;

-- ── 1. 方案 ─────────────────────────────────────────────────────────────────

CREATE TABLE cockpit_proposals (
  id           INTEGER PRIMARY KEY,

  -- DSH 会话 id（由手机通道给的会话标识；不含任何令牌）
  session_id   TEXT    NOT NULL CHECK (length(session_id) BETWEEN 1 AND 200),

  -- DSH 起的标题与说明：只作展示（I3：rationale 不参与执行）
  title        TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  rationale    TEXT    NOT NULL DEFAULT '' CHECK (length(rationale) <= 2000),

  -- 各步最高级（R1 关自动 / R2 / R3 才会落库；R0 直接返回、R1 自动执行不建方案）
  risk         TEXT    NOT NULL CHECK (risk IN ('R0', 'R1', 'R2', 'R3')),

  -- [{capability, args, preview}]：创建时由 Hub 校验参数并算好 preview 一起存（I3）
  steps_json   TEXT    NOT NULL,

  status       TEXT    NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'running', 'succeeded', 'failed',
                                         'rejected', 'expired')),

  created_at   TEXT    NOT NULL CHECK (length(created_at) <= 32),
  -- 创建后 30 分钟（COCKPIT_PROPOSAL_TTL_MINUTES）
  expires_at   TEXT    NOT NULL CHECK (length(expires_at) <= 32),

  -- 决定它的管理员；R1 自动执行不建方案，所以这里只可能是人工批准/拒绝
  decided_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at   TEXT    CHECK (decided_at IS NULL OR length(decided_at) <= 32),

  -- [{stepIndex, ok, result?, error?}]：逐步记录，遇错停止（I3）
  outcome_json TEXT
);

-- 列表默认按状态 + 时间倒序；过期清理也只扫 pending
CREATE INDEX cockpit_proposals_status ON cockpit_proposals(status, created_at);
CREATE INDEX cockpit_proposals_session ON cockpit_proposals(session_id, created_at);

-- ── 2. 画布卡 ───────────────────────────────────────────────────────────────

CREATE TABLE cockpit_canvas_items (
  id          TEXT    PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 80),

  -- 同一张卡属于哪个 DSH 会话（态势板的默认卡用固定前缀 `board:`，不落库）
  session_id  TEXT    NOT NULL CHECK (length(session_id) BETWEEN 1 AND 200),

  title       TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 200),

  -- CanvasSpec 的 JSON（应用层 zod 校验并限制大小）
  spec_json   TEXT    NOT NULL,

  -- 钉到态势板
  pinned      INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),

  -- 文档里的 `order`（SQLite 关键字，改名为 sort_order；repo 层映射回 order）
  sort_order  INTEGER NOT NULL DEFAULT 0,

  -- dsh = DSH 自己画的；hub = 方案卡 / 密钥卡 / 默认态势卡（DSH 不能改或删）
  origin      TEXT    NOT NULL DEFAULT 'dsh' CHECK (origin IN ('dsh', 'hub')),

  -- 舷位（docs/24 §1 投放规则）：DSH 的 'auto' 由 Hub 解析后落库，只存 left/right
  placement   TEXT    NOT NULL DEFAULT 'left' CHECK (placement IN ('left', 'right')),

  -- 高度档位（缺省 m）
  size        TEXT    NOT NULL DEFAULT 'm' CHECK (size IN ('s', 'm', 'l')),

  created_at  TEXT    NOT NULL CHECK (length(created_at) <= 32),
  updated_at  TEXT    NOT NULL CHECK (length(updated_at) <= 32)
);

CREATE INDEX cockpit_canvas_session ON cockpit_canvas_items(session_id, sort_order);
-- 态势板只查钉住的卡
CREATE INDEX cockpit_canvas_pinned ON cockpit_canvas_items(sort_order) WHERE pinned = 1;

-- ── 3. 密钥请求（§3.4） ────────────────────────────────────────────────────

CREATE TABLE cockpit_secrets (
  -- `sec_` + 24 字节 base64url（32 字符），既是引用号也是主键
  id           TEXT    PRIMARY KEY CHECK (id LIKE 'sec_%' AND length(id) = 36),

  -- {sessionId, purpose, capability, field}：申请时的上下文（不含任何值）
  request_json TEXT    NOT NULL,

  -- AES-GCM 密文（lib/crypto 的 v1:<iv>:<tag>:<cipher>）；未填写 / 已用完为 NULL
  ciphertext   TEXT,

  status       TEXT    NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'filled', 'cancelled', 'expired')),

  created_at   TEXT    NOT NULL CHECK (length(created_at) <= 32),
  -- 创建后 15 分钟（COCKPIT_SECRET_TTL_MINUTES）
  expires_at   TEXT    NOT NULL CHECK (length(expires_at) <= 32),
  -- 管理员填写的时刻
  filled_at    TEXT    CHECK (filled_at IS NULL OR length(filled_at) <= 32),
  -- 方案执行解引用之后置位，同时清空 ciphertext（§3.4「执行后删除」）
  used_at      TEXT    CHECK (used_at IS NULL OR length(used_at) <= 32)
);

-- 清理任务 / 过期判定：只扫还没用掉的
CREATE INDEX cockpit_secrets_expires ON cockpit_secrets(expires_at) WHERE used_at IS NULL;

-- ── 4. 交接码（§3.3） ──────────────────────────────────────────────────────

CREATE TABLE cockpit_handoff_codes (
  -- sha256(明文码) hex：与 sessions.id 同纪律，明文只在响应里出现一次、不进日志
  code_hash  TEXT    PRIMARY KEY CHECK (length(code_hash) = 64),

  admin_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  created_at TEXT    NOT NULL CHECK (length(created_at) <= 32),
  -- 60 秒
  expires_at TEXT    NOT NULL CHECK (length(expires_at) <= 32),
  -- 一次性：用过就置位
  used_at    TEXT    CHECK (used_at IS NULL OR length(used_at) <= 32)
);

CREATE INDEX cockpit_handoff_codes_expires ON cockpit_handoff_codes(expires_at);
