/**
 * Test: Peach Limit Order – Price Mode Linkage (价格模式联动)
 *
 * 验证 Limit 页面中 "Sell BNB at rate" 区域 price ↔ percentage 双向联动的正确性：
 *
 * ── Percentage → Price（百分比 → 具体价格）──────────────────────────────────
 *   场景1: 点击 +5%  → rate 输入框 ≈ 市价 × 1.05（误差 ≤ 0.1%）
 *   场景2: 点击 +10% → rate 输入框 ≈ 市价 × 1.10（误差 ≤ 0.1%）
 *
 * ── Price → Percentage（具体价格 → 百分比）──────────────────────────────────
 *   场景3: 手动输入 rate=100  → 百分比 ≈ (100/市价 - 1) × 100（误差 ≤ 0.2%）
 *   场景4: 手动输入 rate=200  → 百分比 ≈ (200/市价 - 1) × 100（误差 ≤ 0.2%）
 *
 *   注：百分比显示区域数值可能被截断，需要点击后通过 copy 操作读取完整值。
 *
 * 运行命令：
 *   npx playwright test tests/e2e/limit-price-mode.spec.ts
 */

import { LimitPage } from '../../src/page-objects/limit.page.js';
import { test, expect } from '../setup/fixtures.js';

const MIN_USD = parseFloat(process.env.LIMIT_MIN_USD ?? '5');
/** 价格误差容忍度 */
const PRICE_TOLERANCE  = 0.001; // 0.1%
const PCT_TOLERANCE    = 0.2;   // 允许 ±0.2 百分点误差

