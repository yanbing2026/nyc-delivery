# -*- coding: utf-8 -*-
"""微信公众号自定义菜单 + 云打印 演示站（Python 标准库，零依赖）。

启动：  python3 server.py  [端口]
默认：  http://127.0.0.1:8899

接口一览
  GET  /                     控制台（菜单编辑器 + 打印配置 + 订单）
  GET  /order                微信内打开的点单页（H5）
  GET  /wx                   微信服务器配置校验
  POST /wx                   微信消息/菜单点击事件回调
  GET  /api/state            配置 + 菜单草稿 + 模式
  POST /api/config           保存配置
  POST /api/menu/draft       保存菜单草稿
  GET  /api/menu/preview     按微信规则校验草稿，返回完整请求体
  POST /api/menu/push        推送菜单到微信（live 真调 / demo 回放请求）
  GET  /api/menu/pull        拉取线上菜单
  POST /api/menu/delete      删除线上菜单
  POST /api/order            下单 → 渲染小票 → 送打印
  GET  /api/orders           订单列表
  POST /api/order/reprint    重打某单
  POST /api/print/test       打印测试页
  GET  /api/events           微信回调事件日志
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import delivery
import menu_spec
import printers
import receipt as R
import store
import wxapi

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")
CTYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
          ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
          ".png": "image/png", ".txt": "text/plain; charset=utf-8"}


def _wx() -> wxapi.WeChat:
    cfg = store.config()
    return wxapi.WeChat(cfg, cfg.get("mode", "demo"))


def _printer_cfg() -> dict:
    cfg = store.config()
    p = dict(cfg.get("printer", {}))
    p.setdefault("driver", "dryrun")
    return p


def _width() -> int:
    return int(store.config().get("printer", {}).get("width", 32) or 32)


def _next_order_no() -> str:
    return time.strftime("%y%m%d%H%M%S") + str(int(time.time() * 1000) % 1000).zfill(3)


# ---------------------------------------------------------------- 业务
def do_order(payload: dict) -> dict:
    cfg = store.config()
    items = payload.get("items") or []
    if not items:
        return {"ok": False, "error": "购物车是空的"}
    d = cfg.get("delivery", {})
    pickup = bool(payload.get("pickup"))
    tip_rate = float(payload.get("tip_rate") or 0)
    req = {
        "no": _next_order_no(),
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "customer": (payload.get("customer") or "").strip(),
        "phone": (payload.get("phone") or "").strip(),
        "openid": payload.get("openid") or "",
        "pickup": pickup,
        "remark": payload.get("remark") or "",
        "pay_type": payload.get("pay_type") or "",
        "tip_rate": tip_rate,
        "items": [
            {"name": i.get("name", ""), "qty": int(i.get("qty", 1)),
             "price": float(i.get("price", 0)), "spec": i.get("spec", "")}
            for i in items
        ],
        "source": payload.get("source") or "h5",
    }
    subtotal = round(sum(i["price"] * i["qty"] for i in req["items"]), 2)
    # 报价一律服务端重算，不信前端传来的金额
    try:
        q = delivery.quote(d.get("restaurant") or {}, payload.get("address", ""), subtotal, d,
                           tip_rate=tip_rate, pickup=pickup)
    except Exception as e:
        return {"ok": False, "error": "地址解析失败：%s" % e}
    if not q.get("ok"):
        # 只有两种不接单的情况：超出配送范围 / 地址不合格或未到起送价
        return {"ok": False, "error": q.get("error") or "无法配送", "quote": q}
    manual = False
    if not pickup and (q.get("distance") or {}).get("ok") is False:
        # 路线服务抽风，距离是直线×1.35 估算的：按兜底配送费接单并标记待人工确认
        q["needs_manual_review"] = True
        manual = True
    req.update({
        "address": (q.get("address") or {}).get("matched") or payload.get("address") or "",
        "address_input": payload.get("address") or "",
        "borough": (q.get("address") or {}).get("borough") or "",
        "distance_miles": (q.get("distance") or {}).get("miles"),
        "drive_minutes": (q.get("distance") or {}).get("minutes"),
        "eta_minutes": q.get("eta_minutes"),
        "subtotal": q["subtotal"],
        "tax": q["tax"],
        "tax_rate": q.get("tax_rate"),
        "tip": q["tip"],
        "delivery_fee": q["delivery_fee"],
        "total": q["total"],
        "needs_manual_review": manual,
    })
    print_result = None
    if cfg.get("auto_print", True):
        print_result = print_one(req)
    store.add_order(req)
    store.log_event("order", {"no": req["no"], "total": req["total"], "pickup": pickup,
                              "miles": req["distance_miles"],
                              "print_ok": (print_result or {}).get("ok")})
    return {"ok": True, "order": req, "print": print_result, "quote": q}


def print_one(order: dict) -> dict:
    try:
        res = printers.print_order(_printer_cfg(), order, store.config().get("shop", {}), _width())
    except printers.PrintError as e:
        res = {"ok": False, "error": str(e)}
    except Exception as e:  # 网络/接口异常也要让页面看到原因
        res = {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
    store.update_order(order.get("no", ""), last_print=res)
    return res


# ---------------------------------------------------------------- 微信回调
def handle_wx_message(xml_text: str) -> str:
    """处理菜单点击等事件；返回给微信的响应体（空串=success）。"""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return ""
    msg = {c.tag: (c.text or "") for c in root}
    from_user = msg.get("FromUserName", "")
    msg_type = msg.get("MsgType", "")
    event = msg.get("Event", "").upper()
    key = msg.get("EventKey", "")
    store.log_event("wx_callback", {"type": msg_type, "event": event, "key": key,
                                    "from": from_user[:12] + "..." if from_user else ""})
    cfg = store.config()
    base = cfg.get("public_base") or ""
    wx = _wx()
    replies = {
        "MY_ORDERS": "你还没有订单哦～ 点「我要点单」开始点菜。",
        "CALL_SERVICE": "客服电话：%s" % cfg.get("shop", {}).get("phone", ""),
        "SHOP_INFO": "%s\n%s\n电话 %s" % (cfg.get("shop", {}).get("name", ""),
                                          cfg.get("shop", {}).get("addr", ""),
                                          cfg.get("shop", {}).get("phone", "")),
        "PROMO_TODAY": "今日特价：琅岐海蛎煎 9.9 元，限今日。",
    }
    if event == "CLICK" and key == "PRINT_TEST":
        res = printers.test_page(_printer_cfg(), cfg.get("shop", {}), _width()) if True else {}
        wx.send_text(from_user, "打印测试已下发：%s" % ("成功" if res.get("ok") else res.get("error")))
    elif event == "CLICK" and key in replies:
        wx.send_text(from_user, replies[key])
    elif event in ("subscribe", "SCAN"):
        wx.send_text(from_user, "谢谢关注！点下面的菜单就能点单，做好会直接打小票到厨房。")
    elif msg_type == "text" and "点单" in msg.get("Content", ""):
        wx.send_text(from_user, "在线点单：%s/order" % base)
    return ""


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "wxmenu/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[web] %s - %s\n" % (self.address_string(), fmt % args))

    # --- 工具 ---
    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        # 允许 GitHub Pages 上的静态前端直接调这个后端（点单页真下单用）
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, b"", "text/plain; charset=utf-8")

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False, indent=2).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return dict(urllib.parse.parse_qsl(raw.decode("utf-8", "replace")))

    def _file(self, path: str) -> None:
        if not os.path.exists(path) or not os.path.isfile(path):
            return self._json({"ok": False, "error": "not found: %s" % path}, 404)
        ext = os.path.splitext(path)[1]
        with open(path, "rb") as f:
            self._send(200, f.read(), CTYPES.get(ext, "application/octet-stream"))

    # --- 路由 ---
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        p = u.path
        if p in ("/", "/index.html"):
            return self._file(os.path.join(STATIC, "index.html"))
        if p in ("/order", "/order.html"):
            return self._file(os.path.join(STATIC, "order.html"))
        if p.startswith("/static/"):
            safe = os.path.normpath(p[len("/static/"):]).lstrip("/.")
            return self._file(os.path.join(STATIC, safe))
        if p == "/wx":
            return self._wx_verify(q)
        if p == "/api/state":
            cfg = store.config()
            return self._json({
                "config": cfg,
                "menu": store.load("menu.json", menu_spec.default_menu(cfg.get("public_base", "") + "/order")),
                "orders": store.orders()[:30],
                "events": store.events()[:20],
                "errors": menu_spec.validate(store.load("menu.json", menu_spec.default_menu(cfg.get("public_base", "") + "/order"))),
                "menu_types": sorted(menu_spec.VALID_TYPES),
                "drivers": list(printers.DRIVERS),
            })
        if p == "/api/menu/preview":
            m = store.load("menu.json", menu_spec.default_menu())
            m = menu_spec.normalize(m)
            return self._json({"menu": m, "errors": menu_spec.validate(m),
                               "endpoint": "POST https://api.weixin.qq.com/cgi-bin/menu/create?access_token=ACCESS_TOKEN"})
        if p == "/api/menu/pull":
            try:
                wx = _wx()
                return self._json({"ok": True, "mode": wx.mode, "data": wx.menu_get(),
                                   "selfmenu": wx.selfmenu_info()})
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 500)
        if p == "/api/orders":
            return self._json({"orders": store.orders()})
        if p == "/api/jobs":
            return self._json({"jobs": store.jobs()[:30],
                               "pending": len(store.pending_jobs())})
        if p == "/api/autocomplete":
            try:
                return self._json({"ok": True, "items": delivery.geocode_candidates(q.get("q", ""), limit=6)})
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 500)
        if p == "/api/quote":
            cfg = store.config()
            d = cfg.get("delivery", {})
            rest = d.get("restaurant") or {}
            try:
                out = delivery.quote(rest, q.get("address", ""), float(q.get("subtotal") or 0), d,
                                     tip_rate=float(q.get("tip_rate") or 0),
                                     pickup=(q.get("pickup") in ("1", "true", "yes")))
                out["address_check"] = delivery.looks_like_address(q.get("address", ""))
                return self._json(out)
            except Exception as e:
                return self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, 500)
        if p == "/api/restaurant":
            try:
                return self._json({"ok": True, "check": delivery.check_restaurant(store.config().get("delivery", {}))})
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 500)
        if p == "/api/agent/next":
            key = (store.config().get("printer", {}).get("queue", {}) or {}).get("agent_key", "")
            if not key or q.get("key") != key:
                return self._json({"ok": False, "error": "agent key 不对"}, 403)
            job = store.next_job()
            if not job:
                return self._json({"ok": True, "job": None, "msg": "没有待打印任务"})
            job = store.update_job(job["id"], status="taken",
                                   taken_at=time.strftime("%Y-%m-%d %H:%M:%S"))
            return self._json({"ok": True, "job": job})
        if p == "/api/events":
            return self._json({"events": store.events()})
        if p == "/api/receipt":
            order = store.load("orders.json", [])
            no = q.get("no", "")
            hit = next((o for o in order if o.get("no") == no), None)
            if not hit:
                return self._json({"ok": False, "error": "订单不存在"}, 404)
            text = R.render_receipt(hit, store.config().get("shop", {}), _width())
            return self._json({"ok": True, "text": text,
                               "escpos_hex": R.to_escpos(text)[:64].hex(" "), "order": hit})
        if p == "/api/oauth":
            base = store.config().get("public_base") or ("http://" + self.headers.get("Host", "127.0.0.1"))
            return self._json({"ok": True, "url": _wx().oauth_url(
                (q.get("redirect") or (base + "/order")), q.get("scope", "snsapi_base"))})
        return self._json({"ok": False, "error": "没有这个接口：%s" % p}, 404)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        p = u.path
        if p == "/wx":
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n).decode("utf-8", "replace") if n else ""
            handle_wx_message(raw)
            return self._send(200, b"", "text/plain; charset=utf-8")
        body = self._body()
        if p == "/api/config":
            return self._json({"ok": True, "config": store.save_config(body)})
        if p == "/api/menu/draft":
            m = menu_spec.normalize(body.get("menu", body))
            store.save("menu.json", m)
            return self._json({"ok": True, "menu": m, "errors": menu_spec.validate(m)})
        if p == "/api/menu/push":
            m = menu_spec.normalize(store.load("menu.json", menu_spec.default_menu()))
            errs = menu_spec.validate(m)
            if errs:
                return self._json({"ok": False, "errors": errs,
                                   "hint": "先修掉这些校验错误再推送"}, 400)
            try:
                res = _wx().menu_create(m)
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 500)
            store.log_event("menu_push", res)
            return self._json({"ok": True, "result": res})
        if p == "/api/menu/delete":
            try:
                return self._json({"ok": True, "result": _wx().menu_delete()})
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 500)
        if p == "/api/print/test":
            try:
                return self._json({"ok": True, "result": printers.test_page(
                    _printer_cfg(), store.config().get("shop", {}), _width())})
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 500)
        if p == "/api/order":
            return self._json(do_order(body))
        if p == "/api/agent/ack":
            key = (store.config().get("printer", {}).get("queue", {}) or {}).get("agent_key", "")
            if not key or body.get("key") != key:
                return self._json({"ok": False, "error": "agent key 不对"}, 403)
            ok = bool(body.get("ok"))
            j = store.update_job(str(body.get("id", "")),
                                 status="done" if ok else "failed",
                                 done_at=time.strftime("%Y-%m-%d %H:%M:%S"),
                                 error=str(body.get("error", ""))[:200])
            store.log_event("print_job", {"id": body.get("id"), "ok": ok,
                                          "error": body.get("error", "")})
            return self._json({"ok": True, "job": j})
        if p == "/api/order/reprint":
            no = body.get("no", "")
            hit = next((o for o in store.orders() if o.get("no") == no), None)
            if not hit:
                return self._json({"ok": False, "error": "订单不存在"}, 404)
            return self._json({"ok": True, "print": print_one(hit)})
        return self._json({"ok": False, "error": "没有这个接口：%s" % p}, 404)

    # --- 微信服务器验证 ---
    def _wx_verify(self, q: dict):
        token = store.config().get("wechat", {}).get("token", "")
        ok = wxapi.check_signature(token, q.get("signature", ""), q.get("timestamp", ""), q.get("nonce", ""))
        store.log_event("wx_verify", {"ok": ok, "echostr": q.get("echostr", "")[:20]})
        if not ok:
            return self._send(403, b"signature check failed", "text/plain; charset=utf-8")
        echo = q.get("echostr", "")
        if echo in ("", None):
            return self._json({"ok": True, "msg": "signature ok（微信服务器验证通过）"})
        return self._send(200, echo.encode("utf-8"), "text/plain; charset=utf-8")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    if not store.load("menu.json", None):
        store.save("menu.json", menu_spec.default_menu(store.config().get("public_base", "") + "/order"))
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print("控制台:  http://127.0.0.1:%d/" % port)
    print("点单页:  http://127.0.0.1:%d/order" % port)
    print("微信回调: http://<你的公网域名>/wx   (Token 见配置页)")
    srv.serve_forever()


if __name__ == "__main__":
    main()
