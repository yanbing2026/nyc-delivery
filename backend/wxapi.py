# -*- coding: utf-8 -*-
"""微信公众号接口封装：服务器验证签名 / access_token / 自定义菜单 / 客服消息。"""
from __future__ import annotations

import hashlib
import json
import threading
import time
import urllib.parse
import urllib.request

API = "https://api.weixin.qq.com"


class WxError(Exception):
    pass


def check_signature(token: str, signature: str, timestamp: str, nonce: str) -> bool:
    """微信服务器配置校验：sha1(sort([token, timestamp, nonce]))."""
    raw = "".join(sorted([token or "", timestamp or "", nonce or ""]))
    return hashlib.sha1(raw.encode("utf-8")).hexdigest() == (signature or "")


class WeChat:
    """live 模式真调微信接口；demo 模式只回放请求，方便没公众号时演示。"""

    def __init__(self, cfg: dict, mode: str = "demo"):
        w = (cfg or {}).get("wechat", {})
        self.appid = (w.get("appid") or "").strip()
        self.secret = (w.get("appsecret") or "").strip()
        self.token = (w.get("token") or "").strip()
        self.mode = mode or "demo"
        self._tok = None
        self._tok_exp = 0.0
        self._lock = threading.Lock()
        self.last_calls: list[dict] = []

    # ---------- 通用 ----------
    def _http(self, url: str, data: bytes | None = None, method: str = "GET") -> dict:
        req = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8", "replace")
        try:
            out = json.loads(body)
        except json.JSONDecodeError:
            raise WxError("微信返回不是 JSON：%s" % body[:200])
        if out.get("errcode"):
            raise WxError("微信接口报错 %s: %s" % (out.get("errcode"), out.get("errmsg")))
        return out

    def _record(self, name: str, url: str, payload=None) -> None:
        self.last_calls.append(
            {"api": name, "url": url, "payload": payload, "at": time.strftime("%H:%M:%S")}
        )
        self.last_calls = self.last_calls[-30:]

    # ---------- access_token ----------
    def access_token(self, force: bool = False) -> str:
        if self.mode != "live":
            return "DEMO_ACCESS_TOKEN"
        with self._lock:
            if not force and self._tok and time.time() < self._tok_exp:
                return self._tok
            if not (self.appid and self.secret):
                raise WxError("缺少 AppID / AppSecret")
            q = urllib.parse.urlencode(
                {"grant_type": "client_credential", "appid": self.appid, "secret": self.secret}
            )
            out = self._http("%s/cgi-bin/token?%s" % (API, q))
            self._tok = out["access_token"]
            self._tok_exp = time.time() + int(out.get("expires_in", 7200)) - 300
            return self._tok

    # ---------- 自定义菜单 ----------
    def menu_create(self, payload: dict) -> dict:
        url = "%s/cgi-bin/menu/create?access_token=%s" % (API, self.access_token())
        self._record("menu/create", url, payload)
        if self.mode != "live":
            return {
                "simulated": True,
                "errcode": 0,
                "errmsg": "ok",
                "note": "演示模式：未真的提交到微信。切到 live 并填 AppID/AppSecret 后即为真实请求。",
                "http": {"method": "POST", "url": url, "body": payload},
            }
        return self._http(url, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "POST")

    def menu_get(self) -> dict:
        url = "%s/cgi-bin/menu/get?access_token=%s" % (API, self.access_token())
        self._record("menu/get", url)
        if self.mode != "live":
            return {"simulated": True, "menu": {"button": []}, "http": {"url": url}}
        return self._http(url)

    def selfmenu_info(self) -> dict:
        url = "%s/cgi-bin/get_current_selfmenu_info?access_token=%s" % (API, self.access_token())
        self._record("get_current_selfmenu_info", url)
        if self.mode != "live":
            return {"simulated": True, "selfmenu_info": {"button": []}, "http": {"url": url}}
        return self._http(url)

    def menu_delete(self) -> dict:
        url = "%s/cgi-bin/menu/delete?access_token=%s" % (API, self.access_token())
        self._record("menu/delete", url)
        if self.mode != "live":
            return {"simulated": True, "errcode": 0, "errmsg": "ok", "http": {"url": url}}
        return self._http(url)

    # ---------- 客服消息 ----------
    def send_text(self, openid: str, text: str) -> dict:
        url = "%s/cgi-bin/message/custom/send?access_token=%s" % (API, self.access_token())
        payload = {"touser": openid, "msgtype": "text", "text": {"content": text}}
        self._record("message/custom/send", url, payload)
        if self.mode != "live":
            return {"simulated": True, "errcode": 0, "errmsg": "ok", "http": {"body": payload}}
        return self._http(url, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "POST")

    # ---------- 网页授权 ----------
    def oauth_url(self, redirect_uri: str, scope: str = "snsapi_base", state: str = "1") -> str:
        q = urllib.parse.urlencode(
            {
                "appid": self.appid or "wxDEMO",
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "scope": scope,
                "state": state,
            }
        )
        return "https://open.weixin.qq.com/connect/oauth2/authorize?%s#wechat_redirect" % q

    def oauth_openid(self, code: str) -> dict:
        q = urllib.parse.urlencode(
            {
                "appid": self.appid,
                "secret": self.secret,
                "code": code,
                "grant_type": "authorization_code",
            }
        )
        if self.mode != "live":
            return {"openid": "oDemoOpenid0001", "simulated": True}
        return self._http("%s/sns/oauth2/access_token?%s" % (API, q))
