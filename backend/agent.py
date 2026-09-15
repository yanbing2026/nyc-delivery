#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""现场取单代理 agent.py —— 跑在店里那台跟打印机相连的机器上。

服务器（网站）只负责把订单排进队列；这台机器不停地问「有没有单」，
拿到就通过下面三种方式之一打出来，然后回报结果。

用法：
  python3 agent.py --server http://127.0.0.1:8899 --key change-me --print file
  python3 agent.py --server http://127.0.0.1:8899 --key change-me --print net --host 192.168.1.50
  python3 agent.py --server http://127.0.0.1:8899 --key change-me --print rfcomm --dev /dev/rfcomm0

  --print file    存成文件（先验证链路，不碰打印机）
  --print net     局域网/网口小票机，TCP 9100 直发 ESC/POS 字节
  --print rfcomm  Linux 蓝牙串口（先 rfcomm bind 0 <打印机MAC> /dev/rfcomm0）
  --once          只跑一轮（调试用）
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import time
import urllib.parse
import urllib.request

import receipt as R

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "prints")


def log(msg: str) -> None:
    print("[%s] %s" % (time.strftime("%H:%M:%S"), msg), flush=True)


def http_json(url: str, payload: dict | None = None) -> dict:
    req = urllib.request.Request(url, method="POST" if payload is not None else "GET")
    if payload is not None:
        req.data = json.dumps(payload).encode()
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def print_net(text: str, host: str, port: int) -> None:
    data = R.to_escpos(text, cutter=True)
    with socket.create_connection((host, port), timeout=8) as s:
        s.sendall(data)
    log("已发 %d 字节到 %s:%d" % (len(data), host, port))


def print_rfcomm(text: str, dev: str) -> None:
    data = R.to_escpos(text, cutter=True)
    with open(dev, "wb", buffering=0) as f:
        f.write(data)
        time.sleep(0.5)
    log("已写 %d 字节到 %s" % (len(data), dev))


def print_file(text: str, job_id: str) -> None:
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "agent_%s.txt" % job_id)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text + "\n")
    log("已保存小票 → %s" % path)
    print(text)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default="http://127.0.0.1:8899")
    ap.add_argument("--key", default="change-me", help="控制台「打印设置」里的 agent key")
    ap.add_argument("--print", dest="mode", default="file", choices=["file", "net", "rfcomm"])
    ap.add_argument("--host", default="192.168.1.50")
    ap.add_argument("--port", type=int, default=9100)
    ap.add_argument("--dev", default="/dev/rfcomm0")
    ap.add_argument("--interval", type=float, default=3.0)
    ap.add_argument("--once", action="store_true")
    a = ap.parse_args()
    base = a.server.rstrip("/")
    log("取单代理启动：%s → %s" % (base, a.mode))

    while True:
        try:
            q = urllib.parse.urlencode({"key": a.key})
            got = http_json("%s/api/agent/next?%s" % (base, q))
            job = got.get("job")
            if job:
                text = job.get("text", "")
                err = ""
                try:
                    if a.mode == "net":
                        print_net(text, a.host, a.port)
                    elif a.mode == "rfcomm":
                        print_rfcomm(text, a.dev)
                    else:
                        print_file(text, job["id"])
                    log("任务 %s 打印完成（单号 %s）" % (job["id"], job.get("order_no", "")))
                except Exception as e:  # 打印失败也要回报，服务器会记下
                    err = "%s: %s" % (type(e).__name__, e)
                    log("任务 %s 打印失败：%s" % (job["id"], err))
                http_json("%s/api/agent/ack" % base,
                          {"key": a.key, "id": job["id"], "ok": not err, "error": err})
            elif a.once:
                log("没有待打印任务")
        except Exception as e:
            log("连服务器失败：%s（%s 秒后重试）" % (e, a.interval))
        if a.once:
            return 0
        time.sleep(a.interval)


if __name__ == "__main__":
    sys.exit(main())
