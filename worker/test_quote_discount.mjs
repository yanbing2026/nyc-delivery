import { quote } from './src/delivery.js';

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function assert(cond, msg) {
  if (!cond) {
    console.error(`Assertion failed: ${msg}`);
    process.exit(1);
  }
}

const taxRate = 0.08875;
const subtotals = [0, 12, 18, 68, 100, 163.31];

console.log('== 1. tipRate = 0, tax_rate = 0.08875 ==');
for (const S of subtotals) {
  const q = await quote({}, '', S, { tax_rate: taxRate, min_order: 20 }, 0, true);
  const expectedDisc = round2(S * (taxRate / (1 + taxRate)));
  const expectedTaxable = round2(S - expectedDisc);
  const expectedTax = round2(expectedTaxable * taxRate);
  const expectedTotal = round2(expectedTaxable + expectedTax);

  assert(q.discount === expectedDisc, `[S=${S}] discount expected ${expectedDisc}, got ${q.discount}`);
  assert(q.tax === expectedTax, `[S=${S}] tax expected ${expectedTax}, got ${q.tax}`);
  assert(q.total === expectedTotal, `[S=${S}] total expected ${expectedTotal}, got ${q.total}`);
  assert(Math.abs(q.total - S) <= 0.01, `[S=${S}] key invariant abs(total - S) <= 0.01 failed: total=${q.total}, S=${S}`);

  console.log(`小计: ${S.toFixed(2).padStart(6)} | 折扣: ${q.discount.toFixed(2).padStart(5)} | 税: ${q.tax.toFixed(2).padStart(5)} | 合计: ${q.total.toFixed(2).padStart(6)} | (合计-小计): ${(q.total - S).toFixed(2)}`);
}

console.log('\n== 2. tipRate = 0.2 (小费按折前小计), tax_rate = 0.08875 ==');
for (const S of subtotals) {
  const q = await quote({}, '', S, { tax_rate: taxRate, min_order: 20 }, 0.2, true);
  const expectedTip = round2(S * 0.2);
  const expectedDisc = round2(S * (taxRate / (1 + taxRate)));
  const expectedTaxable = round2(S - expectedDisc);
  const expectedTax = round2(expectedTaxable * taxRate);
  const expectedTotal = round2(expectedTaxable + expectedTax + expectedTip);

  assert(q.tip === expectedTip, `[S=${S}] tip expected ${expectedTip}, got ${q.tip}`);
  assert(q.discount === expectedDisc, `[S=${S}] discount expected ${expectedDisc}, got ${q.discount}`);
  assert(q.tax === expectedTax, `[S=${S}] tax expected ${expectedTax}, got ${q.tax}`);
  assert(q.total === expectedTotal, `[S=${S}] total expected ${expectedTotal}, got ${q.total}`);
  assert(Math.abs(round2(q.total - q.tip) - S) <= 0.01, `[S=${S}] key invariant abs((total - tip) - S) <= 0.01 failed: total=${q.total}, tip=${q.tip}, S=${S}`);

  console.log(`小计: ${S.toFixed(2).padStart(6)} | 小费: ${q.tip.toFixed(2).padStart(5)} | 折扣: ${q.discount.toFixed(2).padStart(5)} | 税: ${q.tax.toFixed(2).padStart(5)} | 合计: ${q.total.toFixed(2).padStart(6)}`);
}

console.log('\n== 3. tax_rate = 0 ==');
for (const S of subtotals) {
  for (const tipRate of [0, 0.2]) {
    const q = await quote({}, '', S, { tax_rate: 0, min_order: 20 }, tipRate, true);
    const expectedTip = round2(S * tipRate);
    assert(q.discount === 0, `[S=${S}, tipRate=${tipRate}] discount expected 0, got ${q.discount}`);
    assert(q.tax === 0, `[S=${S}, tipRate=${tipRate}] tax expected 0, got ${q.tax}`);
    assert(q.tip === expectedTip, `[S=${S}, tipRate=${tipRate}] tip expected ${expectedTip}, got ${q.tip}`);
    assert(q.total === round2(S + expectedTip), `[S=${S}, tipRate=${tipRate}] total expected ${round2(S + expectedTip)}, got ${q.total}`);
  }
  console.log(`小计: ${S.toFixed(2).padStart(6)} | tax_rate=0: discount=0, tax=0, total=S+tip 验证通过`);
}

console.log('\nALL OK');
process.exitCode = 0;
