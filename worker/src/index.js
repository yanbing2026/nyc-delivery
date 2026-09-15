// Cloudflare Worker：纽约送餐下单 + 店里设备取单（D1 存订单）
// 契约：POST /api/order 下单 → GET /api/agent/pending 取单 → POST /api/agent/status 回写
import * as D from "./delivery.js";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
// Pages 前端跟 Worker 不同源，必须给 CORS，否则顾客点「下单」会被浏览器拦
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-agent-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), { status, headers: { ...JSON_HEADERS, ...CORS } });

const nowISO = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const orderNo = () => {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    String(d.getUTCFullYear()).slice(2) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) +
    String(Math.floor(Math.random() * 1000)).padStart(3, "0")
  );
};

async function getSettings(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'delivery'").first();
  const cfg = row ? JSON.parse(row.value) : {};
  return { ...D.DEFAULT_DELIVERY, ...cfg };
}

async function saveSettings(env, cfg) {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('delivery', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1"
  ).bind(JSON.stringify(cfg)).run();
  return cfg;
}

// 简易限流：同一个 IP 一小时最多 N 单
async function rateLimited(env, ip, limit = 20) {
  await env.DB.prepare("DELETE FROM hits WHERE ts < ?1").bind(Math.floor(Date.now() / 1000) - 7200).run();
  const since = Math.floor(Date.now() / 1000) - 3600;
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM hits WHERE ip = ?1 AND ts > ?2").bind(ip, since).first();
  if ((row?.n ?? 0) >= limit) return true;
  await env.DB.prepare("INSERT INTO hits (ip, ts) VALUES (?1, ?2)").bind(ip, Math.floor(Date.now() / 1000)).run();
  return false;
}

const publicOrder = (r) => ({
  no: r.id, created_at: r.created_at, status: r.status, customer: r.customer, phone: r.phone,
  address: r.address, borough: r.borough, distance_miles: r.distance_miles, eta_minutes: r.eta_minutes,
  remark: r.remark, items: JSON.parse(r.items || "[]"), subtotal: r.subtotal, tax: r.tax,
  tax_rate: r.tax_rate, tip: r.tip, delivery_fee: r.delivery_fee, total: r.total,
  pay_type: r.pay_type, pickup: !!r.pickup, needs_manual_review: !!r.needs_manual_review,
  taken_at: r.taken_at, printed_at: r.printed_at, done_at: r.done_at, error: r.error,
  cash_collected: r.cash_collected,
});

