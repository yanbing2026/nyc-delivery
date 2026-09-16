# -*- coding: utf-8 -*-
"""里程/配送费自测：地址解析优先走 Google（服务端 key），失败退回 NYC 官方 → Nominatim；
里程走 OSRM 真接口（需要联网）。跑法：python3 test_delivery.py"""
from __future__ import annotations

import time

import delivery as D

FAILS: list[str] = []


def check(name, cond, extra=""):
    print(("  ✓ " if cond else "  ✗ ") + name + (("  ← " + str(extra)) if (extra and not cond) else ""))
    if not cond:
        FAILS.append(name)


REST = dict(D.DEFAULT_DELIVERY["restaurant"])            # 店址取自配置（法拉盛 10-53 116th St）
CFG = dict(D.DEFAULT_DELIVERY)
NEAR = "59-04 99th St, Corona, NY 11368"                 # 店附近，约 5.6 英里
FAR = "40 Bayard St, New York, NY 10013"                 # 曼哈顿唐人街，约 13.9 英里

print("== 1. 地址体检（前端也能用同一套判断） ==")
for q, want_ok in [("", False), ("法拉盛 缅街 41-28", False), ("11355", False), ("Bayard St", False),
                   ("40 Bayard St, New York, NY 10013", True), ("136-20 Roosevelt Ave, Flushing, NY 11354", True)]:
    ok, msg = D.looks_like_address(q)
    check("%-40s → %s" % (q or "(空)", "通过" if ok else "拒绝：" + msg[:28]), ok is want_ok, (ok, msg))

print("== 2. 地理编码（Google 优先；没配 key 就退回免费源） ==")
t0 = time.time()
print("     解析来源：%s" % ("Google（已配 key）" if D.google_key() else "免费源（未配 GOOGLE_MAPS_API_KEY）"))
g1 = D.geocode(FAR)
check("唐人街 40 Bayard St 10013 定位到曼哈顿",
      g1.get("ok") and g1["postalcode"] == "10013" and 40.70 < g1["lat"] < 40.73 and -74.01 < g1["lon"] < -73.99,
      g1)
g2 = D.geocode("136-20 Roosevelt Ave, Flushing, NY 11354")
check("法拉盛 136-20 Roosevelt Ave 11354 定位到皇后区",
      g2.get("ok") and g2["postalcode"] == "11354" and 40.74 < g2["lat"] < 40.79, g2)
g_store = D.geocode(D.DEFAULT_DELIVERY["restaurant_addr"])
check("新店址（Queens 连字符门牌号）解析成功 —— 免费源解不了这个，只有 Google 行",
      g_store.get("ok") and g_store["postalcode"] == "11356", g_store)
g3 = D.geocode("40 Bayard St")
check("不写 ZIP 时给歧义警告（会命中布鲁克林的 40 Bayard St）",
      g3.get("ok") and bool(g3.get("warning")), g3.get("warning"))
check("同时返回候选列表供用户点选", len(g3.get("candidates") or []) >= 2, len(g3.get("candidates") or []))
g4 = D.geocode("9999 Nowhere Blvd, New York, NY 10013")
check("瞎编的地址给明确失败信息", not g4.get("ok") and "没找到" in g4.get("error", ""), g4)
print("  （解析共用 %.1f 秒，已带 1 小时缓存）" % (time.time() - t0))

print("== 3. 驾车里程（真调 OSRM） ==")
r1 = D.route_miles(REST, g2)
check("店 → 法拉盛罗斯福大道 ≈ 2~4 英里", r1["ok"] and 1.5 < r1["miles"] < 5, r1)
r2 = D.route_miles(REST, g1)
check("店 → 曼哈顿唐人街 ≈ 12~15 英里（真实驾车距离）", r2["ok"] and 10 < r2["miles"] < 16, r2)
check("带预计时间", r2["ok"] and (r2["minutes"] or 0) > 10, r2)
print("     店→唐人街：%.2f 英里 / %s 分钟（直线 %.2f 英里）" % (r2["miles"], r2["minutes"], r2["straight_miles"]))

