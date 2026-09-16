/* node test-wxmenu.js —— 前端逻辑与后端 Python 交叉验证（同样的输入必须同样的输出） */
const W = require('./wxmenu.js');
let fails = 0;
const check = (name, cond, extra) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond || extra === undefined ? '' : '  ← ' + extra));
  if (!cond) fails++;
};

console.log('== 字节长度：微信按 UTF-8 字节算 ==');
check('「我要点单」= 12 字节', W.bytes('我要点单') === 12, W.bytes('我要点单'));
check('带 emoji 的「🍜 我要点单」= 17 字节（会超 16）', W.bytes('🍜 我要点单') === 17, W.bytes('🍜 我要点单'));

console.log('== 菜单规则校验 ==');
const ok = W.defaultMenu('https://shop.example.com/order');
check('默认菜单无错误', W.validate(ok).length === 0, JSON.stringify(W.validate(ok)));
const bad = JSON.parse(JSON.stringify(ok)); bad.button[0].name = '六个汉字超长了';
check('一级超 16 字节被拦', W.validate(bad).some((e) => e.includes('超长')), W.validate(bad));
const b2 = JSON.parse(JSON.stringify(ok)); b2.button.push({ name: '第四个', type: 'click', key: 'K' });
check('4 个一级被拦', W.validate(b2).some((e) => e.includes('最多 3 个')));
const b3 = JSON.parse(JSON.stringify(ok)); b3.button[0].sub_button = [{ type: 'click', name: '只有一个', key: 'K' }];
check('二级 1 个被拦', W.validate(b3).some((e) => e.includes('2~5 个')));
const b4 = JSON.parse(JSON.stringify(ok)); b4.button[0].sub_button[0] = { type: 'view', name: '没URL' };
check('view 缺 url 被拦', W.validate(b4).some((e) => e.includes('必须填 url')));
const b5 = JSON.parse(JSON.stringify(ok)); b5.button[0].sub_button[0] = { type: 'view', name: '占位', url: 'http://你的域名/order' };
check('占位域名被提示', W.validate(b5).some((e) => e.includes('占位')));

console.log('== 小票渲染（与 Python 同样的订单，必须逐字符一致） ==');
const order = { no: '2509150001', created_at: '2026-09-15 12:00:00', openid: 'oDemoOpenid0001',
  table: 'A3', remark: '少辣', pay_type: '微信支付', footer: '谢谢惠顾|欢迎再来',
  items: [{ name: '琅岐海蛎煎', qty: 2, price: 28.0 }, { name: '茉莉花茶', qty: 1, price: 8.0 }] };
const shop = { name: '琅岐海鲜小馆', slogan: '-- 现捞现做 --', phone: '0591-8888 8888', footer: '谢谢惠顾|欢迎再来' };
const text = W.renderReceipt(order, shop, 32);
console.log(text.split('\n').slice(0, 6).map((l) => '    |' + l).join('\n'));
check('每行不超过 32 半角宽', text.split('\n').every((l) => W.dw(l) <= 32),
  text.split('\n').filter((l) => W.dw(l) > 32).join(' / '));
check('合计 64.00', text.includes('64.00'));
const fsx = require('fs');
// 基准文件是 Python 渲染的真身，由 backend/make_receipt_fixtures.py 生成。
// 以前只在原来那台机器的 /tmp 里留了一份，换台机器（或清过 /tmp）就直接
// ENOENT —— README 说的「可以单独跑」其实不成立，所以这里按需自己生成。
const FIXTURES = ['/tmp/py_receipt.txt', '/tmp/py_receipt_delivery.txt'];
if (!FIXTURES.every((f) => fsx.existsSync(f))) {
  const { execFileSync } = require('child_process');
  const backendDir = require('path').join(__dirname, '..', 'backend');
  try {
    execFileSync('python3', ['make_receipt_fixtures.py'], { cwd: backendDir, stdio: 'pipe' });
    console.log('  （基准文件不存在，已用 backend/make_receipt_fixtures.py 生成）');
  } catch (e) {
    console.log('  ✗ 生成基准文件失败（需要 python3）：' + e.message);
    console.log('    手动跑：cd backend && python3 make_receipt_fixtures.py');
    process.exit(1);
  }
}
check('老式微信单：与 Python 逐字符一致',
  text === fsx.readFileSync('/tmp/py_receipt.txt', 'utf8').replace(/\n$/, ''), '见 /tmp/py_receipt.txt');

console.log('== 纽约送餐单：地址/距离/税/小费/现金，与 Python 逐字符一致 ==');
const dorder = { no: '2509150002', created_at: '2026-09-15 12:30:00', customer: '张先生',
  phone: '917-555-0123', address: '1 PIKE STREET, New York, NY, USA', borough: 'Manhattan',
  distance_miles: 0.84, eta_minutes: 23, remark: '多给筷子，不要辣',
  items: [{ name: '海蛎煎', qty: 2, price: 12.95 }, { name: '白饭', qty: 1, price: 2.0 }],
  subtotal: 27.90, tax: 2.48, tax_rate: 0.08875, tip: 5.02, delivery_fee: 3.0, total: 38.40,
  pay_type: '现金 Cash（送到付）' };
const dtext = W.renderReceipt(dorder, shop, 32);
check('送餐单与 Python 逐字符一致',
  dtext === fsx.readFileSync('/tmp/py_receipt_delivery.txt', 'utf8').replace(/\n$/, ''), dtext.split('\n').slice(0, 14).join(' | '));
check('含送餐地址与距离', dtext.includes('送餐地址') && dtext.includes('0.84 英里'));
check('含税/配送费/小费/现金', dtext.includes('税 8.875%') && dtext.includes('配送费') && dtext.includes('小费') && dtext.includes('现金'));
check('每行不超过 32 宽', dtext.split('\n').every((l) => W.dw(l) <= 32));

console.log('== ESC/POS 字节 ==');
const hex = W.toEscPosHex(text);
check('以 1b 40 开头', hex.startsWith('1b 40'), hex.slice(0, 12));
check('以 1d 56 42 00 结尾（切纸）', hex.endsWith('1d 56 42 00'), hex.slice(-14));
check('中文 UTF-8 编码出现', hex.includes(Buffer.from('琅岐海鲜小馆', 'utf8').toString('hex').replace(/(..)/g, '$1 ').trim()));

console.log('== 飞鹅标签 ==');
const f = W.toFeie(text);
check('含 <CUT> 与 <BR>', f.endsWith('<CUT>') && f.includes('<BR>'));
check('第二行抬头居中加粗', f.startsWith('<CB><B>琅岐海鲜小馆</B></CB><BR>'));

console.log('== 微信请求体 ==');
const pv = W.pushPreview(ok);
check('URL 正确', pv.url.startsWith('https://api.weixin.qq.com/cgi-bin/menu/create?access_token='));
check('body 一级 3 个 / 第一个二级是 view', pv.body.button.length === 3 && pv.body.button[0].sub_button[0].type === 'view');
check('生成 curl', pv.curl.startsWith('curl -X POST'));

console.log();
if (fails) { console.log('❌ ' + fails + ' 项失败'); process.exit(1); }
console.log('✅ 前端逻辑全部通过');
