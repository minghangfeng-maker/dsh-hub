-- 003_account_indexes.sql —— WP1：账号域查询索引（03 §1.1 已定表结构，这里只补索引）
-- 管理端用户列表按注册时间/状态/角色筛排，审计按目标与动作筛，会话清理按过期时间扫

CREATE INDEX users_created ON users(created_at);
CREATE INDEX users_status ON users(status, deleted_at);
CREATE INDEX users_active ON users(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX sessions_expires ON sessions(expires_at);
CREATE INDEX audit_action ON audit_logs(action);
CREATE INDEX audit_target ON audit_logs(target_type, target_id);
