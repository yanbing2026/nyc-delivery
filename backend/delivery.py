# -*- coding: utf-8 -*-
"""送餐里程与配送费计算（纽约市）。

数据源全部免费、无需 API key：
  · 地址 → 经纬度：NYC Planning Labs GeoSearch（官方，认 NY 地址，支持 CORS）
  · 经纬度 → 驾车距离：OSRM（开放路网路线）
  · 非 NY 地址兜底：Nominatim（服务端可调，浏览器无 CORS）

踩过的坑（已在代码里处理）：
  1. 不写 ZIP 会跨区解析错：request "40 Bayard St" → 布鲁克林 11211，写成 "40 Bayard St 10013" 才对（曼哈顿唐人街）。
  2. focus.point 参数压不住这种歧义，必须靠 ZIP / 区名。
  3. 纯中文地址（"法拉盛 缅街 41-28"）搜不到，只认英文街名。
  4. 只给 ZIP 会被当成街名（"11355" → 11355 Springfield Blvd），所以必须要求门牌号 + 街名。
"""
from __future__ import annotations

import json
import math
import time
import urllib.parse
import urllib.request
from decimal import Decimal, ROUND_HALF_UP

GEOSEARCH = "https://geosearch.planninglabs.nyc/v2/search"
GEOSEARCH_AC = "https://geosearch.planninglabs.nyc/v2/autocomplete"
NOMINATIM = "https://nominatim.openstreetmap.org/search"
OSRM = "https://router.project-osrm.org/route/v1/driving"
UA = "delivery-quote/1.0 (contact: shop owner)"
CACHE: dict[str, tuple[float, object]] = {}
CACHE_TTL = 3600
METERS_PER_MILE = 1609.344


class GeoError(Exception):
    pass


def _get(url: str, params: dict, timeout: int = 12) -> dict:
    q = urllib.parse.urlencode(params)
    key = url + "?" + q
    hit = CACHE.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]  # type: ignore[return-value]
    req = urllib.request.Request(key, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode("utf-8", "replace"))
    CACHE[key] = (time.time(), data)
    return data


def haversine_miles(lat1, lon1, lat2, lon2) -> float:
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def looks_like_address(q: str) -> tuple[bool, str]:
    """给前端用的地址体检：纽约这边必须「门牌号 + 英文街名」，最好带 5 位 ZIP。"""
    q = (q or "").strip()
    if not q:
        return False, "地址不能为空"
    if any("\u4e00" <= ch <= "\u9fff" for ch in q):
        return False, "请用英文街名（纽约系统不认中文地址），例如 136-20 Roosevelt Ave, Flushing, NY 11354"
    toks = [t for t in q.replace(",", " ").split() if t]
    if not toks:
        return False, "地址不能为空"
    if not any(ch.isdigit() for ch in toks[0]):
        return False, "请从门牌号开始填，例如 40 Bayard St, New York, NY 10013"
    if not any(any(ch.isalpha() for ch in t) for t in toks):
        return False, "缺少街名：只填 ZIP 会被当成街名解析错"
    if not _has_zip(q):
        return True, "没写 ZIP，可能解析到别的区（同一个街名在多个区都有）"
    return True, ""


def _has_zip(q: str) -> bool:
    return any(t.strip(",").isdigit() and len(t.strip(",")) == 5 for t in q.split())


def _norm_features(data: dict) -> list[dict]:
    out = []
    for f in (data.get("features") or []):
        p = f.get("properties") or {}
        gm = f.get("geometry") or {}
        c = gm.get("coordinates") or []
        if len(c) != 2:
            continue
        lon, lat = float(c[0]), float(c[1])
        out.append({
            "label": p.get("label") or p.get("name") or "",
            "name": p.get("name") or "",
            "borough": p.get("borough") or "",
            "postalcode": p.get("postalcode") or "",
            "lat": lat,
            "lon": lon,
            "source": "nyc-geosearch",
        })
    return out


