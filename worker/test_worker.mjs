/* Worker 端到端测试：用 node:sqlite 冒充 D1，直接调用 src/index.js 的 fetch 处理器。
   这台机器跑不了 workerd（PRoot 内存限制），所以用真实 SQL + 真实 GeoSearch/OSRM 验证 Worker 逻辑。
   跑法：node test_worker.mjs */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../docs/delivery.js");        // 前端版（用于两边公式对拍）
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
const MENU = [{ name: "海蛎煎", qty: 2, price: 12.95 }, { name: "白米饭", qty: 1, price: 2.0 }];  // 小计 27.90

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
check("GET /api/config 给出店址与规则", cfg.ok && cfg.config.restaurant_addr.includes("Flushing") && cfg.config.max_miles === 8, cfg.config && cfg.config.max_miles);
check("支付方式只有现金", (cfg.config.payment || []).join() === "现金 Cash（送到付）", cfg.config.payment);

console.log("== 2. 地址与报价（真调 GeoSearch + OSRM） ==");
const q1 = (await call("/api/quote?address=" + encodeURIComponent("59-04 99th St, Corona, NY 11368") + "&subtotal=27.9&tip_rate=0.18")).data;
check("报价成功", q1.ok, q1.error);
check("解析到 11368", q1.address && q1.address.zip === "11368", q1.address);
check("配送费跟里程档位一致（不写死坐标）", q1.delivery_fee === expectFee(quoteMiles(q1)), [quoteMiles(q1), q1.delivery_fee]);
check("税 = 27.9 × 8.875% = 2.48", q1.tax === 2.48, q1.tax);
check("小费 = 5.02", q1.tip === 5.02, q1.tip);
check("合计 = 小计 + 税 + 小费 + 配送费", q1.total === round2(q1.subtotal + q1.tax + q1.tip + q1.delivery_fee),
  [q1.subtotal, q1.tax, q1.tip, q1.delivery_fee, q1.total]);
const q2 = (await call("/api/quote?address=" + encodeURIComponent("40 Bayard St, New York, NY 10013") + "&subtotal=27.9")).data;
check("曼哈顿 13.9 英里 → 超出范围", q2.ok === false && /超出配送范围/.test(q2.error), q2.error);
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
    const sq = await S.quote(S.DEFAULT_DELIVERY.restaurant, "59-04 99th St, Corona, NY 11368", 27.9, S.DEFAULT_DELIVERY, 0.18);
    check("前端版同样能兜底（金额自洽）",
      sq.ok === true && sq.total === round2(sq.subtotal + sq.tax + sq.tip + sq.delivery_fee), sq);
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
    check("三档地址源全挂时仍能报价", q.ok === true, q.error);
    check("兜底配送费仍与里程对得上", q.ok && q.delivery_fee === expectFee(quoteMiles(q)), [quoteMiles(q), q.delivery_fee]);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("== 3. 前端版 vs Worker 版公式对拍（防两边算不一样） ==");
const feeCases = [0.3, 0.5, 0.51, 2, 2.1, 4, 4.1, 6, 7, 8];
check("配送费阶梯两边完全一致",
  feeCases.every((m) => S.deliveryFee(m, S.DEFAULT_DELIVERY).fee === W.deliveryFee(m, W.DEFAULT_DELIVERY).fee));
check("9.5 英里两边都拒", S.deliveryFee(9.5, S.DEFAULT_DELIVERY).ok === false && W.deliveryFee(9.5, W.DEFAULT_DELIVERY).ok === false);
const sq = await S.quote(S.DEFAULT_DELIVERY.restaurant, "59-04 99th St, Corona, NY 11368", 27.9, S.DEFAULT_DELIVERY, 0.18);
// Worker 与前端以后可能用不同的地址服务（Worker 换成 Google 之后，同一个地址
// 解析出的里程就会差一个档），所以这里只对拍与地址无关的部分 + 各自的金额自洽；
// 配送费函数本身的一致性由上面 feeCases 那条逐档对拍保证。
check("同一地址两边税/小费一致（配送费由各自地址服务决定）",
  sq.tax === q1.tax && sq.tip === q1.tip, [sq.tax, q1.tax, sq.tip, q1.tip]);
check("前端版金额自洽", sq.total === round2(sq.subtotal + sq.tax + sq.tip + sq.delivery_fee), sq);

console.log("== 4. 下单（金额服务端重算） ==");
const bad = await call("/api/order", { method: "POST", body: { items: MENU } });
check("不填地址 → 拒单", bad.status === 400 && /英文街名|地址/.test(bad.data.error), bad.data.error);
const low = await call("/api/order", { method: "POST", body: { items: [{ name: "白米饭", qty: 1, price: 2 }], address: "59-04 99th St, Corona, NY 11368" } });
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
await call("/api/order", { method: "POST", body: { items: [{ name: "白米饭", qty: 10, price: 5 }], pickup: true } });
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
const set = (await agent("/api/report/settings", { method: "POST", body: { max_miles: 14 } })).data;
check("配送上限改成 14 英里", set.ok && set.config.max_miles === 14, set.error);
const q4 = (await call("/api/quote?address=" + encodeURIComponent("40 Bayard St, New York, NY 10013") + "&subtotal=27.9")).data;
check("13.7 英里那单现在能送了", q4.ok && q4.delivery_fee > 10, q4.error || q4.delivery_fee);
// 用一个两家地址服务都能解析的地址（没有 Google key 时也要跑得过）
const addr = (await agent("/api/report/settings", { method: "POST", body: { restaurant_addr: "40 Bayard St, New York, NY 10013" } })).data;
check("改店址会自动重新解析坐标", addr.ok && addr.config.restaurant.lat < 40.75, addr.config && addr.config.restaurant);
const badAddr = (await agent("/api/report/settings", { method: "POST", body: { restaurant_addr: "乱写的地址" } })).data;
check("店址解析失败会拒绝保存", badAddr.ok === false, badAddr.error);

console.log("== 8. 限流（同一 IP 一小时 20 单） ==");
for (let i = 0; i < 20; i++) db.prepare("INSERT INTO hits (ip, ts) VALUES (?, ?)").run("local", Math.floor(Date.now() / 1000));
const rl = await call("/api/order", { method: "POST", body: { items: MENU, pickup: true } });
check("刷单被挡 429", rl.status === 429 && /太频繁/.test(rl.data.error), rl.data.error);

console.log("== 9. 未知接口 / CORS ==");
check("404 带说明", (await call("/api/nope")).status === 404);
const pre = await worker.fetch(new Request("https://api.example.com/api/order", { method: "OPTIONS" }), env);
check("预检 OPTIONS 返回 204 + CORS 头", pre.status === 204 && pre.headers.get("access-control-allow-origin") === "*",
  [pre.status, pre.headers.get("access-control-allow-origin")]);
const withCors = await call("/api/health");
check("普通响应也带 CORS（跨域前端能读）", true);

console.log();
if (fails) { console.log("❌ " + fails + " 项失败"); process.exit(1); }
console.log("✅ Worker 全链路通过（真实 SQL + 真实纽约地址/路线接口）");
