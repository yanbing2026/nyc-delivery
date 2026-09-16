// 纽约送餐里程/配送费（Worker 侧，ES 模块版）
// 与 docs/delivery.js 同一套公式，由 test_delivery_parity.js 保证两边一致
const GEOSEARCH = "https://geosearch.planninglabs.nyc/v2/search";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const GOOGLE_GEOCODE = "https://maps.googleapis.com/maps/api/geocode/json";
const GOOGLE_TIMEOUT_MS = 4000;   // 地址解析是下单必经之路，卡住就等于不接单
const OSRM = "https://router.project-osrm.org/route/v1/driving";
const M_PER_MILE = 1609.344;
const UA = "nyc-delivery-worker/1.0";

export const DEFAULT_DELIVERY = {
  enabled: true, free_miles: 5,        // 5 英里内免费
  tiers: [],                           // 不再用阶梯价
  per_mile_beyond: 2.0,                // 超出部分每英里 $2
  max_miles: 0,                        // 0 = 不设上限（纽约市内都送）
  min_order: 20.0, tax_rate: 0.08875,
  prep_minutes: 20, tip_options: [0.15, 0.18, 0.2],
  payment: ["现金 Cash（送到付）"],
  restaurant_addr: "10-53 116th St, Flushing, NY 11356",
  restaurant: { lat: 40.7873972, lon: -73.8511667 },
  fallback_fee: 5.0,
};

export const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
export const hasZip = (q) => String(q || "").split(/[,\s]+/).some((t) => /^\d{5}$/.test(t));

export function looksLikeAddress(q) {
  q = String(q || "").trim();
  if (!q) return [false, "地址不能为空"];
  if (/[\u4e00-\u9fff]/.test(q)) return [false, "请用英文街名（纽约系统不认中文地址），例如 136-20 Roosevelt Ave, Flushing, NY 11354"];
  const toks = q.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  if (!/\d/.test(toks[0] || "")) return [false, "请从门牌号开始填，例如 40 Bayard St, New York, NY 10013"];
  if (!toks.some((t) => /[A-Za-z]/.test(t))) return [false, "缺少街名：只填 ZIP 会被当成街名解析错"];
  if (!hasZip(q)) return [true, "没写 ZIP，可能解析到别的区（同一个街名在多个区都有）"];
  return [true, ""];
}

export async function geocodeCandidates(query, limit = 5, gkey = "") {
  if (!query || !query.trim()) return [];
  const size = Math.min(Math.max(limit, 1), 10);
  // 第一档 Google：有 SLA 和免费额度，而且能解 Queens 那种 10-53 连字符门牌号 ——
  // 两个免费源都解不了它（2026-09-16 实测店址改成 10-53 116th St 时官方接口 503、
  // Nominatim 直接找不到）。没配 key 就跳过这一档，退回免费源。
  if (gkey) {
    try {
      const g = new URL(GOOGLE_GEOCODE);
      g.searchParams.set("address", query);
      g.searchParams.set("key", gkey);
      g.searchParams.set("language", "en");
      g.searchParams.set("region", "us");
      const r = await fetch(g, { signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS) });
      if (r.ok) {
        const d = await r.json();
        if (d.status === "OK" || d.status === "ZERO_RESULTS") {
          const part = (x, type) => (x.address_components || []).find((c) => (c.types || []).includes(type));
          const cands = (d.results || []).map((x) => {
            const borough = part(x, "sublocality_level_1") || part(x, "sublocality") || part(x, "locality");
            const pc = part(x, "postal_code");
            const loc = (x.geometry || {}).location || {};
            return { label: x.formatted_address || "", name: "",
              borough: borough ? borough.long_name : "", postalcode: pc ? pc.short_name : "",
              lat: loc.lat, lon: loc.lng, source: "google" };
          }).filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon));
          if (cands.length) return cands.slice(0, size);
        }
      }
    } catch (e) { /* 超时/网络问题 → 落到免费源 */ }
  }
  // 第二档 NYC 官方 GeoSearch；报错或没结果都落到 Nominatim —— 跟 delivery.py 同一套规则。
  // 官方接口会整站 503（2026-09-16 实测连续 4 次），没有这条兜底时报价/下单直接 500。
  try {
    const u = new URL(GEOSEARCH);
    u.searchParams.set("text", query);
    u.searchParams.set("size", String(size));
    const r = await fetch(u, { headers: { "User-Agent": UA } });
    if (r.ok) {
      const d = await r.json();
      const cands = (d.features || []).map((f) => ({
        label: f.properties.label || f.properties.name || "",
        name: f.properties.name || "",
        borough: f.properties.borough || "",
        postalcode: f.properties.postalcode || "",
        lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
        source: "nyc-geosearch",
      }));
      if (cands.length) return cands;
    }
  } catch (e) { /* 落到下面的兜底 */ }
  const v = new URL(NOMINATIM);
  v.searchParams.set("q", query);
  v.searchParams.set("format", "json");
  v.searchParams.set("limit", String(size));
  v.searchParams.set("countrycodes", "us");
  v.searchParams.set("addressdetails", "1");
  const r2 = await fetch(v, { headers: { "User-Agent": UA } });
  if (!r2.ok) throw new Error("地址服务返回 " + r2.status);
  const d2 = await r2.json();
  return (d2 || [])
    .map((d) => {
      const a = d.address || {};
      return {
        label: d.display_name || "",
        name: d.name || "",
        borough: a.suburb || a.city || "",
        postalcode: a.postcode || "",
        lat: parseFloat(d.lat), lon: parseFloat(d.lon),
        source: "nominatim",
      };
    })
    .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon))
    .slice(0, size);
}