def geocode_candidates(query: str, limit: int = 5) -> list[dict]:
    """地址 → 候选坐标列表（纽约）。返回多个候选让用户点选，避免同街名跨区歧义。"""
    query = (query or "").strip()
    if not query:
        return []
    try:
        data = _get(GEOSEARCH, {"text": query, "size": max(1, min(limit, 10))})
        cands = _norm_features(data)
        if cands:
            return cands[:limit]
    except Exception:
        pass
    # 兜底：Nominatim（服务端可以调；浏览器直连没有 CORS，所以只在后端用）
    try:
        data = _get(NOMINATIM, {"q": query, "format": "json", "limit": limit,
                                "countrycodes": "us", "addressdetails": 1})
        out = []
        for d in data:
            addr = d.get("address") or {}
            out.append({"label": d.get("display_name", ""), "name": d.get("name", ""),
                        "borough": addr.get("suburb") or addr.get("city") or "",
                        "postalcode": addr.get("postcode", ""),
                        "lat": float(d["lat"]), "lon": float(d["lon"]), "source": "nominatim"})
        return out[:limit]
    except Exception as e:
        raise GeoError("地址解析失败：%s" % e)


def geocode(query: str, prefer_zip: str = "") -> dict:
    """取最佳匹配。给了 5 位 ZIP 就优先选 ZIP 命中的那个。"""
    cands = geocode_candidates(query, limit=10)
    if not cands:
        return {"ok": False, "error": "地址没找到，检查门牌号/街名/邮编，或补上区名（Flushing / Chinatown）"}
    zips = [t.strip(",") for t in (query or "").split() if t.strip(",").isdigit() and len(t.strip(",")) == 5]
    want = prefer_zip or (zips[0] if zips else "")
    if want:
        for c in cands:
            if c["postalcode"] == want:
                return {"ok": True, **c}
    best = cands[0]
    return {"ok": True, **best, "candidates": cands[:5],
            "warning": "没指定 ZIP，可能解析到别的区" if not want else ""}


def route_miles(a: dict, b: dict) -> dict:
    """驾车距离（OSRM）。a/b: {lat, lon}。"""
    url = "%s/%f,%f;%f,%f" % (OSRM, a["lon"], a["lat"], b["lon"], b["lat"])
    try:
        d = _get(url, {"overview": "false", "steps": "false"}, timeout=15)
        r = (d.get("routes") or [{}])[0]
        meters = float(r.get("distance") or 0)
        secs = float(r.get("duration") or 0)
        return {"ok": True, "miles": round(meters / METERS_PER_MILE, 2),
                "km": round(meters / 1000, 2), "minutes": round(secs / 60),
                "straight_miles": round(haversine_miles(a["lat"], a["lon"], b["lat"], b["lon"]), 2),
                "source": "osrm"}
    except Exception as e:
        straight = haversine_miles(a["lat"], a["lon"], b["lat"], b["lon"])
        return {"ok": False, "error": "路线服务不可用：%s" % e,
                "miles": round(straight * 1.35, 2), "straight_miles": round(straight, 2),
                "minutes": None, "estimated": True, "source": "haversine×1.35"}


DEFAULT_DELIVERY = {
    "enabled": True,
    "free_miles": 0.5,                       # 这个距离内不收配送费
    "tiers": [{"max": 2, "fee": 3.0},        # ≤2 英里 $3
              {"max": 4, "fee": 6.0},        # ≤4 英里 $6
              {"max": 6, "fee": 10.0}],      # ≤6 英里 $10
    "per_mile_beyond": 2.5,                  # 超过最后一档，每英里加
    "max_miles": 8,                          # 超出不送
    "min_order": 20.0,                       # 起送金额
    "tax_rate": 0.08875,                     # 纽约市销售税 8.875%
    "prep_minutes": 20,                      # 出餐时间，加到送达预估上
    "tip_options": [0.15, 0.18, 0.20],
    "payment": ["现金 Cash（送到付）"],     # 目前只收现金
    "restaurant_addr": "40 Bayard St, New York, NY 10013",   # ← 改成你自己的店址
    "restaurant": {"lat": 40.715285, "lon": -73.998012},
    "fallback_fee": 5.0,        # 路线服务抽风时用的兜底配送费（订单会标记待人工确认）
}


