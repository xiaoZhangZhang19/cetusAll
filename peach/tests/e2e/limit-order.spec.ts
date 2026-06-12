/**
 * Test: Peach Limit Order – P0 – Place Order
 *
 * 验证在 Peach Swap Limit 页面成功挂限价单的完整流程：
 *
 *   Step 1: 导航至 /limit 并连接 MetaMask 钱包
 *   Step 2: 读取 BNB 当前市价，计算最小输入金额（≥ $5 USD）
 *   Step 3: 在 "You Pay" 输入框填入 BNB 数量
 *             - 若乘以当前 BNB 价格 < $5 USD，则拒绝输入（测试失败）
 *   Step 4: 点击 "+5%" 按钮设置溢价率
 *   Step 5: 点击 "Place Limit Order" 打开 Review 弹窗
 *   Step 6: 在 Review 弹窗中点击 "Wrap BNB & Place Limit Order"
 *   Step 7: 在 MetaMask 中依次确认最多 3 次弹窗
 *             (Wrap BNB → Enable WBNB → Place Limit Order)
 *   Step 8: 点击 Orders 面板图标，验证 Open Orders 中出现新挂单
 *   Step 9: 验证该挂单属于本次操作（BNB/WBNB → USDT）
 *
 * 环境变量（.env）：
 *   LIMIT_PAY_AMOUNT  – 覆盖自动计算的 BNB 数量（可选）
 *   LIMIT_MIN_USD     – 最低 USD 阈值（默认 5）
 *
 * 运行命令：
 *   npx playwright test tests/e2e/limit-order.spec.ts
 */

import { LimitPage } from '../../src/page-objects/limit.page.js';
import { test, expect } from '../setup/fixtures.js';

// ── 环境变量 ─────────────────────────────────────────────────────────────────
const ENV_PAY_AMOUNT = process.env.LIMIT_PAY_AMOUNT?.trim() ?? '';
const MIN_USD        = parseFloat(process.env.LIMIT_MIN_USD ?? '5');

// ── 代币地址 ─────────────────────────────────────────────────────────────────
// BNB (native) → USDT (BSC)
const PAY_TOKEN_SYMBOL     = 'BNB';
const RECEIVE_TOKEN_SYMBOL = 'USDT';

// ── 测试 ─────────────────────────────────────────────────────────────────────