print("== 4. 配送费：5 英里内免费，超出每英里 $2（不足 1 英里按 1 英里算） ==")
cases = [(0.3, 0.0), (5.0, 0.0), (5.01, 2.0), (6.0, 2.0), (6.01, 4.0), (7.0, 4.0),
         (8.0, 6.0), (10.0, 10.0), (13.9, 18.0)]
for miles, want in cases:
    got = D.delivery_fee(miles, CFG)
    check("%.2f 英里 → $%.2f" % (miles, want), got["ok"] and got["fee"] == want, got)
check("不设上限：19.26 英里 → 超出 15 英里 = $30", D.delivery_fee(19.26, CFG)["fee"] == 30.0,
      D.delivery_fee(19.26, CFG))
capped = D.delivery_fee(9.5, dict(CFG, max_miles=8))
check("需要时仍可配上限（max_miles=8 时 9.5 英里被拒）",
      capped["ok"] is False and "超出配送范围" in capped.get("reason", ""), capped)
print("     " + D.delivery_fee(7.0, CFG)["tier"])

print("== 5. 整单报价（税 + 小费 + 配送费） ==")
q = D.quote(REST, NEAR, 42.0, CFG, tip_rate=0.18)
check("报价成功", q.get("ok"), q.get("error"))
check("税 = 42 × 8.875% = 3.73", q["tax"] == 3.73, q["tax"])
check("小费 = 42 × 18% = 7.56", q["tip"] == 7.56, q["tip"])
check("距离落在 4~7 英里", 4 <= q["distance"]["miles"] <= 7, q.get("distance"))
check("配送费与规则一致（超出部分向上取整）",
      q["delivery_fee"] == D.delivery_fee(q["distance"]["miles"], CFG)["fee"], q["delivery_fee"])
check("合计 = 小计 + 税 + 配送费 + 小费", q["total"] == round(42.0 + q["tax"] + q["delivery_fee"] + q["tip"], 2), q["total"])
check("带预计送达分钟", (q.get("eta_minutes") or 0) >= 20, q.get("eta_minutes"))
print("     %s → %.2f 英里 / %s 分钟 / 配送费 $%.2f / 合计 $%.2f"
      % (q["address"]["matched"][:40], q["distance"]["miles"], q["distance"]["minutes"], q["delivery_fee"], q["total"]))

same = D.quote(REST, D.DEFAULT_DELIVERY["restaurant_addr"], 42.0, CFG)
check("同地址（店门口）距离 0 → 落在免费里程内 $0",
      same["ok"] and same["distance"]["miles"] < 0.2 and same["delivery_fee"] == 0.0, same.get("delivery_fee"))

q2 = D.quote(REST, FAR, 42.0, dict(CFG, max_miles=8))
check("配上 8 英里上限时，唐人街 13+ 英里被拒",
      q2.get("ok") is False and "超出配送范围" in q2["error"], q2.get("error"))

qnj = D.quote(REST, "1 Journal Square, Jersey City, NJ 07306", 42.0, CFG)
check("五区外（新泽西）→ 拒单并说明只送纽约五大区",
      qnj.get("ok") is False and "只送纽约五大区" in qnj.get("error", ""), qnj.get("error"))

q3 = D.quote(REST, NEAR, 12.0, CFG)
check("未到起送价 $20 被拦", q3.get("ok") is False and "起送" in q3["error"], q3.get("error"))

q4 = D.quote(REST, "", 42.0, CFG, pickup=True)
check("自取：不要地址、不收配送费、只要税", q4.get("ok") and q4["delivery_fee"] == 0 and q4["total"] == 45.73, q4)
q5 = D.quote(REST, "", 12.0, CFG, pickup=True)
check("自取不受起送价限制（$12 也能下）", q5.get("ok") and q5["total"] == 13.07, q5.get("error"))
q6 = D.quote(REST, NEAR, 12.0, CFG)
check("外送 $12 低于起送价 $20 被拦", q6.get("ok") is False and "起送" in q6["error"], q6.get("error"))

print("== 6. 店址自检 ==")
rc = D.check_restaurant(CFG)
check("店址可用", rc.get("ok"), rc)

print()
if FAILS:
    print("❌ %d 项失败：%s" % (len(FAILS), "；".join(FAILS)))
    raise SystemExit(1)
print("✅ 里程/配送费全部通过")