test.describe('Peach Limit – Price Mode Linkage', () => {
  test(
    'Percentage→Price: +5%/+10% 按钮正确换算; Price→Percentage: 输入 100/200 百分比正确反算',
    async ({ workerPage: page, workerMetamask: metamask }) => {
      test.setTimeout(180_000);

      console.log('═══════════════════════════════════════════════════════════════');
      console.log('  Peach Protocol – Limit Price Mode Linkage Test');
      console.log('═══════════════════════════════════════════════════════════════');

      const limitPage = new LimitPage(page);

      // ── Step 1: 导航并连接钱包 ────────────────────────────────────────────
      console.log('\n[Step 1] Navigating and connecting wallet...');
      await limitPage.goto();
      await metamask.connect(page);
      await expect(page.locator('text=/0x[a-fA-F0-9]{3,}/i').first()).toBeVisible({ timeout: 10_000 });
      console.log('✓ Wallet connected');

      // ── Step 2: 读取市价 ──────────────────────────────────────────────────
      console.log('\n[Step 2] Reading BNB market price...');
      await page.waitForTimeout(2_000);
      const bnbPrice = await limitPage.getBnbMarketPrice();
      const marketPrice = bnbPrice ?? 600;
      if (!bnbPrice) console.log(`⚠ Using fallback price: ${marketPrice}`);
      console.log(`  Market price: ${marketPrice} USDT`);
      console.log(`##PRICE_MODE_MARKET:${marketPrice}##`);

      // ── Step 3: 填入 You Pay（确保 rate 面板激活）────────────────────────
      console.log('\n[Step 3] Entering BNB pay amount...');
      const raw = MIN_USD / marketPrice;
      const payAmount = (Math.ceil(raw * 100) / 100).toFixed(2);
      await limitPage.enterPayAmount(payAmount, marketPrice, MIN_USD);
      await page.waitForTimeout(2_000);
      console.log(`✓ Pay amount: ${payAmount} BNB`);

      // ════════════════════════════════════════════════════════════════════════
      // 场景1: 点击 +5%，验证 rate ≈ marketPrice × 1.05
      // ════════════════════════════════════════════════════════════════════════
      console.log('\n[Scene 1] Clicking +5%...');
      await clickRatePercentBtn(page, '+5%');
      await page.waitForTimeout(1_500);

      const rateAfter5  = await getRateInputValue(page);
      const expected5   = marketPrice * 1.05;
      const diff5       = Math.abs(rateAfter5 - expected5) / expected5;
      const scene1Pass  = rateAfter5 > 0 && diff5 <= PRICE_TOLERANCE;

      console.log(`  Rate input: ${rateAfter5} | expected: ${expected5.toFixed(4)} | diff: ${(diff5*100).toFixed(3)}%`);
      console.log(`  Scene 1: ${scene1Pass ? '✅' : '❌'}`);
      console.log(`##PRICE_MODE_SCENE1:rateAfter=${rateAfter5},expected=${expected5.toFixed(4)},passed=${scene1Pass}##`);

      // ════════════════════════════════════════════════════════════════════════
      // 场景2: 点击 +10%，验证 rate ≈ marketPrice × 1.10
      // ════════════════════════════════════════════════════════════════════════
      console.log('\n[Scene 2] Clicking +10%...');
      await clickRatePercentBtn(page, '+10%');
      await page.waitForTimeout(1_500);

      const rateAfter10 = await getRateInputValue(page);
      const expected10  = marketPrice * 1.10;
      const diff10      = Math.abs(rateAfter10 - expected10) / expected10;
      const scene2Pass  = rateAfter10 > 0 && diff10 <= PRICE_TOLERANCE;

      console.log(`  Rate input: ${rateAfter10} | expected: ${expected10.toFixed(4)} | diff: ${(diff10*100).toFixed(3)}%`);
      console.log(`  Scene 2: ${scene2Pass ? '✅' : '❌'}`);
      console.log(`##PRICE_MODE_SCENE2:rateAfter=${rateAfter10},expected=${expected10.toFixed(4)},passed=${scene2Pass}##`);

      // ════════════════════════════════════════════════════════════════════════
      // 场景3: 输入 rate=100，验证百分比 ≈ (100/marketPrice - 1) × 100
      // ════════════════════════════════════════════════════════════════════════
      console.log('\n[Scene 3] Entering rate=100...');
      await limitPage.enterRatePrice('100', marketPrice);
      await page.waitForTimeout(2_000);

      const expectedPct100 = (100 / marketPrice - 1) * 100;
      const actualPct100   = await getPercentValue(page);
      const diffPct100     = Math.abs(actualPct100 - expectedPct100);
      const scene3Pass     = diffPct100 <= PCT_TOLERANCE;

      console.log(`  Pct shown: ${actualPct100.toFixed(2)}% | expected: ${expectedPct100.toFixed(2)}% | diff: ${diffPct100.toFixed(3)}pp`);
      console.log(`  Scene 3: ${scene3Pass ? '✅' : '❌'}`);
      console.log(`##PRICE_MODE_SCENE3:pctShown=${actualPct100.toFixed(2)},expected=${expectedPct100.toFixed(2)},passed=${scene3Pass}##`);

      // ════════════════════════════════════════════════════════════════════════
      // 场景4: 输入 rate=200，验证百分比 ≈ (200/marketPrice - 1) × 100
      // ════════════════════════════════════════════════════════════════════════
      console.log('\n[Scene 4] Entering rate=200...');
      await limitPage.enterRatePrice('200', marketPrice);
      await page.waitForTimeout(2_000);

      const expectedPct200 = (200 / marketPrice - 1) * 100;
      const actualPct200   = await getPercentValue(page);
      const diffPct200     = Math.abs(actualPct200 - expectedPct200);
      const scene4Pass     = diffPct200 <= PCT_TOLERANCE;

      console.log(`  Pct shown: ${actualPct200.toFixed(2)}% | expected: ${expectedPct200.toFixed(2)}% | diff: ${diffPct200.toFixed(3)}pp`);
      console.log(`  Scene 4: ${scene4Pass ? '✅' : '❌'}`);
      console.log(`##PRICE_MODE_SCENE4:pctShown=${actualPct200.toFixed(2)},expected=${expectedPct200.toFixed(2)},passed=${scene4Pass}##`);

      // ── 汇总 ──────────────────────────────────────────────────────────────
      const passed = scene1Pass && scene2Pass && scene3Pass && scene4Pass;
      console.log(`\n${'═'.repeat(60)}`);
      console.log(`  Sc1(+5%)  : ${scene1Pass ? '✅' : '❌'}  rate=${rateAfter5} vs ${expected5.toFixed(2)}`);
      console.log(`  Sc2(+10%) : ${scene2Pass ? '✅' : '❌'}  rate=${rateAfter10} vs ${expected10.toFixed(2)}`);
      console.log(`  Sc3(100)  : ${scene3Pass ? '✅' : '❌'}  pct=${actualPct100.toFixed(2)} vs ${expectedPct100.toFixed(2)}`);
      console.log(`  Sc4(200)  : ${scene4Pass ? '✅' : '❌'}  pct=${actualPct200.toFixed(2)} vs ${expectedPct200.toFixed(2)}`);
      console.log(`  Overall   : ${passed ? '✅ PASS' : '❌ FAIL'}`);
      console.log(`##PRICE_MODE_RESULT:passed=${passed},sc1=${scene1Pass},sc2=${scene2Pass},sc3=${scene3Pass},sc4=${scene4Pass},market=${marketPrice}##`);
      console.log(`${'═'.repeat(60)}\n`);

      // ── Assertions ───────────────────────────────────────────────────────
      expect(scene1Pass, `[Sc1] +5% 后 rate=${rateAfter5}，期望≈${expected5.toFixed(4)}`).toBe(true);
      expect(scene2Pass, `[Sc2] +10% 后 rate=${rateAfter10}，期望≈${expected10.toFixed(4)}`).toBe(true);
      expect(scene3Pass, `[Sc3] rate=100 百分比=${actualPct100.toFixed(2)}%，期望≈${expectedPct100.toFixed(2)}%`).toBe(true);
      expect(scene4Pass, `[Sc4] rate=200 百分比=${actualPct200.toFixed(2)}%，期望≈${expectedPct200.toFixed(2)}%`).toBe(true);
    }
  );
});

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/**
 * 点击 "Sell BNB at rate" 区域的百分比快捷按钮（+5% 或 +10%）。
 * 按钮文案示例："+5%", "+10%"
 */
