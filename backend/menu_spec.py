# -*- coding: utf-8 -*-
"""自定义菜单：草稿校验 + 默认模板。

微信硬规则（2026 官方文档）：
- 一级菜单 1~3 个，二级菜单 2~5 个（有二级时一级不能超过 3 个）
- name：一级不超过 16 字节，二级不超过 60 字节（UTF-8 汉字 3 字节）
- type：click / view / miniprogram / scancode_push / scancode_waitmsg /
        pic_sysphoto / pic_photo_or_album / pic_weixin / location_select /
        media_id / article_id / article_view_limited
"""
from __future__ import annotations

VALID_TYPES = {
    "click", "view", "miniprogram", "scancode_push", "scancode_waitmsg",
    "pic_sysphoto", "pic_photo_or_album", "pic_weixin", "location_select",
    "media_id", "article_id", "article_view_limited",
}
NEED_URL = {"view"}
NEED_KEY = {"click", "scancode_push", "scancode_waitmsg", "pic_sysphoto",
            "pic_photo_or_album", "pic_weixin", "location_select"}


def default_menu(order_url: str = "http://你的域名/order") -> dict:
    return {
        "button": [
            {
                "name": "我要点单",
                "sub_button": [
                    {"type": "view", "name": "在线点单", "url": order_url},
                    {"type": "click", "name": "今日特价", "key": "PROMO_TODAY"},
                ],
            },
            {
                "name": "我的订单",
                "sub_button": [
                    {"type": "click", "name": "查看订单", "key": "MY_ORDERS"},
                    {"type": "click", "name": "联系客服", "key": "CALL_SERVICE"},
                ],
            },
            {
                "name": "门店信息",
                "sub_button": [
                    {"type": "click", "name": "地址电话", "key": "SHOP_INFO"},
                    {"type": "click", "name": "打印测试", "key": "PRINT_TEST"},
                ],
            },
        ]
    }


def _clean_btn(btn: dict) -> dict:
    out = {k: v for k, v in btn.items() if v not in (None, "", [])}
    if "sub_button" in out:
        out["sub_button"] = [_clean_btn(b) for b in out["sub_button"]]
        out.pop("type", None)
        out.pop("key", None)
        out.pop("url", None)
    return out


def normalize(menu: dict) -> dict:
    return {"button": [_clean_btn(b) for b in (menu or {}).get("button", [])]}


def validate(menu: dict) -> list[str]:
    errs: list[str] = []
    btns = (menu or {}).get("button") or []
    if not btns:
        errs.append("菜单不能为空：至少要有 1 个一级菜单")
    if len(btns) > 3:
        errs.append("一级菜单最多 3 个，当前 %d 个" % len(btns))
    names = [b.get("name", "") for b in btns]
    if len(set(names)) != len(names):
        errs.append("一级菜单名称不能重复")
    for i, b in enumerate(btns, 1):
        name = b.get("name", "")
        if not name:
            errs.append("第 %d 个一级菜单缺少名称" % i)
        elif len(name.encode("utf-8")) > 16:
            errs.append("一级菜单「%s」超长：%d 字节 > 16 字节（汉字算 3 字节，最多 5 个汉字）"
                        % (name, len(name.encode("utf-8"))))
        subs = b.get("sub_button")
        if subs is not None:
            if not (2 <= len(subs) <= 5):
                errs.append("「%s」的二级菜单必须 2~5 个，当前 %d 个" % (name, len(subs)))
            for j, s in enumerate(subs, 1):
                sn = s.get("name", "")
                if not sn:
                    errs.append("「%s」第 %d 个二级菜单缺少名称" % (name, j))
                elif len(sn.encode("utf-8")) > 60:
                    errs.append("二级菜单「%s」超长：%d 字节 > 60 字节" % (sn, len(sn.encode("utf-8"))))
        else:
            if not b.get("type"):
                errs.append("「%s」既没有二级菜单也没有 type" % name)
    for b in _walk(btns):
        t = b.get("type")
        nm = b.get("name", "?")
        if t and t not in VALID_TYPES:
            errs.append("「%s」的 type=%s 不是微信支持的取值" % (nm, t))
            continue
        if t in NEED_URL and not b.get("url"):
            errs.append("「%s」type=view 必须填 url" % nm)
        if t in NEED_KEY and not b.get("key"):
            errs.append("「%s」type=%s 必须填 key" % (nm, t))
        if t == "miniprogram" and not (b.get("appid") and b.get("pagepath")):
            errs.append("「%s」type=miniprogram 必须填 appid 和 pagepath" % nm)
        if t == "view" and str(b.get("url", "")).startswith("http://"):
            if "你的域名" in str(b.get("url")) or "demo" in str(b.get("url", "")):
                errs.append("「%s」的 url 还是占位地址，上线前要换成真实域名（微信要求 http/https 可访问）" % nm)
    return errs


def _walk(btns):
    for b in btns:
        yield b
        for s in b.get("sub_button") or []:
            yield s
