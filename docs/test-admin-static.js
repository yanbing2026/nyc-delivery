/* 用 DOM 桩在 Node 里跑店铺设置页（admin.html）。
   验证的核心是：改完东西到底发出去什么、发去哪、带没带口令，以及服务器拒绝时页面怎么反应。
   跑法：node test-admin-static.js */
const fs = require('fs');
const path = require('path');
let fails = 0;
const check = (n, c, e) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c || e === undefined ? '' : '  ← ' + e)); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 从标签字符串里取属性值（不用正则，避免转义踩坑）
const attr = (tag, name) => {
  const k = name + '="';
  const i = tag.indexOf(k);
  if (i < 0) return '';
  const j = tag.indexOf('"', i + k.length);
  return j < 0 ? '' : tag.slice(i + k.length, j);
};
function mkEl(tag) {
  const el = { tagName: tag, children: [], style: {}, _sel: {}, _cls: new Set(),
    textContent: '', value: '', disabled: false, onclick: null, className: '',
    classList: { add: (c) => el._cls.add(c), remove: (c) => el._cls.delete(c), toggle: (c, on) => (on === undefined ? null : on ? el._cls.add(c) : el._cls.delete(c)), contains: (c) => el._cls.has(c) },
    appendChild(c) { this.children.push(c); return c; },
    // 真浏览器会把 innerHTML 字符串里的 <input id=...> 真的建出来（页面靠 id 取输入框），
    // 桩得照做：扫出 id/value 登记到 elMap，并把 HTML 实体还原成原文
    set innerHTML(v) {
      const s = String(v);
      if (s === '') { this.children.length = 0; this._sel = {}; }
      this._html = s;
      for (const chunk of s.split('<').slice(1)) {
        const tag = chunk.slice(0, chunk.indexOf('>'));
        const id = attr(tag, 'id');
        if (!id) continue;
        const el = elMap[id] || (elMap[id] = mkEl('#' + id));
        el.value = unesc(attr(tag, 'value'));
      }
    },
    get innerHTML() { return this._html || ''; },
    querySelector(s) { return this._sel[s] || (this._sel[s] = mkEl('stub:' + s)); },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; }, click() { if (this.onclick) this.onclick(); } };
  return el;
}
const elMap = {};
const unesc = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
globalThis.document = {
  getElementById: (id) => elMap[id] || (elMap[id] = mkEl('#' + id)),
  createElement: (t) => mkEl(t), querySelectorAll: () => [], documentElement: mkEl('html'),
};
const els = new Proxy({}, { get: (t, k) => globalThis.document.getElementById(k) });
globalThis.window = globalThis;
const store = {};
globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; }, clear: () => { for (const k of Object.keys(store)) delete store[k]; } };

/* ---------- 后端桩 ---------- */
const BACKEND = 'https://shop-backend.test';
const cfg = { restaurant_addr: '10-53 116th St, Flushing, NY 11356', free_miles: 5, per_mile_beyond: 2,
  max_miles: 0, tiers: [], min_order: 20, tax_rate: 0.08875, prep_minutes: 20, tip_options: [0.15, 0.18, 0.2],
  payment: ['现金 Cash（送到付）'] };
const menu0 = [
  { name: '招牌', items: [{ id: 'a1', name: '海蛎煎', en: 'Oyster Omelette', desc: '现点现做', price: 12.95 }] },
  { name: '饮品', items: [{ id: 'd1', name: '茉莉花茶', en: 'Jasmine Tea', desc: '', price: 3.95 }] },
];
const posts = [];
const calls = [];
const verifyCalls = [];
const KEY_OK = 'test-key-123';
let rejectSave = null;   // 设了就让服务器拒绝保存（测页面怎么反应）
const reply = (obj) => ({ ok: true, status: 200, json: async () => obj });
globalThis.fetch = async (u, opts) => {
  const url = String(u); calls.push(url);
  if (url.startsWith(BACKEND + '/api/report/verify')) {
    verifyCalls.push(opts.headers || {});
    const k = (opts.headers || {})['X-Agent-Key'];
    return reply(k === KEY_OK ? { ok: true, at: 'stub', who: '店员' } : { ok: false, error: 'agent key 不对' });
  }
  if (url.startsWith(BACKEND + '/api/config'))
    return reply({ ok: true, shop: { name: '真小店', phone: '212-333-4444', slogan: '真口号' }, menu: menu0, config: cfg });
  if (url.startsWith(BACKEND + '/api/report/settings')) {
    const body = JSON.parse(opts.body);
    posts.push({ url, headers: opts.headers, body });
    if (rejectSave) return reply(rejectSave);
    return reply({ ok: true, shop: body.shop, menu: body.menu, config: { ...cfg, ...body } });
  }
  throw new Error('未打桩的请求：' + url);
};

