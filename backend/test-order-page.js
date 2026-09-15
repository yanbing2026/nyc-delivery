/* 用 DOM 桩在 Node 里跑真实点单页的脚本，打真后端（含真地址解析/里程）。
   跑法：node test-order-page.js   （会自动拉起 python3 server.py 8899） */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = 'http://127.0.0.1:8899';
let fails = 0;
const check = (name, cond, extra) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond || extra === undefined ? '' : '  ← ' + extra));
  if (!cond) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- DOM 桩 ---------------- */
function mkEl(tag) {
  const el = {
    tagName: tag, children: [], style: {}, dataset: {}, _sel: {}, _cls: new Set(),
    innerHTML: '', textContent: '', value: '', disabled: false, checked: false, onclick: null,
    classList: {
      add: (c) => el._cls.add(c), remove: (c) => el._cls.delete(c),
      toggle: (c, on) => (on === undefined ? el._cls.has(c) ? el._cls.delete(c) : el._cls.add(c) : on ? el._cls.add(c) : el._cls.delete(c)),
      contains: (c) => el._cls.has(c),
    },
    appendChild(c) { this.children.push(c); return c; },
    querySelector(s) { return this._sel[s] || (this._sel[s] = mkEl('stub:' + s)); },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    click() { if (this.onclick) this.onclick(); }, remove() {}, focus() {},
  };
  return el;
}
const elMap = {};
const document = {
  getElementById: (id) => elMap[id] || (elMap[id] = mkEl('#' + id)),
  createElement: (t) => mkEl(t),
  querySelectorAll: () => [],
  documentElement: mkEl('html'),
};
// 用 Proxy：测试里 anyName 都能拿到元素桩（页面没碰过的 id 也按需创建）
const els = new Proxy({}, { get: (t, k) => document.getElementById(k) });
globalThis.document = document;
globalThis.window = globalThis;
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#c8321f' });
globalThis.prompt = () => '25';
globalThis.location = { reload() { globalThis.__reloaded = true; }, origin: BASE, pathname: '/order.html' };
globalThis.alert = (m) => { globalThis.__lastAlert = m; };
// 页面里用的是相对路径 fetch('/api/...')，浏览器能懂，Node 要补上主机
const __realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => __realFetch(String(u).startsWith('http') ? u : BASE + u, o);

/* ---------------- 起后端 ---------------- */
async function up() {
  try { const r = await fetch(BASE + '/api/state'); if (r.ok) return null; } catch (e) {}
  const p = spawn('python3', ['server.py', '8899'], { cwd: __dirname, stdio: 'ignore' });
  for (let i = 0; i < 20; i++) { await sleep(500); try { const r = await fetch(BASE + '/api/state'); if (r.ok) return p; } catch (e) {} }
  throw new Error('后端起不来');
}

