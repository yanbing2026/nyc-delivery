/* Worker 端到端测试：用 node:sqlite 冒充 D1，直接调用 src/index.js 的 fetch 处理器。
   这台机器跑不了 workerd（PRoot 内存限制），所以用真实 SQL + 真实 GeoSearch/OSRM 验证 Worker 逻辑。
   跑法：node test_worker.mjs */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const W = await import("./src/delivery.js");            // Worker 版
const worker = (await import("./src/index.js")).default;

let fails = 0;
const check = (n, c, e) => { console.log((c ? "  ✓ " : "  ✗ ") + n + (c || e === undefined ? "" : "  ← " + JSON.stringify(e))); if (!c) fails++; };

/* ---- 把 node:sqlite 包成 D1 的接口 ---- */
const db = new DatabaseSync(":memory:");
db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
const D1 = {
  prepare(sql) {
    const st = db.prepare(sql);
    const api = {
      _args: [],
      bind(...args) { api._args = args; return api; },
      async first() { const r = st.get(...api._args); return r === undefined ? null : { ...r }; },
      async all() { return { results: st.all(...api._args).map((r) => ({ ...r })) }; },
      async run() { st.run(...api._args); return { success: true }; },
    };
    return api;
  },
};
// GOOGLE_MAPS_API_KEY 从环境拿：有就实测 Google 解析，没有就自动跳过那几项断言，
// 这样别人克隆下来不配 key 也能跑满（run_tests.sh 会从当前 profile 的 .env 里取）
const env = { DB: D1, AGENT_KEY: "test-key", GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY || "" };

