# 纽约送餐点单系统 · 操作手册

> 一句话：**顾客在网页点单，店里平板自动出小票，App 就是后台。**
> 本文是这套系统的操作基准（店主/店员看的）。代码仓库见文末。

---

## 一、谁是谁

```
顾客手机 ──> 点单网站（静态页，GitHub Pages）
              https://yanbing2026.github.io/nyc-delivery/
                    │  POST /api/order            下单
                    ▼
        Cloudflare Worker + D1（云端）
        https://nyc-delivery-orders.yanbing2004.workers.dev
                    ▲  POST /api/pos/publish       菜单 / 店信息（App 推上去）
                    │  GET  /api/agent/pending     取单
                    ▼
        店里平板上的 TabPOS（App：唯一后台 + 出票端）
                    │  蓝牙小票机
                    ▼
                 小票
```

- **点单网站**：只读。菜单、价格、售完、店名、电话、税率、小费档位、运费规则**全部来自 App 发布的内容**；顾客那边看不到任何后台信息（店址和配送费规则也不显示）
- **App（TabPOS）**：① 改菜单/价格/售完 = 后台；② 常驻监听线上订单，取单 → 打小票 → 回写状态；③ 本地记账 + 现金对账
- **云端**：下单、算钱（按库里的菜单价重算，不信网页传的价）、地址解析（Google）、路线里程（OSRM）、限流、日报

---

## 二、一次性设置（店里那台平板，约 10 分钟）

1. **装 APK**
   文件形如 `TabPOS-v2.0.34-*.apk`（debug 签名，可直接覆盖安装；数据库会自动升级，老数据不动）
2. **选小票机**
   Settings → Printer → 选那台蓝牙热敏机（58mm / 80mm 会按纸宽自动排版）
   ⚠️ **必须先选打印机**：没选时 App 故意不取单（取了打不出来就是漏单）
3. **填站点信息**：菜单管理页（Manage Menu）顶部 **Online ordering site** 卡片
   - **Site URL**：`https://nyc-delivery-orders.yanbing2004.workers.dev`（末尾不加 `/` 也行）
     别填成 `github.io` 那个——那是给顾客看的网页，不是后端
   - **Publish key**：Worker 的口令（= 取单口令）。在电脑上查看：
     ```
     grep -m1 '^NYC_DELIVERY_AGENT_KEY=' ~/.hermes/profiles/oc/.env
     ```
     **不要把口令贴到聊天/文档/代码里**；它只存在设备本机的 `pos_settings.json`
   - 点 **Save & publish** → 应显示 `✓ 已发布：N 道在售（共 M 道）`；N/M 就是你 App 菜单里的菜数
   - 打开 **Listen for online orders**（通知栏会出现常驻通知："正在等线上订单…"）
4. **保活**（不做会漏单）：设备插电常开；系统设置里把 App 设为「不受限制 / 不优化电池」；允许通知；重启后会自动恢复监听（已加开机自启）

---

## 三、每天怎么用

| 场景 | 操作 |
|---|---|
| 顾客下单 | 平板自动出票，通知栏显示「已出票 单号 · 金额」 |
| 骑手取餐并收到现金 | 菜单页卡片里点 **Delivered + cash**，填实收金额 → 回写 `done` + 实收 |
| 出票失败 | 卡片里显示 ✗ 与原因 → 点 **Reprint** 重打（本地最多自动重试 3 次） |
| 改菜价 / 上下架 | App 里改 → 开了 **Auto-publish** 会自动推；否则点一次 **Save & publish** |
| 看账 | 报表页 "Online orders (site)" 块：外卖/自取、营业额、**应收现金 vs 实收 vs 差额**、出票失败数、距离待核对数 |

**改菜单后建议做的核对**：打开点单页刷新一下，确认菜名/价格/店名/电话就是你在 App 里改的。

---

## 四、出问题怎么查

| 现象 | 先看哪儿 | 处理 |
|---|---|---|
| 平板不出票 | 卡片状态行 / 通知栏文字 | 打印机电源与配对；再点 Reprint |
| 顾客说"下不了单" | 点单页的提示语 | 后端会明说原因：五区外 / 未到起送价 / 这道菜已售完 / 地址要写英文 |
| 网站菜单是旧的 | 卡片里最后一次发布结果 | 点 Save & publish；确认 Site URL 和口令没变 |
| 平板重启后不收单 | 开关是否还开着 | 开关开着会自动恢复；否则手动打开 |
| App 崩了 | 登录页 **Last crash log**，或重开 App 会自动弹 | 点 **Share** 发出来（日志含设备、App 版本、数据库版本、完整堆栈） |
| 现金对不上 | 报表页的差额 | 逐单核对实收（`cash_collected`） |
| 想知道云端状态 | 见下方接口表 | `curl .../api/health` 最简单 |

