# -*- coding: utf-8 -*-
"""自测：签名/校验/小票/驱动/HTTP 全链路。跑法：python3 selftest.py"""
from __future__ import annotations

import json
import os
import socket
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer

# 自测用独立数据目录，跑多少次结果都一样（不受上一轮残留订单/队列影响）
os.environ["WXMENU_DATA_DIR"] = tempfile.mkdtemp(prefix="wxmenu-selftest-")

import menu_spec
import printers
import receipt as R
import store
import wxapi

FAILS: list[str] = []


def check(name, cond, extra=""):
    print(("  ✓ " if cond else "  ✗ ") + name + (("  ← " + str(extra)) if (extra and not cond) else ""))
    if not cond:
        FAILS.append(name)


print("== 1. 微信服务器验证签名（sha1 独立算过：123abcxyz → 94ffbd20…） ==")
check("正确签名通过", wxapi.check_signature("abc", "94ffbd20c84766e871799062cb1bc3e3f40c5e13", "123", "xyz"))
check("错误签名拒绝", not wxapi.check_signature("abc", "deadbeef", "123", "xyz"))
check("token 不对也拒绝", not wxapi.check_signature("abc2", "94ffbd20c84766e871799062cb1bc3e3f40c5e13", "123", "xyz"))

print("== 2. 飞鹅云签名 sha1(user+UKEY+stime)（独立算过：5228b0a5…） ==")
check("签名正确", printers.feie_sign("demo", "-ukey-", "1700000000") ==
      "5228b0a57893021a9e6ca34e360c4289bb3c906c",
      printers.feie_sign("demo", "-ukey-", "1700000000"))

print("== 3. 菜单规则校验 ==")
ok_menu = menu_spec.default_menu("https://shop.example.com/order")
check("默认菜单无错误", not menu_spec.validate(ok_menu), menu_spec.validate(ok_menu))
bad = json.loads(json.dumps(ok_menu))
bad["button"][0]["name"] = "六个汉字超长了"          # 21 字节 > 16
check("一级名称超 16 字节被拦", any("超长" in e for e in menu_spec.validate(bad)), menu_spec.validate(bad))
bad2 = json.loads(json.dumps(ok_menu))
bad2["button"].append({"name": "第四个", "type": "click", "key": "K"})
check("4 个一级菜单被拦", any("最多 3 个" in e for e in menu_spec.validate(bad2)))
bad3 = json.loads(json.dumps(ok_menu))
bad3["button"][0]["sub_button"] = [{"type": "click", "name": "只有一个", "key": "K"}]
check("二级只有 1 个被拦", any("2~5 个" in e for e in menu_spec.validate(bad3)))
bad4 = json.loads(json.dumps(ok_menu))
bad4["button"][0]["sub_button"][0] = {"type": "view", "name": "没URL"}
check("view 缺 url 被拦", any("必须填 url" in e for e in menu_spec.validate(bad4)))
bad5 = json.loads(json.dumps(ok_menu))
bad5["button"][0]["sub_button"][0] = {"type": "view", "name": "占位", "url": "http://你的域名/order"}
check("占位域名被提示（demo 可以，上线要换）", any("占位" in e for e in menu_spec.validate(bad5)))

print("== 4. 小票渲染 + ESC/POS 字节 ==")
order = {"no": "2509150001", "created_at": "2026-09-15 12:00:00", "openid": "oDemoOpenid0001",
         "table": "A3", "remark": "少辣",
         "items": [{"name": "琅岐海蛎煎", "qty": 2, "price": 28.0},
                   {"name": "茉莉花茶", "qty": 1, "price": 8.0}],
         "pay_type": "微信支付", "footer": "谢谢惠顾|欢迎再来"}
text = R.render_receipt(order, {"name": "琅岐海鲜小馆", "slogan": "-- 现捞现做 --",
                                "phone": "0591-8888 8888", "footer": "谢谢惠顾|欢迎再来"}, 32)
print("\n".join("    |" + l for l in text.split("\n")[:8]))
check("每行不超过 32 半角宽", all(R.dw(l) <= 32 for l in text.split("\n")),
      [l for l in text.split("\n") if R.dw(l) > 32])
