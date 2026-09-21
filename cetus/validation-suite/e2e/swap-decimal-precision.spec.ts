import { env } from '@/config/env.js';
import { getBalanceSnapshot, getLatestTransactionDigest, getTransactionResult } from '@/chain/queries.js';
import { decimalPrecisionScenario } from '@/fixtures/scenarios.js';
import { SwapPage } from '@/page-objects/swap.page.js';
import { retry } from '@/utils/retry.js';

import { expect, test } from '../setup/fixtures.js';

test.describe('Swap Token Decimal Precision', () => {
  /**
   * 跨精度代币（USDC 6 位 → SUI 9 位）的 UI 显示校验与链上执行校验
   * 合并在同一个页面会话内完成。
   *
   * 合并原因：两段校验用的是同一个币对、同一个金额，拆成两个 test 会各自
   * goto + connect + 选币 + 等报价一次，白付一整轮页面加载与报价等待。
   * UI 校验只读不写，放在上链之前执行不会污染后续状态。
   *
   * Phase 1 (P1)：UI 必须正确显示跨精度报价与 Minimum Received，无截断。
   * Phase 2 (P0)：实际成交后链上金额必须与精度换算一致，无截断误差。
   */
  test('displays and executes cross-decimal swap with correct precision', async ({
    page,
    walletController,
  }) => {
    const { inputCoinType, outputCoinType, inputDecimal, outputDecimal, inputAmountUi } =
      decimalPrecisionScenario;

    const swapPage = new SwapPage(page);
    await swapPage.goto('/swap');
    await walletController.connect(page);

    await swapPage.selectFromToken(inputCoinType);
    await swapPage.selectToToken(outputCoinType);
    await swapPage.fillAmount(inputAmountUi);
    await page.waitForTimeout(2_000);

    // ── Phase 1: UI 精度显示校验（只读，不上链）──────────────────────────────
    const uiQuoteOutput = await swapPage.getExpectedOutputAmount(outputDecimal);
    expect(uiQuoteOutput).toBeGreaterThan(BigInt(0));

    // Minimum Received 在报价（重）加载期间被包在 skeleton 里，读一次会拿到空值，
    // getMinimumReceived 内部轮询到数值出现为止。
    const minReceived = await swapPage.getMinimumReceived('SUI');

    console.log(`[precision:ui] Input: ${inputAmountUi} USDC (decimal=${inputDecimal})`);
    console.log(`[precision:ui] Output quote: ${uiQuoteOutput} raw SUI (decimal=${outputDecimal})`);
    console.log(`[precision:ui] Minimum Received: ${minReceived?.text ?? '<not rendered>'}`);

    expect(minReceived, 'Minimum Received should render a numeric SUI amount').not.toBeNull();
    expect(minReceived!.value).toBeGreaterThan(0);

    // Minimum Received 已扣掉滑点，必须小于等于报价；报价会周期性刷新，
    // 两次读取之间留 2% 余量。
    const quotedUi = Number(uiQuoteOutput) / 10 ** outputDecimal;
    console.log(
      `[precision:ui] Quote: ${quotedUi} SUI | Minimum Received: ${minReceived!.value} SUI`
    );
    expect(minReceived!.value).toBeLessThanOrEqual(quotedUi * 1.02);
    console.log(`[precision:ui] ✓ Minimum Received displayed correctly: ${minReceived!.value} SUI`);

    // ── Phase 2: 链上执行校验 ─────────────────────────────────────────────────
    // 报价会周期性刷新，Phase 1 读到的值此刻可能已过期，提交前重新读一次
    // 作为偏差比对的基准。
    const expectedOutput = await swapPage.getExpectedOutputAmount(outputDecimal);
    const slippagePercent = await swapPage.getCurrentSlippagePercent();

    console.log(`[precision] Input: ${inputAmountUi} USDC (decimal=${inputDecimal})`);
    console.log(`[precision] Expected output (quote): ${expectedOutput} raw (decimal=${outputDecimal})`);
    console.log(`[precision] Slippage setting: ${slippagePercent}%`);

    // Snapshot pre-swap balances
    const beforeInput = await getBalanceSnapshot(env.testWalletAddress, inputCoinType);
    const beforeOutput = await getBalanceSnapshot(env.testWalletAddress, outputCoinType);

    // 记录 swap 前的最新 digest，供 UI 读不到 digest 时做链上兜底比对
    const digestBefore = await getLatestTransactionDigest(env.testWalletAddress).catch(() => undefined);

    await swapPage.submitSwap();
    await walletController.approveTransaction(page);
    await swapPage.expectSuccess();

    // Cetus 的成功弹窗把 explorer 做成纯 <button>（走 window.open），
    // 既没有 href 也不把 digest 渲染进文案，UI 读不到时回链上取本次新交易。
    let digest = await swapPage.readDigest();
    if (!digest) {
      digest = await retry(
        async () => {
          const latest = await getLatestTransactionDigest(env.testWalletAddress, digestBefore);
          if (!latest) throw new Error('Waiting for the new tx to appear on-chain');
          return latest;
        },
        12,
        5_000
      ).catch(() => undefined);
      console.log(`[precision] digest resolved from chain: ${digest}`);
    }

    expect(digest, 'Swap digest should be readable from the UI or on-chain').toBeTruthy();
    console.log(`[precision] tx reference: ${digest}`);

    const digestCandidate = digest?.match(/[1-9A-HJ-NP-Za-km-z]{40,90}/)?.[0];
    if (digestCandidate) {
      const txResult = await retry(async () => {
        const result = await getTransactionResult(digestCandidate);
        if (!result.success) {
          throw new Error(`Waiting for tx success. status=${result.status}`);
        }
        return result;
      }, 24, 5_000);
      expect(txResult.success).toBe(true);
      console.log(`[precision] tx confirmed on-chain | gas=${txResult.gasUsed}`);
    }

    // Poll until both balances reflect the swap
    const { afterInput, afterOutput } = await retry(async () => {
      const ni = await getBalanceSnapshot(env.testWalletAddress, inputCoinType);
      const no = await getBalanceSnapshot(env.testWalletAddress, outputCoinType);
      if (no.totalBalance <= beforeOutput.totalBalance) {
        throw new Error('Waiting for output balance to increase');
      }
      return { afterInput: ni, afterOutput: no };
    }, 24, 5_000);

    // Verify input consumed with correct decimal precision
    const actualInputDelta = beforeInput.totalBalance - afterInput.totalBalance;
    const expectedInputRaw = BigInt(
      Math.floor(parseFloat(inputAmountUi) * 10 ** inputDecimal)
    );

    console.log(`[precision] Input consumed: ${actualInputDelta} raw (expected ${expectedInputRaw})`);
    // Allow ±1 unit of the last decimal place for rounding
    expect(actualInputDelta - expectedInputRaw).toBeGreaterThanOrEqual(BigInt(-1));
    expect(actualInputDelta - expectedInputRaw).toBeLessThanOrEqual(BigInt(1));

    // Verify output amount is reasonable (not strict price check)
    // The key goal: ensure no decimal truncation errors, not strict price validation
    const actualOutput = afterOutput.totalBalance - beforeOutput.totalBalance;

    // For mainnet, allow wider tolerance (±5%) due to:
    // - Price volatility between quote and execution
    // - Liquidity depth variations
    // - Network latency
    const maxDeviationPercent = 5.0; // 5% tolerance for mainnet
    const minAcceptableOutput = expectedOutput - (expectedOutput * BigInt(Math.floor(maxDeviationPercent * 100))) / 10000n;
    const maxAcceptableOutput = expectedOutput + (expectedOutput * BigInt(Math.floor(maxDeviationPercent * 100))) / 10000n;

    const outputInRange = actualOutput >= minAcceptableOutput && actualOutput <= maxAcceptableOutput;
    const deviationPercent = Number((actualOutput - expectedOutput) * 10000n / expectedOutput) / 100;

    console.log(`[precision] Actual output: ${actualOutput}`);
    console.log(`[precision] Deviation from quote: ${deviationPercent.toFixed(4)}% ${deviationPercent > 0 ? '(positive slippage - user gains)' : '(negative slippage)'}`);
    console.log(`[precision] Acceptable range: [${minAcceptableOutput}, ${maxAcceptableOutput}] (±${maxDeviationPercent}% tolerance)`);
    console.log(`[precision] Output within range: ${outputInRange ? '✓' : '✗'}`);

    expect(outputInRange, `Actual output ${actualOutput} should be within ±${maxDeviationPercent}% of expected ${expectedOutput} for mainnet volatility`).toBe(true);
    console.log('[precision] ✓ Decimal precision correct: no truncation errors detected');
    console.log(
      `[precision] Summary | inputDelta=${actualInputDelta} outputDelta=${actualOutput} deviation=${deviationPercent.toFixed(4)}%`
    );
  });
});
