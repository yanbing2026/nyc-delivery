# 安卓端：把在线订单接进 TabPOS

目标：店里一台安卓设备（平板/旧手机）常驻运行，**自动拉单 → 蓝牙打印 → 回写状态 → 记账报表**。

不新建 App，扩现有的 [`yanbing2026/TabPOS`](https://github.com/yanbing2026/TabPOS)（`/root/TabPOS`）。它的结构（见该仓库 `AGENTS.md`）：

- 包名 `com.example.restaurantpos`，`applicationId` 是 `com.example.restaurantpos.v2`，单模块 Compose，Kotlin 1.9.20 / AGP 8.5.2
- 数据层是**原生 SQLite**（`data/PosDatabase.kt`，`SQLiteOpenHelper`），不是 Room；改表要同时改 `DATABASE_VERSION` 和 `onUpgrade`
- 已有：`ui/EscPosPrinter.kt`（蓝牙经典 / USB OTG / 网口 9100）、`ui/ReceiptPrinter.kt`、`ui/PrinterDiscovery.kt`、`TicketsScreen`（流水）、`ReportsScreen`、`KitchenScreen`、`net/HostServer`+`HostModeService`（LAN host 模式，host 独占写库）
- 构建：`./gradlew assembleDebug`，会被 `uploadDebugApkToR2` 自动传到 R2（rclone remote `r2:restaurantpos`）；不想传就 `-x uploadDebugApkToR2`

## 要加的三样

**1. 在线订单客户端** `net/OnlineOrderClient.kt`

照 `worker/README.md` 的契约实现（接口就这么几个，后端以后换成 VPS 也不影响 App）：

```
GET  {base}/api/agent/pending          Header: x-agent-key
     → { ok, order: {no, items[], address, distance_miles, eta_minutes, total, pay_type, remark, ...} | null }
POST {base}/api/agent/status           { id, status: printed|failed|done|void, error?, cash_collected? }
GET  {base}/api/agent/orders?since=&limit=     批量拉（记账/重装恢复）
GET  {base}/api/report/summary?from=&to=       日报/月报汇总
```

设置里存：Worker 地址 + agent key（复用 `data/SettingsStore.kt`）。agent key 就是取单口令，**别写死在代码里**。

**2. 订单监听前台服务** `service/OnlineOrderService.kt`

- `startForeground` + 常驻通知（Android 14 必须声明 `android:foregroundServiceType="dataSync"`），别用 WorkManager（最小周期 15 分钟，接单太慢）
- 循环：每 3–5 秒 `GET /api/agent/pending`；拿到单就
  1. 写本地库（状态 `pending`，避免重复打印）
  2. 调现成的 `EscPosPrinter` 打小票（走蓝牙那台 TSP143IIIBi；小票正文由本地渲染，字段同 `backend/receipt.py`：地址按词换行、距离、税、配送费、小费、现金合计）
  3. 成功 → `status=printed`；失败 → `status=failed` + 本地重试（退避），并**放声音/震动提醒**
- 断网：本地排队，恢复后重试；同一单绝不能打两次（用订单号做幂等键）
- 已打印未送达的单，骑手端要有「送达并登记现金实收」按钮 → `status=done` + `cash_collected`

**3. 报表口径** `ReportsScreen`

日报/月报按新口径取数（本地 SQLite 算，离线也能看；Worker 的 `/api/report/summary` 用来对账）：

- 营业额、订单数、完成单数、外卖 vs 自取、客单价
- 小计 / 税 / 小费 / 配送费分列
- **现金对账**：应收 vs 骑手实收（`cash_collected`），差额提醒
- 失败打印数、待人工核对数（`needs_manual_review`）

## 保活清单（不做这些会漏单）

- 设备：插电、屏幕常亮或设为 launcher、关电池优化（`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`）
- 国产 ROM 要在系统设置里手动给「自启动 + 后台常驻 + 锁定任务」
- 前台服务 + 常驻通知（杀不掉才怪，Android 也不允许被随便杀）
- 备用方案：另一台手机装同一个 App（两个设备同时拉单会**重复打印** —— 所以需要「一台主 + 一台备」，备用设备平时不轮询，或由 Worker 侧指定活动设备）

## 待确认

1. TabPOS 平时在哪台机器构建？（本开发机没有 Android SDK、也没有 `~/.gradle`，`gen_icons.py` 里还写着 `C:/Users/yanbi` 路径，看起来是 Windows）改完代码是本地构建还是继续走 R2？
2. agent key / Worker 地址是否放进 `SettingsStore`（推荐）还是编译期常量？
3. 双设备主备要不要在第一版就做，还是先单设备 + 云打印机兜底？
