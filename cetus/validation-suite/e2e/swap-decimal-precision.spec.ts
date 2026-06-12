import { env } from '@/config/env.js';
import { getBalanceSnapshot, getTransactionResult } from '@/chain/queries.js';
import { decimalPrecisionScenario } from '@/fixtures/scenarios.js';
import { SwapPage } from '@/page-objects/swap.page.js';
import { retry } from '@/utils/retry.js';

import { expect, test } from '../setup/fixtures.js';

test.describe('Swap Token Decimal Precision', () => {
  /**
   * P0: Swapping between tokens with different decimals (USDC 6 → SUI 9)
   * must produce the correct on-chain amount without truncation errors.
   */
  test('handles USDC (6 decimals) → SUI (9 decimals) correctly', async ({ page, walletController }) => {
    const { inputCoinType, outputCoinType, inputDecimal, outputDecimal, inputAmountUi } =
      decimalPrecisionScenario;

    const swapPage = new SwapPage(page);
    await swapPage.goto('/swap');
    await walletController.connect(page);

    await swapPage.selectFromToken(inputCoinType);
    await swapPage.selectToToken(outputCoinType);
    await swapPage.fillAmount(inputAmountUi);
    await page.waitForTimeout(2_000);

    // Read the UI quote for the expected output and slippage setting
    const expectedOutput = await swapPage.getExpectedOutputAmount(outputDecimal);
    const slippagePercent = await swapPage.getCurrentSlippagePercent();
    const slippageDecimal = parseFloat(slippagePercent) / 100;
    
    console.log(`[precision] Input: ${inputAmountUi} USDC (decimal=${inputDecimal})`);
    console.log(`[precision] Expected output (quote): ${expectedOutput} raw (decimal=${outputDecimal})`);
    console.log(`[precision] Slippage setting: ${slippagePercent}%`);

    // Snapshot pre-swap balances
    const beforeInput = await getBalanceSnapshot(env.testWalletAddress, inputCoinType);
    const beforeOutput = await getBalanceSnapshot(env.testWalletAddress, outputCoinType);

    // Execute the swap
    await swapPage.submitSwap();
    await walletController.approveTransaction(page);
    await swapPage.expectSuccess();

    const digest = await swapPage.readDigest();
    expect(digest).toBeTruthy();
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

  /**
   * P1: Verifies the UI correctly displays amounts for different decimal tokens
   * without showing truncated/incorrect values (UI-only, no transaction).
   */
  test('UI displays correct precision for cross-decimal token pair', async ({ page, walletController }) => {
    const { inputCoinType, outputCoinType, inputAmountUi, inputDecimal, outputDecimal } =
      decimalPrecisionScenario;

    const swapPage = new SwapPage(page);
    await swapPage.goto('/swap');
    await walletController.connect(page);

    await swapPage.selectFromToken(inputCoinType);
    await swapPage.selectToToken(outputCoinType);
    await swapPage.fillAmount(inputAmountUi);
    await page.waitForTimeout(2_000);

    // The output section should display a non-zero amount
    const outputAmount = await swapPage.getExpectedOutputAmount(outputDecimal);
    expect(outputAmount).toBeGreaterThan(BigInt(0));

    // Minimum Received should be visible and non-zero
    // 查找所有包含 SUI 的 p 标签，找到同时包含数字和 SUI 的那个（Minimum Received 的值）
    const allPWithSUI = await page.locator('p:has-text("SUI")').all();
    
    let minReceivedText = '';
    for (const p of allPWithSUI) {
      const pText = await p.innerText().catch(() => '');
      // 匹配类似 "1.20268238 SUI" 的格式（数字 + SUI）
      if (/[\d.]+\s*SUI/.test(pText)) {
        minReceivedText = pText;
        break;
      }
    }
    
    const minReceivedValue = minReceivedText.replace(/\s*SUI/i, '').trim();

    console.log(`[precision:ui] Input: ${inputAmountUi} USDC (decimal=${inputDecimal})`);
    console.log(`[precision:ui] Output quote: ${outputAmount} raw SUI (decimal=${outputDecimal})`);
    console.log(`[precision:ui] Minimum Received: ${minReceivedValue} SUI`);

    // Minimum Received 必须显示非零数字
    const minReceivedNumber = parseFloat(minReceivedValue);
    expect(minReceivedNumber).toBeGreaterThan(0);
    console.log(`[precision:ui] ✓ Minimum Received displayed correctly: ${minReceivedNumber} SUI`);
  });
});
