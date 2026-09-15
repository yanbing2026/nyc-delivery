# -*- coding: utf-8 -*-
"""小票渲染：纯文本预览 / ESC-POS 字节流 / 飞鹅云版式标签。

宽度：58mm → 32 个半角字符；80mm → 48 个半角字符。
汉字按 2 个半角宽计算，保证居中和分隔线对齐。
"""
from __future__ import annotations

WIDTHS = {"58": 32, "80": 48}

# --- ESC/POS 指令 ---
INIT = b"\x1b\x40"
ALIGN_LEFT = b"\x1b\x61\x00"
ALIGN_CENTER = b"\x1b\x61\x01"
BOLD_ON = b"\x1b\x45\x01"
BOLD_OFF = b"\x1b\x45\x00"
BIG_ON = b"\x1d\x21\x11"      # 倍宽 + 倍高
BIG_OFF = b"\x1d\x21\x00"
FEED = b"\n"
CUT = b"\x1d\x56\x42\x00"     # 半切并走纸
KICK_DRAWER = b"\x1b\x70\x00\x19\xfa"


def dw(text: str) -> int:
    """显示宽度：CJK / 全角按 2 计。"""
    return sum(2 if ord(c) > 0x2E7F else 1 for c in text)


def center(text: str, width: int) -> str:
    return " " * max(0, (width - dw(text)) // 2) + text


def right(text: str, width: int) -> str:
    return " " * max(0, width - dw(text)) + text


def lr(left: str, r: str, width: int) -> str:
    """左右对齐（菜单行：菜名 ... 价格）。"""
    space = width - dw(left) - dw(r)
    if space < 1:
        return left + " " + r
    return left + " " * space + r


def rule(width: int, ch: str = "-") -> str:
    return ch * width


def money(v) -> str:
    return "%.2f" % float(v)


def wrap(text: str, width: int, indent: str = "  ") -> list[str]:
    """按词/逗号换行（别把 STREET 切成 ST/REET，送餐员会看错）。"""
    out: list[str] = []
    line = indent
    for word in str(text).replace(",", ", ").split():
        if dw(line) + dw(word) > width and dw(line.strip()) > 0:
            out.append(line.rstrip())
            line = indent
        line += word + " "
    if line.strip():
        out.append(line.rstrip())
    return out or [indent.rstrip()]


def render_receipt(order: dict, shop: dict, width: int = 32) -> str:
    """把订单渲染成小票纯文本（等宽预览 / ESC-POS 正文都用它）。"""
    L: list[str] = []
    L.append(center(shop.get("name", "本店"), width))
    if shop.get("slogan"):
        L.append(center(shop["slogan"], width))
    L.append(center(shop.get("phone", ""), width) if shop.get("phone") else "")
    L.append(rule(width, "="))
    L.append("订单号: %s" % order.get("no", ""))
    L.append("下单时间: %s" % order.get("created_at", ""))
    if order.get("pickup"):
        L.append("** 到店自取 **")
    if order.get("customer"):
        L.append("顾客: %s" % order["customer"])
    if order.get("phone"):
        L.append("电话: %s" % order["phone"])
    if order.get("address") and not order.get("pickup"):
        L.append(rule(width))
        L.append("送餐地址:")
        L.extend(wrap(str(order["address"]), width))
        if order.get("distance_miles") is not None:
            L.append(lr("距离", "%.2f 英里" % float(order["distance_miles"]), width))
        if order.get("eta_minutes"):
            L.append(lr("预计送达", "%s 分钟" % order["eta_minutes"], width))
        if order.get("needs_manual_review"):
            L.append("!! 距离是估算值，请人工核对 !!")
    if order.get("table"):
        L.append("桌号/取餐号: %s" % order["table"])
    if order.get("openid"):
        L.append("微信: %s" % (order["openid"][:12] + "..."))
    if order.get("remark"):
        L.append("备注: %s" % order["remark"])
    L.append(rule(width))
    L.append(lr("品名", "金额", width))
    L.append(rule(width))
    total = 0.0
    for it in order.get("items", []):
        price = float(it.get("price", 0))
        qty = int(it.get("qty", 1))
        amt = price * qty
        total += amt
        name = it.get("name", "")
        if dw(name) > width - 12:
            name = name[: max(1, (width - 12) // 2)]
        L.append(lr(name, money(amt), width))
        if qty > 1 or it.get("spec"):
            sub = "  x%d %s" % (qty, money(price)) if qty > 1 else ""
            if it.get("spec"):
                sub += (" " if sub else "  ") + str(it["spec"])
            L.append(sub)
    L.append(rule(width))
    sub = order.get("subtotal")
    sub_known = sub is not None
    sub = float(sub) if sub_known else total
    L.append(lr("小计" if sub_known else "合计", money(sub), width))
    if order.get("tax"):
        rate = order.get("tax_rate")
        L.append(lr("税%s" % (" %.3f%%" % (float(rate) * 100) if rate else ""), money(order["tax"]), width))
    if order.get("delivery_fee") is not None and not order.get("pickup"):
        fee = float(order["delivery_fee"])
        L.append(lr("配送费" + ("（免）" if fee == 0 else ""), money(fee), width))
    if order.get("tip"):
        L.append(lr("小费", money(order["tip"]), width))
    L.append(rule(width))
    L.append(lr("合计", money(order.get("total", sub)), width))
    if order.get("pay_type"):
        L.append(lr("支付方式", str(order["pay_type"]), width))
    L.append(rule(width, "="))
    footer = order.get("footer") or shop.get("footer", "")
    if footer:
        for seg in footer.split("|"):
            if seg:
                L.append(center(seg, width))
    if order.get("qr_url"):
        L.append(center("[二维码] " + str(order["qr_url"]), width))
    L.append("")
    while L and L[0] == "":
        L.pop(0)
    return "\n".join(L)


def to_escpos(text: str, cutter: bool = True, drawer: bool = False) -> bytes:
    """纯文本 → ESC/POS 字节流（GBK 编码，小票机原生）。"""
    out = bytearray()
    out += INIT
    out += ALIGN_LEFT
    for i, line in enumerate(text.split("\n")):
        stripped = line.strip(" ")
        is_title = i < 2 and stripped and line != stripped  # 前两行的居中行加大
        if is_title:
            out += ALIGN_CENTER + BIG_ON
        try:
            out += line.encode("gbk")
        except UnicodeEncodeError:
            out += line.encode("gbk", "replace")
        if is_title:
            out += BIG_OFF + ALIGN_LEFT
        out += FEED
    out += b"\n\n"
    if drawer:
        out += KICK_DRAWER
    if cutter:
        out += CUT
    return bytes(out)


def to_feie(text: str) -> str:
    """纯文本 → 飞鹅云 content 标签格式（<BR>/<CB>/<B>/<CUT>）。"""
    lines = text.split("\n")
    parts: list[str] = []
    for i, line in enumerate(lines):
        s = line.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        stripped = line.strip(" ")
        if i < 2 and stripped and line != stripped:
            parts.append("<CB><B>%s</B></CB>" % s.strip())
        elif "\u4e00" <= "a" and stripped in ("合计",) or stripped.startswith("合计"):
            parts.append("<B>%s</B>" % s)
        else:
            parts.append(s if s else "")
    return "<BR>".join(parts) + "<CUT>"