check("合计 = 64.00", "64.00" in text)
esc = R.to_escpos(text)
check("ESC/POS 以初始化 1b40 开头", esc.startswith(b"\x1b\x40"), esc[:6].hex())
check("ESC/POS 以切纸 1d564200 结尾", esc.endswith(b"\x1d\x56\x42\x00"), esc[-6:].hex())
check("中文按 GBK 编码", "琅岐海鲜小馆".encode("gbk") in esc)
feie_txt = R.to_feie(text)
check("飞鹅标签：含 <CUT> 和 <BR>", feie_txt.endswith("<CUT>") and "<BR>" in feie_txt)

print("== 5. 网络 ESC/POS 驱动（本地假打印机收字节） ==")
received = bytearray()
srv_sock = socket.socket()
srv_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv_sock.bind(("127.0.0.1", 19100))
srv_sock.listen(1)


def fake_printer():
    conn, _ = srv_sock.accept()
    with conn:
        while True:
            chunk = conn.recv(4096)
            if not chunk:
                break
            received.extend(chunk)


t = threading.Thread(target=fake_printer, daemon=True)
t.start()
res = printers.build_printer({"driver": "net", "net": {"host": "127.0.0.1", "port": 19100}}) \
    .print_text(text, order=order)
time.sleep(0.3)
srv_sock.close()
check("net 驱动返回 ok", res.get("ok") is True, res)
check("打印机收到的字节与 ESC/POS 完全一致", bytes(received) == esc,
      "%d vs %d 字节" % (len(received), len(esc)))

print("== 6. dryrun 落盘 ==")
res = printers.build_printer({"driver": "dryrun"}).print_text(text, order=order)
check("dryrun 写出 txt+bin", res["ok"] and all(os.path.exists(f) for f in res["files"]), res["files"])
check("bin 文件大小与字节数一致", os.path.getsize(res["files"][1]) == res["bytes"])

print("== 7. HTTP 全链路（真起服务器 127.0.0.1:8891） ==")
import server  # noqa: E402

