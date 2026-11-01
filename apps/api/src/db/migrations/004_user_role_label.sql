-- 004_user_role_label.sql —— 普通用户的自定义角色标签（如「家人」「朋友」）
-- 权限仍只看 role（admin/user）；role_label 只是显示名，空串 = 「普通用户」，管理员恒为空串

ALTER TABLE users ADD COLUMN role_label TEXT NOT NULL DEFAULT '';
