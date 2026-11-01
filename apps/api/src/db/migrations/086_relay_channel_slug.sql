-- 086_relay_channel_slug.sql —— WP20a：模型 × 渠道拆成独立模型（16 §2 §3 §6.1）
-- 渠道标识对用户可见；下发选择从「模型」下沉到「路由」；用量记录模型本名与是否指定渠道。
ALTER TABLE relay_channels ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX relay_channels_slug ON relay_channels(slug) WHERE slug IS NOT NULL;

-- 下发选择：老配置是按模型选的，迁移时把这些模型的启用路由都补成已选中。
-- relay_models.dsh_enabled 保留，由 Hub 维护成「任一路由被选中」。
ALTER TABLE relay_routes ADD COLUMN dsh_enabled INTEGER NOT NULL DEFAULT 0;
UPDATE relay_routes
   SET dsh_enabled = 1
 WHERE enabled = 1
   AND model_id IN (SELECT id FROM relay_models WHERE dsh_enabled = 1);

-- 用量：model 记用户请求的原始名字（可能带 @slug），base_model 记本名，pinned 标记是否指定渠道。
ALTER TABLE relay_usage ADD COLUMN base_model TEXT;
UPDATE relay_usage SET base_model = model WHERE base_model IS NULL;
ALTER TABLE relay_usage ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

-- defaultRouteId 回填：老配置只有 defaultModelId，按「渠道优先级降序、倍率升序、渠道 id 升序」取第一条。
-- 默认路由失效时由启动同步再自动改选（需要协议交集等业务判断，SQL 里不做）。
UPDATE settings
   SET value_json = json_set(
         value_json,
         '$.defaultRouteId',
         (
           SELECT r.id
             FROM relay_routes r
             JOIN relay_channels c ON c.id = r.channel_id
            WHERE r.model_id = json_extract(settings.value_json, '$.defaultModelId')
              AND r.dsh_enabled = 1
              AND r.enabled = 1
              AND c.enabled = 1
            ORDER BY c.priority DESC, c.rate_permille ASC, c.id ASC
            LIMIT 1
         )
       )
 WHERE key = 'relay_dsh'
   AND json_extract(value_json, '$.defaultRouteId') IS NULL
   AND json_extract(value_json, '$.defaultModelId') IS NOT NULL;