---

## 五、接口契约（换后端 / 排查时照这个）

写口令的接口都带请求头 `x-agent-key`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/config` | 顾客页读的：`shop` / `menu` / `pos`（最后发布时间）/ `config`（规则） |
| GET | `/api/quote?address=&subtotal=&tip_rate=&pickup=1` | 报价（距离、配送费、税、小费、合计） |
| GET | `/api/autocomplete?q=` | 地址联想 |
| POST | `/api/order` | 下单。服务端按库里菜单价重算；下架/售完直接拒 |
| POST | `/api/pos/publish` | **App 发布菜单 + 店信息**（这个 App 是唯一后台） |
| GET | `/api/agent/pending` | 取下一单。**有副作用：取走即标 taken**，所以只能在"确定能打印"时调用 |
| POST | `/api/agent/status` | 回写 `printed` / `failed` / `done` / `void`（+ `cash_collected`） |
| GET | `/api/agent/orders?since=YYYY-MM-DD HH:MM:SS&limit=` | 批量拉历史单（默认最近 30 天，limit 上限 2000） |
| GET | `/api/report/summary?from=YYYY-MM-DD&to=YYYY-MM-DD` | 区间汇总（对账用） |
| GET | `/api/report/verify` | 只验口令、不动数据（后台门锁用） |
| POST | `/api/report/settings` | 应急改规则/店名/菜单（正常别用：下次 App 发布会覆盖） |

---

## 六、业务规则（改之前先看这里）

- **只送纽约五大区**：曼哈顿 / 布鲁克林 / 皇后区 / 布朗克斯 / 史泰登岛；五区外直接拒单
- **配送费**：5 英里内**免费**；超出每英里 **$2**，不足 1 英里**按 1 英里向上取整**（5–6 英里 $2、6–7 英里 $4…）；**不设距离上限**
- **起送 $20**；税 **8.875%**；**只收现金**
- **店址**：`10-53 116th St, Flushing, NY 11356`（改店址会自动重新解析坐标；解不出来会**拒绝保存/发布**，避免全站里程算错）
- **地址必须英文**、从门牌号开始、带 5 位 ZIP；Queens 那种连字符门牌号（`10-53`）只有 Google 能解出来
- 菜品的 `id` 是历史订单的存档键：**改名字改价格都行，别改 id**

---

## 七、代码在哪 / 怎么重新出包

**网站 + 云端**：`github.com/yanbing2026/nyc-delivery`（分支 `main`）
```
./run_tests.sh          # 6 个套件 264 项：后端、里程/配送费、点单页、Worker 全链路
cd worker && npx wrangler deploy      # 部署后端
```

**App**：`github.com/yanbing2026/TabPOS`（分支 `feat/online-ordering-site`）
```
cd ~/projects/TabPOS
./gradlew :app:assembleDebug -x uploadDebugApkToR2   # 加 -x 就不会自动传 R2
./gradlew :app:testDebugUnitTest                     # 小票版式单测（8 项）
# 产物：app/build/outputs/apk/debug/app-debug.apk
```
改数据库表：在 `data/PosDatabase.kt` 里**建表语句和 `ADDED_COLUMNS` 都要写**（别只写 ALTER，见下面的坑）。

---

## 八、两个踩过的坑（写给以后的自己）

1. **版本号跑在语句前面**：`DATABASE_VERSION` 涨了、`ALTER` 没发布 → 设备长期缺列 → 一登录就 `SQLiteException: no such column`。
   现在每次打开数据库都会拿"建表语句 ∪ 历史 ALTER"比对一遍并自动补列（幂等、只加不删），所以这类漂移能自愈。
2. **Compose 里往已有页面插内容**：页面若有 `LazyColumn` / `verticalScroll`，新块**必须放进那个滚动容器**。放在外面会占掉一块固定高度，把下面的内容挤没——表现是**页面不能上下拉**（不崩、但没法用，比崩还难查）。
