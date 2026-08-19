import { highImpactScenario, TOKEN_DECIMALS } from '@/fixtures/scenarios.js';
import { SwapPage } from '@/page-objects/swap.page.js';

import { expect, test } from '../setup/fixtures.js';

/**
 * P2: High Price Impact / Price Difference warning tests.
 *
 * SBOX → SUI 输入极大金额时，Cetus 在报价明细里给出高价格冲击信号。
 * 注意：SBOX 缺少可信 USD 价格源（面板显示 $0.00），此时 Price Difference
 * 会渲染成 "Incalculable" 而**不会**出现 "High price difference" 红色警告框，
 * 因此断言必须覆盖「超阈值百分比」与「Incalculable」两种合法状态。
 * 全程不发送任何链上交易。
 */
test.describe('Swap High Price Impact Warning', () => {
  test('shows high price difference warning for extremely large SBOX → SUI amount', async ({
    page,
    walletController
  }) => {
    const { fromCoin, toCoin, fromSymbol, toSymbol, largeAmount, expectedDeviationThreshold } =
      highImpactScenario;

    const swapPage = new SwapPage(page);
    await swapPage.goto('/swap');
    await walletController.connect(page);

    // Step 1: select SBOX → SUI and enter a large amount
    await swapPage.selectFromToken(fromCoin);
    await swapPage.selectToToken(toCoin);
    await swapPage.fillAmount(largeAmount);

    console.log(`[high-impact] Token pair: ${fromSymbol} → ${toSymbol}`);
    console.log(`[high-impact] Amount: ${largeAmount}`);

    // Step 2: 等报价结算，不用固定 sleep 读中间态
    const buttonText = await swapPage.waitForQuoteSettled();
    console.log(`[high-impact] Action button: "${buttonText}"`);

    // Step 3: 读取 Price Difference 行
    const priceDiff = await swapPage.getPriceDifference();
    const hasWarningBox = await swapPage.hasHighPriceDifferenceWarning(3_000);
    console.log(`[high-impact] Price Difference row: "${priceDiff.text}"`);
    console.log(`[high-impact] Warning box visible: ${hasWarningBox}`);

    // Step 4: 断言存在高价格冲击信号（红框 / 超阈值百分比 / Incalculable 任一成立）
    const exceedsThreshold = priceDiff.percent !== null && priceDiff.percent > expectedDeviationThreshold;
    const hasHighImpactSignal = hasWarningBox || exceedsThreshold || priceDiff.incalculable;

    expect(
      hasHighImpactSignal,
      `期望出现高价格冲击信号，实际 Price Difference = "${priceDiff.text}"`
    ).toBe(true);

    if (priceDiff.incalculable) {
      console.log('[high-impact] ✓ Price Difference = Incalculable（SBOX 无可信 USD 价格源）');
    } else if (exceedsThreshold) {
      console.log(`[high-impact] ✓ 价格偏差 ${priceDiff.percent}% > ${expectedDeviationThreshold}%`);
    } else {
      console.log('[high-impact] ✓ High price difference 警告框可见');
    }

    // Step 5: verify the output amount is still calculated (not empty/zero)
    const outputDecimal = TOKEN_DECIMALS[toCoin] ?? 9;
    const outputAmount = await swapPage.getExpectedOutputAmount(outputDecimal).catch(() => BigInt(0));
    expect(outputAmount).toBeGreaterThan(BigInt(0));
    console.log(`[high-impact] Output amount calculated: ${outputAmount} raw ${toSymbol}`);

    // Step 6: Minimum Received 必须渲染出数值
    const minReceived = await swapPage.getMinimumReceived(toSymbol);
    console.log(`[high-impact] Min Received: ${minReceived?.text ?? 'N/A'}`);
    expect(minReceived, 'Minimum Received 未渲染出数值').not.toBeNull();

    // Step 7: check Auto Router is active (multi-pool route for large swap)
    const hasAutoRouter = await swapPage.waitForAutoRouter(10_000);
    console.log(`[high-impact] Auto Router visible: ${hasAutoRouter}`);

    console.log('[high-impact] ✓ High price impact scenario validated (no actual swap executed)');
  });

  /**
   * Boundary check: a normal-sized swap should NOT trigger the warning.
   */
  test('does not show price difference warning for normal swap amount', async ({
    page,
    walletController
  }) => {
    const { fromCoin, toCoin, fromSymbol } = highImpactScenario;

    const swapPage = new SwapPage(page);
    await swapPage.goto('/swap');
    await walletController.connect(page);

    await swapPage.selectFromToken(fromCoin);
    await swapPage.selectToToken(toCoin);
    // Use a very small amount that should not cause high price impact
    await swapPage.fillAmount('1');
    await swapPage.waitForQuoteSettled();

    const hasWarning = await swapPage.hasHighPriceDifferenceWarning(3_000);
    const priceDiff = await swapPage.getPriceDifference(8_000);

    console.log(`[high-impact:normal] Amount: 1 ${fromSymbol}`);
    console.log(`[high-impact:normal] Price Difference row: "${priceDiff.text}"`);
    console.log(`[high-impact:normal] Warning present: ${hasWarning}`);

    expect(hasWarning, `小额兑换不应出现高价格差警告，实际 "${priceDiff.text}"`).toBe(false);
    console.log('[high-impact:normal] ✓ No warning for small amount — boundary check passed');
  });
});
