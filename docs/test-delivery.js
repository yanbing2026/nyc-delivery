/* node test-delivery.js —— 前端里程模块：真调 NYC GeoSearch + OSRM，与后端 Python 结果对齐 */
const D = require('./delivery.js');
let fails = 0;
const check = (n, c, e) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c || e === undefined ? '' : '  ← ' + e)); if (!c) fails++; };
const REST = D.DEFAULT_DELIVERY.restaurant;

(async () => {
  console.log('== 1. 地址体检（与后端 Python 同一套规则） ==');
  for (const [q, want] of [['', false], ['法拉盛 缅街 41-28', false], ['11355', false], ['Bayard St', false],
    ['40 Bayard St, New York, NY 10013', true], ['136-20 Roosevelt Ave, Flushing, NY 11354', true]]) {
    const [ok, msg] = D.looksLikeAddress(q);
    check(`${q || '(空)'} → ${ok ? '通过' : '拒绝'}`, ok === want, msg);
  }

  console.log('== 2. 配送费阶梯（与后端 Python 完全一致） ==');
  const CFG = D.DEFAULT_DELIVERY;
  for (const [miles, want] of [[0.3, 0], [0.5, 0], [0.51, 3], [2, 3], [2.1, 6], [4, 6], [4.1, 10], [6, 10], [7, 12.5], [8, 15]]) {
    const got = D.deliveryFee(miles, CFG);
    check(`${miles} 英里 → $${want}`, got.ok && got.fee === want, got);
  }
  check('9.5 英里超上限 → 不送', D.deliveryFee(9.5, CFG).ok === false, D.deliveryFee(9.5, CFG));

  console.log('== 3. 真实地址解析 + 里程（调真接口） ==');
  const g1 = await D.geocode('40 Bayard St, New York, NY 10013');
  check('唐人街 10013 定位正确', g1.ok && g1.postalcode === '10013' && g1.lat > 40.70 && g1.lat < 40.73, g1);
  const g2 = await D.geocode('1 Pike St, New York, NY 10002');
  check('下东城 10002 定位正确', g2.ok && g2.postalcode === '10002', g2);
  const g3 = await D.geocode('136-20 Roosevelt Ave, Flushing, NY 11354');
  check('法拉盛 11354 定位正确', g3.ok && g3.postalcode === '11354', g3);
  const r = await D.routeMiles(REST, g2);
  check('算出驾车里程且含时间', r.ok && r.miles > 0.5 && r.miles < 1.5 && r.minutes > 0, r);

  console.log('== 4. 整单报价（与后端 Python 对齐） ==');
  const q = await D.quote(REST, '1 Pike St, New York, NY 10002', 42, CFG, 0.18);
  check('报价成功', q.ok, q.error);
  check('税 42×8.875% = 3.73', q.tax === 3.73, q.tax);
  check('小费 42×18% = 7.56', q.tip === 7.56, q.tip);
  check('配送费 $3（0.8 英里落在 ≤2 英里档）', q.delivery_fee === 3, q.delivery_fee);
  check('合计 56.29', q.total === 56.29, q.total);
  check('预计送达 = 车程 + 20 分钟备餐', q.eta_minutes === q.distance.minutes + 20, [q.eta_minutes, q.distance.minutes]);
  console.log(`     ${q.address.matched} → ${q.distance.miles} 英里 / ${q.distance.minutes} 分钟 / 配送费 $${q.delivery_fee} / 合计 $${q.total}`);

  const q2 = await D.quote(REST, '136-20 Roosevelt Ave, Flushing, NY 11354', 42, CFG, 0.18);
  check('法拉盛 11 英里 → 超出配送范围', q2.ok === false && /超出配送范围/.test(q2.error), q2.error);
  const q3 = await D.quote(REST, '1 Pike St, New York, NY 10002', 12, CFG, 0);
  check('$12 低于起送价 $20 → 拦', q3.ok === false && /起送/.test(q3.error), q3.error);
  const q4 = await D.quote(REST, '', 42, CFG, 0, true);
  check('自取：免配送费、只要税 45.73', q4.ok && q4.delivery_fee === 0 && q4.total === 45.73, q4);
  const q5 = await D.quote(REST, '法拉盛 缅街 41-28', 42, CFG, 0);
  check('中文地址 → 明确提示英文街名', q5.ok === false && /英文街名/.test(q5.error), q5.error);

  console.log();
  if (fails) { console.log('❌ ' + fails + ' 项失败'); process.exit(1); }
  console.log('✅ 前端里程模块全部通过');
})();
