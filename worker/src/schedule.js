// 取餐排期（全部按纽约时间；调用方传进来的一定是纽约时间 "YYYY-MM-DD HH:MM:SS"）
export const PICKUP_RULES = { cutoff: "22:00", start: "14:00", end: "20:00", step_minutes: 30, lead_days: 1 };

const toMin = (hhmm) => { const [h, m] = String(hhmm).split(":").map(Number); return h * 60 + m; };
const fromMin = (n) => String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0");

// 目标取餐日：纽约时间 cutoff 之前下单 → 次日；cutoff 及以后 → 后天
export function pickupDay(stamp, rules = PICKUP_RULES) {
  const day = String(stamp || "").slice(0, 10);
  const nowMin = toMin(String(stamp || "").slice(11, 16));
  const add = nowMin < toMin(rules.cutoff) ? rules.lead_days : rules.lead_days + 1;
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + add);
  return d.toISOString().slice(0, 10);
}

// 该日全部可选取餐时间格（含首含尾）：14:00, 14:30, ... 20:00 → 共 13 个
export function slotsFor(day, rules = PICKUP_RULES) {
  const out = [];
  for (let m = toMin(rules.start); m <= toMin(rules.end); m += rules.step_minutes) out.push(fromMin(m));
  return out;
}

export function pickupPlan(stamp, rules = PICKUP_RULES) {
  const day = pickupDay(stamp, rules);
  return { day, slots: slotsFor(day, rules), cutoff: rules.cutoff, start: rules.start,
    end: rules.end, step_minutes: rules.step_minutes, lead_days: rules.lead_days };
}

// 顾客传上来的是 "YYYY-MM-DD HH:MM"（或带 :SS），必须正好落在允许集合里
export function validPickup(value, stamp, rules = PICKUP_RULES) {
  const plan = pickupPlan(stamp, rules);
  const v = String(value || "").trim();
  if (v.slice(0, 10) !== plan.day) return false;
  return plan.slots.includes(v.slice(11, 16));
}
