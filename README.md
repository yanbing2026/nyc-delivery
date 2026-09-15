# 纽约送餐点单系统（静态站接单 + 店里打印 + 记账）

不经过微信公众号的普通点单网站：顾客户端下单 → 云端排队 → 店里安卓设备拉单 → 蓝牙热敏打印机出票 → 本地记账/对账。

```
顾客手机 ──> docs/（静态站，Cloudflare/GitHub Pages，浏览器内算里程）
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
| `docs/` | 顾客看的点单网页（纯静态，可直连 Worker 或本地后端）。地址补全、里程、配送费、税、小费全在浏览器算 | 打开 `docs/index.html`，或推到 Pages：仓库设置 → Pages → 分支 `main` + 目录 `/docs` |
| `worker/` | **线上后端**：下单/取单/回写/日报汇总。Cloudflare Worker + D1，免费档 10 万请求/天 | 见 `worker/README.md`（4 条 wrangler 命令） |
| `backend/` | 本地参考后端（Python 标准库零依赖）：同一套业务逻辑，方便没网/没账号时跑通全流程，也能当自托管方案 | `cd backend && sh run.sh 8899` → http://127.0.0.1:8899/order |

`backend/` 里顺带保留了早期做的**微信公众号自定义菜单**那部分（`wxapi.py` / `menu_spec.py`，菜单编辑器+规则校验+推送）。现在这条路不走微信了，但代码和测试都还在，以后想加公众号入口可以直接用。

## 跑测试（全部无需密钥，但需要联网调纽约官方地址/路线接口）

```bash
./run_tests.sh          # 一次跑完 7 个套件，共 245 项检查
```

明细（也可以单独跑）：

```bash
cd backend && python3 selftest.py            # 48 项：签名/菜单规则/小票/ESC-POS 字节/HTTP 全链路/打印队列
cd backend && python3 test_delivery.py       # 39 项：真调 NYC GeoSearch + OSRM，里程/配送费/税/小费/自取
cd backend && node test-order-page.js        # 38 项：DOM 桩把页面脚本跑在真后端上（真下单、真出小票）
cd docs    && node test-wxmenu.js            # 23 项：菜单规则 + 小票渲染（与 Python 逐字符比对）
cd docs    && node test-delivery.js          # 31 项：前端里程模块（与后端公式对齐）
cd docs    && node test-order-page-static.js # 20 项：Pages 版点单页（浏览器内算里程）
cd worker  && node test_worker.mjs           # 46 项：Worker 全链路（真实 SQL + 真实地址/路线）
```

`worker/test_worker.mjs` 说明：这台开发机是 PRoot/Termux 类环境，`wrangler dev` 起不来（workerd 需要 1GB 对齐内存，PRoot 给不了）。所以测试用 Node 内建 `node:sqlite` 冒充 D1，直接调用 Worker 的 `fetch` 处理器 —— 测的是**同一份 Worker 代码**，不是复刻。

## 关键业务规则（改店的时候先看这里）

配送费阶梯默认为：≤0.5 英里免 · ≤2 英里 $3 · ≤4 英里 $6 · ≤6 英里 $10 · 超出每英里 $2.5 · 最远 8 英里 · 起送 $20 · 纽约市销售税 8.875%。

- 顾客**目前只收现金**（送到付）。不收卡 → 不碰支付网关/PCI，HTTPS 证书用 Let's Encrypt/Cloudflare 免费。
- **金额一律服务端重算**，前端传来的 subtotal/total 直接忽略（测试里专门放了一单假金额验证）。
- 现货地址解析的四个坑（都踩过）：不写 ZIP 会把 `40 Bayard St` 解析到布鲁克林；`focus.point` 压不住这种歧义；**纯中文地址搜不到**（必须英文街名）；只给 ZIP 会被当街名。所以前端强制「门牌号 + 英文街名」，并给候选列表让顾客点选。
- 钱用 Decimal / ROUND_HALF_UP（浮点会把 `12×8.875%` 算成 1.06）。
- 路线服务挂掉时不堵单：按直线×1.35 估算 + 兜底配送费，订单标 `needs_manual_review` 留人工核对。
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
