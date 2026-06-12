/**
 * Test: Peach Limit Order – Price Guard (不合理价格限制)
 *
 * 验证当用户在 "Sell BNB at rate" 输入框中填入远低于市场价格的值时，
 * 页面会阻止下单并展示正确的提示文字。
 *
 * 测试场景（对应需求表格第一行）：
 *   - 类别：不合理价格限制
 *   - 描述：卖出价低于市场价过多
 *   - 是否存在：是
 *   - 阈值限制：提示文案、禁止下单
 *   - 触发方式：输入超阈值价格 → 观察按钮状态
 *   - 预期结果：不允许下单，提示正确
 *
 * 流程：
 *   Step 1: 导航至 /limit 并连接 MetaMask 钱包
 *   Step 2: 读取当前 BNB 市场价格（来自页面 "Market: X USDT per BNB"）
 *   Step 3: 计算触发阈值价格 = 市场价 × 94.9%（低于市场价 5.1%，超过合理区间）
 *   Step 4: 先将超阈值价格填入 "Sell BNB at rate" 红框输入框
 *   Step 5: 再输入大于 $5 USD 等值的 BNB 金额到 "You Pay"（确保价格保护优先触发）
 *   Step 6: 断言提交按钮处于置灰（disabled）状态
 *   Step 7: 断言按钮文字为 "Adjust price to continue"
 *
 * 环境变量（.env）：
 *   LIMIT_PAY_AMOUNT    – 覆盖自动计算的 BNB 数量（可选）
 *   LIMIT_MIN_USD       – 最低 USD 阈值（默认 5）
 *   LIMIT_PRICE_RATIO   – 市场价乘以的比例（默认 0.949，即 94.9%）
 *
 * 运行命令：
 *   npx playwright test tests/e2e/limit-price-guard.spec.ts
 */

import { LimitPage } from '../../src/page-objects/limit.page.js';
import { test, expect } from '../setup/fixtures.js';

// ── 环境变量 ─────────────────────────────────────────────────────────────────
const ENV_PAY_AMOUNT  = process.env.LIMIT_PAY_AMOUNT?.trim() ?? '';
const MIN_USD         = parseFloat(process.env.LIMIT_MIN_USD ?? '5');
// 市场价乘以的比例，默认 94.9%（低于市场 5.1%，足以触发价格保护）
const PRICE_RATIO     = parseFloat(process.env.LIMIT_PRICE_RATIO ?? '0.949');

// ── 测试 ─────────────────────────────────────────────────────────────────────

