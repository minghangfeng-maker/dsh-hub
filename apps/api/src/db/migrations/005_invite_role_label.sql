-- 005_invite_role_label.sql —— WP9：邀请码带角色（用这个码注册的人自动得到该角色名）
-- 邀请码上只有 role_label（显示名），没有 role：用它注册的人 role 恒为 'user'，永远拿不到管理权限；
-- 空串 = 「普通用户」，管理员不是可选值（03 §1.1、04 §4.4）

ALTER TABLE invites ADD COLUMN role_label TEXT NOT NULL DEFAULT '';
