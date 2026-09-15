# 公众号自定义菜单 + 云打印 演示站

零依赖（Python 3 标准库），`python3 server.py` 就能跑。没公众号也能演示：默认 demo 模式会**把要发给微信的请求原样摊开给你看**，切 live 填 AppID/AppSecret 就是真调。

## 跑起来

```bash
python3 server.py            # 默认 8899 端口
python3 selftest.py          # 33 项自测：签名/菜单规则/小票/字节/HTTP 全链路
```

- 控制台 <http://127.0.0.1:8899/>
- 点单页 <http://127.0.0.1:8899/order>（手机版式，下单→出票）

## 四个打印驱动（打印设置页切换）

| 驱动 | 适用打印机 | 原理 |
|---|---|---|
| `dryrun` | 无（先跑流程） | 小票文本 + ESC/POS 字节存到 `data/prints/` |
| `feie` | 飞鹅云打印机 | 打印机自己连网，网站 POST `api.feieyun.cn` |
| `net` | 网口/云盒小票机 | TCP 9100 直发 ESC/POS 字节 |
| `queue` | **蓝牙/USB 打印机** | 网站排队 → 现场设备 `agent.py` 取单后打 |

## 你那台 Star TSP143IIIBi 怎么接

**先说结论：这台是蓝牙机型，网站/服务器碰不到它，必须"店里放一台设备拉单再蓝牙打出去"。**

查证过的事实：

1. TSP143IIIBI 接口是 **Bluetooth 2.1（iOS MFi）+ USB**（USB-A 口规格书写的是给平板供电 5V-1A）。蓝牙是点对点短距连接，云端服务器没有蓝牙，连不上。
2. **不支持 Star CloudPRNT**（"打印机自己上网拉任务"那套）。Star 官方支持的机型只有 mC-Print2/3、mC-Label2/3、TSP100IV、TSP654II，而且 CloudPRNT **必须用以太网**，官方明说不支持 USB，蓝牙更不行。
3. TSP100III 系列的**原生命令集是 Star Graphic Mode（光栅）**，不是 ESC/POS。所以别指望直接往它灌 ESC/POS 文本字节就能出票（要 ESC/POS 得用 Star 的 futurePRNT 驱动转换）。走 Star 官方 SDK 最稳。

所以两条落地路线：

**路线 A（推荐，工作量小）：店内安卓平板 + StarPRNT SDK**

```
微信用户点菜单 → 你的网站 /order 下单
      → 服务器把订单排进 queue（driver=queue）
      → 店里安卓平板上的小 App 每 2~3 秒拉一次 /api/agent/next
      → 拿到小票文本，用 StarPRNT SDK 通过蓝牙打出去
      → POST /api/agent/ack 回报成功/失败
```

安卓侧关键几行（StarPRNT SDK，蓝牙 + StarGraphic 模拟）：

```kotlin
val port = StarIOPort.getPort(printerName, "BT:${mac}", 10000, context)  // 蓝牙口
val builder = StarXpandCommand.StarXpandCommandBuilder()
builder.addDocument(
  StarXpandCommand.DocumentBuilder()
    .addPrinter(StarXpandCommand.PrinterBuilder()
      .addText(text)                 // 服务端给的小票文本
      .actionCut(StarXpandCommand.Printer.CutType.PARTIAL))
)
val commands = builder.getCommands()
port.write(commands.toByteArray(Charsets.US_ASCII))   // 或 StarIO 的 printRasterReceipt
```

接单侧现在就能用 Python 代理（局域网内先跑通）：

```bash
# 服务器上，driver 切成 queue，agent key 填 k-test
python3 agent.py --server http://127.0.0.1:8899 --key k-test --print file     # 只落盘，验证链路
python3 agent.py --server http://127.0.0.1:8899 --key k-test --print net --host 192.168.1.50
python3 agent.py --server http://127.0.0.1:8899 --key k-test --print rfcomm --dev /dev/rfcomm0
```

`rfcomm` 那档要先 `rfcomm bind 0 <打印机MAC>`（Linux 蓝牙串口）。**注意**：如果打印机是 StarGraphic 模式，这样直发 ESC/POS 文本可能不认，得先在 Star 驱动/futurePRNT 里切 ESC/POS 模式，或者走 SDK。

**路线 B（长期最省心）：换/加一台云打印机**

买台飞鹅云、易联云或 Star mC-Print 系列（带网口/Wi-Fi，支持 CloudPRNT）。之后网站直接 POST 一个 HTTP 接口，不用现场设备、不用公网域名、断电不丢单。TSP143IIIBi 可以留着做备用/前台。

## 微信侧要准备什么

1. 订阅号或服务号（自定义菜单接口认证号就有；个人未认证订阅号没有）。
2. 公众平台「设置与开发 → 基本配置」拿 AppID / AppSecret，**把服务器出口 IP 加白名单**（不然 access_token 报 40164）。
3. 公网 HTTPS 域名指向本服务，后台「服务器配置」URL 填 `https://你的域名/wx`，Token 跟这里一致。
   - 没域名时用 cloudflared/frp 临时隧道调试；正式上线要**备案域名**，微信内打开未备案域名会被拦。
   - 本机自测：`curl "http://127.0.0.1:8899/wx?signature=<sha1>&timestamp=1&nonce=1&echostr=hello"` 回 `hello` 即通。
4. 菜单推上去后，手机取关再关注一次就能看到新菜单（微信最多缓存 24 小时）。

## 目录

```
server.py       HTTP 服务 + 全部接口（微信回调 / 菜单 / 订单 / 打印队列）
wxapi.py        微信签名、access_token、menu create/get/delete、客服消息、网页授权
menu_spec.py    菜单规则校验 + 默认三栏模板
printers.py     dryrun / feie / net / queue 四个驱动
receipt.py      小票渲染（等宽文本 / ESC-POS 字节 / 飞鹅标签）
agent.py        现场取单代理（file / net / rfcomm）
store.py        JSON 存储：配置 / 订单 / 打印队列 / 事件
static/         控制台 index.html、点单页 order.html
selftest.py     33 项自测
```

## 接口

```
GET  /                      控制台
GET  /order                 点单页
GET  /wx                    微信服务器验证（sha1 校验）
POST /wx                    菜单点击事件回调
GET  /api/state             配置 + 菜单草稿 + 订单 + 事件
POST /api/config            保存配置
POST /api/menu/draft|push   保存草稿 / 推送菜单（含规则校验）
GET  /api/menu/pull         拉线上菜单     POST /api/menu/delete
POST /api/order             下单 → 自动打印
GET  /api/receipt?no=       小票文本 + ESC/POS 字节头
POST /api/order/reprint     重打
POST /api/print/test        打印测试页
GET  /api/agent/next?key=   现场设备取单（返回小票文本）
POST /api/agent/ack         现场设备回报结果
GET  /api/jobs              打印队列
```
