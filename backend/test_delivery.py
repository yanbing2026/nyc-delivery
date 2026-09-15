# -*- coding: utf-8 -*-
"""里程/配送费自测：真调 NYC GeoSearch + OSRM（需要联网）。跑法：python3 test_delivery.py"""
from __future__ import annotations

import time

import delivery as D

FAILS: list[str] = []


def check(name, cond, extra=""):
    print(("  ✓ " if cond else "  ✗ ") + name + (("  ← " + str(extra)) if (extra and not cond) else ""))
    if not cond:
        FAILS.append(name)


REST = {"lat": 40.715285, "lon": -73.998012}          # 曼哈顿唐人街 40 Bayard St
CFG = dict(D.DEFAULT_DELIVERY)

print("== 1. 地址体检（前端也能用同一套判断） ==")
for q, want_ok in [("", False), ("法拉盛 缅街 41-28", False), ("11355", False), ("Bayard St", False),
                   ("40 Bayard St, New York, NY 10013", True), ("136-20 Roosevelt Ave, Flushing, NY 11354", True)]:
    ok, msg = D.looks_like_address(q)
    check("%-40s → %s" % (q or "(空)", "通过" if ok else "拒绝：" + msg[:28]), ok is want_ok, (ok, msg))

print("== 2. 地理编码（真调 NYC GeoSearch） ==")
t0 = time.time()
g1 = D.geocode("40 Bayard St, New York, NY 10013")
check("唐人街 40 Bayard St 10013 定位到曼哈顿",
      g1.get("ok") and g1["postalcode"] == "10013" and 40.70 < g1["lat"] < 40.73 and -74.01 < g1["lon"] < -73.99,
      g1)
g2 = D.geocode("136-20 Roosevelt Ave, Flushing, NY 11354")
check("法拉盛 136-20 Roosevelt Ave 11354 定位到皇后区",
      g2.get("ok") and g2["postalcode"] == "11354" and 40.75 < g2["lat"] < 40.78, g2)
g3 = D.geocode("40 Bayard St")
check("不写 ZIP 时给歧义警告（会命中布鲁克林的 40 Bayard St）",
      g3.get("ok") and bool(g3.get("warning")), g3.get("warning"))
check("同时返回候选列表供用户点选", len(g3.get("candidates") or []) >= 2, len(g3.get("candidates") or []))
g4 = D.geocode("9999 Nowhere Blvd, New York, NY 10013")
check("瞎编的地址给明确失败信息", not g4.get("ok") and "没找到" in g4.get("error", ""), g4)
print("  （3 次解析共 %.1f 秒，已带 1 小时缓存）" % (time.time() - t0))

print("== 3. 驾车里程（真调 OSRM） ==")
r1 = D.route_miles(REST, g1)
check("店门口 → 唐人街同一栋 ≈ 0 英里", r1["ok"] and r1["miles"] < 0.3, r1)
r2 = D.route_miles(REST, g2)
check("唐人街 → 法拉盛 ≈ 11~13 英里（真实驾车距离）", r2["ok"] and 10 < r2["miles"] < 14, r2)
check("带预计时间", r2["ok"] and (r2["minutes"] or 0) > 10, r2)
print("     唐人街→法拉盛：%.2f 英里 / %s 分钟（直线 %.2f 英里）" % (r2["miles"], r2["minutes"], r2["straight_miles"]))

print("== 4. 配送费阶梯（纯计算，不联网） ==")
cases = [(0.3, 0.0), (0.5, 0.0), (0.51, 3.0), (2.0, 3.0), (2.1, 6.0), (4.0, 6.0),
         (4.1, 10.0), (6.0, 10.0), (7.0, 12.5), (8.0, 15.0)]
for miles, want in cases:
    got = D.delivery_fee(miles, CFG)
    check("%.2f 英里 → $%.2f" % (miles, want), got["ok"] and got["fee"] == want, got)
over = D.delivery_fee(9.5, CFG)
check("9.5 英里超出 8 英里上限 → 不送", over["ok"] is False and "超出配送范围" in over["reason"], over)
print("     " + D.delivery_fee(7.0, CFG)["tier"])

print("== 5. 整单报价（税 + 小费 + 配送费） ==")
CUST = "100 Mott St, New York, NY 10013"      # 唐人街邻居（别用店址本身，那距离是 0）
q = D.quote(REST, CUST, 42.0, CFG, tip_rate=0.18)
check("报价成功", q.get("ok"), q.get("error"))
check("税 = 42 × 8.875% = 3.73", q["tax"] == 3.73, q["tax"])
check("小费 = 42 × 18% = 7.56", q["tip"] == 7.56, q["tip"])
check("距离落在唐人街内部 0.1~1.5 英里", 0.1 <= q["distance"]["miles"] <= 1.5, q.get("distance"))
check("配送费与阶梯一致", q["delivery_fee"] == D.delivery_fee(q["distance"]["miles"], CFG)["fee"], q["delivery_fee"])
check("合计 = 小计 + 税 + 配送费 + 小费", q["total"] == round(42.0 + q["tax"] + q["delivery_fee"] + q["tip"], 2), q["total"])
check("带预计送达分钟", (q.get("eta_minutes") or 0) >= 20, q.get("eta_minutes"))
print("     %s → %.2f 英里 / %s 分钟 / 配送费 $%.2f / 合计 $%.2f"
      % (q["address"]["matched"][:40], q["distance"]["miles"], q["distance"]["minutes"], q["delivery_fee"], q["total"]))

same = D.quote(REST, "40 Bayard St, New York, NY 10013", 42.0, CFG)
check("同地址（店门口）距离 0 → 落在免费里程内 $0",
      same["ok"] and same["distance"]["miles"] < 0.2 and same["delivery_fee"] == 0.0, same.get("delivery_fee"))

q2 = D.quote(REST, "136-20 Roosevelt Ave, Flushing, NY 11354", 42.0, dict(CFG, max_miles=8))
check("法拉盛 11+ 英里被拒（超出配送范围）", q2.get("ok") is False and "超出配送范围" in q2["error"], q2.get("error"))

q3 = D.quote(REST, "40 Bayard St, New York, NY 10013", 12.0, CFG)
check("未到起送价 $20 被拦", q3.get("ok") is False and "起送" in q3["error"], q3.get("error"))

q4 = D.quote(REST, "", 42.0, CFG, pickup=True)
check("自取：不要地址、不收配送费、只要税", q4.get("ok") and q4["delivery_fee"] == 0 and q4["total"] == 45.73, q4)
q5 = D.quote(REST, "", 12.0, CFG, pickup=True)
check("自取不受起送价限制（$12 也能下）", q5.get("ok") and q5["total"] == 13.07, q5.get("error"))
q6 = D.quote(REST, CUST, 12.0, CFG)
check("外送 $12 低于起送价 $20 被拦", q6.get("ok") is False and "起送" in q6["error"], q6.get("error"))

print("== 6. 店址自检 ==")
rc = D.check_restaurant(CFG)
check("店址可用", rc.get("ok"), rc)

print()
if FAILS:
    print("❌ %d 项失败：%s" % (len(FAILS), "；".join(FAILS)))
    raise SystemExit(1)
print("✅ 里程/配送费全部通过")
