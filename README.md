# 纽约送餐点单系统（静态站接单 + 店里打印 + 记账）

不经过微信公众号的普通点单网站：顾客户端下单 → 云端排队 → 店里安卓设备拉单 → 蓝牙热敏打印机出票 → 本地记账/对账。

```
顾客手机 ──> docs/（静态站，Cloudflare/GitHub Pages，只收集地址/显示金额）
                │ POST /api/order
                ▼
          worker/（Cloudflare Worker + D1，免费档，不休眠）
                │ GET /api/agent/pending   ↑ POST /api/agent/status
                ▼
        店里安卓设备（TabPOS 扩展：前台服务轮询 → 蓝牙打印 → 回写状态 → 报表）
```

## 三块东西

| 目录 | 是什么 | 怎么跑 |
|---|---|---|
| `worker/src/index.js` | Worker 路由：`/api/config`、`/api/quote`、`/api/autocomplete`、`/api/order`、**`/api/lookup`（老客取回，只凭手机号）**、`/api/agent/*`（取单/回写）、`/api/report/*`、`/api/pos/publish` |
| `docs/index.html` | **顾客点单页（站点首页）**。只负责收集地址、显示金额：地址候选走 Worker 的 `/api/autocomplete`，报价走 `/api/quote`，自己不算钱、也不需要任何 key。店名/电话/菜单全从后端读（内容来自 TabPOS 的发布） | 推到 Pages：仓库设置 → Pages → 分支 `main` + 目录 `/docs`，站点根就是它 |
| `docs/order.html` | 老链接的跳转页（转到 `./`），之前发出去的 `/order.html` 不会失效 | — |
| `worker/` | **线上后端**：下单/取单/回写/日报汇总。Cloudflare Worker + D1，免费档 10 万请求/天 | 见 `worker/README.md`（4 条 wrangler 命令） |
| `backend/` | 本地参考后端（Python 标准库零依赖）：同一套业务逻辑，方便没网/没账号时跑通全流程，也能当自托管方案 | `cd backend && sh run.sh 8899` → http://127.0.0.1:8899/order |

`backend/` 里顺带保留了早期做的**微信公众号自定义菜单**那部分（`wxapi.py` / `menu_spec.py`，菜单编辑器+规则校验+推送）。现在这条路不走微信了，但代码和测试都还在，以后想加公众号入口可以直接用。

## 跑测试（全部无需密钥，但需要联网调纽约官方地址/路线接口）

```bash
./run_tests.sh          # 一次跑完 6 个套件，共 264 项检查
```

明细（也可以单独跑）：

```bash
cd backend && python3 selftest.py            # 48 项：签名/菜单规则/小票/ESC-POS 字节/HTTP 全链路/打印队列
cd backend && python3 test_delivery.py       # 41 项：地址解析（Google 优先）+ OSRM 里程/配送费/税/小费/自取/五区范围
cd backend && node test-order-page.js        # 38 项：DOM 桩把页面脚本跑在真后端上（真下单、真出小票）
cd docs    && node test-wxmenu.js            # 23 项：菜单规则 + 小票渲染（与 Python 逐字符比对）
cd docs    && node test-order-page-static.js # 37 项：点单页（站点首页）—— 后端用桩，不依赖线上地址服务，结果确定
cd worker  && node test_worker.mjs           # 77 项：Worker 全链路（真实 SQL + 真实地址/路线 + App 发布菜单/下单校验）
```

`worker/test_worker.mjs` 说明：这台开发机是 PRoot/Termux 类环境，`wrangler dev` 起不来（workerd 需要 1GB 对齐内存，PRoot 给不了）。所以测试用 Node 内建 `node:sqlite` 冒充 D1，直接调用 Worker 的 `fetch` 处理器 —— 测的是**同一份 Worker 代码**，不是复刻。

## 菜单和店信息：以 TabPOS 为准（没有网页后台）

**店里那台安卓设备上的 TabPOS 就是后台** —— 菜单、分类、价格、售完、店名、电话、地址、税率、小费档位都在 App 里维护，App 发布上来，网站只读：

```
TabPOS（App，唯一编辑入口）
   │ POST /api/pos/publish   Header: x-agent-key
   ▼
Worker + D1（settings 表里的 shop / menu / pos 三行 = 网站的唯一真相源）
   │ GET /api/config
   ▼
点单页（顾客手机）
```