def delivery_fee(miles: float, cfg: dict) -> dict:
    """按里程算配送费。返回费用和一句人话解释（显示给顾客）。"""
    t = cfg.get("tiers") or DEFAULT_DELIVERY["tiers"]
    free = float(cfg.get("free_miles") or 0)
    beyond = float(cfg.get("per_mile_beyond") or 0)
    cap = float(cfg.get("max_miles") or 0)
    m = round(float(miles or 0), 2)
    if cap and m > cap:
        return {"ok": False, "miles": m, "fee": None,
                "reason": "%.1f 英里超出配送范围（最远 %.1f 英里），请到店自取或换地址" % (m, cap)}
    if m <= free:
        return {"ok": True, "miles": m, "fee": 0.0, "tier": "%.1f 英里内免配送费" % free}
    for tier in sorted(t, key=lambda x: float(x["max"])):
        if m <= float(tier["max"]):
            return {"ok": True, "miles": m, "fee": float(tier["fee"]),
                    "tier": "%.0f 英里内 $%.2f" % (float(tier["max"]), float(tier["fee"]))}
    last = max(t, key=lambda x: float(x["max"])) if t else {"max": free, "fee": 0.0}
    extra = max(0.0, m - float(last["max"])) * beyond
    return {"ok": True, "miles": m, "fee": round(float(last["fee"]) + extra, 2),
            "tier": "%.0f 英里 $%.2f + 超出 %.1f 英里 × $%.2f/英里" % (
                float(last["max"]), float(last["fee"]), m - float(last["max"]), beyond)}


def money(v) -> float:
    """金额一律 Decimal 四舍五入到分，别用浮点凑（12×8.875% 浮点会算成 1.06）。"""
    return float(Decimal(str(v)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def quote(restaurant: dict, addr_query: str, subtotal: float, cfg: dict,
          tip_rate: float = 0.0, pickup: bool = False) -> dict:
    """整单报价：地址 → 距离 → 配送费 → 税 → 小费 → 合计。"""
    cfg = {**DEFAULT_DELIVERY, **(cfg or {})}
    out = {"subtotal": round(float(subtotal or 0), 2), "pickup": bool(pickup),
           "tax_rate": float(cfg.get("tax_rate") or 0),
           "min_order": float(cfg.get("min_order") or 0),
           "quote_at": time.strftime("%Y-%m-%d %H:%M:%S")}
    if pickup:
        out["distance"] = None
        out["delivery"] = {"ok": True, "fee": 0.0, "miles": 0, "tier": "到店自取"}
    else:
        ok, warn = looks_like_address(addr_query)
        if not ok:
            return {"ok": False, "error": warn, **out}
        g = geocode(addr_query)
        if not g.get("ok"):
            return {**g, **out}
        out["address"] = {"input": addr_query, "matched": g["label"],
                          "borough": g.get("borough"), "zip": g.get("postalcode"),
                          "lat": g["lat"], "lon": g["lon"], "source": g["source"]}
        if g.get("warning"):
            out["address"]["warning"] = g["warning"]
        if g.get("candidates"):
            out["address"]["candidates"] = g["candidates"]
        r = route_miles(restaurant, g)
        out["distance"] = r
        fee = delivery_fee(r["miles"], cfg)
        out["delivery"] = fee
        if not fee.get("ok"):
            out["ok"] = False
            out["error"] = fee["reason"]
    sub = out["subtotal"]
    if sub < out["min_order"] and not pickup:
        out["ok"] = False
        out["error"] = "还没到起送价 $%.2f（当前 $%.2f）" % (out["min_order"], sub)
    dfee = float((out["delivery"] or {}).get("fee") or 0)
    tax = money(Decimal(str(sub)) * Decimal(str(out["tax_rate"])))
    tip = money(Decimal(str(sub)) * Decimal(str(tip_rate or 0)))
    out["tax"] = tax
    out["tip"] = tip
    out["delivery_fee"] = dfee
    out["total"] = money(Decimal(str(sub)) + Decimal(str(tax)) + Decimal(str(dfee)) + Decimal(str(tip)))
    if out["distance"] and out["distance"].get("minutes") is not None and not pickup:
        out["eta_minutes"] = int(out["distance"]["minutes"]) + int(cfg.get("prep_minutes") or 0)
    out.setdefault("ok", True)
    return out


def check_restaurant(cfg: dict) -> dict:
    """店址自检：能不能解析、有没有坐标。"""
    addr = (cfg or {}).get("restaurant_addr") or ""
    rc = (cfg or {}).get("restaurant") or {}
    if rc.get("lat") and rc.get("lon"):
        return {"ok": True, "source": "手工坐标", "addr": addr, "lat": rc["lat"], "lon": rc["lon"]}
    try:
        g = geocode(addr)
    except GeoError as e:
        return {"ok": False, "error": str(e)}
    if not g.get("ok"):
        return g
    return {"ok": True, "source": "解析", "addr": addr, "matched": g["label"],
            "lat": g["lat"], "lon": g["lon"], "borough": g.get("borough")}
