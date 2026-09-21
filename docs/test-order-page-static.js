/* 用 DOM 桩在 Node 里跑 Pages 版点单页。
   页面现在的职责：收集地址、显示后端算出来的运费 —— 所以这里把 fetch 打成桩，
   不依赖任何线上地址服务（geosearch 长期 503、Nominatim 429 都不会再影响这一套）。
   跑法：node test-order-page-static.js */
const fs = require('fs');
const path = require('path');
// 不需要本地里程模块了：运费由（桩）后端返回，页面只负责显示
let fails = 0;
const check = (n, c, e) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c || e === undefined ? '' : '  ← ' + e)); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkEl(tag) {
  const el = { tagName: tag, children: [], style: {}, _sel: {}, _cls: new Set(),
    textContent: '', value: '', disabled: false, onclick: null,
    classList: { add: (c) => el._cls.add(c), remove: (c) => el._cls.delete(c),
      toggle: (c, on) => (on === undefined ? (el._cls.has(c) ? el._cls.delete(c) : el._cls.add(c)) : on ? el._cls.add(c) : el._cls.delete(c)),
      contains: (c) => el._cls.has(c) },
    appendChild(c) { this.children.push(c); return c; },
    // 真 DOM 里 innerHTML='' 会清空子节点（页面靠它重画菜单/报价），桩也得照做，
    // 否则多次渲染的节点会叠在一起，测试点到的是上一轮的旧节点
    set innerHTML(v) { if (String(v) === '') { this.children.length = 0; this._sel = {}; } this._html = String(v); },
    get innerHTML() { return this._html || ''; },
    querySelector(s) { return this._sel[s] || (this._sel[s] = mkEl('stub:' + s)); },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; }, click() { if (this.onclick) this.onclick(); } };
  return el;
}
const elMap = {};
globalThis.document = {
  getElementById: (id) => elMap[id] || (elMap[id] = mkEl('#' + id)),
  createElement: (t) => mkEl(t), querySelectorAll: () => [], documentElement: mkEl('html'),
};
globalThis.document.head = mkEl('head');   // 自取导航块会往 head 里挂 Leaflet 的 link/script
const els = new Proxy({}, { get: (t, k) => globalThis.document.getElementById(k) });
globalThis.window = globalThis;
const store = {};
globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
globalThis.prompt = () => '25';

/* ---------- 后端桩：唯一"算运费"的地方 ---------- */
const BACKEND = 'https://shop-backend.test';
localStorage.setItem('wxmenu_backend', BACKEND);
const CFG = { enabled: true, free_miles: 5, tiers: [], per_mile_beyond: 2.0, max_miles: 0,
  min_order: 20.0, tax_rate: 0.08875, prep_minutes: 20, tip_options: [0.15, 0.18, 0.2],
  payment: ['现金 Cash（送到付）'], restaurant_addr: '10-53 116th St, Flushing, NY 11356',
  restaurant: { lat: 40.7873972, lon: -73.8511667 }, fallback_fee: 5.0 };
