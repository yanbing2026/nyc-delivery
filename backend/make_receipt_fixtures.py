# -*- coding: utf-8 -*-
"""生成后端小票渲染的基准文件，给前端 JS 交叉比对用（node test-wxmenu.js 会读它们）。
跑法：python3 make_receipt_fixtures.py"""
import receipt as R

SHOP = {"name": "琅岐海鲜小馆", "slogan": "-- 现捞现做 --", "phone": "0591-8888 8888",
        "footer": "谢谢惠顾|欢迎再来"}

# 1) 老式（微信点单，没有 subtotal/tax）：确认没有破坏原有格式
legacy = {
    "no": "2509150001", "created_at": "2026-09-15 12:00:00", "openid": "oDemoOpenid0001",
    "table": "A3", "remark": "少辣", "pay_type": "微信支付", "footer": "谢谢惠顾|欢迎再来",
    "items": [{"name": "琅岐海蛎煎", "qty": 2, "price": 28.0}, {"name": "茉莉花茶", "qty": 1, "price": 8.0}],
}

# 2) 纽约送餐单：地址 / 距离 / 税 / 小费 / 现金
delivery = {
    "no": "2509150002", "created_at": "2026-09-15 12:30:00", "customer": "张先生",
    "phone": "917-555-0123", "address": "1 PIKE STREET, New York, NY, USA", "borough": "Manhattan",
    "distance_miles": 0.84, "eta_minutes": 23, "remark": "多给筷子，不要辣",
    "items": [{"name": "海蛎煎", "qty": 2, "price": 12.95}, {"name": "白饭", "qty": 1, "price": 2.0}],
    "subtotal": 27.90, "tax": 2.48, "tax_rate": 0.08875, "tip": 5.02,
    "delivery_fee": 3.0, "total": 38.40, "pay_type": "现金 Cash（送到付）",
}

for name, order in (("/tmp/py_receipt.txt", legacy), ("/tmp/py_receipt_delivery.txt", delivery)):
    with open(name, "w", encoding="utf-8") as f:
        f.write(R.render_receipt(order, SHOP, 32) + "\n")
    print("写出", name)
print(R.render_receipt(delivery, SHOP, 32))
