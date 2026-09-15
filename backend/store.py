# -*- coding: utf-8 -*-
"""极简 JSON 存储：配置 / 订单 / 事件日志，带线程锁。"""
from __future__ import annotations

import json
import os
import threading
import time

import delivery

BASE = os.path.dirname(os.path.abspath(__file__))
# 数据目录可用环境变量隔离（自测用临时目录，避免上一轮残留数据干扰）
DATA = os.environ.get("WXMENU_DATA_DIR") or os.path.join(BASE, "data")
_lock = threading.RLock()

DEFAULT_CONFIG = {
    "mode": "demo",
    "public_base": "http://你的域名",
    "shop": {
        "name": "琅岐海鲜小馆",
        "slogan": "-- 现捞现做 --",
        "phone": "0591-8888 8888",
        "addr": "福州市马尾区琅岐岛码头旁 12 号",
        "footer": "谢谢惠顾|欢迎再来",
    },
    "wechat": {
        "appid": "",
        "appsecret": "",
        "token": "demo_token_123",
        "aeskey": "",
        "mp_name": "演示公众号",
    },
    "printer": {
        "driver": "dryrun",
        "width": 32,
        "copies": 1,
        "queue": {"agent_key": "change-me", "target": "前台平板"},
        "feie": {"user": "", "ukey": "", "sn": ""},
        "net": {"host": "", "port": 9100, "timeout": 5},
    },
    "auto_print": True,
    "delivery": dict(delivery.DEFAULT_DELIVERY),
    "menu": {
        "note": "这是占位菜单，改成你店里的菜和价格",
        "categories": [
            {"name": "招牌", "items": [
                {"id": "a1", "name": "海蛎煎", "en": "Oyster Omelette", "desc": "现点现做", "price": 12.95},
                {"id": "a2", "name": "红蟳米糕", "en": "Steamed Rice w/ Crab", "desc": "", "price": 32.95},
                {"id": "a3", "name": "福州鱼丸汤", "en": "Fuzhou Fish Ball Soup", "desc": "", "price": 9.95}]},
            {"name": "小炒", "items": [
                {"id": "b1", "name": "荔枝肉", "en": "Lychee Pork", "desc": "福州味", "price": 14.95},
                {"id": "b2", "name": "糟菜炒粉干", "en": "Rice Noodle w/ Pickled Veg", "desc": "", "price": 12.95},
                {"id": "b3", "name": "白灼虾", "en": "Boiled Shrimp", "desc": "按份", "price": 19.95},
                {"id": "b4", "name": "蒜蓉炒青菜", "en": "Garlic Chinese Broccoli", "desc": "", "price": 11.95}]},
            {"name": "主食 / 汤", "items": [
                {"id": "c1", "name": "锅边糊", "en": "Rice Noodle Soup", "desc": "", "price": 8.95},
                {"id": "c2", "name": "福州拌面", "en": "Fuzhou Lo Mein", "desc": "", "price": 9.95},
                {"id": "c3", "name": "白饭", "en": "Steamed Rice", "desc": "", "price": 2.0}]},
            {"name": "饮品", "items": [
                {"id": "d1", "name": "茉莉花茶", "en": "Jasmine Tea", "desc": "一壶", "price": 3.95},
                {"id": "d2", "name": "王老吉", "en": "Herbal Tea Can", "desc": "", "price": 2.5}]}
        ]
    },
    "hours": {"open": "11:00", "close": "22:30", "note": ""},
}


def _path(name: str) -> str:
    os.makedirs(DATA, exist_ok=True)
    return os.path.join(DATA, name)


def load(name: str, default=None):
    p = _path(name)
    if not os.path.exists(p):
        return default
    with _lock:
        try:
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return default


def save(name: str, obj) -> None:
    p = _path(name)
    with _lock:
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
        os.replace(tmp, p)


def config() -> dict:
    cfg = load("config.json", None)
    if not cfg:
        cfg = json.loads(json.dumps(DEFAULT_CONFIG))
        save("config.json", cfg)
        return cfg
    merged = json.loads(json.dumps(DEFAULT_CONFIG))
    for k, v in cfg.items():
        if isinstance(v, dict) and isinstance(merged.get(k), dict):
            merged[k].update(v)
        else:
            merged[k] = v
    return merged


def save_config(cfg: dict) -> dict:
    cur = config()
    for k, v in (cfg or {}).items():
        if isinstance(v, dict) and isinstance(cur.get(k), dict):
            cur[k].update(v)
        else:
            cur[k] = v
    save("config.json", cur)
    return cur


def orders() -> list:
    return load("orders.json", [])


def add_order(order: dict) -> None:
    with _lock:
        all_o = orders()
        all_o.insert(0, order)
        save("orders.json", all_o[:300])


def update_order(no: str, **fields) -> dict | None:
    with _lock:
        all_o = orders()
        hit = None
        for o in all_o:
            if o.get("no") == no:
                o.update(fields)
                hit = o
                break
        save("orders.json", all_o)
        return hit


def add_job(job: dict) -> dict:
    """打印队列：蓝牙/离线打印机靠现场设备来取，服务器只负责排队。"""
    with _lock:
        all_j = load("jobs.json", [])
        jid = time.strftime("%y%m%d%H%M%S") + "-" + str(len(all_j) + 1)
        rec = {"id": jid, "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
               "status": "pending", "taken_at": "", "done_at": "", "error": ""}
        rec.update(job)
        all_j.insert(0, rec)
        save("jobs.json", all_j[:300])
        return rec


def jobs() -> list:
    return load("jobs.json", [])


def pending_jobs() -> list:
    return [j for j in jobs() if j.get("status") in ("pending", "taken")]


def next_job() -> dict | None:
    for j in jobs():
        if j.get("status") == "pending":
            return j
    return None


def update_job(jid: str, **fields) -> dict | None:
    with _lock:
        all_j = jobs()
        hit = None
        for j in all_j:
            if j.get("id") == jid:
                j.update(fields)
                hit = j
                break
        save("jobs.json", all_j)
        return hit


def log_event(kind: str, payload) -> None:
    with _lock:
        logs = load("events.json", [])
        logs.insert(0, {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "kind": kind, "payload": payload})
        save("events.json", logs[:200])


def events() -> list:
    return load("events.json", [])
