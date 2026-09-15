/* 公众号菜单 + 小票：纯前端实现（跟后端 Python 规则一致）
   校验规则、小票渲染、ESC/POS 字节、飞鹅标签，浏览器和 node 都能跑。 */
(function (root) {
  'use strict';

  const VALID_TYPES = ['click', 'view', 'miniprogram', 'scancode_push', 'scancode_waitmsg',
    'pic_sysphoto', 'pic_photo_or_album', 'pic_weixin', 'location_select',
    'media_id', 'article_id', 'article_view_limited'];
  const NEED_URL = ['view'];
  const NEED_KEY = ['click', 'scancode_push', 'scancode_waitmsg', 'pic_sysphoto',
    'pic_photo_or_album', 'pic_weixin', 'location_select'];

  const enc = (s) => new TextEncoder().encode(String(s == null ? '' : s));
  const bytes = (s) => enc(s).length;            // 微信按 UTF-8 字节算长度
  const dw = (s) => {                            // 小票显示宽度：CJK 算 2
    let n = 0;
    for (const ch of String(s)) n += ch.codePointAt(0) > 0x2E7F ? 2 : 1;
    return n;
  };

  function defaultMenu(orderUrl) {
    orderUrl = orderUrl || 'http://你的域名/order';
    return {
      button: [
        { name: '我要点单', sub_button: [
          { type: 'view', name: '在线点单', url: orderUrl },
          { type: 'click', name: '今日特价', key: 'PROMO_TODAY' }] },
        { name: '我的订单', sub_button: [
          { type: 'click', name: '查看订单', key: 'MY_ORDERS' },
          { type: 'click', name: '联系客服', key: 'CALL_SERVICE' }] },
        { name: '门店信息', sub_button: [
          { type: 'click', name: '地址电话', key: 'SHOP_INFO' },
          { type: 'click', name: '打印测试', key: 'PRINT_TEST' }] }
      ]
    };
  }

  function cleanBtn(b) {
    const out = {};
    for (const k of Object.keys(b)) {
      const v = b[k];
      if (v === '' || v === null || v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      out[k] = v;
    }
    if (out.sub_button) {
      out.sub_button = out.sub_button.map(cleanBtn);
      delete out.type; delete out.key; delete out.url;
    }
    return out;
  }
  const normalize = (menu) => ({ button: ((menu || {}).button || []).map(cleanBtn) });

  function walk(btns) {
    const out = [];
    for (const b of btns) { out.push(b); for (const s of (b.sub_button || [])) out.push(s); }
    return out;
  }

  function validate(menu) {
    const errs = [];
    const btns = ((menu || {}).button) || [];
    if (!btns.length) errs.push('菜单不能为空：至少要有 1 个一级菜单');
    if (btns.length > 3) errs.push(`一级菜单最多 3 个，当前 ${btns.length} 个`);
    const names = btns.map((b) => b.name || '');
    if (new Set(names).size !== names.length) errs.push('一级菜单名称不能重复');
    btns.forEach((b, i) => {
      const name = b.name || '';
      if (!name) errs.push(`第 ${i + 1} 个一级菜单缺少名称`);
      else if (bytes(name) > 16) errs.push(`一级菜单「${name}」超长：${bytes(name)} 字节 > 16 字节（汉字算 3 字节，最多 5 个汉字）`);
      const subs = b.sub_button;
      if (subs) {
        if (subs.length < 2 || subs.length > 5) errs.push(`「${name}」的二级菜单必须 2~5 个，当前 ${subs.length} 个`);
        subs.forEach((s, j) => {
          if (!s.name) errs.push(`「${name}」第 ${j + 1} 个二级菜单缺少名称`);
          else if (bytes(s.name) > 60) errs.push(`二级菜单「${s.name}」超长：${bytes(s.name)} 字节 > 60 字节`);
        });
      } else if (!b.type) {
        errs.push(`「${name}」既没有二级菜单也没有 type`);
      }
    });
    for (const b of walk(btns)) {
      const t = b.type, nm = b.name || '?';
      if (t && VALID_TYPES.indexOf(t) < 0) { errs.push(`「${nm}」的 type=${t} 不是微信支持的取值`); continue; }
      if (NEED_URL.indexOf(t) >= 0 && !b.url) errs.push(`「${nm}」type=view 必须填 url`);
      if (NEED_KEY.indexOf(t) >= 0 && !b.key) errs.push(`「${nm}」type=${t} 必须填 key`);
      if (t === 'miniprogram' && !(b.appid && b.pagepath)) errs.push(`「${nm}」type=miniprogram 必须填 appid 和 pagepath`);
      if (t === 'view' && String(b.url || '').indexOf('你的域名') >= 0) errs.push(`「${nm}」的 url 还是占位地址，上线前要换成真实域名`);
    }
    return errs;
  }

  const WA_MENU_CREATE = 'https://api.weixin.qq.com/cgi-bin/menu/create?access_token=ACCESS_TOKEN';
  function pushPreview(menu) {
    const body = normalize(menu);
    return { method: 'POST', url: WA_MENU_CREATE, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: body,
      curl: `curl -X POST '${WA_MENU_CREATE}' -H 'Content-Type: application/json' -d '${JSON.stringify(body)}'` };
  }

  /* ---------------- 小票 ---------------- */
  const pad = (s, n, w) => s + ' '.repeat(Math.max(0, n - w));
  function lr(left, right, width) {
    const gap = width - dw(left) - dw(right);
    return gap < 1 ? left + ' ' + right : left + ' '.repeat(gap) + right;
  }
  const center = (s, width) => ' '.repeat(Math.max(0, Math.floor((width - dw(s)) / 2))) + s;
  const money = (v) => Number(v || 0).toFixed(2);
  // 按词/逗号换行（别把 STREET 切成 ST/REET，送餐员会看错）
  function wrapText(text, width, indent) {
    indent = indent === undefined ? '  ' : indent;
    const out = []; let line = indent;
    for (const word of String(text).replace(/,/g, ', ').split(/\s+/).filter(Boolean)) {
      if (dw(line) + dw(word) > width && dw(line.trim()) > 0) { out.push(line.replace(/\s+$/, '')); line = indent; }
      line += word + ' ';
    }
    if (line.trim()) out.push(line.replace(/\s+$/, ''));
    return out.length ? out : [indent.replace(/\s+$/, '')];
  }

  function renderReceipt(order, shop, width) {
    width = width || 32; shop = shop || {}; order = order || {};
    const L = [];
    L.push(center(shop.name || '本店', width));
    if (shop.slogan) L.push(center(shop.slogan, width));
    if (shop.phone) L.push(center(shop.phone, width));
    L.push('='.repeat(width));
    L.push('订单号: ' + (order.no || ''));
    L.push('下单时间: ' + (order.created_at || ''));
    if (order.pickup) L.push('** 到店自取 **');
    if (order.customer) L.push('顾客: ' + order.customer);
    if (order.phone) L.push('电话: ' + order.phone);
    if (order.address && !order.pickup) {
      L.push('-'.repeat(width));
      L.push('送餐地址:');
      for (const line of wrapText(String(order.address), width)) L.push(line);
      if (order.distance_miles != null) L.push(lr('距离', Number(order.distance_miles).toFixed(2) + ' 英里', width));
      if (order.eta_minutes) L.push(lr('预计送达', order.eta_minutes + ' 分钟', width));
      if (order.needs_manual_review) L.push('!! 距离是估算值，请人工核对 !!');
    }
    if (order.table) L.push('桌号/取餐号: ' + order.table);
    if (order.openid) L.push('微信: ' + String(order.openid).slice(0, 12) + '...');
    if (order.remark) L.push('备注: ' + order.remark);
    L.push('-'.repeat(width));
    L.push(lr('品名', '金额', width));
    L.push('-'.repeat(width));
    let total = 0;
    for (const it of (order.items || [])) {
      const qty = Number(it.qty || 1), price = Number(it.price || 0);
      total += price * qty;
      let name = it.name || '';
      if (dw(name) > width - 12) name = name.slice(0, Math.max(1, Math.floor((width - 12) / 2)));
      L.push(lr(name, money(price * qty), width));
      if (qty > 1 || it.spec) {
        let sub2 = qty > 1 ? `  x${qty} ${money(price)}` : '';
        if (it.spec) sub2 += (sub2 ? ' ' : '  ') + it.spec;
        L.push(sub2);
      }
    }
    L.push('-'.repeat(width));
    const subKnown = order.subtotal != null;
    const sub = subKnown ? Number(order.subtotal) : total;
    L.push(lr(subKnown ? '小计' : '合计', money(sub), width));
    if (order.tax) {
      const rate = order.tax_rate;
      L.push(lr('税' + (rate ? ' ' + (Number(rate) * 100).toFixed(3) + '%' : ''), money(order.tax), width));
    }
    if (order.delivery_fee != null && !order.pickup) {
      const fee = Number(order.delivery_fee);
      L.push(lr('配送费' + (fee === 0 ? '（免）' : ''), money(fee), width));
    }
    if (order.tip) L.push(lr('小费', money(order.tip), width));
    L.push('-'.repeat(width));
    L.push(lr('合计', money(order.total != null ? order.total : sub), width));
    if (order.pay_type) L.push(lr('支付方式', order.pay_type, width));
    L.push('='.repeat(width));
    const footer = order.footer || shop.footer || '';
    for (const seg of String(footer).split('|')) if (seg) L.push(center(seg, width));
    if (order.qr_url) L.push(center('[二维码] ' + order.qr_url, width));
    L.push('');
    return L.join('\n');
  }

  const ESC = { init: [0x1b, 0x40], center: [0x1b, 0x61, 0x01], left: [0x1b, 0x61, 0x00],
    bigOn: [0x1d, 0x21, 0x11], bigOff: [0x1d, 0x21, 0x00], nl: [0x0a], cut: [0x1d, 0x56, 0x42, 0x00] };

  /* GBK 编码表太大，浏览器里用内置 TextEncoder 只能出 UTF-8。
     这里提供两种：utf8 字节流（便于看结构）+ 前端 GBK 简表（常用汉字覆盖不到就替换）。
     真机打印请用后端 Python 的 GBK 编码结果。 */
  function toEscPosHex(text, opts) {
    opts = opts || {};
    const out = [];
    const push = (arr) => out.push.apply(out, arr);
    push(ESC.init); push(ESC.left);
    const lines = String(text).split('\n');
    lines.forEach((line, i) => {
      const stripped = line.replace(/^ +| +$/g, '');
      const isTitle = i < 2 && stripped && line !== stripped;
      if (isTitle) { push(ESC.center); push(ESC.bigOn); }
      push(enc(line));
      if (isTitle) { push(ESC.bigOff); push(ESC.left); }
      push(ESC.nl);
    });
    push(ESC.nl); push(ESC.nl);
    if (opts.cutter !== false) push(ESC.cut);
    return out.map((b) => b.toString(16).padStart(2, '0')).join(' ');
  }

  function toFeie(text) {
    return String(text).split('\n').map((line, i) => {
      const s = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const stripped = line.replace(/^ +| +$/g, '');
      if (i < 2 && stripped && line !== stripped) return `<CB><B>${stripped}</B></CB>`;
      return s;
    }).join('<BR>') + '<CUT>';
  }

  const API = { VALID_TYPES, bytes, dw, defaultMenu, normalize, validate, pushPreview,
    renderReceipt, toEscPosHex, toFeie, WA_MENU_CREATE };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.WXMenu = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
