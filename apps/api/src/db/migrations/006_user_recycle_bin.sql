-- 006_user_recycle_bin.sql —— WP22：用户回收站（03 §1.1 / 04 §4.2）
--
-- 删除用户（软删除）时**立即释放用户名**：`users.username` 是 UNIQUE，软删除不释放会导致
-- 「删了的人查不到、同名又建不了」。释放方式是把 `username` 改成 `<原名>#del<id>`
-- （不满足 USERNAME_REGEX，永远无法被注册/登录），原名存进 `deleted_username`，
-- 回收站展示与恢复都用它。恢复时原名已被占用，管理员可指定新用户名。
--
-- `purged_at`：彻底删除时间（null = 还在回收站）。超过保留期（7 天）的条目由后台清理任务置位。
-- `trash_dir`：数据目录在 `trash/` 下的相对路径（如 `trash/<slug>-<时间戳>`），恢复时搬回
--            `users/<slug>`；没有数据目录时为空。`deleted_from_status`：删除前的状态，恢复后回到它。

ALTER TABLE users ADD COLUMN deleted_username TEXT;
ALTER TABLE users ADD COLUMN deleted_from_status TEXT;
ALTER TABLE users ADD COLUMN purged_at TEXT;
ALTER TABLE users ADD COLUMN trash_dir TEXT;

-- 存量已删除用户：补 deleted_username，并立即释放用户名（上线后这些名字就能重新注册）。
-- 历史上手工改过的 `someuser#del5` 这类墓碑名也能还原出原名 `someuser`。
UPDATE users
   SET deleted_username = CASE
                            WHEN instr(username, '#del') > 0
                              THEN substr(username, 1, instr(username, '#del') - 1)
                            ELSE username
                          END,
       username = CASE
                    WHEN instr(username, '#del') > 0 THEN username
                    ELSE username || '#del' || id
                  END
 WHERE deleted_at IS NOT NULL;