test.describe('Peach Limit – P0 – Place Limit Order', () => {
  test('places a +5% limit order and verifies it appears in Open Orders', async ({
    page,
    metamask,
  }) => {
    test.setTimeout(360_000); // 6 minutes — wrapping + 3 MetaMask confirmations

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  Peach Protocol – Limit Order P0 Test');
    console.log('  Sell BNB at +5% above market price → verify Open Orders');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`Min USD threshold: $${MIN_USD}`);

    const limitPage = new LimitPage(page);

    // ── Step 1: 导航并连接钱包 ────────────────────────────────────────────
    console.log('\n[Step 1] Navigating to Limit page and connecting wallet...');
    await limitPage.goto();
    await metamask.connect(page);
    await expect(page.locator('text=/0x[a-fA-F0-9]{3,}/i').first()).toBeVisible({ timeout: 10_000 });
    console.log('✓ Wallet connected');

    // ── Step 2: 读取 BNB 市价 ────────────────────────────────────────────
    console.log('\n[Step 2] Reading BNB market price...');
    // Wait a moment for the rate panel to load after wallet connection
    await page.waitForTimeout(2_000);
    const bnbPrice = await limitPage.getBnbMarketPrice();

    if (!bnbPrice || bnbPrice <= 0) {
      console.log('⚠ Could not read BNB market price, using fallback price 600');
    }

    const effectivePrice = bnbPrice ?? 600;
    console.log(`  BNB price: ${effectivePrice} USDT`);
    console.log(`##LIMIT_BNB_PRICE:${effectivePrice}##`);

    // ── Step 3: 计算/确认 pay 金额 ────────────────────────────────────────
    console.log('\n[Step 3] Determining pay amount...');

    let payAmount: string;
    if (ENV_PAY_AMOUNT && !isNaN(parseFloat(ENV_PAY_AMOUNT))) {
      payAmount = ENV_PAY_AMOUNT;
      console.log(`  Using env LIMIT_PAY_AMOUNT: ${payAmount} BNB`);
    } else {
      payAmount = limitPage.computeMinBnbAmount(effectivePrice, MIN_USD, 1.1);
      console.log(`  Computed minimum amount: ${payAmount} BNB (≈$${(parseFloat(payAmount) * effectivePrice).toFixed(2)})`);
    }

    // Validate: amount × price must be ≥ MIN_USD
    const usdValue = parseFloat(payAmount) * effectivePrice;
    console.log(`  USD value: $${usdValue.toFixed(2)} (min required: $${MIN_USD})`);

    if (usdValue < MIN_USD) {
      const errMsg = `Pay amount ${payAmount} BNB (≈$${usdValue.toFixed(2)}) is below minimum $${MIN_USD} USD`;
      console.log(`##LIMIT_RESULT:passed=false,error=${errMsg}##`);
      throw new Error(`[Limit P0] ${errMsg}`);
    }

    // ── Step 4: 填入金额 ──────────────────────────────────────────────────
    console.log(`\n[Step 4] Entering pay amount: ${payAmount} BNB...`);
    await limitPage.enterPayAmount(payAmount, effectivePrice, MIN_USD);
    console.log('✓ Pay amount entered');

    // ── Step 5: 选择 +5% 溢价率 ───────────────────────────────────────────
    console.log('\n[Step 5] Selecting +5% rate premium...');
    await limitPage.selectPlusFivePercent();
    console.log('✓ +5% rate selected');

    // Small wait for recalculation
    await page.waitForTimeout(1_500);

    // ── Step 6 & 7: 下单 + MetaMask 确认 ─────────────────────────────────
    console.log('\n[Step 6+7] Placing order and approving MetaMask...');
    try {
      await limitPage.placeOrder(metamask);
      console.log('✓ Order placement flow completed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`##LIMIT_RESULT:passed=false,error=Order placement failed: ${msg}##`);
      throw err;
    }

    // ── Step 8: 打开 Orders 面板 ──────────────────────────────────────────
    console.log('\n[Step 8] Opening Orders panel...');
    await limitPage.openOrdersPanel();
    console.log('✓ Orders panel opened (or already visible)');

    // ── Step 9: 验证 Open Orders 中存在新挂单 ─────────────────────────────
    console.log('\n[Step 9] Verifying open order exists...');
    const orderFound = await limitPage.waitForOpenOrder(
      { sellToken: PAY_TOKEN_SYMBOL, buyToken: RECEIVE_TOKEN_SYMBOL },
      60_000
    );

    // ── 汇总报告 ──────────────────────────────────────────────────────────
    console.log(`\n${'═'.repeat(60)}`);
    console.log('  LIMIT ORDER P0 TEST REPORT');
    console.log(`${'═'.repeat(60)}`);
    console.log(`  Pay amount:  ${payAmount} BNB`);
    console.log(`  BNB price:   ${effectivePrice} USDT`);
    console.log(`  USD value:   $${usdValue.toFixed(2)}`);
    console.log(`  Rate:        +5%`);
    console.log(`  Order found: ${orderFound ? '✅ YES' : '❌ NO'}`);
    console.log(`${'─'.repeat(60)}`);

    if (orderFound) {
      console.log('  ✅ PASS – Open order confirmed in Open Orders panel');
    } else {
      console.log('  ❌ FAIL – Open order NOT found in Open Orders panel');
    }

    // Structured log marker for dashboard parsing
    console.log(
      `##LIMIT_RESULT:passed=${orderFound},payAmount=${payAmount},usdValue=${usdValue.toFixed(2)},bnbPrice=${effectivePrice}##`
    );
    console.log(`${'═'.repeat(60)}\n`);

    // ── Assertion ────────────────────────────────────────────────────────
    expect(
      orderFound,
      `[Limit P0] Expected a BNB→USDT open order to appear in the Open Orders panel after placing a +5% limit order, but none was found.`
    ).toBe(true);
  });
});
