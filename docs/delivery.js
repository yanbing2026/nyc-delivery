/* 纽约送餐里程/配送费：纯前端版（跟后端 delivery.py 同一套规则）
   数据源都不需要 API key，且都带 CORS，浏览器可以直连：
     · 地址→坐标：NYC Planning Labs GeoSearch（官方，认 NY 地址）
     · 地址兜底：Nominatim（官方接口 503 时用；实测返回 access-control-allow-origin: *）
     · 坐标→驾车距离：OSRM
   两个坑已在代码里处理：不写 ZIP 会跨区解析错；中文地址搜不到。 */
(function (root) {
  'use strict';
  const GEOSEARCH = 'https://geosearch.planninglabs.nyc/v2/search';
  const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  const OSRM = 'https://router.project-osrm.org/route/v1/driving';
  const M_PER_MILE = 1609.344;
  // 告诉 Nominatim 我们是谁（其使用政策要求）。浏览器会忽略这个头、用自带 UA，
  // 但在 Node 里跑测试时它必须存在 —— 空 UA 会被 Nominatim 直接 403。
  const UA = 'nyc-delivery/1.0 (contact: shop owner)';

  const DEFAULT_DELIVERY = {
    enabled: true, free_miles: 0.5,
    tiers: [{ max: 2, fee: 3.0 }, { max: 4, fee: 6.0 }, { max: 6, fee: 10.0 }],
    per_mile_beyond: 2.5, max_miles: 8, min_order: 20.0, tax_rate: 0.08875,
    prep_minutes: 20, tip_options: [0.15, 0.18, 0.20],
    payment: ['现金 Cash（送到付）'],
    restaurant_addr: '10-53 116th St, Flushing, NY 11356',
    restaurant: { lat: 40.7873972, lon: -73.8511667 },
    fallback_fee: 5.0,
  };

  const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
  const moneyStr = (v) => '$' + money(v).toFixed(2);
  const hasZip = (q) => q.split(/[,\s]+/).some((t) => /^\d{5}$/.test(t));
  const milesOf = (m) => Math.round((m / M_PER_MILE) * 100) / 100;

  function looksLikeAddress(q) {
    q = String(q || '').trim();
    if (!q) return [false, '地址不能为空'];
    if (/[\u4e00-\u9fff]/.test(q)) return [false, '请用英文街名（纽约系统不认中文地址），例如 136-20 Roosevelt Ave, Flushing, NY 11354'];
    const toks = q.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
    if (!/\d/.test(toks[0] || '')) return [false, '请从门牌号开始填，例如 40 Bayard St, New York, NY 10013'];
    if (!toks.some((t) => /[A-Za-z]/.test(t))) return [false, '缺少街名：只填 ZIP 会被当成街名解析错'];
    if (!hasZip(q)) return [true, '没写 ZIP，可能解析到别的区（同一个街名在多个区都有）'];
    return [true, ''];
  }

  async function geocodeCandidates(query, limit) {
    limit = limit || 5;
    if (!query || !query.trim()) return [];
    const size = Math.min(Math.max(limit, 1), 10);
    // 首选 NYC 官方 GeoSearch；报错或没结果都落到 Nominatim —— 跟 Worker 侧同一套规则
    try {
      const u = new URL(GEOSEARCH);
      u.searchParams.set('text', query);
      u.searchParams.set('size', String(size));
      const r = await fetch(u, { headers: { 'User-Agent': UA } });
      if (r.ok) {
        const d = await r.json();
        const cands = ((d.features) || []).map((f) => ({
          label: f.properties.label || f.properties.name || '',
          name: f.properties.name || '',
          borough: f.properties.borough || '',
          postalcode: f.properties.postalcode || '',
          lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
          source: 'nyc-geosearch',
        }));
        if (cands.length) return cands;
      }
    } catch (e) { /* 落到下面的兜底 */ }
    // 兜底：Nominatim（带 CORS 可浏览器直连）。User-Agent 不设 —— 浏览器会忽略它
    const v = new URL(NOMINATIM);
    v.searchParams.set('q', query);
    v.searchParams.set('format', 'json');
    v.searchParams.set('limit', String(size));
    v.searchParams.set('countrycodes', 'us');
    v.searchParams.set('addressdetails', '1');
    const r2 = await fetch(v, { headers: { 'User-Agent': UA } });
    if (!r2.ok) throw new Error('地址服务返回 ' + r2.status);
    const d2 = await r2.json();
    return (d2 || [])
      .map((d) => {
        const a = d.address || {};
        return {
          label: d.display_name || '',
          name: d.name || '',
          borough: a.suburb || a.city || '',
          postalcode: a.postcode || '',
          lat: parseFloat(d.lat), lon: parseFloat(d.lon),
          source: 'nominatim',
        };
      })
      .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon))
      .slice(0, size);
  }

  async function geocode(query) {
    const zips = String(query || '').split(/[,\s]+/).filter((t) => /^\d{5}$/.test(t));
    const cands = await geocodeCandidates(query, 10);
    if (!cands.length) return { ok: false, error: '地址没找到，检查门牌号/街名/邮编，或补上区名（Flushing / Chinatown）' };
    if (zips.length) {
      const hit = cands.find((c) => c.postalcode === zips[0]);
      if (hit) return Object.assign({ ok: true }, hit);
    }
    return Object.assign({ ok: true, candidates: cands.slice(0, 5), warning: zips.length ? '' : '没指定 ZIP，可能解析到别的区' }, cands[0]);
  }

  async function routeMiles(a, b) {
    try {
      // 同样要带 UA：空 UA 会被 OSRM 前置的 nginx 挡成 403 HTML
      const r = await fetch(`${OSRM}/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false&steps=false`,
        { headers: { 'User-Agent': UA } });
      if (!r.ok) return { ok: false, error: '路线服务返回 ' + r.status, miles: null, minutes: null, source: 'unavailable' };
      const d = await r.json();
      const route = (d.routes || [])[0] || {};
      return { ok: true, miles: milesOf(route.distance || 0), minutes: Math.round((route.duration || 0) / 60), source: 'osrm' };
    } catch (e) {
      return { ok: false, error: '路线服务不可用：' + e.message, miles: null, minutes: null, source: 'unavailable' };
    }
  }

  function deliveryFee(miles, cfg) {
    cfg = Object.assign({}, DEFAULT_DELIVERY, cfg || {});
    const t = cfg.tiers || DEFAULT_DELIVERY.tiers;
    const m = Math.round((Number(miles) || 0) * 100) / 100;
    if (cfg.max_miles && m > cfg.max_miles)
      return { ok: false, miles: m, fee: null, reason: `${m.toFixed(1)} 英里超出配送范围（最远 ${cfg.max_miles} 英里），请到店自取或换地址` };
    if (m <= cfg.free_miles) return { ok: true, miles: m, fee: 0, tier: `${cfg.free_miles} 英里内免配送费` };
    for (const tier of t.slice().sort((a, b) => a.max - b.max)) {
      if (m <= tier.max) return { ok: true, miles: m, fee: tier.fee, tier: `${tier.max} 英里内 $${tier.fee.toFixed(2)}` };
    }
    const last = t.slice().sort((a, b) => b.max - a.max)[0] || { max: cfg.free_miles, fee: 0 };
    const extra = Math.max(0, m - last.max) * cfg.per_mile_beyond;
    return { ok: true, miles: m, fee: money(last.fee + extra),
      tier: `${last.max} 英里 $${last.fee.toFixed(2)} + 超出 ${(m - last.max).toFixed(1)} 英里 × $${cfg.per_mile_beyond}/英里` };
  }

  async function quote(restaurant, addrQuery, subtotal, cfg, tipRate, pickup) {
    cfg = Object.assign({}, DEFAULT_DELIVERY, cfg || {});
    const out = { subtotal: money(subtotal), pickup: !!pickup, tax_rate: cfg.tax_rate, min_order: cfg.min_order };
    if (pickup) {
      out.delivery = { ok: true, fee: 0, miles: 0, tier: '到店自取' };
    } else {
      const [ok, warn] = looksLikeAddress(addrQuery);
      if (!ok) return Object.assign({ ok: false, error: warn }, out);
      const g = await geocode(addrQuery);
      if (!g.ok) return Object.assign(g, out);
      out.address = { input: addrQuery, matched: g.label, borough: g.borough, zip: g.postalcode, lat: g.lat, lon: g.lon, source: g.source };
      if (g.warning) out.address.warning = g.warning;
      if (g.candidates) out.address.candidates = g.candidates;
      const r = await routeMiles(restaurant, g);
      out.distance = r;
      const fee = deliveryFee(r.miles, cfg);
      out.delivery = fee;
      if (!fee.ok) { out.ok = false; out.error = fee.reason; }
    }
    if (!pickup && subtotal < cfg.min_order) {
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

  const API = { DEFAULT_DELIVERY, looksLikeAddress, geocodeCandidates, geocode, routeMiles, deliveryFee, quote, money, moneyStr };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.WXDelivery = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