httpd = ThreadingHTTPServer(("127.0.0.1", 8891), server.Handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = "http://127.0.0.1:8891"


def url(path, data=None, raw=False, ctype="application/json"):
    req = urllib.request.Request(BASE + path, method="POST" if data is not None else "GET")
    body = None
    if data is not None:
        body = data if isinstance(data, bytes) else json.dumps(data).encode()
        req.data = body
        req.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            txt = r.read().decode()
            return r.status, (txt if raw else json.loads(txt))
    except urllib.error.HTTPError as e:
        txt = e.read().decode()
        return e.code, (txt if raw else json.loads(txt))


st = url("/api/state")[1]
check("GET /api/state 返回配置", "config" in st and st["config"]["printer"]["driver"] in printers.DRIVERS)

# 微信服务器验证
import hashlib  # noqa: E402
tok = st["config"]["wechat"]["token"]
raw = "".join(sorted([tok, "1700000000", "nonce1"]))
sig = hashlib.sha1(raw.encode()).hexdigest()
code, body = url("/wx?signature=%s&timestamp=1700000000&nonce=nonce1&echostr=hello123" % sig, raw=True)
check("GET /wx 正确签名回 echostr", code == 200 and body == "hello123", (code, body))
code, _ = url("/wx?signature=bad&timestamp=1700000000&nonce=nonce1&echostr=hello", raw=True)
check("GET /wx 错误签名 403", code == 403, code)

# 菜单推送（demo 模式回放真实请求体）
url("/api/menu/draft", {"menu": menu_spec.default_menu("https://shop.example.com/order")})
code, push = url("/api/menu/push", {})
check("POST /api/menu/push 成功（demo）", code == 200 and push["ok"] is True, push)
check("推送请求体是微信 menu/create 格式", push["result"]["http"]["body"]["button"][0]["sub_button"][0]["type"] == "view", push.get("result"))
check("推送 URL 正确", push["result"]["http"]["url"].startswith("https://api.weixin.qq.com/cgi-bin/menu/create?access_token="))
bad_menu = json.loads(json.dumps(menu_spec.default_menu()))
bad_menu["button"][0]["name"] = "一二三四五六七八"
url("/api/menu/draft", {"menu": bad_menu})
code, push2 = url("/api/menu/push", {})
check("非法菜单推送被挡（400）", code == 400 and push2["ok"] is False, (code, push2))
url("/api/menu/draft", {"menu": menu_spec.default_menu("https://shop.example.com/order")})

# 微信消息回调
xml = """<xml><ToUserName><![CDATA[gh_demo]]></ToUserName><FromUserName><![CDATA[oUser123]]></FromUserName>
<CreateTime>1700000000</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[CLICK]]></Event>
<EventKey><![CDATA[MY_ORDERS]]></EventKey></xml>"""
code, _ = url("/wx", xml.encode(), raw=True, ctype="application/xml")
check("POST /wx 处理菜单点击事件", code == 200)
ev = url("/api/events")[1]["events"]
check("事件进了日志", any(e["kind"] == "wx_callback" and e["payload"]["key"] == "MY_ORDERS" for e in ev))
check("客服消息在 demo 下被回放", any(e["kind"] == "wx_callback" for e in ev))

# 下单 → 打印（自测不联网：走自取，不触发地址解析）
code, o = url("/api/order", {"items": [{"name": "海蛎煎", "qty": 2, "price": 28.0}],
                             "pickup": True, "customer": "张三", "phone": "917-555-0123",
                             "pay_type": "现金 Cash"})
check("POST /api/order 自取下单成功", code == 200 and o["ok"], o)
check("自动打印成功(dryrun)", o["print"] and o["print"]["ok"], o.get("print"))
check("小计 56.00", o["order"]["subtotal"] == 56.0, o["order"]["subtotal"])
check("税 = 56 × 8.875% = 4.97", o["order"]["tax"] == 4.97, o["order"]["tax"])
check("自取不收配送费", o["order"]["delivery_fee"] == 0.0, o["order"]["delivery_fee"])
check("合计 60.97", o["order"]["total"] == 60.97, o["order"]["total"])
rc = url("/api/receipt?no=" + o["order"]["no"])[1]
check("GET /api/receipt 出小票", rc["ok"] and "60.97" in rc["text"] and "到店自取" in rc["text"], rc.get("error"))
check("小票上有顾客和电话", "张三" in rc["text"] and "917-555-0123" in rc["text"])
code, nope = url("/api/order", {"items": [{"name": "海蛎煎", "qty": 2, "price": 28.0}]})
check("外送不给地址 → 直接拒单", code == 200 and nope["ok"] is False and "地址" in nope["error"], nope.get("error"))
code, q2 = url("/api/quote?pickup=1&subtotal=42")
check("GET /api/quote 自取报价", code == 200 and q2["ok"] and q2["total"] == 45.73, q2.get("error"))
code, rp = url("/api/order/reprint", {"no": o["order"]["no"]})
check("重打接口可用", code == 200 and rp["ok"])

print("== 8. 排队模式 + 取单代理（蓝牙打印机的接法） ==")
url("/api/config", {"printer": {"driver": "queue", "queue": {"agent_key": "k-test", "target": "前台平板"}}})
code, o2 = url("/api/order", {"items": [{"name": "荔枝肉", "qty": 1, "price": 32.0}], "pickup": True})
check("queue 驱动下单成功", o2["ok"] and o2["print"]["driver"] == "queue", o2.get("print"))
code, denied = url("/api/agent/next?key=wrong")
check("agent key 不对返回 403", code == 403, code)
code, got = url("/api/agent/next?key=k-test")
check("代理取到任务", code == 200 and got["job"] and got["job"]["order_no"] == o2["order"]["no"], got)
check("任务里带完整小票文本", "荔枝肉" in got["job"]["text"] and "32.00" in got["job"]["text"])
code, again = url("/api/agent/next?key=k-test")
check("同一个任务不会被取两次", again["job"] is None, again)
code, ack = url("/api/agent/ack", {"key": "k-test", "id": got["job"]["id"], "ok": True})
check("回报成功写入", ack["ok"] and ack["job"]["status"] == "done", ack)
jn = url("/api/jobs")[1]
check("任务列表可查", jn["jobs"] and jn["jobs"][0]["status"] == "done")

httpd.shutdown()

print()
if FAILS:
    print("❌ %d 项失败：%s" % (len(FAILS), "；".join(FAILS)))
    raise SystemExit(1)
print("✅ 全部通过（%s）" % time.strftime("%Y-%m-%d %H:%M:%S"))