test.describe('Peach Limit – Price Guard – 不合理价格限制', () => {
  test(
    '输入市场价 × 94.9% 时按钮置灰且提示 "Adjust price to continue"',
    async ({ page, metamask }) => {
      test.setTimeout(120_000); // 2 minutes — no on-chain tx needed

      console.log('═══════════════════════════════════════════════════════════════');
      console.log('  Peach Protocol – Limit Price Guard Test');
      console.log(`  Sell BNB at ${(PRICE_RATIO * 100).toFixed(1)}% of market price`);
      console.log('  Expected: button disabled + "Adjust price to continue"');
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

      // ── Step 2: 读取 BNB 市价 ────────────────────────────────────────────
      console.log('\n[Step 2] Reading BNB market price...');
      await page.waitForTimeout(2_000);
      const bnbPrice = await limitPage.getBnbMarketPrice();

      if (!bnbPrice || bnbPrice <= 0) {
        console.log('⚠ Could not read BNB market price from page, using fallback 600');
      }

      const marketPrice   = bnbPrice ?? 600;
      console.log(`  BNB market price: ${marketPrice} USDT`);
      console.log(`##PRICE_GUARD_BNB_PRICE:${marketPrice}##`);

      // ── Step 3: 计算超阈值价格 ──────────────────────────────────────────
      // 市场价 × 94.9% → 触发"不合理低价"保护（超出 -5% 阈值）
      const belowThresholdPrice = parseFloat((marketPrice * PRICE_RATIO).toFixed(6));
      console.log(
        `\n[Step 3] Calculated below-threshold price: ` +
        `${marketPrice} × ${PRICE_RATIO} = ${belowThresholdPrice} USDT`
      );
      console.log(`  (${((1 - PRICE_RATIO) * 100).toFixed(1)}% below market — expected to trigger guard)`);
      console.log(`##PRICE_GUARD_TRIGGER_PRICE:${belowThresholdPrice}##`);

      // ── Step 4: 先填 You Pay（触发 rate 输入框出现并自动计算默认值） ────
      console.log('\n[Step 4] Entering BNB pay amount first (makes rate input active)...');

      let payAmount: string;
      if (ENV_PAY_AMOUNT && !isNaN(parseFloat(ENV_PAY_AMOUNT))) {
        payAmount = ENV_PAY_AMOUNT;
        console.log(`  Using env LIMIT_PAY_AMOUNT: ${payAmount} BNB`);
      } else {
        const walletBalanceBnb = await limitPage.getWalletBnbBalance();
        console.log(`  Wallet BNB balance from page: ${walletBalanceBnb ?? 'unknown'}`);
        const minBnb = limitPage.computeMinBnbAmount(marketPrice, MIN_USD, 1.1);
        if (walletBalanceBnb !== null && walletBalanceBnb > 0) {
          const maxUsable = walletBalanceBnb * 0.9;
          const minNeeded = parseFloat(minBnb);
          if (maxUsable < minNeeded) {
            throw new Error(
              `[PriceGuard] Wallet balance (${walletBalanceBnb} BNB) is too low ` +
              `to cover minimum test amount (${minBnb} BNB ≈ $${MIN_USD}). ` +
              `Please fund the test wallet.`
            );
          }
          payAmount = minBnb;
          console.log(`  Using computed min: ${payAmount} BNB (wallet has ${walletBalanceBnb} BNB)`);
        } else {
          payAmount = minBnb;
          console.log(`  Computed minimum amount: ${payAmount} BNB`);
        }
      }

      const usdValue = parseFloat(payAmount) * marketPrice;
      if (usdValue < MIN_USD) {
        throw new Error(
          `[PriceGuard] Pay amount ${payAmount} BNB (≈$${usdValue.toFixed(2)}) ` +
          `is below minimum $${MIN_USD} USD`
        );
      }

      await limitPage.enterPayAmount(payAmount, marketPrice, MIN_USD);
      console.log(`✓ Pay amount entered: ${payAmount} BNB (≈$${usdValue.toFixed(2)})`);

      // 等待页面自动计算 rate 的默认值（+0%）
      await page.waitForTimeout(2_000);

      // ── Step 5: 覆盖写入超阈值价格到 "Sell BNB at rate" 输入框 ──────────
      console.log(`\n[Step 5] Overwriting rate with below-threshold price: ${belowThresholdPrice} USDT...`);
      await limitPage.enterRatePrice(String(belowThresholdPrice), marketPrice);
      console.log(`✓ Rate price entered: ${belowThresholdPrice} USDT`);

      // 等待 UI 响应（重新计算并更新按钮状态）
      await page.waitForTimeout(2_000);

      // ── Step 6 & 7: 断言按钮置灰且文字正确 ─────────────────────────────
      console.log('\n[Step 6+7] Verifying button state...');
      const btnState = await limitPage.getActionButtonState();

      console.log(`  Button text:     "${btnState.text}"`);
      console.log(`  Button disabled: ${btnState.disabled}`);

      const textMatches = /Adjust price to continue/i.test(btnState.text);
      const isDisabled  = btnState.disabled;

      // ── 汇总报告 ──────────────────────────────────────────────────────────
      console.log(`\n${'═'.repeat(60)}`);
      console.log('  PRICE GUARD TEST REPORT');
      console.log(`${'═'.repeat(60)}`);
      console.log(`  Pay amount:       ${payAmount} BNB (≈$${usdValue.toFixed(2)})`);
      console.log(`  Market price:     ${marketPrice} USDT`);
      console.log(`  Trigger price:    ${belowThresholdPrice} USDT (${(PRICE_RATIO * 100).toFixed(1)}%)`);
      console.log(`  Button text:      "${btnState.text}"`);
      console.log(`  Button disabled:  ${isDisabled}`);
      console.log(`  Text matches:     ${textMatches ? '✅' : '❌'}`);
      console.log(`  Is disabled:      ${isDisabled  ? '✅' : '❌'}`);
      console.log(`${'─'.repeat(60)}`);

      const passed = textMatches && isDisabled;
      if (passed) {
        console.log('  ✅ PASS – Price guard triggered correctly');
      } else {
        console.log('  ❌ FAIL – Price guard did NOT behave as expected');
        if (!isDisabled)    console.log('    → Button should be disabled but is not');
        if (!textMatches)   console.log(`    → Button text should be "Adjust price to continue" but got "${btnState.text}"`);
      }

      console.log(
        `##PRICE_GUARD_RESULT:passed=${passed},` +
        `textMatches=${textMatches},` +
        `isDisabled=${isDisabled},` +
        `triggerPrice=${belowThresholdPrice},` +
        `marketPrice=${marketPrice}##`
      );
      console.log(`${'═'.repeat(60)}\n`);

      // ── Assertions ────────────────────────────────────────────────────────
      expect(
        isDisabled,
        `[PriceGuard] Submit button should be disabled when rate price is ` +
        `${belowThresholdPrice} USDT (${(PRICE_RATIO * 100).toFixed(1)}% of market ${marketPrice} USDT)`
      ).toBe(true);

      expect(
        textMatches,
        `[PriceGuard] Button text should be "Adjust price to continue" ` +
        `but got "${btnState.text}"`
      ).toBe(true);
    }
  );
});
