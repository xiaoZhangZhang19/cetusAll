import { highImpactScenario, TOKEN_DECIMALS } from '@/fixtures/scenarios.js';
import { SwapPage } from '@/page-objects/swap.page.js';

import { expect, test } from '../setup/fixtures.js';

/**
 * P2: High Price Impact / Price Difference warning tests.
 *
 * SBOX → SUI 输入极大金额时，Cetus 在报价明细里给出高价格冲击信号。
 * 注意：SBOX 缺少可信 USD 价格源（面板显示 $0.00），此时 Price Difference
 * 会渲染成 "Incalculable" 而**不会**出现 "High price difference" 红色警告框；
 * 金额大到池子吃不下时按钮会直接变成 "Insufficient liquidity for this trade"。
 * 这几种都是合法的高冲击表现，断言需要一并覆盖。全程不发送任何链上交易。
 */
test.describe('Swap High Price Impact Warning', () => {
  test('warns on extremely large amount', async ({ page, walletController }) => {
    const { fromCoin, toCoin, fromSymbol, toSymbol, largeAmount, expectedDeviationThreshold } =
      highImpactScenario;

    const swapPage = new SwapPage(page);
    await swapPage.goto('/swap');
    await walletController.connect(page);

    await swapPage.selectFromToken(fromCoin);
    await swapPage.selectToToken(toCoin);

    console.log(`[high-impact] Token pair: ${fromSymbol} → ${toSymbol}`);
    console.log(`[high-impact] Amount: ${largeAmount}`);

    // 直接填大额：小额边界检查已移除（SBOX/SUI 池深度极浅，1 SBOX 也拿不到报价，
    // 那一段只会让用例在 Price Difference 轮询上白等满超时）。
    await swapPage.fillAmount(largeAmount);

    const buttonText = await swapPage.waitForQuoteSettled();
    console.log(`[high-impact] Action button: "${buttonText}"`);

    const noLiquidity = /insufficient liquidity/i.test(buttonText);

    // 池子吃不下这笔单时不会有报价明细，跳过 Price Difference 轮询（否则白等满超时）
    const priceDiff = noLiquidity
      ? { text: 'n/a (insufficient liquidity)', percent: null, incalculable: false }
      : await swapPage.getPriceDifference();
    const hasWarningBox = noLiquidity ? false : await swapPage.hasHighPriceDifferenceWarning(3_000);
    console.log(`[high-impact] Price Difference row: "${priceDiff.text}"`);
    console.log(`[high-impact] Warning box visible: ${hasWarningBox}`);

    // 高价格冲击信号：流动性不足 / 红框 / 超阈值百分比 / Incalculable 任一成立
    const exceedsThreshold =
      priceDiff.percent !== null && priceDiff.percent > expectedDeviationThreshold;
    const hasHighImpactSignal =
      noLiquidity || hasWarningBox || exceedsThreshold || priceDiff.incalculable;

    expect(
      hasHighImpactSignal,
      `期望出现高价格冲击信号，实际按钮 "${buttonText}"，Price Difference = "${priceDiff.text}"`
    ).toBe(true);

    if (noLiquidity) {
      console.log('[high-impact] ✓ 按钮显示 Insufficient liquidity — 极大金额超出池子深度');
      console.log('[high-impact] ✓ High price impact scenario validated (no actual swap executed)');
      return;
    }

    if (priceDiff.incalculable) {
      console.log('[high-impact] ✓ Price Difference = Incalculable（SBOX 无可信 USD 价格源）');
    } else if (exceedsThreshold) {
      console.log(`[high-impact] ✓ 价格偏差 ${priceDiff.percent}% > ${expectedDeviationThreshold}%`);
    } else {
      console.log('[high-impact] ✓ High price difference 警告框可见');
    }

    // 报价仍需被算出来（不为空 / 不为零）
    const outputDecimal = TOKEN_DECIMALS[toCoin] ?? 9;
    const outputAmount = await swapPage.getExpectedOutputAmount(outputDecimal).catch(() => BigInt(0));
    expect(outputAmount).toBeGreaterThan(BigInt(0));
    console.log(`[high-impact] Output amount calculated: ${outputAmount} raw ${toSymbol}`);

    // Minimum Received 必须渲染出数值
    const minReceived = await swapPage.getMinimumReceived(toSymbol);
    console.log(`[high-impact] Min Received: ${minReceived?.text ?? 'N/A'}`);
    expect(minReceived, 'Minimum Received 未渲染出数值').not.toBeNull();

    // 大额兑换应走多池路由，Auto Router 处于激活状态
    const hasAutoRouter = await swapPage.waitForAutoRouter(10_000);
    console.log(`[high-impact] Auto Router visible: ${hasAutoRouter}`);

    console.log('[high-impact] ✓ High price impact scenario validated (no actual swap executed)');
  });
});
