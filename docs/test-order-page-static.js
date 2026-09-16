/* 用 DOM 桩在 Node 里跑 Pages 版点单页（浏览器内算里程版），调真 GeoSearch + OSRM。
   跑法：node test-order-page-static.js */
const fs = require('fs');
const path = require('path');
const D = require('./delivery.js');
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

(async () => {
  const dir = __dirname;
  eval(fs.readFileSync(path.join(dir, 'wxmenu.js'), 'utf8'));
  eval(fs.readFileSync(path.join(dir, 'delivery.js'), 'utf8'));
  const html = fs.readFileSync(path.join(dir, 'order.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const code = scripts[scripts.length - 1].replace(/\bboot\(\);\s*$/, '');
  eval(code + `\n;globalThis.__T={boot,refresh,cart,MENU,setMode,setTip,setAddr:(v)=>{$('addr').value=v;onAddr()},submit(){ $('submit').onclick(); },resolveRest,
    get Q(){return Q}, get rest(){return rest}, get pickup(){return pickup} };`);
  const T = globalThis.__T;

  console.log('== 1. 启动（浏览器内解析店址，调真 GeoSearch） ==');
  await T.boot();
  await sleep(2500);
  await T.resolveRest();
  check('店址解析成功拿到坐标', !!T.rest && T.rest.lat > 40.7, T.rest);
  check('设置区显示定位结果', els['shopHint'].innerHTML.includes('起点已定位'), els['shopHint'].innerHTML);
  check('菜单渲染', (els['menu'].children || []).length >= 8, (els['menu'].children || []).length);
  check('现金支付文案', html.includes('目前只收现金'));

  console.log('== 2. 选菜 ==');
  els['menu'].children[1].querySelector('.plus').onclick();
  els['menu'].children[1].querySelector('.plus').onclick();
  els['menu'].children[2].querySelector('.plus').onclick();
  await sleep(200);
  check('3 件菜', T.count === undefined ? Object.values(T.cart).reduce((a, b) => a + b, 0) === 3 : true, T.cart);

  console.log('== 3. 填地址 → 浏览器内算里程与配送费（真 OSRM） ==');
  T.setAddr('136-20 Roosevelt Ave, Flushing, NY 11354');
  await sleep(3200);
  await T.refresh();
  const q = T.Q;
  check('报价成功', q && q.ok, q && q.error);
  check('解析到 11354', q.address && q.address.zip === '11354', q.address);
  check('配送费与实测里程一致', q.delivery_fee === D.deliveryFee(q.distance.miles, D.DEFAULT_DELIVERY).fee, [q.distance.miles, q.delivery_fee]);
  check('税 = 小计 × 8.875%（与后端同一公式）',
    q.tax === Math.round(T.Q.subtotal * 0.08875 * 100) / 100, [q.tax, T.Q.subtotal]);
  check('预计送达有值', q.eta_minutes > 0, q.eta_minutes);
  check('底栏显示英里', els['barHint'].textContent.includes('英里'), els['barHint'].textContent);
  const beforeTip = q.total;
  T.setTip(0.18);
  await sleep(600);
  await T.refresh();
  check('18% 小费加进合计', T.Q.tip > 0 && T.Q.total > beforeTip, [T.Q.tip, T.Q.total]);

  console.log('== 4. 下单（静态模式：本地生成小票） ==');
  els['cust'].value = '张先生'; els['phone'].value = '917-555-0123';
  await T.submit();
  await sleep(600);
  check('接单页弹出', els['done']._cls.has('show'), [...els['done']._cls]);
  check('小票含送餐地址', els['doneRcpt'].textContent.includes('ROOSEVELT'), els['doneRcpt'].textContent.split('\n').slice(0, 10).join(' | '));
  check('小票含税/配送费/小费', ['税', '配送费', '小费'].every((k) => els['doneRcpt'].textContent.includes(k)), els['doneRcpt'].textContent);
  check('提示备好现金', els['doneMsg'].textContent.includes('现金'), els['doneMsg'].textContent);
  check('提示这是演示（没有真打印机）', els['doneMsg'].textContent.includes('演示'), els['doneMsg'].textContent);

  console.log('== 5. 自取 / 远距离 / 中文地址 ==');
  T.setMode(true); await sleep(900);
  check('自取免配送费', T.Q.delivery_fee === 0, T.Q.delivery_fee);
  T.setMode(false);
  T.setAddr('1 Pike St, New York, NY 10002');
  await sleep(3200); await T.refresh();
  check('下东城十几英里 → 不设上限，照算能送',
    T.Q.ok === true && T.Q.delivery_fee === D.deliveryFee(T.Q.distance.miles, D.DEFAULT_DELIVERY).fee,
    [T.Q.distance && T.Q.distance.miles, T.Q.delivery_fee]);
  T.setAddr('法拉盛 缅街 41-28'); await sleep(600); await T.refresh();
  check('中文地址提示用英文', els['msgs'].innerHTML.includes('英文街名'), els['msgs'].innerHTML.slice(0, 80));

  console.log();
  if (fails) { console.log('❌ ' + fails + ' 项失败'); process.exit(1); }
  console.log('✅ Pages 版点单页全部通过');
})();
