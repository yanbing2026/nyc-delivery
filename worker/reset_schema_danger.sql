-- ⚠️ 危险操作：清空并重建所有表结构（会彻底抹除 orders/settings/hits 真实数据！）
-- 生产环境严禁直接执行！如需升级现有数据库，请使用 safe 的 schema.sql 或执行增量 ALTER 迁移。
-- 如确需完全重置本地或测试数据库：
-- wrangler d1 execute nyc-orders --file=./reset_schema_danger.sql --local

DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS hits;
DROP TABLE IF EXISTS commands;
DROP TABLE IF EXISTS menu_images;
