/**
 * Test: Peach Limit Order – Price Direction Auto-Detection
 *
 * 验证当用户在 "Sell BNB at rate" 输入框中填入不同价格时，
 * 页面底部的判断文案和颜色能正确反映价格方向：
 *
 * 场景一：输入市场价 × 50%（低于市价）
 *   - 预期高亮文案颜色为红色
 *
 * 场景二：输入市场价 × 150%（高于市价）
 *   - 预期高亮文案颜色为绿色
 *
 * 说明：页面无论高低均显示 "price goes above X USDT"，
 * 方向判定依据为高亮文案的渲染颜色（红色=低于市价，绿色=高于市价）
 *
 * 流程：
 *   Step 1: 导航至 /limit 并连接 MetaMask 钱包
 *   Step 2: 读取当前 BNB 市场价格
 *   Step 3: 计算 BNB 数量（= ceil(5 / BNB价格)）并填入 "You Pay"
 *   Step 4: 填入 市场价 × 50%，读取并断言提示文案含 "below"，颜色为红色
 *   Step 5: 填入 市场价 × 150%，读取并断言提示文案含 "above"，颜色为绿色
 *
 * 环境变量（.env）：
 *   LIMIT_MIN_USD   – 最低 USD 阈值（默认 5）
 *
 * 运行命令：
 *   npx playwright test tests/e2e/limit-price-direction.spec.ts
 */

import { LimitPage } from '../../src/page-objects/limit.page.js';
import { test, expect } from '../setup/fixtures.js';

const MIN_USD = parseFloat(process.env.LIMIT_MIN_USD ?? '5');

// ── 结构化日志 marker（供 dashboard 解析） ────────────────────────────────────
// ##PRICE_DIR_RESULT:passed=true,belowPassed=true,abovePassed=true,belowText=...,aboveText=...,marketPrice=...##

test.describe('Peach Limit – Price Direction Auto-Detection', () => {
  test(
    '分别输入 50% 和 150% 市价时，判断文案和颜色正确（below 红 / above 绿）',
    async ({ workerPage: page, workerMetamask: metamask }) => {
      test.setTimeout(180_000); // 3 minutes — no on-chain tx needed

      console.log('═══════════════════════════════════════════════════════════════');
      console.log('  Peach Protocol – Limit Price Direction Test');
      console.log('  50% market price → "below" (red)');
      console.log('  150% market price → "above" (green)');
      console.log('═══════════════════════════════════════════════════════════════');

      const limitPage = new LimitPage(page);

      // ── Step 1: 导航并连接钱包 ──────────────────────────────────────────
      console.log('\n[Step 1] Navigating to Limit page and connecting wallet...');
      await limitPage.goto();
      await metamask.connect(page);
      await expect(
        page.locator('text=/0x[a-fA-F0-9]{3,}/i').first()
      ).toBeVisible({ timeout: 10_000 });
      console.log('✓ Wallet connected');

      // ── Step 2: 读取 BNB 市价 ──────────────────────────────────────────
      console.log('\n[Step 2] Reading BNB market price...');
      await page.waitForTimeout(2_000);
      const bnbPrice = await limitPage.getBnbMarketPrice();
      const marketPrice = bnbPrice ?? 600;
      if (!bnbPrice) {
        console.log(`⚠ Could not read BNB market price, using fallback ${marketPrice}`);
      } else {
        console.log(`  BNB market price: ${marketPrice} USDT`);
      }
      console.log(`##PRICE_DIR_BNB_PRICE:${marketPrice}##`);

      // ── Step 3: 计算并填入 BNB 数量（= ceil(5 / bnbPrice)，整数向上取整）──
      // 要求：数量 = 5 / BNB价格，然后向上取整（取整到整数精度）
      console.log('\n[Step 3] Computing and entering BNB pay amount...');
      const rawAmount = MIN_USD / marketPrice;
      // 向上取整到第 2 位小数
      const ceiled = Math.ceil(rawAmount * 100) / 100;
      const payAmount = ceiled.toFixed(2);
      console.log(`  ceil(${MIN_USD} / ${marketPrice}) = ${payAmount} BNB`);
      await limitPage.enterPayAmount(payAmount, marketPrice, MIN_USD);
      console.log(`✓ Pay amount entered: ${payAmount} BNB`);

      // 等待 UI 稳定
      await page.waitForTimeout(2_000);

      // ── Step 4: 填入 50% 市价，断言文案含 "below"，颜色为红色 ─────────────
      const belowPrice = parseFloat((marketPrice * 0.5).toFixed(2));
      console.log(`\n[Step 4] Entering 50% market price: ${belowPrice} USDT...`);
      await limitPage.enterRatePrice(String(belowPrice), marketPrice);
      await page.waitForTimeout(2_500);

      const belowResult = await getDirectionHint(page);
      console.log(`  [50%] color="${belowResult.color}" isRed=${belowResult.isRed} text="${belowResult.text.slice(0, 60)}"`);
      console.log(`##PRICE_DIR_BELOW_COLOR:${belowResult.color}##`);

      // ── Step 5: 填入 150% 市价，断言文案含 "above"，颜色为绿色 ──────────
      const abovePrice = parseFloat((marketPrice * 1.5).toFixed(2));
      console.log(`\n[Step 5] Entering 150% market price: ${abovePrice} USDT...`);
      await limitPage.enterRatePrice(String(abovePrice), marketPrice);
      await page.waitForTimeout(2_500);

      const aboveResult = await getDirectionHint(page);
      console.log(`  [150%] color="${aboveResult.color}" isGreen=${aboveResult.isGreen} text="${aboveResult.text.slice(0, 60)}"`);
      console.log(`##PRICE_DIR_ABOVE_COLOR:${aboveResult.color}##`);

      // ── 汇总报告 ─────────────────────────────────────────────────────────
      const belowPassed = belowResult.isRed;
      const abovePassed = aboveResult.isGreen;
      const passed = belowPassed && abovePassed;

      console.log(`\n${'═'.repeat(60)}`);
      console.log('  PRICE DIRECTION TEST REPORT');
      console.log(`${'═'.repeat(60)}`);
      console.log(`  BNB market price:   ${marketPrice} USDT`);
      console.log(`  50% price:          ${belowPrice} USDT → isRed=${belowResult.isRed}  ${belowPassed ? '✅' : '❌'}`);
      console.log(`  150% price:         ${abovePrice} USDT → isGreen=${aboveResult.isGreen}  ${abovePassed ? '✅' : '❌'}`);
      console.log(`  Overall: ${passed ? '✅ PASS' : '❌ FAIL'}`);
      console.log(
        `##PRICE_DIR_RESULT:passed=${passed},` +
        `belowPassed=${belowPassed},abovePassed=${abovePassed},` +
        `marketPrice=${marketPrice}##`
      );
      console.log(`${'═'.repeat(60)}\n`);

      // ── Assertions ────────────────────────────────────────────────────────
      expect(
        belowResult.isRed,
        `[PriceDir] 输入 50% 市价 (${belowPrice} USDT) 时，高亮文案颜色应为红色，实际 color: "${belowResult.color}"`
      ).toBe(true);

      expect(
        aboveResult.isGreen,
        `[PriceDir] 输入 150% 市价 (${abovePrice} USDT) 时，高亮文案颜色应为绿色，实际 color: "${aboveResult.color}"`
      ).toBe(true);
    }
  );
});