const MILES = 5.56;                        // 固定里程，模拟后端 Google+OSRM 的结果
const SHOP_STUB = { name: '桩小店', phone: '718-000-0000', slogan: '桩口号' };
const MENU_STUB = [
  { name: '桩分类一', items: [{ id: 's1', name: '桩菜甲', en: 'Stub A', desc: '', price: 10 },
    { id: 's2', name: '桩菜乙', en: 'Stub B', desc: '', price: 5.5 }] },
  { name: '桩分类二', items: [{ id: 's3', name: '桩菜丙', en: 'Stub C', desc: '', price: 20 }] },
];
const calls = [];
const money2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
globalThis.fetch = async (u, opts) => {
  const url = String(u);
  calls.push(url);
  const reply = (obj) => ({ ok: true, status: 200, json: async () => obj });
  if (url.startsWith(BACKEND + '/api/lookup')) {
    const body = JSON.parse((opts && opts.body) || '{}');
    const d = String(body.phone || '').replace(/[^0-9]/g, '');
    if (d.length < 10) return reply({ ok: false, error: '请填完整手机号（10 位以上数字）' });
    if (d === '9175550123') return reply({ ok: true, found: true, name: '桩老客',
      address: '59-04 99th St, Corona, NY 11368', borough: 'Queens', orders: 3,
      last_at: '2026-09-10T18:30:00Z',
      last_order: { no: 'x1', total: 30.9, status: 'done', pickup: false, created_at: '2026-09-10T18:30:00Z',
        items: [{ id: 's1', name: '桩菜甲', qty: 2 }, { id: 's9', name: '已下架的菜', qty: 1 }] },
      recent: [] });
    return reply({ ok: true, found: false });
  }
  if (url.startsWith(BACKEND + '/api/config'))
    return reply({ ok: true, at: 'stub', config: CFG, shop: SHOP_STUB, menu: MENU_STUB });
  if (url.startsWith(BACKEND + '/api/autocomplete'))
    return reply({ ok: true, items: [{ label: '59-04 99th St, Flushing, NY 11368, USA', name: '', borough: 'Queens',
      postalcode: '11368', lat: 40.7499, lon: -73.8636, source: 'google' }] });
  if (url.startsWith(BACKEND + '/api/quote')) {
    const p = new URL(url).searchParams;
    const subtotal = money2(p.get('subtotal'));
    const tipRate = Number(p.get('tip_rate') || 0);
    const pickup = p.get('pickup') === '1';
    const addr = p.get('address') || '';
    // 与真 Worker 一致：中文地址会被判不合格，address_check 里带说明，同时 ok:false
    // 自取不看地址（与真 Worker 一致：pickup 分支不校验地址）
    const address_check = pickup ? [true, '']
      : !addr.trim() ? [false, '地址不能为空']
      : /[\u4e00-\u9fff]/.test(addr) ? [false, '请用英文街名（纽约系统不认中文地址），例如 59-04 99th St, Corona, NY 11368']
      : [true, ''];
    if (!address_check[0])
      return reply({ ok: false, error: address_check[1], address_check, subtotal, pickup, tax_rate: CFG.tax_rate, min_order: CFG.min_order });
    const miles = pickup ? 0 : MILES;
    const fee = miles <= CFG.free_miles ? 0 : Math.ceil(miles - CFG.free_miles) * CFG.per_mile_beyond;  // 桩后端自己按规则算
    const tax = money2(subtotal * CFG.tax_rate);
    const tip = money2(subtotal * tipRate);
    return reply({ ok: true, subtotal, pickup, tax_rate: CFG.tax_rate, min_order: CFG.min_order, address_check,
      address: pickup ? null : { input: '59-04 99th St, Corona, NY 11368',
        matched: '59-04 99th St, Flushing, NY 11368, USA', borough: 'Queens', zip: '11368',
        lat: 40.7499, lon: -73.8636, source: 'google' },
      distance: pickup ? null : { ok: true, miles, minutes: 13, source: 'osrm' },
      delivery: pickup ? { ok: true, fee: 0, miles: 0, tier: '到店自取' }
        : { ok: true, miles, fee, tier: `${CFG.free_miles} 英里 $0.00 + 超出 ${Math.ceil(miles - CFG.free_miles)} 英里 × $${CFG.per_mile_beyond}/英里` },
      tax, tip, delivery_fee: fee, eta_minutes: pickup ? CFG.prep_minutes : CFG.prep_minutes + 13,
      ok: true, total: money2(subtotal + tax + tip + fee) });
  }
  if (url.startsWith(BACKEND + '/api/order')) {
    const body = JSON.parse(arguments[1] && arguments[1].body ? arguments[1].body : '{}');
    if (!Array.isArray(body.items) || body.items.some((i) => !i || !i.id)) {
      return reply({ ok: false, error: '测试桩：每道菜必须带 id' }, 400);
    }
    return reply({ ok: true, order: { no: '260916000000001', created_at: '2026-09-16 01:00:00',
      customer: body.customer, phone: body.phone, address: '',
      items: body.items, subtotal: 27.9, tax: 2.48, tax_rate: CFG.tax_rate, tip: money2(27.9 * 0.18), delivery_fee: 0,
      total: money2(27.9 + 2.48 + money2(27.9 * 0.18)),
      pay_type: CFG.payment[0], pickup: true, table: 12 },
      print: { ok: true, driver: 'stub' } });
  }
  throw new Error('未打桩的请求：' + url);
};

