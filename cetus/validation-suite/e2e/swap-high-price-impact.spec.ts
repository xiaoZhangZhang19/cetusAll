import { highImpactScenario, TOKEN_DECIMALS } from '@/fixtures/scenarios.js';
import { SwapPage } from '@/page-objects/swap.page.js';

import { expect, test } from '../setup/fixtures.js';

/** 边界检查用的小额金额（不应触发高价格冲击信号）。 */
const NORMAL_AMOUNT = '1';

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
  /**
   * 小额边界检查与大额高冲击检查合并在同一个页面会话内完成。
   *
   * 合并原因：两者币对相同、都只读 UI 报价、不上链，拆成两个 test 会各自
   * goto + connect + 选币一次，白付一整轮页面加载与钱包连接。
   *
   * 执行顺序是「小额 → 大额」而不是反过来：大额阶段会留下高价格差警告框，
   * 若小额在后，残留的警告会让「小额不应有警告」这条断言假失败。
   * 小额在前时页面从未出现过警告，"无警告"的判定是干净的。
   */
  test('warns on extremely large amount but not on normal amount', async ({
    page,
    walletController
  }) => {
    const { fromCoin, toCoin, fromSymbol, toSymbol, largeAmount, expectedDeviationThreshold } =
      highImpactScenario;

    const swapPage = new SwapPage(page);
    await swapPage.goto('/swap');
    await walletController.connect(page);

    await swapPage.selectFromToken(fromCoin);
    await swapPage.selectToToken(toCoin);

    console.log(`[high-impact] Token pair: ${fromSymbol} → ${toSymbol}`);

    // ── Phase 1: 小额边界检查（不应出现高价格差警告）──────────────────────────
    await swapPage.fillAmount(NORMAL_AMOUNT);
    await swapPage.waitForQuoteSettled();

    const normalHasWarning = await swapPage.hasHighPriceDifferenceWarning(3_000);
    const normalPriceDiff = await swapPage.getPriceDifference(8_000);

    console.log(`[high-impact:normal] Amount: ${NORMAL_AMOUNT} ${fromSymbol}`);
    console.log(`[high-impact:normal] Price Difference row: "${normalPriceDiff.text}"`);
    console.log(`[high-impact:normal] Warning present: ${normalHasWarning}`);

    expect(
      normalHasWarning,
      `小额兑换不应出现高价格差警告，实际 "${normalPriceDiff.text}"`
    ).toBe(false);
    console.log('[high-impact:normal] ✓ No warning for small amount — boundary check passed');

    // ── Phase 2: 极大金额应出现高价格冲击信号 ─────────────────────────────────
    console.log(`[high-impact] Amount: ${largeAmount}`);

    // 不能用 fillAmount + waitForQuoteSettled：同一页面内改金额时，
    // receive 字段和主按钮在重新报价期间仍保留 Phase 1 的旧状态，
    // waitForQuoteSettled 第一次轮询就会拿小额的结果返回。
    // fillAmountAndWaitForFreshQuote 会先清空输入再等新值落地。
    await swapPage.fillAmountAndWaitForFreshQuote(largeAmount);

    const buttonText = await swapPage.waitForQuoteSettled();
    console.log(`[high-impact] Action button: "${buttonText}"`);

    const priceDiff = await swapPage.getPriceDifference();
    const hasWarningBox = await swapPage.hasHighPriceDifferenceWarning(3_000);
    console.log(`[high-impact] Price Difference row: "${priceDiff.text}"`);
    console.log(`[high-impact] Warning box visible: ${hasWarningBox}`);

    // 高价格冲击信号：红框 / 超阈值百分比 / Incalculable 任一成立
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
