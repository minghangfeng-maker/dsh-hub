-- 125_desktop_release_portable.sql —— WP38：安装包发布记录挂一个免安装 ZIP（公开主页「安装版 | 免安装版」切换）
--
-- 免安装版不进 feed（electron-updater 只认安装器），只作为同一条发布记录的附属下载：
-- 与安装器同目录 `bin/<target>/`，经 `/desktop/bin/<target>/<file>` 匿名下载。三列要么全空、要么全有。

ALTER TABLE desktop_releases ADD COLUMN portable_file TEXT CHECK (portable_file IS NULL OR length(portable_file) BETWEEN 1 AND 200);
ALTER TABLE desktop_releases ADD COLUMN portable_bytes INTEGER CHECK (portable_bytes IS NULL OR portable_bytes > 0);
ALTER TABLE desktop_releases ADD COLUMN portable_sha512 TEXT;