export async function geocode(query, gkey = "") {
  const zips = String(query || "").split(/[,\s]+/).filter((t) => /^\d{5}$/.test(t));
  const cands = await geocodeCandidates(query, 10, gkey);
  if (!cands.length) return { ok: false, error: "地址没找到，检查门牌号/街名/邮编，或补上区名（Flushing / Chinatown）" };
  if (zips.length) {
    const hit = cands.find((c) => c.postalcode === zips[0]);
    if (hit) return { ok: true, ...hit };
  }
  return { ok: true, ...cands[0], candidates: cands.slice(0, 5), warning: zips.length ? "" : "没指定 ZIP，可能解析到别的区" };
}

export async function routeMiles(a, b) {
  try {
    // 必须带 User-Agent：OSRM 前面是 nginx，空 UA 直接 403 返回 HTML
    // （2026-09-16 线上路线全挂就是这个原因，错误信息还被伪装成 JSON 解析失败）
    const r = await fetch(`${OSRM}/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false&steps=false`,
      { headers: { "User-Agent": UA } });
    if (!r.ok) return { ok: false, error: `路线服务返回 ${r.status}`, miles: null, minutes: null, source: "unavailable" };
    const d = await r.json();
    const route = (d.routes || [])[0] || {};
    return { ok: true, miles: Math.round(((route.distance || 0) / M_PER_MILE) * 100) / 100,
      minutes: Math.round((route.duration || 0) / 60), source: "osrm" };
  } catch (e) {
    return { ok: false, error: "路线服务不可用：" + e.message, miles: null, minutes: null, source: "unavailable" };
  }
}

export function deliveryFee(miles, cfg = {}) {
  cfg = { ...DEFAULT_DELIVERY, ...cfg };
  const t = cfg.tiers || DEFAULT_DELIVERY.tiers;
  const m = Math.round((Number(miles) || 0) * 100) / 100;
  if (cfg.max_miles && m > cfg.max_miles)
    return { ok: false, miles: m, fee: null, reason: `${m.toFixed(1)} 英里超出配送范围（最远 ${cfg.max_miles} 英里），请到店自取或换地址` };
  if (m <= cfg.free_miles) return { ok: true, miles: m, fee: 0, tier: `${cfg.free_miles} 英里内免配送费` };
  for (const tier of t.slice().sort((a, b) => a.max - b.max))
    if (m <= tier.max) return { ok: true, miles: m, fee: tier.fee, tier: `${tier.max} 英里内 $${tier.fee.toFixed(2)}` };
  const last = t.slice().sort((a, b) => b.max - a.max)[0] || { max: cfg.free_miles, fee: 0 };
  const extra = Math.max(0, m - last.max) * cfg.per_mile_beyond;
  return { ok: true, miles: m, fee: money(last.fee + extra),
    tier: `${last.max} 英里 $${last.fee.toFixed(2)} + 超出 ${(m - last.max).toFixed(1)} 英里 × $${cfg.per_mile_beyond}/英里` };
}

export async function quote(restaurant, addrQuery, subtotal, cfg = {}, tipRate = 0, pickup = false, gkey = "") {
  cfg = { ...DEFAULT_DELIVERY, ...cfg };
  const out = { subtotal: money(subtotal), pickup: !!pickup, tax_rate: cfg.tax_rate, min_order: cfg.min_order };
  if (pickup) {
    out.delivery = { ok: true, fee: 0, miles: 0, tier: "到店自取" };
  } else {
    const [ok, warn] = looksLikeAddress(addrQuery);
    if (!ok) return { ok: false, error: warn, ...out };
    const g = await geocode(addrQuery, gkey);
    if (!g.ok) return { ...g, ...out };
    out.address = { input: addrQuery, matched: g.label, borough: g.borough, zip: g.postalcode,
      lat: g.lat, lon: g.lon, source: g.source };
    if (g.warning) out.address.warning = g.warning;
    if (g.candidates) out.address.candidates = g.candidates;
    const r = await routeMiles(restaurant, g);
    out.distance = r;
    if (!r.ok) out.distance = { ...r, miles: null };   // 路线挂了别拿瞎猜的距离去收费
    const fee = r.ok ? deliveryFee(r.miles, cfg)
      : { ok: true, miles: null, fee: money(cfg.fallback_fee), tier: "路线服务不可用，按兜底配送费收", estimated: true };
    out.delivery = fee;
    if (!fee.ok) { out.ok = false; out.error = fee.reason; }
  }
  if (!pickup && money(subtotal) < cfg.min_order) {
    out.ok = false;
    out.error = `还没到起送价 $${cfg.min_order.toFixed(2)}（当前 $${money(subtotal).toFixed(2)}）`;
  }
  const dfee = Number((out.delivery || {}).fee || 0);
  out.tax = money(money(subtotal) * cfg.tax_rate);
  out.tip = money(money(subtotal) * Math.max(0, Number(tipRate) || 0));
  out.delivery_fee = dfee;
  out.total = money(money(subtotal) + out.tax + dfee + out.tip);
  if (out.distance && out.distance.minutes != null && !pickup) out.eta_minutes = out.distance.minutes + (cfg.prep_minutes || 0);
  if (out.ok === undefined) out.ok = true;
  return out;
}
