// 店名 / 电话 / 口号 / 菜品：存在 D1 的 settings 表（key = 'shop' / 'menu'），
// 由店里在菜单编辑页改，点单页只读。这里同时是默认值 —— 库里还没有记录时用这一份，
// 所以「改店信息」不需要改代码重新发布。
//
// 为什么放后端而不是页面里写死：店名/电话/菜名价格都是店里会改的东西，
// 写死在页面上意味着每次改价都要改代码 + 重新发布，还会出现「页面上是旧价、
// 后厨按新价收钱」这种对不上的情况。

export const DEFAULT_SHOP = {
  name: "福州小馆",
  phone: "917-555-0123",
  slogan: "现点现做 · 法拉盛 30 分钟送达",
};

export const DEFAULT_MENU = [
  { name: "招牌", items: [
    { id: "a1", name: "海蛎煎", en: "Oyster Omelette", desc: "现点现做", price: 12.95 },
    { id: "a2", name: "红蟳米糕", en: "Steamed Rice w/ Crab", desc: "", price: 32.95 },
    { id: "a3", name: "福州鱼丸汤", en: "Fuzhou Fish Ball Soup", desc: "", price: 9.95 }] },
  { name: "小炒", items: [
    { id: "b1", name: "荔枝肉", en: "Lychee Pork", desc: "福州味", price: 14.95 },
    { id: "b2", name: "糟菜炒粉干", en: "Rice Noodle w/ Pickled Veg", desc: "", price: 12.95 },
    { id: "b3", name: "白灼虾", en: "Boiled Shrimp", desc: "按份", price: 19.95 },
    { id: "b4", name: "蒜蓉炒青菜", en: "Garlic Chinese Broccoli", desc: "", price: 11.95 }] },
  { name: "主食 / 汤", items: [
    { id: "c1", name: "锅边糊", en: "Rice Noodle Soup", desc: "", price: 8.95 },
    { id: "c2", name: "福州拌面", en: "Fuzhou Lo Mein", desc: "", price: 9.95 },
    { id: "c3", name: "白饭", en: "Steamed Rice", desc: "", price: 2.0 }] },
  { name: "饮品", items: [
    { id: "d1", name: "茉莉花茶", en: "Jasmine Tea", desc: "一壶", price: 3.95 },
    { id: "d2", name: "王老吉", en: "Herbal Tea", desc: "", price: 2.5 }] },
];

const MAX_CATEGORIES = 30, MAX_ITEMS_PER_CAT = 60;
const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const money2 = (v) => Math.round(Number(v) * 100) / 100;
const cloneMenu = (m) => m.map((c) => ({ name: c.name, items: c.items.map((i) => ({ ...i })) }));

// 库里读出来的东西可能是手改坏的 JSON，一律过一遍规范化，坏条目丢掉而不是让页面崩
export function readShop(stored) {
  // 库里没这条记录 → 整份默认值（电话/口号也要给，否则页头会空一块）
  if (!stored || typeof stored !== "object") return { ...DEFAULT_SHOP };
  return {
    name: str(stored.name, 40) || DEFAULT_SHOP.name,
    phone: str(stored.phone, 30),
    slogan: str(stored.slogan, 60),
  };
}

// 保存时用这个：坏数据要报错，不能静默丢弃（否则店里以为存上了）
export function buildMenu(input) {
  if (!Array.isArray(input)) return { ok: false, error: "菜单要是一个数组（分类 → 菜）" };
  const seen = new Set();
  const cats = [];
  let dropped = 0;
  for (const c of input.slice(0, MAX_CATEGORIES)) {
    if (!c || typeof c !== "object") { dropped++; continue; }
    const items = [];
    for (const it of (Array.isArray(c.items) ? c.items : []).slice(0, MAX_ITEMS_PER_CAT)) {
      const id = str(it && it.id, 24), name = str(it && it.name, 40);
      const price = Number(it && it.price);
      if (!id || !name || seen.has(id) || !Number.isFinite(price) || price < 0 || price > 999) { dropped++; continue; }
      seen.add(id);
      items.push({ id, name, en: str(it.en, 60), desc: str(it.desc, 40), price: money2(price) });
    }
    if (items.length) cats.push({ name: str(c.name, 30) || "菜单", items });
  }
  if (!cats.length)
    return { ok: false, error: "菜单里没有一道合格的菜：每道菜要有唯一 id、名字，价格 0~999" };
  if (dropped) return { ok: true, menu: cats, dropped };
  return { ok: true, menu: cats };
}

// 读的时候用这个：解析不出来就退回默认菜单（页面上宁可是默认菜，也不能空着）
export function readMenu(stored) {
  const r = buildMenu(stored);
  return r.ok ? r.menu : cloneMenu(DEFAULT_MENU);
}
