/**
 * 验证测试：selectCetusRoutes 对 Cetus 3 条 + DeepBook V3 的完整流程
 *
 * 运行：npx playwright test debug-cetus-unlock --headed --timeout 180000
 */

import { SwapPage } from '@/page-objects/swap.page.js';
import { test, expect } from '../setup/fixtures.js';

test('verify: selectCetusRoutes with Cetus sub-routes', async ({ page }) => {
  test.setTimeout(180_000);

  const swapPage = new SwapPage(page);
  await swapPage.goto('/swap');

  // ── 打开弹窗 ──────────────────────────────────────────────────────────────
  await swapPage.openAggregatorSettings();

  const aggDialog = page.locator('[role="dialog"]').filter({ has: page.getByText('Aggregator Settings') }).last();

  const getCounter = async () => aggDialog.evaluate((el: Element) => {
    const inp = el.querySelector<HTMLInputElement>('input#select-all');
    if (!inp) return -1;
    let anc: Element | null = inp.parentElement;
    for (let i = 0; i < 8 && anc; i++) {
      const m = (anc.textContent ?? '').match(/(\d+)\s*\/\s*28/);
      if (m) return parseInt(m[1], 10);
      anc = anc.parentElement;
    }
    return -1;
  }).catch(() => -1);

  console.log(`\nInitial counter: ${await getCounter()}/28`);

  // ── 测试 1：选中 Cetus 3 条 + DeepBook V3 ────────────────────────────────
  console.log('\n=== Test 1: selectCetusRoutes(["CLMM", "DLMM", "Cetus Tide", "DeepBook V3"]) ===');
  await swapPage.disableAllRoutes();
  const count1 = await swapPage.selectCetusRoutes(['CLMM', 'DLMM', 'Cetus Tide', 'DeepBook V3']);
  const counter1 = await getCounter();
  console.log(`Returned count: ${count1}, UI counter: ${counter1}/28`);
  console.log(`Expected: count=4, counter=4`);

  // ── 测试 2：仅选 CLMM ────────────────────────────────────────────────────
  console.log('\n=== Test 2: selectCetusRoutes(["CLMM"]) ===');
  await swapPage.disableAllRoutes();
  const count2 = await swapPage.selectCetusRoutes(['CLMM']);
  const counter2 = await getCounter();
  console.log(`Returned count: ${count2}, UI counter: ${counter2}/28`);
  console.log(`Expected: count=1, counter=1`);

  // ── 测试 3：仅选 DeepBook V3（无 Cetus）─────────────────────────────────
  console.log('\n=== Test 3: selectCetusRoutes(["DeepBook V3"]) ===');
  await swapPage.disableAllRoutes();
  const count3 = await swapPage.selectCetusRoutes(['DeepBook V3']);
  const counter3 = await getCounter();
  console.log(`Returned count: ${count3}, UI counter: ${counter3}/28`);
  console.log(`Expected: count=1, counter=1`);

  // ── 最终断言 ──────────────────────────────────────────────────────────────
  console.log('\n=== Results ===');
  console.log(`Test 1: count=${count1} counter=${counter1} → ${count1 === 4 && counter1 === 4 ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Test 2: count=${count2} counter=${counter2} → ${count2 === 1 && counter2 === 1 ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Test 3: count=${count3} counter=${counter3} → ${count3 === 1 && counter3 === 1 ? '✓ PASS' : '✗ FAIL'}`);

  expect(count1, 'Test 1: selectCetusRoutes should return 4').toBe(4);
  expect(counter1, 'Test 1: UI counter should be 4/28').toBe(4);
  expect(count2, 'Test 2: selectCetusRoutes should return 1').toBe(1);
  expect(counter2, 'Test 2: UI counter should be 1/28').toBe(1);
  expect(count3, 'Test 3: selectCetusRoutes should return 1').toBe(1);
  expect(counter3, 'Test 3: UI counter should be 1/28').toBe(1);
});