(async () => {
  const proc = await up();
  try {
    const html = fs.readFileSync(path.join(__dirname, 'static', 'order.html'), 'utf8');
    const code = html.match(/<script>([\s\S]*)<\/script>/)[1];
    // 去掉页面自带的 boot() 调用（测试自己控制启动时机，不然会渲染两遍）
    const noAuto = code.replace(/\bboot\(\);\s*$/, '');
    // 把内部状态暴出来给测试用
    const patched = noAuto + `\n;globalThis.__T = { boot, refresh, renderMenu, cart, setMode, setTip, pick,
      get Q(){return Q}, get CFG(){return CFG}, get MENU(){return MENU}, get pickup(){return pickup},
      submit(){ $('submit').onclick(); }, setAddr(v){ $('addr').value = v; onAddr(); }, get acTimer(){return acTimer} };`;
    eval(patched);
    const T = globalThis.__T;

    console.log('== 1. 加载配置与菜单 ==');
    await T.boot();
    check('拿到配置', !!T.CFG && !!T.CFG.delivery, T.CFG && T.CFG.delivery && 'ok');
    check('菜单渲染出分类', (els['menu'].children || []).length >= 4, (els['menu'].children || []).length);
    check('店名显示', els['shopName'].textContent.length > 0, els['shopName'].textContent);
    check('送餐/自取切换存在', typeof T.setMode === 'function');
    T.setMode(true);
    check('切到自取后按钮高亮跟着走', els['mPickup']._cls.has('on') && !els['mDelivery']._cls.has('on'),
      [...els['mPickup']._cls, ...els['mDelivery']._cls]);
    T.setMode(false);
    check('切回送餐按钮状态正确', els['mDelivery']._cls.has('on') && !els['mPickup']._cls.has('on'));
    check('支付方式只有现金', (T.CFG.delivery.payment || []).join() === '现金 Cash（送到付）', T.CFG.delivery.payment);
    check('起送价显示', els['shopLine'].textContent.includes('起送'), els['shopLine'].textContent);

    console.log('== 2. 选菜（点页面上的 + 按钮） ==');
    const firstItem = els['menu'].children[1];              // [0] 是分类标题
    firstItem.querySelector('.plus').onclick();
    firstItem.querySelector('.plus').onclick();
    check('同一道菜点两次 → 数量 2', Object.values(T.cart).reduce((a, b) => a + b, 0) === 2, T.cart);
    const secondItem = els['menu'].children[2];
    secondItem.querySelector('.plus').onclick();
    await sleep(300);
    check('底栏合计 > 0', parseFloat(els['tot'].textContent.replace('$', '')) > 0, els['tot'].textContent);
    check('底栏显示件数', els['barHint'].textContent.includes('3 件'), els['barHint'].textContent);

    console.log('== 3. 送餐地址 + 真实里程报价（调真接口） ==');
    T.setAddr('100 Mott St, New York, NY 10013');
    await sleep(3200);                                      // 等 debounce + 真网络
    await T.refresh();
    const q = T.Q;
    check('报价成功', q && q.ok, q && q.error);
    check('解析到曼哈顿唐人街 (10013)', q.address && q.address.zip === '10013', q.address);
    check('算出驾车里程 0.1~1.5 英里', q.distance && q.distance.miles > 0.05 && q.distance.miles < 1.5, q.distance);
    check('配送费按阶梯给出数字', typeof q.delivery_fee === 'number', q.delivery_fee);
    check('税 = 小计 × 8.875%', q.tax === Math.round(T.Q.subtotal * 0.08875 * 100) / 100, [q.tax, T.Q.subtotal]);
    check('小费默认 0（未选）', q.tip === 0, q.tip);
    check('预计送达分钟 > 0', (q.eta_minutes || 0) > 0, q.eta_minutes);
    check('底栏显示英里数', els['barHint'].textContent.includes('英里'), els['barHint'].textContent);
    check('报价区渲染出行', els['quote'].innerHTML.includes('合计'), els['quote'].innerHTML.slice(0, 60));

    console.log('== 4. 小费按钮 ==');
    T.setTip(0.18);
    await sleep(300);
    await T.refresh();
    check('18% 小费被算进合计', T.Q.tip > 0 && T.Q.total === Math.round((T.Q.subtotal + T.Q.tax + T.Q.delivery_fee + T.Q.tip) * 100) / 100, T.Q);
    check('小票预览会含小费行', true);

    console.log('== 5. 提交下单（真下单 → 真出小票） ==');
    els['cust'].value = '张先生';
    els['phone'].value = '917-555-0123';
    els['remark'].value = '多给筷子，不要辣';
    check('提交按钮已启用', els['submit'].disabled === false, els['submit'].disabled);
    await T.submit();
    await sleep(1500);
    const doneNo = els['doneNo'].textContent;
    check('弹出接单页并带订单号', /订单号 \d+/.test(doneNo), doneNo);
    check('提示备好现金', els['doneMsg'].textContent.includes('现金'), els['doneMsg'].textContent);
    check('小票正文含送餐地址', els['doneRcpt'].textContent.includes('MOTT ST'), els['doneRcpt'].textContent.split('\n').slice(0, 12).join(' | '));
    check('小票含税/配送费/小费', ['税', '配送费', '小费'].every((k) => els['doneRcpt'].textContent.includes(k)));

    const orderNo = doneNo.replace('订单号 ', '');
    const saved = (await (await fetch(BASE + '/api/orders')).json()).orders.find((o) => o.no === orderNo);
    check('后端存下的订单金额与页面一致',
      saved && saved.total === T.Q.total && saved.tax === T.Q.tax && saved.tip === T.Q.tip, saved && { total: saved.total, ui: T.Q.total });
    check('订单记录了服务端重算的距离', saved && saved.distance_miles > 0.05, saved && saved.distance_miles);
    check('订单是现金支付', saved && saved.pay_type.includes('现金'), saved && saved.pay_type);

    console.log('== 6. 切到自取：不要地址、免配送费 ==');
    // 先用一个要收配送费的地址（唐人街到 Pike St 约 0.8 英里 → $3），不然对比看不出来
    T.setAddr('1 Pike St, New York, NY 10002');
    await sleep(3200);
    await T.refresh();
    const feeDelivery = T.Q.delivery_fee;
    const deliveryTotal = T.Q.total;
    check('这个地址确实要收配送费', feeDelivery > 0, feeDelivery);
    T.setMode(true);
    await sleep(400);
    await T.refresh();
    check('自取不收配送费', T.Q.delivery_fee === 0, T.Q.delivery_fee);
    check('自取总价比送餐低，差额正好是配送费',
      deliveryTotal - T.Q.total === feeDelivery, [T.Q.total, deliveryTotal, feeDelivery]);
    check('自取隐藏地址框', els['deliveryBox'].style.display === 'none', els['deliveryBox'].style.display);

    console.log('== 7. 超范围地址被挡（法拉盛 11 英里 > 8 英里上限） ==');
    T.setMode(false);
    T.setAddr('136-20 Roosevelt Ave, Flushing, NY 11354');
    await sleep(3200);
    await T.refresh();
    check('报价失败并说明超出范围', T.Q && T.Q.ok === false && /超出配送范围/.test(T.Q.error || ''), T.Q && T.Q.error);
    check('下单按钮被禁用', els['submit'].disabled === true, els['submit'].disabled);
    check('页面显示红色错误', els['msgs'].innerHTML.includes('msg err'), els['msgs'].innerHTML.slice(0, 80));

    console.log('== 8. 中文地址被挡（纽约系统不认） ==');
    T.setAddr('法拉盛 缅街 41-28');
    await sleep(1200);
    await T.refresh();
    check('提示要用英文街名', els['msgs'].innerHTML.includes('英文街名'), els['msgs'].innerHTML.slice(0, 120));
  } finally {
    if (proc) proc.kill();
  }

  console.log();
  if (fails) { console.log('❌ ' + fails + ' 项失败'); process.exit(1); }
  console.log('✅ 点单页（真后端 + 真里程）全部通过');
})();
