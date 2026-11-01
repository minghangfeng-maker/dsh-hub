-- 043_model_catalog.sql —— 模型信息库的「自定义」部分：管理员按模型名存的上下文 / 输出上限 / 输入类型 / 思考档位。
-- 内置部分是代码里的 catalog-data.ts（由 scripts/gen-model-catalog.mjs 从 pi-ai 目录生成）；同名时自定义覆盖内置。

CREATE TABLE model_catalog (
  key        TEXT PRIMARY KEY,  -- 规范化后的匹配键（小写、去厂商前缀 / 日期后缀、. _ 统一成 -）
  model_id   TEXT NOT NULL,     -- 管理员填的原始写法（展示用）
  info_json  TEXT NOT NULL,     -- {name?, contextWindow?, maxTokens?, input?, reasoningEfforts?}
  updated_at TEXT NOT NULL
);