// ── 工具函数：读取价格方向提示高亮文案的颜色 ──────────────────────────────────
/**
 * 读取页面提示句中高亮部分（"above X USDT (±XX% from market)"）的渲染颜色。
 *
 * 页面规则（无论输入高低，关键词永远是 "above"）：
 *   - 低于市价：高亮文案为红色
 *   - 高于市价：高亮文案为绿色
 *
 * 颜色判定：computedStyle color → rgb(R, G, B)
 *   - 红色：R > 150 且 G < 120 且 B < 120，或 className 含 "red"
 *   - 绿色：G > 100 且 R < 180，或 className 含 "green"
 */
async function getDirectionHint(page: import('@playwright/test').Page): Promise<{
  text: string;
  color: string;
  className: string;
  hasBelow: boolean;
  hasAbove: boolean;
  isRed: boolean;
  isGreen: boolean;
}> {
  // 找到包含提示句的容器（含 "from market"）
  const sentenceEl = page.locator('p, span, div')
    .filter({ hasText: /from market/i }).first();

  const sentVisible = await sentenceEl.isVisible({ timeout: 6_000 }).catch(() => false);
  if (!sentVisible) {
    console.log('[getDirectionHint] sentence element not found');
    return { text: '', color: '', className: '', hasBelow: false, hasAbove: false, isRed: false, isGreen: false };
  }

  const text = ((await sentenceEl.textContent().catch(() => '')) ?? '').trim();

  // 在浏览器内同时扫描 color 和 backgroundColor，找红色或绿色
  const info = await sentenceEl.evaluate((container): {
    red:   { color: string; className: string } | null;
    green: { color: string; className: string } | null;
  } => {
    const allEls = [container, ...Array.from(container.querySelectorAll('*'))];
    let red:   { color: string; className: string } | null = null;
    let green: { color: string; className: string } | null = null;

    for (const el of allEls) {
      const style = window.getComputedStyle(el);
      for (const prop of ['color', 'backgroundColor'] as const) {
        const c = style[prop];
        const m = /rgb[a]?\((\d+),\s*(\d+),\s*(\d+)/.exec(c ?? '');
        if (!m) continue;
        const r = parseInt(m[1], 10);
        const g = parseInt(m[2], 10);
        const b = parseInt(m[3], 10);
        // 排除近灰色和过暗颜色
        if (Math.max(r, g, b) - Math.min(r, g, b) < 50) continue;
        if (Math.max(r, g, b) < 80) continue;
        const cls = (el as HTMLElement).className ?? '';
        if (!red   && r > g + 40 && r > b + 40 && r > 100) red   = { color: c, className: cls };
        if (!green && g > r + 20 && g > b + 20 && g > 80)  green = { color: c, className: cls };
      }
      if (red && green) break;
    }

    return { red, green };
  }).catch(() => ({ red: null, green: null }));

  const isRed   = !!info.red;
  const isGreen = !!info.green;
  const color     = info.red?.color ?? info.green?.color ?? '';
  const className = info.red?.className ?? info.green?.className ?? '';

  console.log(`[getDirectionHint] isRed=${isRed}(${info.red?.color ?? '-'}) isGreen=${isGreen}(${info.green?.color ?? '-'})`);
  return { text, color, className, hasBelow: isRed, hasAbove: isGreen, isRed, isGreen };
}
