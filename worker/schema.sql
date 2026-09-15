-- Cloudflare D1：纽约送餐订单库
-- 应用方式：wrangler d1 execute nyc-orders --file=./schema.sql --local（本地）或去掉 --local（线上）

DROP TABLE IF EXISTS orders;
CREATE TABLE orders (
  id            TEXT PRIMARY KEY,          -- 订单号
  created_at    TEXT NOT NULL,
  source        TEXT DEFAULT 'web',
  customer      TEXT DEFAULT '',
  phone         TEXT DEFAULT '',
  address       TEXT DEFAULT '',           -- 解析后的标准地址（送餐员看的）
  borough       TEXT DEFAULT '',
  distance_miles REAL,
  drive_minutes  INTEGER,
  eta_minutes    INTEGER,
  remark        TEXT DEFAULT '',
  items         TEXT NOT NULL,             -- JSON 数组
  subtotal      REAL NOT NULL DEFAULT 0,
  tax           REAL NOT NULL DEFAULT 0,
  tax_rate      REAL NOT NULL DEFAULT 0,
  tip           REAL NOT NULL DEFAULT 0,
  delivery_fee  REAL NOT NULL DEFAULT 0,
  total         REAL NOT NULL DEFAULT 0,
  pay_type      TEXT DEFAULT '现金 Cash（送到付）',
  pickup        INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending/taken/printed/failed/done/void
  needs_manual_review INTEGER NOT NULL DEFAULT 0,
  taken_at      TEXT DEFAULT '',
  printed_at    TEXT DEFAULT '',
  done_at       TEXT DEFAULT '',
  error         TEXT DEFAULT '',
  cash_collected REAL,                     -- 骑手实收现金（对账用）
  synced_at     TEXT DEFAULT ''
);
CREATE INDEX idx_orders_status ON orders(status, created_at);
CREATE INDEX idx_orders_created ON orders(created_at);

-- 店的配置（配送费规则/店址/支付方式），改这里不用重新部署
DROP TABLE IF EXISTS settings;
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings (key, value) VALUES ('delivery', '{
  "enabled": true,
  "free_miles": 0.5,
  "tiers": [{"max": 2, "fee": 3.0}, {"max": 4, "fee": 6.0}, {"max": 6, "fee": 10.0}],
  "per_mile_beyond": 2.5,
  "max_miles": 8,
  "min_order": 20.0,
  "tax_rate": 0.08875,
  "prep_minutes": 20,
  "tip_options": [0.15, 0.18, 0.2],
  "payment": ["现金 Cash（送到付）"],
  "restaurant_addr": "40 Bayard St, New York, NY 10013",
  "restaurant": {"lat": 40.715285, "lon": -73.998012},
  "fallback_fee": 5.0
}');

-- 简易限流（按 IP 小时窗口）
DROP TABLE IF EXISTS hits;
CREATE TABLE hits (ip TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX idx_hits ON hits(ip, ts);