- **云端连不进店里局域网**，所以只能 App 主动推。反过来说：App 关机/离线，网站照常点单（用的是上一次发布的快照）
- `POST /api/pos/publish` 直接吃 TabPOS 的原生形状：`categories[{name,ord}]` + `items[{id,name,price,category,available}]` + `shop{companyName,companyAddress,companyPhone,taxRate,suggestedTips,...}`（App 那边不用为了对接拼数据结构）
- 发布失败不会写坏线上：**没价格的菜被跳过并回报 `skipped`**、**店址解析不出来整份拒绝**（不然全站里程全错）
- **每个菜可以单独决定"上不上网页"**（App 里菜单项的 `Show on the online menu`）：内部用的东西（员工餐、只店里卖的）关掉后，顾客菜单里看不到、拿旧页面提交也会被拒。这跟"售完"是两个字段（`publish` vs `available`），别混用
- 下单校验：服务端按**库里的菜单价**重算（网页传的价不作数），App 里下架/售完的菜直接拒单
- `GET /api/config` 里带 `pos: {at, device, items, available, skipped}`，能看出线上菜单是不是 App 最新发布的
- 应急通道：`POST /api/report/settings` 也还能改 `shop`/`menu`（curl 用，没有网页入口）。正常情况下**别用** —— 下次 App 发布会覆盖它

`id` 是历史订单的存档键：改菜名改价格都不影响旧订单，但**别改 id**。

## 关键业务规则（改店的时候先看这里）

配送费默认为：**5 英里内免费 · 超出每英里 $2（不足 1 英里按 1 英里算，即 5~6 英里 $2、6~7 英里 $4，类推）· 不设距离上限 · 起送 $20 · 纽约市销售税 8.875%**。

- **只送纽约五大区**（曼哈顿 / 布鲁克林 / 皇后区 / 布朗克斯 / 史泰登岛）：解析结果不在五区内直接拒单，别让顾客下完单才发现送不了。
- 后台接口：`GET /api/config`（公开：店名/电话/菜单/运费规则）、`GET /api/report/verify`（验口令）、`POST /api/report/settings`（改规则/店名/菜单，需口令）。`/api/report/verify` 是专门给后台门锁用的**无副作用**接口 —— 不能用 `/api/agent/pending` 验口令，它会把订单标成"已取"。

- 顾客**目前只收现金**（送到付）。不收卡 → 不碰支付网关/PCI，HTTPS 证书用 Let's Encrypt/Cloudflare 免费。
- **金额一律服务端重算**，前端传来的 subtotal/total 直接忽略（测试里专门放了一单假金额验证）。
- 现货地址解析的四个坑（都踩过）：不写 ZIP 会把 `40 Bayard St` 解析到布鲁克林；`focus.point` 压不住这种歧义；**纯中文地址搜不到**（必须英文街名）；只给 ZIP 会被当街名。所以前端强制「门牌号 + 英文街名」，并给候选列表让顾客点选。
- 钱用 Decimal / ROUND_HALF_UP（浮点会把 `12×8.875%` 算成 1.06）。
- 路线服务挂掉时不堵单：按直线×1.35 估算 + 兜底配送费，订单标 `needs_manual_review` 留人工核对。
- 地址解析优先 Google（每月 10,000 次免费），其次 NYC 官方 GeoSearch，最后 Nominatim。免费源都解不了 Queens 那种 `10-53 116th St` 连字符门牌号，Google 才行。
- **Google 会把瞎编地址脑补成附近的真街道**（实测 `9999 Nowhere Blvd, New York, NY 10013` → `40 Lispenard St`，带 `partial_match: true`），放过去等于让骑手送错地址，所以只采信 `partial_match` 为假的结果。
- 免费源要带 User-Agent：Nominatim / OSRM 对空 UA 直接 403（伪装成 JSON 解析失败），而且会限流（429）。
- 小票上地址要按词换行（`STREET` 被切成 `ST`/`REET` 送餐员会送错）；配送费即使 $0 也要打出来。

## 打印机（店里那台 Star TSP143IIIBi）

它是**蓝牙机型**，服务器碰不到它 —— 蓝牙是点对点短距连接。而且它**不支持 Star CloudPRNT**（那套要以太网，官方支持机型里没有 TSP143III 系列），原生也不是 ESC/POS 而是 Star Graphic Mode。

所以架构上就是这样：**店里那台安卓设备就是打印服务器**。它只需要出网（拉单），不需要公网 IP、不用端口映射。

店里设备出故障 = 出不了票，建议备用：另一台手机装同一个 App，或加一台云打印机（飞鹅云约 200 元）做兜底 —— `backend/printers.py` 里的飞鹅驱动（签名 `sha1(user+UKEY+stime)`、`api.feieyun.cn/Api/Open/`）已经写好并过了签名测试。

## 下一步（换机器接着做）

见 [`ANDROID-PLAN.md`](ANDROID-PLAN.md)：在现成的 `yanbing2026/TabPOS`（餐厅 POS，已有蓝牙/USB/网口打印、订单流水、报表、LAN 主机模式）里加三样东西 —— 在线订单监听、打印回写、报表口径。接口契约见 `worker/README.md`，安卓端照它实现即可。

## 需要你自己准备的凭据

- Cloudflare 账号（Workers + D1 免费档，`worker/README.md` 里的 4 条命令）
- 一个域名（可选，Pages 的 `*.github.io` 也能用；正式接单建议自定义域名）
- TabPOS 构建：Android SDK + 签名（本仓库不含 APK）
