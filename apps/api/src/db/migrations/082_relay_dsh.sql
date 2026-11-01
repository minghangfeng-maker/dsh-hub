-- 082_relay_dsh.sql —— WP12a：下发到 DSH（12 §7.0 / §8）
-- 勾选要下发的对外模型；默认模型与系统预设 id 存 settings 键 relay_dsh（不进 SettingsSchema，同 relay）。
-- 老库升级后所有模型都是「没勾选」：默认模型、系统提供方、系统预设都由管理员在「下发到 DSH」里显式配置。
ALTER TABLE relay_models ADD COLUMN dsh_enabled INTEGER NOT NULL DEFAULT 0;
