import { allure } from 'allure-playwright';

import { env } from '@/config/env.js';
import { getBalanceSnapshot, getTransactionResult } from '@/chain/queries.js';
import { swapScenario, TOKEN_DECIMALS } from '@/fixtures/scenarios.js';
import { SwapPage } from '@/page-objects/swap.page.js';
import { retry } from '@/utils/retry.js';

import { expect, test } from '../setup/fixtures.js';

test.describe('Cetus Mainnet Swap', () => {
  test(`executes a successful ${swapScenario.fromTokenSymbol}-${swapScenario.toTokenSymbol} Cetus swap and validates on-chain balance movement`, async ({ page, walletController }) => {
    await allure.epic('Cetus DEX');
    await allure.feature('Swap');
    await allure.story('Execute token swap and verify on-chain balance');
    await allure.severity('critical');
    await allure.tag('swap', 'mainnet', 'P0', 'balance-check');
    await allure.description(`Executes a ${swapScenario.fromTokenSymbol}→${swapScenario.toTokenSymbol} swap, confirms the transaction on-chain, and validates the balance movement is within the slippage tolerance.`);

    // Allow up to 3 minutes: wallet approval + tx propagation + balance indexing lag.
    test.setTimeout(180_000);

    const fmt = (value: bigint) => value.toString();

    // ── Step 1: Capture wallet balances BEFORE the swap ───────────────────────
    const beforeInput = await getBalanceSnapshot(env.testWalletAddress, swapScenario.inputCoinType);
    const beforeOutput = await getBalanceSnapshot(env.testWalletAddress, swapScenario.outputCoinType);
    console.log(
      `[swap:e2e] before balance | input(${swapScenario.fromTokenSymbol}): ${fmt(beforeInput.totalBalance)} | output(${swapScenario.toTokenSymbol}): ${fmt(beforeOutput.totalBalance)}`
    );

    // ── Step 2: Execute the swap ──────────────────────────────────────────────
    const swapPage = new SwapPage(page);
    await swapPage.goto(swapScenario.path);

    await walletController.connect(page);
    await swapPage.selectFromToken(swapScenario.inputCoinType);
    await swapPage.selectToToken(swapScenario.outputCoinType);
    await swapPage.fillAmount(swapScenario.inputAmountUi);

    // ── Read UI expectations BEFORE submitting ────────────────────────────────
    const outputDecimal = TOKEN_DECIMALS[swapScenario.outputCoinType] ?? 9;
    const expectedOutputRaw = await swapPage.getExpectedOutputAmount(outputDecimal);
    const slippagePercent = await swapPage.getCurrentSlippagePercent();
    const slippageDecimal = parseFloat(slippagePercent) / 100; // e.g., "0.5" -> 0.005

    console.log(
      `[swap:e2e] UI expectations | output: ${expectedOutputRaw.toString()} (${(Number(expectedOutputRaw) / 10 ** outputDecimal).toFixed(outputDecimal)} ${swapScenario.toTokenSymbol}) | slippage: ${slippagePercent}%`
    );

    await swapPage.submitSwap();
    await walletController.approveTransaction(page);
    await swapPage.expectSuccess();

    // ── Step 3: Obtain the tx digest (click into SuiVision page if needed) ───
    const digest = await swapPage.readDigest();
    if (digest) {
      expect(digest.length).toBeGreaterThan(10);
      console.log(`[swap:e2e] tx digest: ${digest}`);
    } else {
      console.log('[swap:e2e] tx digest: <not found in UI — falling back to balance movement check>');
    }

    // ── Step 4: Confirm the tx reached on-chain success (if digest available) ─
    const digestCandidate = digest?.match(/[1-9A-HJ-NP-Za-km-z]{40,90}/)?.[0];
    let txConfirmedOnChain = false;
    let txResult: Awaited<ReturnType<typeof getTransactionResult>> | undefined;
    
    if (digestCandidate) {
      txResult = await retry(async () => {
        const result = await getTransactionResult(digestCandidate);
        if (!result.success) {
          console.log(`[swap:e2e] waiting tx on-chain | digest=${digestCandidate} status=${result.status}`);
          throw new Error(`Waiting for tx success on-chain. digest=${digestCandidate} status=${result.status}`);
        }
        return result;
      }, 24, 5_000);
      
      // ── Verify transaction status ─────────────────────────────────────────────
      expect(txResult.success, 'Transaction should succeed').toBe(true);
      expect(txResult.status, 'Transaction status should be "success"').toBe('success');
      
      txConfirmedOnChain = true;
      console.log(`[swap:e2e] tx status: ${txResult.status} ✓`);
      console.log(`[swap:e2e] tx gas used: ${txResult.gasUsed.toString()}`);
      
      // ── Log transaction events ────────────────────────────────────────────────
      console.log(`[swap:e2e] tx events (${txResult.events.length} total):`);
      for (const event of txResult.events) {
        console.log(`  - ${event.type}`);
        if (event.parsedJson) {
          console.log(`    ${JSON.stringify(event.parsedJson, null, 2).replace(/\n/g, '\n    ')}`);
        }
      }
      
      // ── Log swap-specific events ──────────────────────────────────────────────
      if (txResult.swapEvents.length > 0) {
        console.log(`[swap:e2e] swap events (${txResult.swapEvents.length} events):`);
        for (const swapEvent of txResult.swapEvents) {
          console.log(`  - ${swapEvent.type}`);
          if (swapEvent.pool) console.log(`    pool: ${swapEvent.pool}`);
          if (swapEvent.amountIn) console.log(`    amountIn: ${swapEvent.amountIn}`);
          if (swapEvent.amountOut) console.log(`    amountOut: ${swapEvent.amountOut}`);
          if (swapEvent.atob !== undefined) console.log(`    atob: ${swapEvent.atob}`);
        }
      } else {
        console.log(`[swap:e2e] swap events: none found (event type may not match "swap" pattern)`);
      }
      
      // ── Log balance changes ───────────────────────────────────────────────────
      if (txResult.balanceChanges.length > 0) {
        console.log(`[swap:e2e] balance changes (${txResult.balanceChanges.length} changes):`);
        for (const change of txResult.balanceChanges) {
          const coinSymbol = change.coinType.split('::').pop() ?? change.coinType;
          console.log(`  - ${coinSymbol}: ${change.amount} (owner: ${change.owner.slice(0, 10)}...)`);
        }
      }
    }

    // ── Step 5: Poll until BOTH balances reflect the swap ─────────────────────
    // Require: input(SUI) decreased  AND  output(USDC) increased.
    // If the tx is confirmed on-chain we accept either-side movement for the
    // first few attempts (indexer lag), then require both after tx is final.
    const { afterInput, afterOutput } = await retry(async () => {
      const nextInput = await getBalanceSnapshot(env.testWalletAddress, swapScenario.inputCoinType);
      const nextOutput = await getBalanceSnapshot(env.testWalletAddress, swapScenario.outputCoinType);

      const inputDecreased = nextInput.totalBalance < beforeInput.totalBalance;
      const outputIncreased = nextOutput.totalBalance > beforeOutput.totalBalance;

      console.log(
        `[swap:e2e] polling balance` +
          ` | input(${swapScenario.fromTokenSymbol}): ${fmt(nextInput.totalBalance)} (${inputDecreased ? 'decreased ✓' : 'not-decreased'})` +
          ` | output(${swapScenario.toTokenSymbol}): ${fmt(nextOutput.totalBalance)} (${outputIncreased ? 'increased ✓' : 'not-increased'})`
      );

      // When tx is confirmed on-chain, either side moving is sufficient to avoid
      // flakiness from indexer lag; we still require both in the final assertion.
      const movementSatisfied = txConfirmedOnChain
        ? inputDecreased || outputIncreased
        : outputIncreased;

      if (!movementSatisfied) {
        throw new Error('Waiting for mainnet balance to reflect the swap');
      }

      return { afterInput: nextInput, afterOutput: nextOutput };
    }, 24, 5_000);

    // ── Step 6: Assert and log final balance deltas ───────────────────────────
    const inputDecreased = afterInput.totalBalance < beforeInput.totalBalance;
    const outputIncreased = afterOutput.totalBalance > beforeOutput.totalBalance;
    const actualOutputReceived = afterOutput.totalBalance - beforeOutput.totalBalance;

    console.log(
      `[swap:e2e] after balance` +
        ` | input(${swapScenario.fromTokenSymbol}): ${fmt(afterInput.totalBalance)}` +
        ` | output(${swapScenario.toTokenSymbol}): ${fmt(afterOutput.totalBalance)}`
    );
    console.log(
      `[swap:e2e] delta` +
        ` | input change: ${fmt(afterInput.totalBalance - beforeInput.totalBalance)}` +
        ` | output change: +${fmt(actualOutputReceived)}`
    );

    // ── Step 7: Validate data reasonableness against UI expectations ──────────
    // The actual received output should be within the slippage tolerance of the expected amount.
    // Allow positive slippage (user getting more tokens) up to 1% above expected.
    const minAcceptableOutput = expectedOutputRaw - (expectedOutputRaw * BigInt(Math.floor(slippageDecimal * 10000))) / 10000n;
    const maxAcceptableOutput = expectedOutputRaw + (expectedOutputRaw * 100n) / 10000n; // Allow up to 1% positive slippage
    
    const outputInRange = actualOutputReceived >= minAcceptableOutput && actualOutputReceived <= maxAcceptableOutput;
    const deviationPercent = Number((actualOutputReceived - expectedOutputRaw) * 10000n / expectedOutputRaw) / 100;

    console.log(
      `[swap:e2e] reasonableness check` +
        ` | expected: ${fmt(expectedOutputRaw)}` +
        ` | actual: ${fmt(actualOutputReceived)}` +
        ` | deviation: ${deviationPercent.toFixed(2)}%` +
        ` ${deviationPercent > 0 ? '(positive slippage - user gains)' : '(negative slippage)'}` +
        ` | acceptable range: [${fmt(minAcceptableOutput)}, ${fmt(maxAcceptableOutput)}]` +
        ` | within range: ${outputInRange ? '✓' : '✗'}`
    );

    console.log(
      `[swap:e2e] result | inputDecreased=${inputDecreased} | outputIncreased=${outputIncreased} | outputReasonable=${outputInRange}`
    );

    expect(inputDecreased, `${swapScenario.fromTokenSymbol} balance should decrease after swap`).toBe(true);
    expect(outputIncreased, `${swapScenario.toTokenSymbol} balance should increase after swap`).toBe(true);
    expect(outputInRange, `Actual output ${fmt(actualOutputReceived)} should be within slippage (${slippagePercent}%) of expected ${fmt(expectedOutputRaw)}`).toBe(true);
  });
});
