# AGENTS.md — NYC Delivery（纽约送餐点单系统）

面向所有在这个仓库干活的人与 AI（Hermes、ChatGPT、Meta AI …）。动手前先读这份。

## 这是什么
不经过微信的普通点单系统：顾客网页下单 → Cloudflare Worker + D1 排队 → 店里 Android 设备
（`yanbing2026/TabPOS`）拉单蓝牙出票。四块：
- `docs/` = 顾客点单页（**Pages 站点的根就是这里**）
- `worker/` = 线上后端（Cloudflare Worker + D1）
- `backend/` = 本地 Python 参考后端（零依赖，同一套业务逻辑）
- `run_tests.sh` = 测试入口
线上：https://yanbing2026.github.io/nyc-delivery/

## 构建
没有构建步骤（静态站 + 直接部署的 Worker，全树无 package.json / bundler）。
本地后端：`cd backend && sh run.sh 8899` → http://127.0.0.1:8899/order
Worker 配置在 `worker/wrangler.toml`（main=`src/index.js`，D1 binding `DB` → `nyc-orders`）。

## 测试（改完必跑）
```bash
./run_tests.sh          # 从仓库根跑，6 个套件
```
逐目录跑：`backend/`（`python3 selftest.py`、`python3 test_delivery.py`、`node test-order-page.js`）、
`docs/`（`node test-wxmenu.js`、`node test-order-page-static.js`）、`worker/`（`node test_worker.mjs`）。
需要 python3、Node 22+（用内置 `node:sqlite` 冒充 D1）、**并且联网**（真调 NYC 官方地址/路线接口）。
不需要密钥；`GOOGLE_MAPS_API_KEY` 可选（自动读 `${HERMES_HOME:-$HOME/.hermes}/.env`，缺了就跳过 Google 那几项）。
README 里写的 289 项、INSTRUCTIONS.md 里的 264 项都是旧数字 —— 以实跑输出为准。

## 发布（两条路，别搞混）
1. **网站**：GitHub Pages，分支 `main` + 目录 `/docs`。合并到 `main` 即上线。
2. **后端 Worker**：`cd worker && npx wrangler deploy`（首次按 `worker/README.md`：`d1 create nyc-orders`、
   `d1 execute schema.sql --remote`、`wrangler secret put AGENT_KEY`）。
   ⚠️ **草稿 PR（draft PR）里绝不部署 Worker** —— `wrangler deploy` 推的是**线上库 + 线上密钥**，
   只在合并到 `main` 且确认后才部署。

## 绝不手改 / 不能乱动的东西
- `backend/data/`（订单/队列/小票，每次运行重生成）、`worker/.wrangler/`、`*.bin` —— 都在 `.gitignore`。
- `worker/schema.sql` 开头是 `DROP TABLE IF EXISTS` —— **线上有真实订单后绝不能重跑**。
- 菜品 `id` 是历史订单的存档键：改名改价都行，**别改 `id`**（改了老订单就对不上）。

## 流程（main 已保护）
1. 开分支（`feat/…`、`fix/…`）→ 提交 → 开 PR。**不要直接推 `main`**（已禁止直推/强推/删分支，对管理员同样生效）。
2. PR 里写清：改的是哪一块（`docs/` / `worker/` / `backend/`）+ `./run_tests.sh` 的实跑结果。
3. 仓库里不放任何密钥（Worker 密钥走 `wrangler secret`）。