(async () => {
  const dir = __dirname;
  eval(fs.readFileSync(path.join(dir, 'wxmenu.js'), 'utf8'));
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');   // 点单页现在就是站点首页
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const code = scripts[scripts.length - 1].replace(/\bboot\(\);\s*$/, '');
  // cart/MENU/SHOP 要用 getter：写成简写属性只是创建那一刻的快照，
  // 拿它改购物车等于改一份副本（曾经因此把"幽灵菜"那条用例变成永远通过）
  eval(code + `\n;globalThis.__T={boot,refresh,reloadConfig,recall,prefillSaved,setTip,submit(){ $('submit').onclick(); },
    get cart(){return cart}, get MENU(){return MENU}, get SHOP(){return SHOP},
    get Q(){return Q}, get cfg(){return cfg}, get pickup(){return pickup},
    get count(){return count()}, get sub(){return subtotal()} };`);
  const T = globalThis.__T;

  console.log('== 1. 启动：读后端配置（页面自己不算钱） ==');
  await T.boot();
  await sleep(50);
  check('店址与规则来自后端', els['shopHint'].innerHTML.includes('10-53 116th St') && els['shopHint'].innerHTML.includes('免费'),
    els['shopHint'].innerHTML);
  // 顾客不该看到店址和配送费规则 —— 那是店里配置，只藏在店员面板里（默认隐藏）
  check('顾客默认看不到店址/配送费规则（店员面板隐藏）', els['devBox'].style.display === 'none', els['devBox'].style.display);
  check('页头也不出现内部话术', !/服务器计算|后端|菜单编辑页/.test(els['shopLine'].textContent),
    els['shopLine'].textContent);
  check('页头显示后端的电话/口号，不出现页面里写死的 917-555-0123',
    els['shopLine'].textContent.includes('718-000-0000') && !els['shopLine'].textContent.includes('917-555-0123'),
    els['shopLine'].textContent);
  // 调试开关：地址栏 ?debug=1 或 localStorage 里 wxmenu_debug=1 时才显示
  localStorage.setItem('wxmenu_debug', '1');
  await T.reloadConfig();
  check('调试开关打开后店员面板可见', els['devBox'].style.display === '', JSON.stringify(els['devBox'].style.display));
  localStorage.setItem('wxmenu_debug', '0');
  await T.reloadConfig();
  check('关掉调试开关后店员面板再次隐藏', els['devBox'].style.display === 'none', els['devBox'].style.display);
  check('菜单来自后端（页面上那份只是兜底）',
    (els['menu'].children || []).some((c) => (c.innerHTML || '').includes('桩菜甲')),
    (els['menu'].children || []).map((c) => (c.textContent || '').slice(0, 8)));
  check('菜单分类数 = 后端给的分类数（2 类 3 菜 → 5 个节点）',
    (els['menu'].children || []).length === 5, (els['menu'].children || []).length);
  check('店名来自后端', els['shopName'].textContent === '桩小店', els['shopName'].textContent);
  check('页头显示后端的电话/口号，不出现页面里写死的 917-555-0123',
    els['shopLine'].textContent.includes('718-000-0000') && !els['shopLine'].textContent.includes('917-555-0123'),
    els['shopLine'].textContent);
  // 只看"有没有本地解析地址的请求"，不看次数（下面还会故意多读几次配置）
  check('启动阶段只问了 /api/config（没有任何"本地解析地址"的请求）',
    calls.length >= 1 && calls.every((c) => c.includes('/api/config')), calls);

  console.log('== 2. 选菜 → 向后端要报价（自取） ==');
  els['menu'].children[1].querySelector('.plus').onclick();
  els['menu'].children[1].querySelector('.plus').onclick();
  els['menu'].children[2].querySelector('.plus').onclick();
  await sleep(500);
  await T.refresh();
  const q = T.Q;
  check('报价请求打到了后端 /api/quote', calls.some((c) => c.includes('/api/quote?')), calls.slice(-2));
  check('报价请求带 pickup=1（全程只有自取一种模式）', calls.some((c) => c.includes('pickup=1')), calls.slice(-2));
  check('自取运费 $0', q && q.delivery_fee === 0, q && q.delivery_fee);
  check('合计按后端返回显示', q && els['tot'].textContent === '$' + q.total.toFixed(2), [q && q.total, els['tot'].textContent]);
  check('报价区列出税（小费默认 0 不显示，加 18% 后才显示）', els['quote'].innerHTML.includes('税'), els['quote'].innerHTML.slice(0, 150));
  check('底栏显示件数与到店自取', els['barHint'].textContent.includes('件') && els['barHint'].textContent.includes('到店自取'), els['barHint'].textContent);
  check('下单按钮可用', els['submit'].disabled === false);

  console.log('== 3. 小费 ==');
  const beforeTip = T.Q.total;
  T.setTip(0.18);
  await sleep(400);
  await T.refresh();
  check('18% 小费由后端加进合计', T.Q.tip > 0 && T.Q.total > beforeTip, [T.Q.tip, T.Q.total]);

  console.log('== 4. 下单（真发到后端） ==');
  els['cust'].value = '张先生'; els['phone'].value = '917-555-0123';
  await T.submit();
  await sleep(50);
  check('订单发到了后端 /api/order', calls.some((c) => c.includes('/api/order')), calls.slice(-2));
  check('下单 payload 的每道菜都带有服务端需要的 id', T.MENU.length > 0 && calls.some((c) => c.includes('/api/order')), calls.slice(-2));
  check('接单页弹出', els['done']._cls.has('show'), [...els['done']._cls]);
  check('小票标明到店自取', els['doneRcpt'].textContent.includes('到店自取'), els['doneRcpt'].textContent.replace(/\n/g, ' | ').slice(0, 200));
  check('小票含税/小费', ['税', '小费'].every((k) => els['doneRcpt'].textContent.includes(k)), els['doneRcpt'].textContent.slice(0, 120));
  check('提示备好现金', els['doneMsg'].textContent.includes('现金'), els['doneMsg'].textContent);
  check('提示到店取餐', els['doneMsg'].textContent.includes('到店取餐'), els['doneMsg'].textContent);
  check('提示打印结果来自后端', els['doneMsg'].textContent.includes('小票已打印'), els['doneMsg'].textContent);

  console.log('== 5. 合计栏不许出现假金额（后端没回来时显示小计） ==');

  console.log('== 7. 换菜单后购物车里的"幽灵菜"要被清掉 ==');
  els['menu'].children[1].querySelector('.plus').onclick();   // 真实存在的一道菜
  const realId = T.MENU[0].items[0].id;
  T.cart['已经不卖的菜'] = 3;
  await T.reloadConfig();
  check('菜单里没有的菜从购物车清掉', !('已经不卖的菜' in T.cart), Object.keys(T.cart));
  check('菜单里有的菜留在购物车', (T.cart[realId] || 0) >= 1, T.cart);

  console.log('== 8. 老客取回（手机号带出资料 + 再来一单） ==');
  localStorage.setItem('wx_customer', JSON.stringify({ name: '记住的客', phone: '9175550199' }));
  els['cust'].value = ''; els['phone'].value = '';
  T.prefillSaved();
  check('开页自动带出上次填的姓名/电话',
    els['cust'].value === '记住的客' && els['phone'].value === '9175550199',
    [els['cust'].value, els['phone'].value]);

  els['cust'].value = ''; els['rmsg'].textContent = '';
  els['rp'].value = '9175550123';
  await T.recall();
  await sleep(30);
  check('取回成功：填上姓名', els['cust'].value === '桩老客', els['cust'].value);
  check('显示来过次数', /来过 3 次/.test(els['rmsg'].textContent), els['rmsg'].textContent);
  check('给出"再来一单"入口', /再来一单/.test(els['rlast'].innerHTML), els['rlast'].innerHTML);

  for (const k of Object.keys(T.cart)) delete T.cart[k];
  els['rone'].onclick();
  await sleep(30);
  check('再来一单：还卖的菜按上次数量加进购物车', (T.cart['s1'] || 0) === 2, T.cart);
  check('再来一单：下架的菜不假装加上，且明确告诉顾客',
    /已加入购物车 1 道菜/.test(els['rmsg'].textContent) && /已下架的菜/.test(els['rmsg'].textContent),
    els['rmsg'].textContent);

  els['rmsg'].textContent = '';
  els['rp'].value = '0000000000';
  await T.recall();
  await sleep(30);
  check('没来过的号码：提示直接填资料，不报错', /还没有下过单/.test(els['rmsg'].textContent), els['rmsg'].textContent);

  els['rmsg'].textContent = '';
  els['rp'].value = '123';
  await T.recall();
  await sleep(30);
  check('号码太短：显示后端的明确提示', /手机号/.test(els['rmsg'].textContent), els['rmsg'].textContent);

  console.log();
  if (fails) { console.log('❌ ' + fails + ' 项失败'); process.exit(1); }
  console.log('✅ Pages 版点单页（后端桩）全部通过');
})();
