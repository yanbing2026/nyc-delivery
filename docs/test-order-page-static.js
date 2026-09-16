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
    innerHTML: '', textContent: '', value: '', disabled: false, onclick: null,
    classList: { add: (c) => el._cls.add(c), remove: (c) => el._cls.delete(c),
      toggle: (c, on) => (on === undefined ? (el._cls.has(c) ? el._cls.delete(c) : el._cls.add(c)) : on ? el._cls.add(c) : el._cls.delete(c)),
      contains: (c) => el._cls.has(c) },
    appendChild(c) { this.children.push(c); return c; },
    querySelector(s) { return this._sel[s] || (this._sel[s] = mkEl('stub:' + s)); },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; }, click() { if (this.onclick) this.onclick(); } };
  return el;
}
const elMap = {};
globalThis.document = {
  getElementById: (id) => elMap[id] || (elMap[id] = mkEl('#' + id)),
  createElement: (t) => mkEl(t), querySelectorAll: () => [], documentElement: mkEl('html'),
};
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
const calls = [];
const money2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
globalThis.fetch = async (u) => {
  const url = String(u);
  calls.push(url);
  const reply = (obj) => ({ ok: true, status: 200, json: async () => obj });
  if (url.startsWith(BACKEND + '/api/config')) return reply({ ok: true, at: 'stub', config: CFG });
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
    return reply({ ok: true, order: { no: '260916000000001', created_at: '2026-09-16 01:00:00',
      customer: body.customer, phone: body.phone, address: '59-04 99th St, Flushing, NY 11368, USA',
      items: body.items, subtotal: 27.9, tax: 2.48, tax_rate: CFG.tax_rate, tip: 5.02, delivery_fee: 2,
      total: 37.4, eta_minutes: 33, pay_type: CFG.payment[0], pickup: !!body.pickup, distance_miles: MILES },
      print: { ok: true, driver: 'stub' } });
  }
  throw new Error('未打桩的请求：' + url);
};