(async () => {
  const html = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
  // 真浏览器从标签上读初始的 style/class（比如 #panel 默认 display:none），桩得照着填，
  // 否则"没验口令时表单不显示"这条根本测不出来。
  // 不用正则：属性里带不带转义都无所谓（曾经因为 \b 被写成 \\b 导致这一整段静默失效）
  for (const chunk of html.split('<').slice(1)) {
    const tag = chunk.slice(0, chunk.indexOf('>'));
    const id = attr(tag, 'id');
    if (!id) continue;
    const el = globalThis.document.getElementById(id);
    const disp = attr(tag, 'style').split(';').map((s) => s.split(':'))
      .filter((p) => p[0] && p[0].trim() === 'display').map((p) => (p[1] || '').trim())[0];
    if (disp) el.style.display = disp;
    const cls = attr(tag, 'class');
    if (cls) el.className = cls;
  }
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const code = scripts[scripts.length - 1].replace(/\bboot\(\);\s*$/, '');
  eval(code + `\n;globalThis.__A={boot,load,save,unlock,lock,collect,renderMenu,addCat,addItem,delItem,get model(){return model},get unlocked(){return unlocked},get nextId(){return nextId}};`);
  const A = globalThis.__A;

  console.log('== 0. 门锁：没有口令进不去（校验在服务器上，不是前端摆设） ==');
  localStorage.setItem('wxmenu_backend', BACKEND);
  await A.boot();
  await sleep(20);
  check('没口令：不去读后端配置', !calls.some((c) => c.includes('/api/config')), calls);
  check('没口令：表单不显示', els['panel'].style.display === 'none', els['panel'].style.display);
  check('没口令：门锁就在那儿', els['lockBox'].style.display !== 'none', els['lockBox'].style.display);

  els['backend'].value = BACKEND; els['key'].value = '错的口令';
  await A.unlock();
  await sleep(20);
  check('口令错：明说进不去', /口令不对/.test(els['lockStatus'].textContent), els['lockStatus'].textContent);
  check('口令错：表单还是不显示、也没读配置',
    els['panel'].style.display === 'none' && !calls.some((c) => c.includes('/api/config')),
    [els['panel'].style.display, calls.length]);
  check('验口令是去服务器问的（不是页面里写死比对）', verifyCalls.length >= 1 && calls.some((c) => c.includes('/api/report/verify')), verifyCalls.length);

  els['key'].value = KEY_OK;
  await A.unlock();
  await sleep(20);
  check('口令对：进了后台（表单出来、门锁收起）',
    els['panel'].style.display === '' && els['lockBox'].style.display === 'none',
    [els['panel'].style.display, els['lockBox'].style.display]);
  check('口令对：这时候才去读配置', calls.some((c) => c.includes('/api/config')), calls);
  check('验口令请求带上了口令', verifyCalls[verifyCalls.length - 1]['X-Agent-Key'] === KEY_OK, verifyCalls[verifyCalls.length - 1]);
  check('口令存进本机（下次不用重填）', localStorage.getItem('wxmenu_agentkey') === KEY_OK);

  A.lock();
  check('锁定后本机不再留口令', !localStorage.getItem('wxmenu_agentkey'), localStorage.getItem('wxmenu_agentkey'));
  check('锁定后表单收起、回到门锁', els['panel'].style.display === 'none' && els['lockBox'].style.display === '',
    [els['panel'].style.display, els['lockBox'].style.display]);
  els['key'].value = KEY_OK; await A.unlock(); await sleep(20);

  console.log('== 1. 打开页面：从后端读店名/菜单/规则 ==');
  localStorage.setItem('wxmenu_backend', BACKEND);
  await A.boot();
  await sleep(20);
  check('读了 /api/config', calls.some((c) => c.includes('/api/config')), calls);
  check('店名/电话填进了输入框', els['shop_name'].value === '真小店' && els['shop_phone'].value === '212-333-4444',
    [els['shop_name'].value, els['shop_phone'].value]);
  check('配送费规则填进了输入框',
    els['r_free'].value == 5 && els['r_per_mile'].value == 2 && els['r_min'].value == 20 && String(els['r_tax'].value) === '8.875',
    [els['r_free'].value, els['r_per_mile'].value, els['r_min'].value, els['r_tax'].value]);
  check('店址填进了输入框', els['r_addr'].value.includes('Flushing'), els['r_addr'].value);
  check('菜单渲染成可编辑的行', A.model.menu.length === 2 && A.model.menu[0].items[0].id === 'a1', A.model.menu);
  check('每道菜有独立的输入框 id（保存时按 id 取值）',
    els['i_name_0_0'].value === '海蛎煎' && String(els['i_price_0_0'].value) === '12.95',
    [els['i_name_0_0'].value, els['i_price_0_0'].value]);

  console.log('== 2. 改店名 + 改价 → 保存 ==');
  els['shop_name'].value = '新店名小馆';
  els['i_price_0_0'].value = '15.5';
  els['key'].value = KEY_OK;
  await A.save();
  await sleep(20);
  check('发到 /api/report/settings', posts.length === 1 && posts[0].url.endsWith('/api/report/settings'), posts.length);
  check('带上口令（X-Agent-Key）', posts[0].headers['X-Agent-Key'] === KEY_OK, posts[0].headers);
  check('发的是改后的店名', posts[0].body.shop.name === '新店名小馆', posts[0].body.shop);
  check('发的是改后的价格（数字，不是字符串）',
    posts[0].body.menu[0].items[0].price === 15.5, posts[0].body.menu[0].items[0]);
  check('配送费规则一并发出', posts[0].body.free_miles === 5 && posts[0].body.per_mile_beyond === 2
    && posts[0].body.tax_rate === 0.08875 && posts[0].body.min_order === 20,
    [posts[0].body.free_miles, posts[0].body.per_mile_beyond, posts[0].body.tax_rate]);
  check('保存成功有明确提示', els['status'].className === 'ok' && /已保存/.test(els['status'].textContent), els['status'].textContent);
  check('保存时也把口令记在本机（下次不用重填）', localStorage.getItem('wxmenu_agentkey') === KEY_OK);

  console.log('== 3. 没口令不许改 ==');
  const n = posts.length;
  els['key'].value = '';
  await A.save();
  check('没口令就不发请求', posts.length === n, posts.length - n);
  check('提示要填口令', /口令/.test(els['status'].textContent), els['status'].textContent);
  els['key'].value = KEY_OK;

  console.log('== 4. 服务器拒绝时要看到原因 ==');
  rejectSave = { ok: false, error: '菜单里没有一道合格的菜：每道菜要有唯一 id、名字，价格 0~999' };
  await A.save();
  check('拒绝的原因显示在页面上', /合格/.test(els['status'].textContent) && els['status'].className === 'err', els['status'].textContent);
  check('拒绝时不算成功（不显示已保存）', !/已保存/.test(els['status'].textContent), els['status'].textContent);
  rejectSave = null;

  console.log('== 5. 加分类 / 加菜 / 删菜 ==');
  A.addCat();
  await sleep(10);
  const ci = A.model.menu.length - 1;
  els['c_name_' + ci].value = '新分类名';
  A.addItem(ci);
  await sleep(10);
  const ii = A.model.menu[ci].items.length - 1;
  els['i_name_' + ci + '_' + ii].value = '新菜名';
  els['i_price_' + ci + '_' + ii].value = '8.25';
  await A.save();
  await sleep(20);
  const last = posts[posts.length - 1].body.menu;
  const added = last[last.length - 1];
  check('改完分类名再点"+加菜"，名字不会被重新渲染冲掉（回归）', added.name === '新分类名', added);
  check('新菜被发出且价格是数字', added.items[added.items.length - 1].name === '新菜名'
    && added.items[added.items.length - 1].price === 8.25, added.items);
  check('新菜编号非空且唯一', added.items.every((it, i) => it.id && added.items.filter((x) => x.id === it.id).length === 1),
    added.items.map((it) => it.id));
  A.delItem(0, 0);
  await sleep(10);
  check('删掉的菜不再出现在模型里', A.model.menu[0].items.length === 0 || A.model.menu[0].items[0].id !== 'a1', A.model.menu[0]);

  console.log('== 6. 价格填成乱码：不发请求、明确提示，坏行留在界面上 ==');
  A.addItem(0);                       // 加一道菜，把它的价格改成乱码
  const badIi = A.model.menu[0].items.length - 1;
  els['i_price_0_' + badIi].value = 'abc';
  const before = posts.length;
  await A.save();
  check('坏价格不发请求（不把 $0 或 NaN 的菜存进后端）', posts.length === before, posts.length - before);
  check('提示里指明是哪道菜、且提示"还没存"',
    /还没存/.test(els['status'].textContent) && new RegExp('第 1 个分类的第 ' + (badIi + 1) + ' 道菜').test(els['status'].textContent),
    els['status'].textContent);
  check('坏行还在界面上（用户可以改，不是被静默丢掉）',
    A.model.menu[0].items.length === badIi + 1, A.model.menu[0].items.length);
  els['i_price_0_' + badIi].value = '7.75';
  await A.save();
  check('改好后就能存上，价格是数字', posts.length === before + 1
    && posts[posts.length - 1].body.menu[0].items[badIi].price === 7.75,
    posts.length - before);

  console.log('== 7. 名字里带引号/尖括号：渲染要转义、保存要原文 ==');
  A.model.menu = [{ name: '分类"X<Y>', items: [{ id: 'x1', name: 'A"B<C>', en: '', desc: '', price: 1 }] }];
  A.renderMenu();
  const rowHtml = ((els['menu'].children[0] || {}).innerHTML) || '';
  check('渲染时转义了引号/尖括号（不会被当成标签，页面不会破）',
    rowHtml.includes('&quot;') && rowHtml.includes('&lt;Y&gt;') && !/<Y>/.test(rowHtml), rowHtml.slice(0, 140));
  els['i_name_0_0'].value = 'A"B<C>';
  check('保存时发出去的是原文（不把 HTML 实体存进后端）',
    A.collect().menu[0].items[0].name === 'A"B<C>', A.collect().menu[0].items[0].name);

  console.log();
  if (fails) { console.log('❌ ' + fails + ' 项失败'); process.exit(1); }
  console.log('✅ 店铺设置页（后端桩）全部通过');
})();
