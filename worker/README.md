# Cloudflare Worker + D1：纽约送餐订单后端

免费档就够：Workers 每天 10 万次请求 / 10ms CPU / 128MB，D1 5GB 存储 + 每天 10 万行写入，静态站带宽不限量。**不休眠、无冷启动** —— 这点比 Render 免费档（15 分钟休眠）和 Supabase 免费档（7 天无活动暂停）都强。

负载估算：店里设备每 3 秒拉一次单 ≈ 2.88 万次/天，占免费额度 29%。

## 部署（需要你自己的 Cloudflare 账号）

```bash
cd worker
npx wrangler login                      # 浏览器授权
npx wrangler d1 create nyc-orders       # 建库，把返回的 database_id 填进 wrangler.toml
npx wrangler d1 execute nyc-orders --file=./schema.sql --remote   # 建表 + 默认配置
npx wrangler secret put AGENT_KEY       # 店里设备取单的口令，别用默认值
npx wrangler deploy                     # 拿到 https://nyc-delivery-orders.<你的子域>.workers.dev
```

前端（Cloudflare Pages 或 GitHub Pages）只需要把 API 地址填成上面这个 Worker 域名。

## 接口契约（安卓端照这个实现，后端以后换掉也不影响 App）

| 接口 | 谁用 | 说明 |
|---|---|---|
| `POST /api/order` | 顾客网页 | 下单。**金额服务端重算**，前端传的 subtotal/total 一律忽略；带 IP 限流（20 单/小时） |
| `GET /api/quote` | 顾客网页 | 报价：地址→里程→配送费→税→小费→合计 + 预计送达 |
| `GET /api/autocomplete` | 顾客网页 | 地址自动补全（同名街道跨区时让顾客点选） |
| `GET /api/agent/pending` | 店里 App | 取最早一单，自动标记 `taken`，同一单不会取两次 |
| `POST /api/agent/status` | 店里 App | 回写 `printed` / `failed` / `done` / `void`，可带 `cash_collected`（骑手实收现金） |
| `GET /api/agent/orders?since=&limit=` | 店里 App | 批量拉订单，用于本地记账/对账/重装恢复 |
| `GET /api/report/summary?from=&to=` | 店里 App | 日报/月报：营业额、小计、税、小费、配送费、外卖 vs 自取、客单价、实收现金、**现金差额**、失败打印数、待人工核对数 |
| `POST /api/report/settings` | 店主 | 改配送规则/店址（改店址会自动重新解析坐标） |

Agent 接口用请求头 `x-agent-key` 认证（不接受 `?key=` —— query 里的 key 会进日志）。

## 订单状态机

```
pending ──取单──> taken ──打印成功──> printed ──送达收款──> done
                    └──打印失败──> failed ──重试──> printed
                                          └──作废──> void
```

## 本地测试

这台机器跑不了 `wrangler dev`（workerd 需要 1GB 对齐内存，PRoot 给不了），所以用 Node 内建 SQLite 冒充 D1，直接调 Worker 的 fetch 处理器，地址/路线走真实 NYC 官方接口：

```bash
node test_worker.mjs        # 93 项：接口、金额重算、取单不重复、状态回写、日报对账、限流、CORS
```

`/api/pos/publish` 的每条菜（`items[]`）字段：`id / name / price / category / available / publish / desc`。
其中 `desc` 是菜品简介（顾客页显示在菜名后面，**最多 40 字**，超了截断）—— 安卓端的
`MENU_DESC_MAX` 必须跟这个数一致，否则店里写的好好的简介会被后端悄悄截掉。

这个测试还会把 Worker 版和前端版（`docs/delivery.js`）的配送费/税/合计逐项对拍，防止两边算不一样。

## 安全边界

- 顾客接口是公开的：已有 IP 限流 + 金额服务端重算。要更严再加 Cloudflare Turnstile 人机验证（`TURNSTILE_SECRET` + 前端 widget）。
- 只有拿得到 `AGENT_KEY` 的设备能取单/回写，所以这个值就是你的取单口令，换人换店要重设。
- 订单表没有顾客密码之类敏感信息；现金支付不涉及卡号，PCI 不沾边。