async function createOrder(env, body, ip) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return json({ ok: false, error: "购物车是空的" }, 400);
  const cfg = await getSettings(env);
  const pickup = !!body.pickup;
  const subtotal = D.money(items.reduce((s, i) => s + Number(i.price || 0) * Number(i.qty || 1), 0));
  if (!pickup && subtotal < cfg.min_order)
    return json({ ok: false, error: `还没到起送价 $${cfg.min_order.toFixed(2)}（当前 $${subtotal.toFixed(2)}）` }, 400);

  // 金额一律服务端重算，不信前端传的
  const q = await D.quote(cfg.restaurant, pickup ? "" : (body.address || "").trim(), subtotal, cfg,
    Number(body.tip_rate || 0), pickup);
  if (!q.ok) return json({ ok: false, error: q.error, quote: q }, 400);
  if (await rateLimited(env, ip)) return json({ ok: false, error: "下单太频繁，请稍后再试或打电话订" }, 429);

  const id = orderNo();
  const manual = !pickup && (q.distance || {}).ok === false;
  await env.DB.prepare(`INSERT INTO orders
    (id, created_at, source, customer, phone, address, borough, distance_miles, drive_minutes, eta_minutes,
     remark, items, subtotal, tax, tax_rate, tip, delivery_fee, total, pay_type, pickup, status, needs_manual_review)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,'pending',?21)`).bind(
    id, nowISO(), String(body.source || "web").slice(0, 32), String(body.customer || "").slice(0, 60),
    String(body.phone || "").slice(0, 32), (q.address || {}).matched || String(body.address || "").slice(0, 200),
    (q.address || {}).borough || "", (q.distance || {}).miles ?? null, (q.distance || {}).minutes ?? null,
    q.eta_minutes ?? null, String(body.remark || "").slice(0, 300), JSON.stringify(items.slice(0, 50)),
    q.subtotal, q.tax, q.tax_rate, q.tip, q.delivery_fee, q.total,
    String(body.pay_type || cfg.payment[0]).slice(0, 40), pickup ? 1 : 0, manual ? 1 : 0
  ).run();

  const row = await env.DB.prepare("SELECT * FROM orders WHERE id = ?1").bind(id).first();
  return json({ ok: true, order: publicOrder(row), quote: q });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const ip = request.headers.get("cf-connecting-ip") || "local";
    const agentKey = request.headers.get("x-agent-key") || url.searchParams.get("key") || "";

    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

      // 前端可读的配置（不含密钥）
      if (p === "/api/config") {
        const cfg = await getSettings(env);
        return json({ ok: true, config: {
          restaurant_addr: cfg.restaurant_addr, restaurant: cfg.restaurant, max_miles: cfg.max_miles,
          min_order: cfg.min_order, tax_rate: cfg.tax_rate, tiers: cfg.tiers, free_miles: cfg.free_miles,
          per_mile_beyond: cfg.per_mile_beyond, prep_minutes: cfg.prep_minutes, tip_options: cfg.tip_options,
          payment: cfg.payment } });
      }
      if (p === "/api/health") return json({ ok: true, at: nowISO() });

      if (p === "/api/quote") {
        const cfg = await getSettings(env);
        const q = await D.quote(cfg.restaurant, url.searchParams.get("address") || "",
          Number(url.searchParams.get("subtotal") || 0), cfg,
          Number(url.searchParams.get("tip_rate") || 0), url.searchParams.get("pickup") === "1");
        q.address_check = D.looksLikeAddress(url.searchParams.get("address") || "");
        return json(q);
      }

      if (p === "/api/autocomplete")
        return json({ ok: true, items: await D.geocodeCandidates(url.searchParams.get("q") || "", 6) });

      if (p === "/api/order" && request.method === "POST")
        return await createOrder(env, await request.json().catch(() => ({})), ip);

      // ---- 店里设备（Agent）用的接口，需要 agent key ----
      const needKey = p.startsWith("/api/agent/") || p.startsWith("/api/report");
      if (needKey && (!env.AGENT_KEY || agentKey !== env.AGENT_KEY))
        return json({ ok: false, error: "agent key 不对" }, 403);

      if (p === "/api/agent/pending") {
        const row = await env.DB.prepare(
          "SELECT * FROM orders WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1").first();
        if (!row) return json({ ok: true, order: null, msg: "没有待处理订单" });
        await env.DB.prepare("UPDATE orders SET status='taken', taken_at=?1 WHERE id=?2")
          .bind(nowISO(), row.id).run();
        row.status = "taken"; row.taken_at = nowISO();
        return json({ ok: true, order: publicOrder(row) });
      }

      if (p === "/api/agent/status" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        const allow = ["printed", "failed", "done", "void", "taken", "pending"];
        const status = allow.includes(b.status) ? b.status : "failed";
        const id = String(b.id || "");
        const err = String(b.error || "").slice(0, 300);
        const cash = b.cash_collected === undefined || b.cash_collected === null ? null : Number(b.cash_collected);
        const sets = ["status = ?1", "error = ?2", "cash_collected = ?3"];
        const args = [status, err, cash];
        if (status === "printed") { args.push(nowISO()); sets.push(`printed_at = ?${args.length}`); }
        if (status === "done") { args.push(nowISO()); sets.push(`done_at = ?${args.length}`); }
        args.push(id);
        await env.DB.prepare(`UPDATE orders SET ${sets.join(", ")} WHERE id = ?${args.length}`)
          .bind(...args).run();
        const row = await env.DB.prepare("SELECT * FROM orders WHERE id = ?1").bind(id).first();
        return json({ ok: !!row, order: row ? publicOrder(row) : null });
      }

      // 设备同步用：拉一批订单（默认最近 30 天），记账在设备本地做
      if (p === "/api/agent/orders") {
        const since = url.searchParams.get("since") || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 19).replace("T", " ");
        const lim = Math.min(Number(url.searchParams.get("limit") || 500), 2000);
        const rs = await env.DB.prepare(
          "SELECT * FROM orders WHERE created_at >= ?1 ORDER BY created_at DESC LIMIT ?2").bind(since, lim).all();
        return json({ ok: true, orders: (rs.results || []).map(publicOrder) });
      }

      if (p === "/api/report/summary") {
        // 店里 App 拿来做日报/月报对账（设备本地也会算一遍）
        const from = url.searchParams.get("from") || new Date().toISOString().slice(0, 10);
        const to = url.searchParams.get("to") || from;
        const r = await env.DB.prepare(`SELECT
            COUNT(*) AS orders,
            SUM(CASE WHEN status IN ('done','printed') THEN 1 ELSE 0 END) AS fulfilled,
            SUM(CASE WHEN pickup = 0 AND status IN ('done','printed') THEN 1 ELSE 0 END) AS delivery_orders,
            SUM(CASE WHEN pickup = 1 AND status IN ('done','printed') THEN 1 ELSE 0 END) AS pickup_orders,
            ROUND(SUM(CASE WHEN status IN ('done','printed') THEN total ELSE 0 END), 2) AS revenue,
            ROUND(SUM(CASE WHEN status IN ('done','printed') THEN subtotal ELSE 0 END), 2) AS subtotal,
            ROUND(SUM(CASE WHEN status IN ('done','printed') THEN tax ELSE 0 END), 2) AS tax,
            ROUND(SUM(CASE WHEN status IN ('done','printed') THEN tip ELSE 0 END), 2) AS tip,
            ROUND(SUM(CASE WHEN status IN ('done','printed') AND pickup = 0 THEN delivery_fee ELSE 0 END), 2) AS delivery_fee,
            ROUND(SUM(CASE WHEN status IN ('done','printed') THEN COALESCE(cash_collected,0) ELSE 0 END), 2) AS cash_collected,
            ROUND(AVG(CASE WHEN status IN ('done','printed') THEN total END), 2) AS avg_order,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_prints,
            SUM(CASE WHEN needs_manual_review = 1 THEN 1 ELSE 0 END) AS manual_review
          FROM orders WHERE date(created_at) BETWEEN ?1 AND ?2`).bind(from, to).first();
        if (r) r.cash_difference = Math.round(((r.cash_collected || 0) - (r.revenue || 0)) * 100) / 100;
        return json({ ok: true, from, to, summary: r });
      }

      if (p === "/api/report/settings" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        const cfg = await getSettings(env);
        const next = { ...cfg, ...b };
        next.restaurant_addr = String(next.restaurant_addr || "").slice(0, 200);
        next.min_order = Number(next.min_order ?? cfg.min_order);
        next.max_miles = Number(next.max_miles ?? cfg.max_miles);
        next.tax_rate = Number(next.tax_rate ?? cfg.tax_rate);
        if (Array.isArray(next.tiers)) next.tiers = next.tiers.map((t) => ({ max: Number(t.max), fee: Number(t.fee) }));
        // 店址改了就把坐标重新解析一遍，不然里程全错
        if (b.restaurant_addr && b.restaurant_addr !== cfg.restaurant_addr) {
          const g = await D.geocode(next.restaurant_addr);
          if (g.ok) next.restaurant = { lat: g.lat, lon: g.lon };
          else return json({ ok: false, error: "店址解析失败：" + g.error }, 400);
        }
        await saveSettings(env, next);
        return json({ ok: true, config: next });
      }

      return json({ ok: false, error: "没有这个接口：" + p }, 404);
    } catch (e) {
      return json({ ok: false, error: `${e.name}: ${e.message}` }, 500);
    }
  },
};