async function clickRatePercentBtn(page: import('@playwright/test').Page, label: string) {
  // 将 label（如 "+5%"）转义为安全的正则，精确匹配整个文本
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactRe  = new RegExp(`^${escaped}$`);

  // 先在 rate 区域附近找（定位到 Market: 文字的祖先区域）
  const rateSection = page.locator('text=/Market:/i').locator('xpath=ancestor::div[4]');
  const btn = rateSection.locator('button, span, div').filter({ hasText: exactRe }).first();
  const vis = await btn.isVisible({ timeout: 4_000 }).catch(() => false);
  if (vis) {
    await btn.click();
    console.log(`[clickRatePercentBtn] Clicked "${label}" in rate section`);
    return;
  }

  // 全页面兜底
  const fallback = page.locator('button, span, div').filter({ hasText: exactRe }).first();
  await expect(fallback).toBeVisible({ timeout: 5_000 });
  await fallback.click();
  console.log(`[clickRatePercentBtn] Clicked "${label}" via page fallback`);
}

/**
 * 读取 "Sell BNB at rate" 输入框当前的数值。
 *
 * 定位策略：
 *  1. 找到 "Market:" 标签的祖先 div[5]（rate 整体区域），在其中找
 *     value > 100 的 input（排除百分比选择器的 0-100 范围输入）
 *  2. 若策略1失败，通过 "Market:" 标签的 bounding box 向上 ~30px 点击
 *     该坐标，读取 document.activeElement 的值
 */
