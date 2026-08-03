/**
 * 验证测试：selectCetusRoutes 对 Cetus 3 条 + DeepBook V3 的完整流程
 *
 * 运行：npx playwright test debug-cetus-unlock --headed --timeout 180000
 */

import { SwapPage } from '@/page-objects/swap.page.js';
import { test, expect } from '../setup/fixtures.js';

const ROUTER_STATUS_API = 'https://api-sui.cetus.zone/router_v3/status';

/** 从 router_v3/status 接口获取 providers 总数 */
async function fetchTotalRouteCount(): Promise<number> {
  try {
    const res = await fetch(ROUTER_STATUS_API);
    const json = await res.json() as { code: number; data?: { providers?: string[] } };
    const count = json?.data?.providers?.length ?? 0;
    if (count > 0) {
      console.log(`[fetchTotalRouteCount] providers total: ${count}`);
      return count;
    }
  } catch (e) {
    console.warn(`[fetchTotalRouteCount] API error: ${e}`);
  }
  // 接口不可用时降级到当前已知值，避免测试因网络问题整体中断
  console.warn('[fetchTotalRouteCount] Fallback to default count 25');
  return 25;
}

test('verify: selectCetusRoutes with Cetus sub-routes', async ({ page }) => {
  test.setTimeout(180_000);

  const totalRouteCount = await fetchTotalRouteCount();

  const swapPage = new SwapPage(page);
  await swapPage.goto('/swap');

  // ── 打开弹窗 ──────────────────────────────────────────────────────────────
  await swapPage.openAggregatorSettings();

  const aggDialog = page.locator('[role="dialog"]').filter({ has: page.getByText('Aggregator Settings') }).last();

  const getCounter = async () => aggDialog.evaluate((el: Element, total: number) => {
    const inp = el.querySelector<HTMLInputElement>('input#select-all');
    if (!inp) return -1;
    let anc: Element | null = inp.parentElement;
    for (let i = 0; i < 8 && anc; i++) {
      const m = (anc.textContent ?? '').match(new RegExp(`(\\d+)\\s*\\/\\s*${total}`));
      if (m) return parseInt(m[1], 10);
      anc = anc.parentElement;
    }
    return -1;
  }, totalRouteCount).catch(() => -1);

  console.log(`\nInitial counter: ${await getCounter()}/${totalRouteCount}`);

  // ── 测试 1：选中 Cetus 3 条 + DeepBook V3 ────────────────────────────────
  console.log('\n=== Test 1: selectCetusRoutes(["CLMM", "DLMM", "Cetus Tide", "DeepBook V3"]) ===');
  await swapPage.disableAllRoutes();
  const count1 = await swapPage.selectCetusRoutes(['CLMM', 'DLMM', 'Cetus Tide', 'DeepBook V3']);
  const counter1 = await getCounter();
  console.log(`Returned count: ${count1}, UI counter: ${counter1}/${totalRouteCount}`);
  console.log(`Expected: count=4, counter=4`);

  // ── 测试 2：仅选 CLMM ────────────────────────────────────────────────────
  console.log('\n=== Test 2: selectCetusRoutes(["CLMM"]) ===');
  await swapPage.disableAllRoutes();
  const count2 = await swapPage.selectCetusRoutes(['CLMM']);
  const counter2 = await getCounter();
  console.log(`Returned count: ${count2}, UI counter: ${counter2}/${totalRouteCount}`);
  console.log(`Expected: count=1, counter=1`);

  // ── 测试 3：仅选 DeepBook V3（无 Cetus）─────────────────────────────────
  console.log('\n=== Test 3: selectCetusRoutes(["DeepBook V3"]) ===');
  await swapPage.disableAllRoutes();
  const count3 = await swapPage.selectCetusRoutes(['DeepBook V3']);
  const counter3 = await getCounter();
  console.log(`Returned count: ${count3}, UI counter: ${counter3}/${totalRouteCount}`);
  console.log(`Expected: count=1, counter=1`);

  // ── 最终断言 ──────────────────────────────────────────────────────────────
  console.log('\n=== Results ===');
  console.log(`Test 1: count=${count1} counter=${counter1} → ${count1 === 4 && counter1 === 4 ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Test 2: count=${count2} counter=${counter2} → ${count2 === 1 && counter2 === 1 ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Test 3: count=${count3} counter=${counter3} → ${count3 === 1 && counter3 === 1 ? '✓ PASS' : '✗ FAIL'}`);

  expect(count1, 'Test 1: selectCetusRoutes should return 4').toBe(4);
  expect(counter1, `Test 1: UI counter should be 4/${totalRouteCount}`).toBe(4);
  expect(count2, 'Test 2: selectCetusRoutes should return 1').toBe(1);
  expect(counter2, `Test 2: UI counter should be 1/${totalRouteCount}`).toBe(1);
  expect(count3, 'Test 3: selectCetusRoutes should return 1').toBe(1);
  expect(counter3, `Test 3: UI counter should be 1/${totalRouteCount}`).toBe(1);
});