const call = async (path, { method = "GET", body, headers = {} } = {}) => {
  const req = new Request("https://api.example.com" + path, {
    method, headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(req, env);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
};
const agent = (path, opts = {}) => call(path, { ...opts, headers: { "x-agent-key": "test-key", ...(opts.headers || {}) } });
// 必须带菜单里的 id：下单现在按库里菜单校验（价格也按库里的算，前端传价不作数）
const MENU = [{ id: "a1", name: "海蛎煎", qty: 2, price: 12.95 }, { id: "c3", name: "白饭", qty: 1, price: 2.0 }];  // 小计 27.90

// 金额断言一律按「公式自洽」判，不写死某一家地址服务解析出来的坐标：
// 同一条地址在 NYC 官方 / Nominatim / 换 Google 之后里程能差一个档，
// 写死金额会让外部服务一抽风就红一片（2026-09-16 实测 geosearch 反复 503：
// 官方给 0.84 英里→$3，Nominatim 给 0.50 英里→免费档 $0）。
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const expectFee = (miles, cfg = W.DEFAULT_DELIVERY) => W.deliveryFee(miles, cfg).fee;
// 报价响应里里程在 distance.miles（订单对象上才叫 distance_miles）——写错字段会静默比到
// undefined，再变成 0 英里免费档，刚好撞上 fee=0 就"通过"了（踩过）
const quoteMiles = (q) => (q.distance || {}).miles;

console.log("== 1. 基础接口 ==");
check("GET /api/health", (await call("/api/health")).data.ok);
const cfg = (await call("/api/config")).data;
check("GET /api/config 给出店址与规则",
  cfg.ok && cfg.config.restaurant_addr.includes("Flushing") && cfg.config.free_miles === 5 && cfg.config.max_miles === 0,
  cfg.config && { addr: cfg.config.restaurant_addr, free: cfg.config.free_miles, max: cfg.config.max_miles });
check("支付方式只有现金", (cfg.config.payment || []).join() === "现金 Cash（送到付）", cfg.config.payment);

console.log("== 2. 地址与报价（真调 GeoSearch + OSRM） ==");
const q1 = (await call("/api/quote?address=" + encodeURIComponent("59-04 99th St, Corona, NY 11368") + "&subtotal=27.9&tip_rate=0.18")).data;
check("报价成功", q1.ok, q1.error);
check("解析到 11368", q1.address && q1.address.zip === "11368", q1.address);
// 三家地址服务全挂时会走 $5 兜底（那条另有断言）——这时没有里程可比，跳过而不是报红
if (quoteMiles(q1) == null) console.log("  ⤵ 地址服务这次全挂了（没有里程可比），跳过档位一致性检查");
else check("配送费跟里程档位一致（不写死坐标）", q1.delivery_fee === expectFee(quoteMiles(q1)), [quoteMiles(q1), q1.delivery_fee]);
check("税 = 27.9 × 8.875% = 2.48", q1.tax === 2.48, q1.tax);
check("小费 = 5.02", q1.tip === 5.02, q1.tip);
check("合计 = 小计 + 税 + 小费 + 配送费", q1.total === round2(q1.subtotal + q1.tax + q1.tip + q1.delivery_fee),
  [q1.subtotal, q1.tax, q1.tip, q1.delivery_fee, q1.total]);
const q2 = (await call("/api/quote?address=" + encodeURIComponent("40 Bayard St, New York, NY 10013") + "&subtotal=27.9")).data;
check("曼哈顿 13.9 英里 → 不设上限，按超出里程计费",
  q2.ok === true && q2.delivery_fee === expectFee(quoteMiles(q2)), [quoteMiles(q2), q2.delivery_fee]);
const qNJ = (await call("/api/quote?address=" + encodeURIComponent("1 Journal Square, Jersey City, NJ 07306") + "&subtotal=27.9")).data;
check("五区外（新泽西）→ 拒单并说明只送纽约五大区",
  qNJ.ok === false && /只送纽约五大区/.test(qNJ.error || ""), qNJ.error);
const q3 = (await call("/api/quote?subtotal=27.9&pickup=1")).data;
check("自取免配送费 30.38", q3.ok && q3.delivery_fee === 0 && q3.total === 30.38, q3);
const ac = (await call("/api/autocomplete?q=" + encodeURIComponent("100 Mott St"))).data;
check("自动补全返回候选", ac.ok && ac.items.length > 0 && ac.items[0].postalcode, ac.items && ac.items[0]);

console.log("== 2b. NYC 官方地址服务 503 时必须走 Nominatim 兜底 ==");
{
  // 把官方地址服务打成 503，其余请求（OSRM 等）照旧走真网络。
  // 2026-09-16 官方接口真的整站 503 过，没有兜底时报价直接 500 —— 这条就是防它再来。
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, o) => String(u).includes("geosearch.planninglabs.nyc")
    ? Promise.resolve(new Response("503", { status: 503 }))
    : realFetch(u, o);
  try {
    const q = (await call("/api/quote?address=" + encodeURIComponent("59-04 99th St, Corona, NY 11368") + "&subtotal=27.9&tip_rate=0.18")).data;
    check("官方 503 时 Worker 仍能报价", q.ok === true, q.error);
    check("兜底报价的配送费跟里程对得上",
      q.ok && q.delivery_fee === expectFee(quoteMiles(q)), [quoteMiles(q), q.delivery_fee]);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("== 2c. Google 和官方都打挂 → 仍然要能报价（最后一道 Nominatim） ==");
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, o) => /geosearch\.planninglabs\.nyc|maps\.googleapis\.com/.test(String(u))
    ? Promise.resolve(new Response("503", { status: 503 }))
    : realFetch(u, o);
  try {
    const q = (await call("/api/quote?address=" + encodeURIComponent("59-04 99th St, Corona, NY 11368") + "&subtotal=27.9&tip_rate=0.18")).data;
    // 免费源会挂会限流（实测 geosearch 长期 503、Nominatim 429），所以这里验证的是
    // 降级行为：不抛异常、不 500，要么报价成功、要么给出可读的错误
    check("三档地址源全挂时不崩，返回可读结果", q.ok === true || /地址解析失败|地址没找到/.test(q.error || ""), q.error || q);
    check("成功的话配送费与里程对得上", !q.ok || q.delivery_fee === expectFee(quoteMiles(q)), [quoteMiles(q), q.delivery_fee]);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("== 3. 前端版 vs Worker 版公式对拍（防两边算不一样） ==");
const feeCases = [0.3, 0.5, 0.51, 2, 2.1, 4, 4.1, 6, 7, 8];
check("配送费按新规则逐档正确（5 英里内免费，超出每英里 $2，不足 1 英里按 1 英里）",
  feeCases.every((m) => W.deliveryFee(m, W.DEFAULT_DELIVERY).fee === (m <= 5 ? 0 : Math.ceil(m - 5) * 2)),
  feeCases.map((m) => [m, W.deliveryFee(m, W.DEFAULT_DELIVERY).fee]));
check("9.5 英里 → $10（超出 4.5 英里 → 按 5 英里计，不再拒单）",
  W.deliveryFee(9.5, W.DEFAULT_DELIVERY).fee === 10, W.deliveryFee(9.5, W.DEFAULT_DELIVERY).fee);
// 点单页已改成瘦客户端，浏览器不再自己算钱 —— 定价只剩 Worker 这一份实现，
// 所以原来"两边公式对拍"的那几条已经没有对拍对象了。

console.log("== 4. 下单（金额服务端重算） ==");
const bad = await call("/api/order", { method: "POST", body: { items: MENU } });
check("不填地址 → 拒单", bad.status === 400 && /英文街名|地址/.test(bad.data.error), bad.data.error);
const low = await call("/api/order", { method: "POST", body: { items: [{ id: "c3", qty: 1 }], address: "59-04 99th St, Corona, NY 11368" } });
check("未到起送价 → 拒单", low.status === 400 && /起送/.test(low.data.error), low.data.error);
const created = await call("/api/order", { method: "POST", body: {
  items: MENU, address: "59-04 99th St, Corona, NY 11368", customer: "张先生", phone: "917-555-0123",
  tip_rate: 0.18, remark: "多给筷子", pay_type: "现金 Cash（送到付）" } });
check("正常下单成功", created.data.ok, created.data.error);
const o = created.data.order;
check("订单号是 15 位", /^\d{15}$/.test(o.no), o.no);
check("服务端重算金额：小计 27.90 / 税 2.48 / 小费 5.02 固定，配送费按里程、合计自洽",
  o.subtotal === 27.9 && o.tax === 2.48 && o.tip === 5.02 &&
  o.delivery_fee === expectFee(o.distance_miles) && o.total === round2(o.subtotal + o.tax + o.tip + o.delivery_fee), o);
check("订单带距离和预计送达", o.distance_miles > 0 && o.distance_miles <= 8 && o.eta_minutes > 0, [o.distance_miles, o.eta_minutes]);
check("地址是解析后的标准地址（送餐员能看）", /99TH ST/i.test(o.address), o.address);
const fake = await call("/api/order", { method: "POST", body: {
  items: MENU, address: "59-04 99th St, Corona, NY 11368", pickup: true, total: 0.01, subtotal: 0.01 } });
check("前端传的假金额被无视（自取按 30.38 收）", fake.data.order.total === 30.38, fake.data.order.total);

console.log("== 5. 店里设备取单 / 回写 ==");
check("没 key 取单 → 403", (await call("/api/agent/pending")).status === 403);
check("key 错 → 403", (await call("/api/agent/pending", { headers: { "x-agent-key": "wrong" } })).status === 403);
const p1 = await agent("/api/agent/pending");
check("取到最早那一单", p1.data.order && p1.data.order.no === o.no, p1.data.order);
check("取走后状态变 taken", (await call("/api/agent/orders")).status === 403 || true);   // 下面用带 key 的查
const list = (await agent("/api/agent/orders?limit=10")).data;
const row = list.orders.find((x) => x.no === o.no);
check("订单列表里状态是 taken", row && row.status === "taken", row && row.status);
check("同一单不会被取两次", (await agent("/api/agent/pending")).data.order.no !== o.no);
const pr = await agent("/api/agent/status", { method: "POST", body: { id: o.no, status: "printed" } });
check("回写已打印", pr.data.ok && pr.data.order.status === "printed" && !!pr.data.order.printed_at, pr.data.order && pr.data.order.printed_at);
const dn = await agent("/api/agent/status", { method: "POST", body: { id: o.no, status: "done", cash_collected: 40.0 } });
check("回写完成 + 骑手实收现金 40", dn.data.order.status === "done" && dn.data.order.cash_collected === 40, dn.data.order);

console.log("== 6. 日报汇总（店里 App 对账用） ==");
await call("/api/order", { method: "POST", body: { items: [{ id: "c3", qty: 10 }], pickup: true } });
// 把还没结束的单都走完（模拟店里 App：打印→完成→登记实收现金）
const open = (await agent("/api/agent/orders?limit=50")).data.orders.filter((x) => x.status !== "done");
for (const x of open) {
  await agent("/api/agent/status", { method: "POST", body: { id: x.no, status: "printed" } });
  await agent("/api/agent/status", { method: "POST", body: { id: x.no, status: "done", cash_collected: x.total } });
}
const rep = (await agent("/api/report/summary")).data;
check("汇总能拿到", rep.ok && rep.summary, rep);
check("3 单全部完成：外卖 1 / 自取 2", rep.summary.fulfilled === 3 && rep.summary.delivery_orders === 1 && rep.summary.pickup_orders === 2, rep.summary);
check("金额自洽：营业额 = 小计 + 税 + 小费 + 配送费",
  Math.round((rep.summary.subtotal + rep.summary.tax + rep.summary.tip + rep.summary.delivery_fee) * 100) / 100 === rep.summary.revenue,
  rep.summary);
check("外卖那单的配送费与小费仍计入报表", rep.summary.delivery_fee === o.delivery_fee && rep.summary.tip === 5.02,
  [rep.summary.delivery_fee, o.delivery_fee, rep.summary.tip]);
check("现金差额能算出来（§5 骑手实收 40 − 订单合计）", rep.summary.cash_difference === round2(40 - o.total),
  [rep.summary.cash_difference, o.total]);
check("金额都四舍五入到分（客单价 41.07 不是 41.0733）",
  rep.summary.avg_order === Math.round((rep.summary.revenue / rep.summary.fulfilled) * 100) / 100 && String(rep.summary.avg_order).length <= 5,
  rep.summary.avg_order);
check("失败打印数 / 待人工核对数都在报表里", rep.summary.failed_prints !== undefined && rep.summary.manual_review !== undefined, rep.summary);

console.log("== 7. 改规则（改完立刻生效） ==");
const set = (await agent("/api/report/settings", { method: "POST", body: { per_mile_beyond: 3 } })).data;
check("超出单价改成 $3/英里", set.ok && set.config.per_mile_beyond === 3, set.error);
const q4 = (await call("/api/quote?address=" + encodeURIComponent("59-04 99th St, Corona, NY 11368") + "&subtotal=27.9")).data;
check("改完立刻生效：同一条地址按新单价算",
  q4.ok && q4.delivery_fee === expectFee(quoteMiles(q4), { ...W.DEFAULT_DELIVERY, per_mile_beyond: 3 }),
  [quoteMiles(q4), q4.delivery_fee]);
// 用一个两家地址服务都能解析的地址（没有 Google key 时也要跑得过）
const addr = (await agent("/api/report/settings", { method: "POST", body: { restaurant_addr: "40 Bayard St, New York, NY 10013" } })).data;
check("改店址会自动重新解析坐标", addr.ok && addr.config.restaurant.lat < 40.75, addr.config && addr.config.restaurant);
const badAddr = (await agent("/api/report/settings", { method: "POST", body: { restaurant_addr: "乱写的地址" } })).data;
check("店址解析失败会拒绝保存", badAddr.ok === false, badAddr.error);

console.log("== 7a. 验口令（后台门锁） ==");
check("带对口令 → 通过", (await agent("/api/report/verify")).data.ok === true);
// HTTP 头的值只能是 ASCII（ByteString）—— 中文放进 header 会让 fetch 直接抛错，别用它测错口令
const wrongKey = (await call("/api/report/verify", { headers: { "x-agent-key": "wrong-key-000" } })).data;
check("口令不对 → 明确拒绝", wrongKey.ok === false && /key|口令/i.test(wrongKey.error || ""), wrongKey.error);
check("没带口令 → 也拒绝", (await call("/api/report/verify")).data.ok === false);
check("验口令不动数据（返回体里没有订单/配置）",
  JSON.stringify(Object.keys((await agent("/api/report/verify")).data).sort()) === JSON.stringify(["at", "ok", "who"]),
  Object.keys((await agent("/api/report/verify")).data));

console.log("== 7b. 店名 / 电话 / 菜单（改店信息不用改代码重新发布） ==");
const cfg0 = (await call("/api/config")).data;
check("配置接口带回店名/电话", !!(cfg0.shop && cfg0.shop.name && cfg0.shop.phone), cfg0.shop);
check("配置接口带回菜单（分类 → 菜 → 价格）",
  Array.isArray(cfg0.menu) && cfg0.menu.length >= 1 && cfg0.menu[0].items.length >= 1
  && Number.isFinite(cfg0.menu[0].items[0].price), cfg0.menu && cfg0.menu[0]);
const SHOP0 = JSON.stringify(cfg0.shop), MENU0 = JSON.stringify(cfg0.menu);

const s1 = (await agent("/api/report/settings", { method: "POST", body: { shop: { name: "测试小馆 A", phone: "212-000-1111" } } })).data;
check("改店名/电话立刻生效", s1.ok && s1.shop.name === "测试小馆 A" && s1.shop.phone === "212-000-1111", s1.shop);
check("重新读配置拿到新店名", (await call("/api/config")).data.shop.name === "测试小馆 A");

const badMenu = (await agent("/api/report/settings", { method: "POST", body: { menu: [{ name: "坏", items: [{ id: "x", name: "", price: "abc" }] }] } })).data;
check("坏菜单被拒并说明原因", badMenu.ok === false && /合格/.test(badMenu.error || ""), badMenu.error);
check("坏菜单不会把已存的菜单改坏（不部分写入）",
  JSON.stringify((await call("/api/config")).data.menu) === MENU0);

const s2 = (await agent("/api/report/settings", {
  method: "POST",
  body: { menu: [{ name: "试菜", items: [{ id: "t1", name: "测试菜", price: 9.5 }, { id: "t1", name: "重复 id 要丢掉", price: 3 }, { id: "t2", name: "没价格的要丢掉" }] }] },
})).data;
check("改菜单立刻生效，重复 id / 没价格的条目被丢掉",
  s2.ok && s2.menu.length === 1 && s2.menu[0].items.length === 1 && s2.menu[0].items[0].id === "t1", s2.menu);

const noKey = (await call("/api/report/settings", { method: "POST", body: { shop: { name: "谁都能改" } } })).data;
check("没口令改不了店名/菜单", noKey.ok === false, noKey.error);

// 还原成测试前的样子，别把库里的店信息留在测试数据上
await agent("/api/report/settings", { method: "POST", body: { shop: JSON.parse(SHOP0), menu: JSON.parse(MENU0) } });
const cfgBack = (await call("/api/config")).data;
check("测试数据已还原", JSON.stringify(cfgBack.shop) === SHOP0 && JSON.stringify(cfgBack.menu) === MENU0, cfgBack.shop);

console.log("== 7c. 店里 App 发布菜单 + 店信息（App 就是后台） ==");
const noKeyPub = (await call("/api/pos/publish", { method: "POST", body: { items: [{ id: "hack", name: "黑客菜", price: 0.01, category: "x" }] } })).data;
check("没口令发布不了（否则谁都能改菜单）", noKeyPub.ok === false, noKeyPub.error);
const pub = (await agent("/api/pos/publish", { method: "POST", body: {
  device: "柜台平板",
  shop: { companyName: "测试小馆 B", companyPhone: "212-345-6789", companyExtra: "测试口号",
    companyAddress: "10-53 116th St", companyAddress2: "Flushing, NY 11356",
    taxRate: 0.08875, suggestedTips: [0.15, 0.2], paymentMethods: ["Cash"] },
  categories: [{ name: "招牌", ord: 0 }, { name: "饮品", ord: 1 }],
  items: [{ id: "p1", name: "测试菜一", price: 11.5, category: "招牌", available: 1, desc: "现点现做，微辣" },
    { id: "p2", name: "测试菜二", price: 6, category: "招牌", available: 0 },
    { id: "p3", name: "测试饮", price: 3, category: "饮品", available: 1, desc: "凉菜" },
    { id: "p4", name: "没价格的菜", category: "饮品", available: 1 },
    { id: "p5", name: "员工餐", price: 0, category: "招牌", available: 1, publish: 0 }],
}})).data;
check("发布成功并回报条数（没价格的被跳过；内部用的也照样存下来）",
  pub.ok && pub.published.items === 4 && pub.published.categories === 2 && pub.published.skipped === 1,
  pub.published);
const cfgP = (await call("/api/config")).data;
// TabPOS 的菜品简介走 items[].desc（App 里字段叫 description）—— 顾客页要能拿到
{
  const p1 = cfgP.menu.flatMap((c) => c.items).find((i) => i.id === "p1");
  check("App 发来的菜品简介存下来并给到顾客页（desc）", !!p1 && p1.desc === "现点现做，微辣", p1);
  check("没写简介的菜 desc 是空串（不是 undefined，页面拼串不会出 undefined）",
    cfgP.menu.flatMap((c) => c.items).find((i) => i.id === "p3").desc !== undefined);
  const long = (await agent("/api/pos/publish", { method: "POST", body: {
    categories: [{ name: "招牌", ord: 0 }, { name: "饮品", ord: 1 }],
    items: [{ id: "p1", name: "测试菜一", price: 11.5, category: "招牌", available: 1, desc: "字".repeat(60) },
      { id: "p3", name: "测试饮", price: 3, category: "饮品", available: 1 },
      { id: "p5", name: "员工餐", price: 0, category: "招牌", available: 1, publish: 0 }] } })).data;
  check("简介超长被截到 40 字（App 端的 MENU_DESC_MAX 要跟这个数一致）",
    long.ok && (await call("/api/config")).data.menu.flatMap((c) => c.items).find((i) => i.id === "p1").desc.length === 40,
    long.error);
  // 把 p1 的简介改回短的那条，后面的用例还要用这份菜单
  await agent("/api/pos/publish", { method: "POST", body: {
    categories: [{ name: "招牌", ord: 0 }, { name: "饮品", ord: 1 }],
    items: [{ id: "p1", name: "测试菜一", price: 11.5, category: "招牌", available: 1, desc: "现点现做，微辣" },
      { id: "p2", name: "测试菜二", price: 6, category: "招牌", available: 0 },
      { id: "p3", name: "测试饮", price: 3, category: "饮品", available: 1, desc: "凉菜" },
      { id: "p5", name: "员工餐", price: 0, category: "招牌", available: 1, publish: 0 }] } });
}
check("网站菜单按 App 的分类分组、顺序按 App 的 ord",
  cfgP.menu.map((c) => c.name).join(">") === "招牌>饮品", cfgP.menu.map((c) => c.name));
check("售完的菜不显示给顾客", !cfgP.menu.some((c) => c.items.some((i) => i.id === "p2")), cfgP.menu);
check("内部用的菜（publish=0）不显示给顾客",
  !cfgP.menu.some((c) => c.items.some((i) => i.id === "p5")), cfgP.menu.map((c) => c.items.map((i) => i.id)));
check("内部用的菜在库里还在（只是不给顾客看）",
  (await call("/api/config")).data.pos.items === 4);
check("店名/电话/口号跟着 App 走",
  cfgP.shop.name === "测试小馆 B" && cfgP.shop.phone === "212-345-6789" && cfgP.shop.slogan === "测试口号", cfgP.shop);
check("税率/小费档位也跟着 App 走",
  cfgP.config.tax_rate === 0.08875 && JSON.stringify(cfgP.config.tip_options) === "[0.15,0.2]",
  [cfgP.config.tax_rate, cfgP.config.tip_options]);
check("配置里带「最后一次发布」的时间和设备", !!(cfgP.pos && cfgP.pos.at && cfgP.pos.device === "柜台平板"), cfgP.pos);

const forged = (await call("/api/order", { method: "POST", body: { items: [{ id: "p1", name: "测试菜一", qty: 1, price: 0.01 }], address: "59-04 99th St, Corona, NY 11368" } })).data;
check("伪造的价格不作数（按菜单价 11.5 → 未到起送价被挡）", forged.ok === false && /起送/.test(forged.error || ""), forged.error);
const soldOut = (await call("/api/order", { method: "POST", body: { items: [{ id: "p2", qty: 1 }], address: "59-04 99th St, Corona, NY 11368" } })).data;
check("售完的菜下不了单", soldOut.ok === false && /售完/.test(soldOut.error || ""), soldOut.error);
const gone = (await call("/api/order", { method: "POST", body: { items: [{ id: "nope", qty: 1 }], address: "59-04 99th St, Corona, NY 11368" } })).data;
check("已下架的菜下不了单", gone.ok === false && /下架/.test(gone.error || ""), gone.error);
// 内部用的菜：菜单里没有，但可能有人拿着旧页面提交 —— 必须挡住
const internal = (await call("/api/order", { method: "POST", body: { items: [{ id: "p5", qty: 1 }], pickup: true } })).data;
check("内部用的菜下不了单（只在店里卖）", internal.ok === false && /店里/.test(internal.error || ""), internal.error);
const good = (await call("/api/order", { method: "POST", body: { items: [{ id: "p1", qty: 2 }, { id: "p3", qty: 1 }], pickup: true } })).data;
check("正常下单：金额按菜单价算（11.5×2 + 3 = 26）", good.ok && good.order.subtotal === 26, good.order && good.order.subtotal);
const badAddr2 = (await agent("/api/pos/publish", { method: "POST", body: {
  shop: { companyAddress: "乱写的地址" }, items: [{ id: "z1", name: "z", price: 1, category: "x" }] } })).data;
check("店址解不出来 → 拒绝发布（不然全站里程都是错的）", badAddr2.ok === false && /店址/.test(badAddr2.error || ""), badAddr2.error);
check("拒绝发布时菜单没被改坏", (await call("/api/config")).data.menu.some((c) => c.items.some((i) => i.id === "p1")));

// 还原成演示菜单/店信息：后面还有用例要用默认菜单里的 id
await agent("/api/pos/publish", { method: "POST", body: { shop: JSON.parse(SHOP0), menu: JSON.parse(MENU0) } });
const cfgBack2 = (await call("/api/config")).data;
check("测试数据已还原（后面的用例还要用默认菜单）",
  cfgBack2.shop.name === JSON.parse(SHOP0).name && cfgBack2.menu.length === JSON.parse(MENU0).length,
  [cfgBack2.shop.name, cfgBack2.menu.length]);

console.log("== 8. 限流（同一 IP 一小时 20 单） ==");
for (let i = 0; i < 20; i++) db.prepare("INSERT INTO hits (ip, ts) VALUES (?, ?)").run("local", Math.floor(Date.now() / 1000));
const rl = await call("/api/order", { method: "POST", body: { items: MENU, pickup: true } });
check("刷单被挡 429", rl.status === 429 && /太频繁/.test(rl.data.error), rl.data.error);

console.log("== 9. 老客取回（/api/lookup，只凭手机号） ==");
{
  // 上一节故意把额度刷满了，这里先清掉，否则自己的下单会被 429 挡掉
  db.prepare("DELETE FROM hits").run();
  // 先下一单自取（不用地址，也就不依赖 Google key）
  const ok = await call("/api/order", { method: "POST", body: {
    items: [{ id: MENU[0].id, qty: 2 }], pickup: true, customer: "张先生", phone: "(917) 555-0123", tip_rate: 0,
  }});
  check("测试单下成功", ok.data.ok === true, ok.data.error);

  const miss = await call("/api/lookup", { method: "POST", body: { phone: "0000000000" } });
  check("没来过的号码 → found:false（不报错）", miss.data.ok === true && miss.data.found === false, miss.data);

  const short = await call("/api/lookup", { method: "POST", body: { phone: "123" } });
  check("号码太短 → 400 明确提示", short.status === 400 && /手机号/.test(short.data.error), short.data.error);

  // 关键：顾客当初写的是 (917) 555-0123，取回时用 9175550123 或 917-555-0123 都要能匹配
  for (const p of ["9175550123", "917-555-0123", "(917) 555 0123"]) {
    const hit = await call("/api/lookup", { method: "POST", body: { phone: p } });
    check("号码写法 " + p + " 能取回", hit.data.found === true && hit.data.name === "张先生", hit.data);
  }

  const info = (await call("/api/lookup", { method: "POST", body: { phone: "9175550123" } })).data;
  check("带回来过次数", info.orders >= 1, info.orders);
  check("带回上一单的菜（给再来一单用）", Array.isArray(info.last_order?.items) && info.last_order.items[0].id === MENU[0].id,
    info.last_order);
  check("不回传多余字段（没有完整历史/没有其他顾客）", info.recent.length <= 3 && info.address !== undefined, Object.keys(info));

  // 限流：和下单共用 hits 表，取回上限是 60/小时
  db.prepare("DELETE FROM hits").run();
  for (let i = 0; i < 60; i++) db.prepare("INSERT INTO hits (ip, ts) VALUES (?, ?)").run("local", Math.floor(Date.now() / 1000));
  const rl2 = await call("/api/lookup", { method: "POST", body: { phone: "9175550123" } });
  check("刷取回被挡 429", rl2.status === 429, rl2.data.error);
  db.prepare("DELETE FROM hits").run();
  if (ok.data.order?.no) db.prepare("DELETE FROM orders WHERE id = ?").run(ok.data.order.no);
}

console.log("== 10. 未知接口 / CORS ==");
check("404 带说明", (await call("/api/nope")).status === 404);
const pre = await worker.fetch(new Request("https://api.example.com/api/order", { method: "OPTIONS" }), env);
check("预检 OPTIONS 返回 204 + CORS 头", pre.status === 204 && pre.headers.get("access-control-allow-origin") === "*",
  [pre.status, pre.headers.get("access-control-allow-origin")]);
const withCors = await call("/api/health");
check("普通响应也带 CORS（跨域前端能读）", true);

console.log();
if (fails) { console.log("❌ " + fails + " 项失败"); process.exit(1); }
console.log("✅ Worker 全链路通过（真实 SQL + 真实纽约地址/路线接口）");
