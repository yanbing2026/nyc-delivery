# -*- coding: utf-8 -*-
"""打印驱动：预览(dryrun) / 飞鹅云 / 网络 ESC-POS(9100 端口直连)。

三个驱动的共同接口：
    printer = build_printer(cfg)
    printer.print_text(text, order=order, copies=1) -> {"ok": bool, "driver": str, ...}
"""
from __future__ import annotations

import hashlib
import json
import os
import socket
import time
import urllib.parse
import urllib.request

import receipt as R
import store as store_mod

BASE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(store_mod.DATA, "prints")
FEIE_API = "http://api.feieyun.cn/Api/Open/"


class PrintError(Exception):
    pass


def feie_sign(user: str, ukey: str, stime: str) -> str:
    """飞鹅云签名：sha1(user + UKEY + stime)，40 位小写。"""
    return hashlib.sha1((user + ukey + stime).encode("utf-8")).hexdigest()


class DryRunPrinter:
    """不碰真打印机：把字节流和文本存盘，前端直接预览。"""
    driver = "dryrun"

    def __init__(self, cfg: dict):
        self.cfg = cfg

    def print_text(self, text: str, order: dict | None = None, copies: int = 1) -> dict:
        os.makedirs(OUT_DIR, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        order_no = (order or {}).get("no", "TEST")
        escpos = R.to_escpos(text, cutter=True)
        base = os.path.join(OUT_DIR, "%s_%s" % (order_no, stamp))
        txt_path = base + ".txt"
        bin_path = base + ".bin"
        with open(txt_path, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        with open(bin_path, "wb") as f:
            f.write(escpos)
        return {
            "ok": True,
            "driver": self.driver,
            "mode": "预览模式（没有真的连打印机）",
            "copies": copies,
            "bytes": len(escpos),
            "files": [txt_path, bin_path],
            "escpos_hex_head": escpos[:16].hex(" "),
            "text": text,
        }


class FeiePrinter:
    """飞鹅云打印机：POST http://api.feieyun.cn/Api/Open/  form-urlencoded。"""
    driver = "feie"

    def __init__(self, cfg: dict):
        p = cfg.get("feie", {})
        self.user = (p.get("user") or "").strip()
        self.ukey = (p.get("ukey") or "").strip()
        self.sn = (p.get("sn") or "").strip()
        self.base = (p.get("api_base") or FEIE_API).strip()

    def _post(self, apiname: str, extra: dict) -> dict:
        stime = str(int(time.time()))
        form = {
            "user": self.user,
            "stime": stime,
            "sig": feie_sign(self.user, self.ukey, stime),
            "apiname": apiname,
        }
        form.update(extra)
        data = urllib.parse.urlencode(form).encode("utf-8")
        req = urllib.request.Request(
            self.base,
            data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))

    def print_text(self, text: str, order: dict | None = None, copies: int = 1) -> dict:
        if not (self.user and self.ukey and self.sn):
            raise PrintError("飞鹅云参数不全：需要 user / ukey / sn（打印机编号）")
        res = self._post(
            "Open_printMsg",
            {"sn": self.sn, "content": R.to_feie(text), "times": str(max(1, int(copies)))},
        )
        return {
            "ok": res.get("ret") == 0,
            "driver": self.driver,
            "request": {"apiname": "Open_printMsg", "sn": self.sn, "times": copies},
            "response": res,
            "raw": res,
        }


class NetEscPosPrinter:
    """网口小票机 / 云盒直连：TCP 9100 发 ESC/POS 原始字节。"""
    driver = "net"

    def __init__(self, cfg: dict):
        p = cfg.get("net", {})
        self.host = (p.get("host") or "").strip()
        self.port = int(p.get("port") or 9100)
        self.timeout = float(p.get("timeout") or 5)

    def print_text(self, text: str, order: dict | None = None, copies: int = 1) -> dict:
        if not self.host:
            raise PrintError("网络打印机没填 IP/主机名")
        data = R.to_escpos(text, cutter=True) * max(1, int(copies))
        with socket.create_connection((self.host, self.port), timeout=self.timeout) as s:
            s.sendall(data)
        return {
            "ok": True,
            "driver": self.driver,
            "target": "%s:%d" % (self.host, self.port),
            "bytes": len(data),
            "copies": copies,
            "text": text,
        }


class QueuePrinter:
    """排队模式：网站不直接连打印机，把任务丢进队列，由店内连着打印机的设备来取。
    蓝牙打印机（如 Star TSP143IIIBi）只能这么接：蓝牙是点对点短距连接，
    服务器碰不到它，必须由现场那台手机/平板/PC 拉单后走蓝牙或 USB 打出去。
    """
    driver = "queue"

    def __init__(self, cfg: dict):
        q = cfg.get("queue", {}) or {}
        self.agent_key = (q.get("agent_key") or "change-me").strip()
        self.target = (q.get("target") or "前台平板").strip()

    def print_text(self, text: str, order: dict | None = None, copies: int = 1) -> dict:
        job = store_mod.add_job({
            "text": text,
            "copies": max(1, int(copies)),
            "target": self.target,
            "order_no": (order or {}).get("no", ""),
            "shop": (order or {}).get("_shop_name", ""),
        })
        return {
            "ok": True,
            "driver": self.driver,
            "mode": "已排入打印队列，等「%s」来取单" % self.target,
            "job_id": job["id"],
            "pending": len(store_mod.pending_jobs()),
            "agent_key_hint": self.agent_key[:3] + "***",
            "text": text,
        }


DRIVERS = {"dryrun": DryRunPrinter, "feie": FeiePrinter, "net": NetEscPosPrinter,
           "queue": QueuePrinter}


def build_printer(cfg: dict):
    drv = (cfg.get("driver") or "dryrun").lower()
    if drv not in DRIVERS:
        raise PrintError("未知打印驱动：%s（可选 %s）" % (drv, "/".join(DRIVERS)))
    return DRIVERS[drv](cfg)


def print_order(cfg: dict, order: dict, shop: dict, width: int = 32, copies: int = 1) -> dict:
    text = R.render_receipt(order, shop, width)
    printer = build_printer(cfg)
    out = printer.print_text(text, order=order, copies=copies)
    out["order_no"] = order.get("no")
    return out


def test_page(cfg: dict, shop: dict, width: int = 32) -> dict:
    order = {
        "no": "TEST-" + time.strftime("%H%M%S"),
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "items": [{"name": "测试商品", "qty": 1, "price": 0.01}],
        "pay_type": "打印测试",
        "footer": "打印链路正常",
    }
    return print_order(cfg, order, shop, width=width)
