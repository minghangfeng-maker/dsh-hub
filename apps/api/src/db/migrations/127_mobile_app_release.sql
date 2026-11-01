-- 127: 安卓 App 发布记录（WP40r）
--
-- 一张只服务安卓的单表，不动桌面端的 `desktop_releases`（那张表的 target 有 CHECK 约束，
-- 且每条记录都要生成 electron-updater 的 feed YAML / blockmap，语义不能被 APK 复用）。
--
-- 三条设计约束：
--   * **最多一条 published**（部分唯一索引）：主页、`bootstrap.app`、二维码三处都只认它，
--     不存在「哪个是最新」的歧义；回滚 = 把当前行 yank 掉、把上一版标回 published。
--   * 文件不删：yanked 的行仍然按 id 读得到文件名，回滚只是改状态，不用重新上传。
--   * 纯加法：不重建任何既有表，旧代码（7533be5）不认识这张表也照常运行。

CREATE TABLE mobile_app_releases (
  id           INTEGER PRIMARY KEY,
  version_name TEXT NOT NULL CHECK (length(version_name) BETWEEN 1 AND 64),
  version_code INTEGER NOT NULL CHECK (version_code >= 1 AND version_code <= 10000000),
  file_name    TEXT NOT NULL UNIQUE CHECK (length(file_name) BETWEEN 1 AND 200),
  bytes        INTEGER NOT NULL CHECK (bytes > 0),
  sha256       TEXT NOT NULL CHECK (length(sha256) = 64),
  status       TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'yanked')),
  uploaded_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at  TEXT NOT NULL
);

-- 「当前对外发布的 APK」最多一条（回滚只改状态，靠这个索引保证不会出现两条）
CREATE UNIQUE INDEX mobile_app_releases_published ON mobile_app_releases (status) WHERE status = 'published';
-- 列表与「上一版」都按 versionCode 倒序取
CREATE INDEX mobile_app_releases_code ON mobile_app_releases (version_code DESC, id DESC);