async function getRateInputValue(page: import('@playwright/test').Page): Promise<number> {
  const marketLabel = page.locator('text=/Market:/i').first();
  await expect(marketLabel).toBeVisible({ timeout: 8_000 });

  // 策略1：在 rate 区域找所有 input，选出 value > 100 的那个（价格 input）
  const rateSection = marketLabel.locator('xpath=ancestor::div[5]');
  const sectionValue = await rateSection.evaluate((container) => {
    const inputs = Array.from(container.querySelectorAll('input'));
    for (const inp of inputs) {
      const v = parseFloat((inp as HTMLInputElement).value.replace(/,/g, ''));
      // 价格 > 100，百分比在 0-100 范围内；以 > 50 作为阈值区分
      if (!isNaN(v) && v > 50) return (inp as HTMLInputElement).value;
    }
    // 没命中时返回所有 input 的值以便调试
    return inputs.map(i => (i as HTMLInputElement).value).join(',');
  }).catch(() => '');

  const parsed = parseFloat(sectionValue.split(',')[0].replace(/,/g, ''));
  if (!isNaN(parsed) && parsed > 50) {
    console.log(`[getRateInputValue] Found via section scan: ${parsed}`);
    return parsed;
  }

  // 策略2：通过坐标点击定位并读取
  const box = await marketLabel.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.click(box.x + 80, box.y - 30);
    await page.waitForTimeout(300);
    const activeVal = await page.evaluate(() => {
      const el = document.activeElement as HTMLInputElement | null;
      return el?.tagName === 'INPUT' ? el.value : '';
    });
    const v2 = parseFloat(activeVal.replace(/,/g, ''));
    if (!isNaN(v2) && v2 > 0) {
      console.log(`[getRateInputValue] Found via click+activeElement: ${v2}`);
      return v2;
    }
  }

  console.log(`[getRateInputValue] Fallback debug: sectionValue="${sectionValue}"`);
  return parsed || 0;
}

/**
 * 读取 "Sell BNB at rate" 右侧显示的百分比数值（如 "-83.29%"、"+66.58%"）。
 *
 * 主策略：从页面底部的描述文字中提取完整百分比。
 * 页面会显示类似 "...above 100 USDT (-83.29% from market)..." 的文字，
 * 这是唯一包含完整、精确偏差百分比的地方。
 *
 * 兜底策略：在 rate 卡片内找截断显示的百分比标签（如 "-83."），
 * 通过 title/data 属性读取完整值。
 */
async function getPercentValue(page: import('@playwright/test').Page): Promise<number> {
  // ── 主策略：从 "(-83.29% from market)" 描述句中提取 ─────────────────────────
  // 这段文字通常渲染为 span/p，内含 "from market" 字样
  // textContent 会把子节点文本合并，能拿到完整内容
  const candidates = page.locator('p, span, div').filter({ hasText: /from market/i });
  const count = await candidates.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    const el = candidates.nth(i);
    const visible = await el.isVisible({ timeout: 1_000 }).catch(() => false);
    if (!visible) continue;

    const fullText = (await el.textContent().catch(() => '')) ?? '';
    console.log(`[getPercentValue] candidate[${i}] text="${fullText.slice(0, 120)}"`);

    // 匹配 "(-83.29% from market)" 或 "-83.29% from market"
    const m = /\(?\s*([+-]?\d+\.?\d+)%\s*from market/i.exec(fullText);
    if (m) {
      const val = parseFloat(m[1]);
      console.log(`[getPercentValue] from-market match → ${val}`);
      return val;
    }
  }

  // ── 兜底：在 rate 卡片区域找截断的百分比标签 ─────────────────────────────────
  // rate 卡片是 "Market:" 标签的 ancestor::div[3]（不含 platform fee 区域）
  const rateCard = page.locator('text=/Market:/i').locator('xpath=ancestor::div[3]');
  const SKIP = /^[+-]?[35]%$|^\+10%$|^25%$|^50%$|^75%$|^100%$|^0%$|^%$/;

  const fallback = await rateCard.evaluate((card, skipRe) => {
    const all = Array.from(card.querySelectorAll('*'));
    for (const el of all) {
      if (el.children.length > 0) continue;
      const txt = (el.textContent ?? '').trim();
      if (!txt || new RegExp(skipRe).test(txt)) continue;
      // 必须带 % 且有数字
      if (!txt.includes('%') || !/\d/.test(txt)) continue;
      // 优先读完整属性
      const full = (el as HTMLElement).title ||
        (el as HTMLElement).dataset['value'] ||
        el.getAttribute('aria-label') || '';
      return full || txt;
    }
    return '';
  }, SKIP.source).catch(() => '');

  if (fallback) {
    const m2 = /([+-]?\d+\.?\d*)/.exec(fallback);
    if (m2) {
      const val = parseFloat(m2[1]);
      console.log(`[getPercentValue] rate-card fallback="${fallback}" → ${val}`);
      return val;
    }
  }

  console.log('[getPercentValue] Could not read percent value, returning 0');
  return 0;
}
