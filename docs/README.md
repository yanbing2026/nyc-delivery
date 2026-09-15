# 公众号自定义菜单 + 小票 演示（静态版）

纯前端，托管在 GitHub Pages。跟后端 Python 版共用同一套规则（`wxmenu.js` 与 `menu_spec.py` / `receipt.py` 输出逐字符一致，由 `test-wxmenu.js` 交叉验证）。

- `index.html` — 菜单编辑器（实时微信底栏预览）、规则校验、生成真实的 `menu/create` 请求体 + curl、小票排版预览 + ESC/POS 字节 + 飞鹅云标签
- `order.html` — 手机版点单页；留空后端时本地生成小票样张，填了后端就真 POST `/api/order`
- `wxmenu.js` — 规则/渲染核心（浏览器 + node 通用）
- `test-wxmenu.js` — `node test-wxmenu.js` 跑自测

## 这页做不到什么

推送菜单到微信、接收菜单点击回调、真出票、网页授权换 openid —— 都要后端服务器（AppID/AppSecret、公网 HTTPS 回调、加白名单的出口 IP、以及打印机）。

后端版在 `/root/wechat-menu-printer/`：`python3 server.py` 起服务，`selftest.py` 33 项自测。
后端已开 CORS，所以本静态页填上后端地址后可以直接下单打印。