(async () => {
  const dir = __dirname;
  eval(fs.readFileSync(path.join(dir, 'wxmenu.js'), 'utf8'));
  const html = fs.readFileSync(path.join(dir, 'order.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const code = scripts[scripts.length - 1].replace(/\bboot\(\);\s*$/, '');
  eval(code + `\n;globalThis.__T={boot,refresh,reloadConfig,cart,MENU,setMode,setTip,setAddr:(v)=>{$('addr').value=v;onAddr()},submit(){ $('submit').onclick(); },
    get Q(){return Q}, get cfg(){return cfg}, get pickup(){return pickup} };`);
  const T = globalThis.__T;

  console.log('== 1. 启动：读后端配置（页面自己不算钱） ==');
  await T.boot();
  await sleep(50);
  check('店址与规则来自后端', els['shopHint'].innerHTML.includes('10-53 116th St') && els['shopHint'].innerHTML.includes('免费'),
    els['shopHint'].innerHTML);
  check('起送价显示在后端信息里', els['shopLine'].textContent.includes('起送'), els['shopLine'].textContent);
  check('菜单渲染', (els['menu'].children || []).length >= 8, (els['menu'].children || []).length);
  check('启动没有发任何"本地解析地址"的请求（只问了 /api/config）',
    calls.length === 1 && calls[0].includes('/api/config'), calls);

  console.log('== 2. 选菜 → 向后端要报价 ==');
  els['menu'].children[1].querySelector('.plus').onclick();
  els['menu'].children[1].querySelector('.plus').onclick();
  els['menu'].children[2].querySelector('.plus').onclick();
  T.setAddr('59-04 99th St, Corona, NY 11368');
  await sleep(500);
  await T.refresh();
  const q = T.Q;
  check('报价请求打到了后端 /api/quote', calls.some((c) => c.includes('/api/quote?')), calls.slice(-2));
  check('后端返回的运费被采纳（5.56 英里 → $2）', q && q.delivery_fee === 2, q && q.delivery_fee);
  check('页面显示的运费就是后端返回的数字（不重算）', q && q.delivery_fee === 2, q && [q.delivery_fee]);
  check('合计按后端返回显示', q && els['tot'].textContent === '$' + q.total.toFixed(2), [q && q.total, els['tot'].textContent]);
  check('报价区列出配送费与距离', els['quote'].innerHTML.includes('配送费') && els['quote'].innerHTML.includes('英里'), els['quote'].innerHTML.slice(0, 150));
  check('底栏显示件数与英里', els['barHint'].textContent.includes('件') && els['barHint'].textContent.includes('英里'), els['barHint'].textContent);
  check('下单按钮可用', els['submit'].disabled === false);

  console.log('== 3. 小费 / 自取 ==');
  const beforeTip = T.Q.total;
  T.setTip(0.18);
  await sleep(400);
  await T.refresh();
  check('18% 小费由后端加进合计', T.Q.tip > 0 && T.Q.total > beforeTip, [T.Q.tip, T.Q.total]);
  T.setMode(true);
  await sleep(300);
  await T.refresh();
  check('自取：请求带 pickup=1，运费 $0', T.Q.delivery_fee === 0 && calls.some((c) => c.includes('pickup=1')),
    T.Q.delivery_fee);
  T.setMode(false);
  await sleep(300);
  await T.refresh();

  console.log('== 4. 下单（真发到后端） ==');
  els['cust'].value = '张先生'; els['phone'].value = '917-555-0123';
  await T.submit();
  await sleep(50);
  check('订单发到了后端 /api/order', calls.some((c) => c.includes('/api/order')), calls.slice(-2));
  check('接单页弹出', els['done']._cls.has('show'), [...els['done']._cls]);
  // 大小写按后端返回的原样（Google 给的是混合大小写，不再强制大写）
  check('小票含后端返回的送餐地址', /99th st/i.test(els['doneRcpt'].textContent), els['doneRcpt'].textContent.replace(/\n/g, ' | ').slice(0, 200));
  check('小票含税/配送费/小费', ['税', '配送费', '小费'].every((k) => els['doneRcpt'].textContent.includes(k)), els['doneRcpt'].textContent.slice(0, 120));
  check('提示备好现金', els['doneMsg'].textContent.includes('现金'), els['doneMsg'].textContent);
  check('提示打印结果来自后端', els['doneMsg'].textContent.includes('小票已打印'), els['doneMsg'].textContent);

  console.log('== 5. 地址格式提示（纯本地规则，不联网） ==');
  T.setAddr('法拉盛 缅街 41-28');
  await sleep(400);
  await T.refresh();
  check('中文地址提示用英文街名', els['msgs'].innerHTML.includes('英文街名'), els['msgs'].innerHTML.slice(0, 100));

  console.log('== 6. 合计栏不许出现假金额（没填地址 / 地址后端不认） ==');
  // 回归用例：顾客加了两道菜但还没填地址，页面上"合计"曾经显示 $0.00，
  // 看着像加菜没生效。现在必须显示小计并标明还没算运费。
  els['menu'].children[1].querySelector('.plus').onclick();
  els['menu'].children[1].querySelector('.plus').onclick();
  T.setMode(false);
  T.setAddr('');
  await sleep(400);
  await T.refresh();
  // 小计要按菜单单价算（cart 存的是 id → 份数）
  const priceOf = (id) => { for (const g of T.MENU) for (const it of g.items) if (it.id === id) return it.price; return 0; };
  const sub = Object.entries(T.cart).reduce((a, [id, n]) => a + priceOf(id) * n, 0);
  check('购物车确实非空（复现前提）', sub > 0, sub);
  check('没填地址时合计栏不显示 $0.00', els['tot'].textContent !== '$0.00', els['tot'].textContent);
  check('没填地址时合计栏显示小计并标明还要加运费',
    els['tot'].textContent.startsWith('$') && els['tot'].textContent.includes('运费'), els['tot'].textContent);
  check('合计栏显示的小计与购物车一致', els['tot'].textContent.includes(sub.toFixed(2)), [els['tot'].textContent, sub]);
  check('报价区的合计行写"填地址后计算"而不是金额',
    els['quote'].innerHTML.includes('填地址后计算'), els['quote'].innerHTML.slice(0, 160));
  check('底栏提示待填地址', els['barHint'].textContent.includes('待填地址'), els['barHint'].textContent);

  T.setAddr('法拉盛 缅街 41-28');   // 后端判不合格 → ok:false
  await sleep(400);
  await T.refresh();
  check('后端拒单时合计栏也不显示 $0.00',
    els['tot'].textContent !== '$0.00' && els['tot'].textContent.includes('运费'), els['tot'].textContent);
  check('后端拒单时报价区合计行不是金额', !/合计（现金）<\/span><span>\$/.test(els['quote'].innerHTML), els['quote'].innerHTML.slice(-90));

  console.log();
  if (fails) { console.log('❌ ' + fails + ' 项失败'); process.exit(1); }
  console.log('✅ Pages 版点单页（后端桩）全部通过');
})();
