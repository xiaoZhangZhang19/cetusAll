import { env } from '@/config/env.js';
import { getBalanceSnapshot, getTransactionResult } from '@/chain/queries.js';
import { mergeSwapScenario } from '@/fixtures/scenarios.js';
import { MergeSwapPage } from '@/page-objects/merge-swap.page.js';
import { retry } from '@/utils/retry.js';

import { expect, test } from '../setup/fixtures.js';

test.describe('Cetus Mainnet Merge Swap', () => {
  /**
   * P0: SUI + USDC → CETUS via the Merge Swap page.
   *
   * Steps:
   *   1. Capture on-chain balances for SUI, USDC and CETUS before the swap.
   *   2. Navigate to /merge-swap and connect wallet.
   *   3. Select input token 1 = SUI (0.1), input token 2 = USDC (0.1).
   *   4. Select output token = CETUS.
   *   5. Read UI quote and current slippage.
   *   6. Submit swap → approve in wallet.
   *   7. Confirm the transaction is on-chain and successful.
   *   8. Poll until all three balances reflect the swap.
   *   9. Assert SUI decreased, USDC decreased, CETUS increased, output within slippage.
   */
  test(
    'executes a successful SUI+USDC→CETUS merge swap and validates on-chain balance movement',
    async ({ page, walletController }) => {
      // Allow up to 3 minutes: wallet approval + tx propagation + balance indexing lag.
      test.setTimeout(180_000);

      const fmt = (value: bigint) => value.toString();

      // ── Step 1: Capture wallet balances BEFORE the swap ─────────────────────
      const beforeInput1 = await getBalanceSnapshot(
        env.testWalletAddress,
        mergeSwapScenario.inputCoinType1
      );
      const beforeInput2 = await getBalanceSnapshot(
        env.testWalletAddress,
        mergeSwapScenario.inputCoinType2
      );
      const beforeOutput = await getBalanceSnapshot(
        env.testWalletAddress,
        mergeSwapScenario.outputCoinType
      );
      console.log(
        `[merge-swap:e2e] before balance` +
          ` | ${mergeSwapScenario.inputSymbol1}: ${fmt(beforeInput1.totalBalance)}` +
          ` | ${mergeSwapScenario.inputSymbol2}: ${fmt(beforeInput2.totalBalance)}` +
          ` | ${mergeSwapScenario.outputSymbol}: ${fmt(beforeOutput.totalBalance)}`
      );

      // ── Step 2: Navigate and connect wallet ─────────────────────────────────
      const mergeSwapPage = new MergeSwapPage(page);
      await mergeSwapPage.goto();
      await walletController.connect(page);

      // ── Step 3: Select tokens and fill amounts ──────────────────────────────
      // Input 1: SUI
      await mergeSwapPage.selectInputToken(0, mergeSwapScenario.inputCoinType1);
      await mergeSwapPage.fillInputAmount(0, mergeSwapScenario.inputAmountUi1);
      console.log(
        `[merge-swap:e2e] Selected input 1: ${mergeSwapScenario.inputSymbol1} (${mergeSwapScenario.inputAmountUi1})`
      );

      // Input 2: USDC
      await mergeSwapPage.selectInputToken(1, mergeSwapScenario.inputCoinType2);
      await mergeSwapPage.fillInputAmount(1, mergeSwapScenario.inputAmountUi2);
      console.log(
        `[merge-swap:e2e] Selected input 2: ${mergeSwapScenario.inputSymbol2} (${mergeSwapScenario.inputAmountUi2})`
      );

      // Output: CETUS
      await mergeSwapPage.selectOutputToken(mergeSwapScenario.outputCoinType);
      console.log(`[merge-swap:e2e] Selected output: ${mergeSwapScenario.outputSymbol}`);

      // ── Step 4: Wait for quote and read UI expectations ──────────────────────
      await page.waitForTimeout(2_000);

      const expectedOutputRaw = await mergeSwapPage.getExpectedOutputAmount(
        mergeSwapScenario.outputDecimal
      );
      const slippagePercent = await mergeSwapPage.getCurrentSlippagePercent();
      const slippageDecimal = parseFloat(slippagePercent) / 100;

      console.log(
        `[merge-swap:e2e] UI expectations` +
          ` | output: ${fmt(expectedOutputRaw)} (${(Number(expectedOutputRaw) / 10 ** mergeSwapScenario.outputDecimal).toFixed(mergeSwapScenario.outputDecimal)} ${mergeSwapScenario.outputSymbol})` +
          ` | slippage: ${slippagePercent}%`
      );

      // ── Step 5: Submit swap and approve in wallet ────────────────────────────
      await mergeSwapPage.submitSwap();
      await walletController.approveTransaction(page);
      await mergeSwapPage.expectSuccess();

      // ── Step 6: Obtain the tx digest ─────────────────────────────────────────
      const digest = await mergeSwapPage.readDigest();
      if (digest) {
        expect(digest.length).toBeGreaterThan(10);
        console.log(`[merge-swap:e2e] tx digest: ${digest}`);
      } else {
        console.log(
          '[merge-swap:e2e] tx digest: <not found in UI — falling back to balance movement check>'
        );
      }

      // ── Step 7: Confirm tx reached on-chain success ──────────────────────────
      const digestCandidate = digest?.match(/[1-9A-HJ-NP-Za-km-z]{40,90}/)?.[0];
      let txConfirmedOnChain = false;
      let txResult: Awaited<ReturnType<typeof getTransactionResult>> | undefined;

      if (digestCandidate) {
        txResult = await retry(
          async () => {
            const result = await getTransactionResult(digestCandidate);
            if (!result.success) {
              console.log(
                `[merge-swap:e2e] waiting tx on-chain | digest=${digestCandidate} status=${result.status}`
              );
              throw new Error(
                `Waiting for tx success on-chain. digest=${digestCandidate} status=${result.status}`
              );
            }
            return result;
          },
          24,
          5_000
        );

        expect(txResult.success, 'Transaction should succeed').toBe(true);
        expect(txResult.status, 'Transaction status should be "success"').toBe('success');

        txConfirmedOnChain = true;
        console.log(`[merge-swap:e2e] tx status: ${txResult.status} ✓`);
        console.log(`[merge-swap:e2e] tx gas used: ${txResult.gasUsed.toString()}`);

        console.log(`[merge-swap:e2e] tx events (${txResult.events.length} total):`);
        for (const event of txResult.events) {
          console.log(`  - ${event.type}`);
          if (event.parsedJson) {
            console.log(`    ${JSON.stringify(event.parsedJson, null, 2).replace(/\n/g, '\n    ')}`);
          }
        }

        if (txResult.swapEvents.length > 0) {
          console.log(`[merge-swap:e2e] swap events (${txResult.swapEvents.length} events):`);
          for (const swapEvent of txResult.swapEvents) {
            console.log(`  - ${swapEvent.type}`);
            if (swapEvent.pool) console.log(`    pool: ${swapEvent.pool}`);
            if (swapEvent.amountIn) console.log(`    amountIn: ${swapEvent.amountIn}`);
            if (swapEvent.amountOut) console.log(`    amountOut: ${swapEvent.amountOut}`);
            if (swapEvent.atob !== undefined) console.log(`    atob: ${swapEvent.atob}`);
          }
        } else {
          console.log(`[merge-swap:e2e] swap events: none found`);
        }

        if (txResult.balanceChanges.length > 0) {
          console.log(`[merge-swap:e2e] balance changes (${txResult.balanceChanges.length} changes):`);
          for (const change of txResult.balanceChanges) {
            const coinSymbol = change.coinType.split('::').pop() ?? change.coinType;
            console.log(`  - ${coinSymbol}: ${change.amount} (owner: ${change.owner.slice(0, 10)}...)`);
          }
        }
      }

      // ── Step 8: Poll until all three balances reflect the swap ───────────────
      const { afterInput1, afterInput2, afterOutput } = await retry(
        async () => {
          const nextInput1 = await getBalanceSnapshot(
            env.testWalletAddress,
            mergeSwapScenario.inputCoinType1
          );
          const nextInput2 = await getBalanceSnapshot(
            env.testWalletAddress,
            mergeSwapScenario.inputCoinType2
          );
          const nextOutput = await getBalanceSnapshot(
            env.testWalletAddress,
            mergeSwapScenario.outputCoinType
          );

          const input1Decreased = nextInput1.totalBalance < beforeInput1.totalBalance;
          const input2Decreased = nextInput2.totalBalance < beforeInput2.totalBalance;
          const outputIncreased = nextOutput.totalBalance > beforeOutput.totalBalance;

          console.log(
            `[merge-swap:e2e] polling balance` +
              ` | ${mergeSwapScenario.inputSymbol1}: ${fmt(nextInput1.totalBalance)} (${input1Decreased ? 'decreased ✓' : 'not-decreased'})` +
              ` | ${mergeSwapScenario.inputSymbol2}: ${fmt(nextInput2.totalBalance)} (${input2Decreased ? 'decreased ✓' : 'not-decreased'})` +
              ` | ${mergeSwapScenario.outputSymbol}: ${fmt(nextOutput.totalBalance)} (${outputIncreased ? 'increased ✓' : 'not-increased'})`
          );

          // When tx is confirmed on-chain, any movement is sufficient to avoid indexer lag flakiness.
          const movementSatisfied = txConfirmedOnChain
            ? input1Decreased || input2Decreased || outputIncreased
            : outputIncreased;

          if (!movementSatisfied) {
            throw new Error('[merge-swap:e2e] Waiting for mainnet balance to reflect the swap');
          }

          return { afterInput1: nextInput1, afterInput2: nextInput2, afterOutput: nextOutput };
        },
        24,
        5_000
      );

      // ── Step 9: Assert and log final balance deltas ──────────────────────────
      const input1Decreased = afterInput1.totalBalance < beforeInput1.totalBalance;
      const input2Decreased = afterInput2.totalBalance < beforeInput2.totalBalance;
      const outputIncreased = afterOutput.totalBalance > beforeOutput.totalBalance;
      const actualOutputReceived = afterOutput.totalBalance - beforeOutput.totalBalance;

      console.log(
        `[merge-swap:e2e] after balance` +
          ` | ${mergeSwapScenario.inputSymbol1}: ${fmt(afterInput1.totalBalance)}` +
          ` | ${mergeSwapScenario.inputSymbol2}: ${fmt(afterInput2.totalBalance)}` +
          ` | ${mergeSwapScenario.outputSymbol}: ${fmt(afterOutput.totalBalance)}`
      );
      console.log(
        `[merge-swap:e2e] delta` +
          ` | ${mergeSwapScenario.inputSymbol1} change: ${fmt(afterInput1.totalBalance - beforeInput1.totalBalance)}` +
          ` | ${mergeSwapScenario.inputSymbol2} change: ${fmt(afterInput2.totalBalance - beforeInput2.totalBalance)}` +
          ` | ${mergeSwapScenario.outputSymbol} change: +${fmt(actualOutputReceived)}`
      );

      // Verify actual received output is within slippage tolerance of the UI quote.
      // Allow positive slippage (user receiving more) up to 1%.
      const minAcceptableOutput =
        expectedOutputRaw -
        (expectedOutputRaw * BigInt(Math.floor(slippageDecimal * 10_000))) / 10_000n;
      const maxAcceptableOutput = expectedOutputRaw + (expectedOutputRaw * 100n) / 10_000n; // Allow up to 1% positive slippage
      const outputInRange =
        actualOutputReceived >= minAcceptableOutput &&
        actualOutputReceived <= maxAcceptableOutput;
      const deviationPercent =
        Number(((actualOutputReceived - expectedOutputRaw) * 10_000n) / expectedOutputRaw) / 100;

      console.log(
        `[merge-swap:e2e] reasonableness check` +
          ` | expected: ${fmt(expectedOutputRaw)}` +
          ` | actual: ${fmt(actualOutputReceived)}` +
          ` | deviation: ${deviationPercent.toFixed(2)}%` +
          ` ${deviationPercent > 0 ? '(positive slippage - user gains)' : '(negative slippage)'}` +
          ` | acceptable range: [${fmt(minAcceptableOutput)}, ${fmt(maxAcceptableOutput)}]` +
          ` | within range: ${outputInRange ? '✓' : '✗'}`
      );

      console.log(
        `[merge-swap:e2e] result` +
          ` | input1Decreased(${mergeSwapScenario.inputSymbol1})=${input1Decreased}` +
          ` | input2Decreased(${mergeSwapScenario.inputSymbol2})=${input2Decreased}` +
          ` | outputIncreased(${mergeSwapScenario.outputSymbol})=${outputIncreased}` +
          ` | outputReasonable=${outputInRange}`
      );

      expect(
        input1Decreased,
        `${mergeSwapScenario.inputSymbol1} balance should decrease after merge swap`
      ).toBe(true);
      expect(
        input2Decreased,
        `${mergeSwapScenario.inputSymbol2} balance should decrease after merge swap`
      ).toBe(true);
      expect(
        outputIncreased,
        `${mergeSwapScenario.outputSymbol} balance should increase after merge swap`
      ).toBe(true);
      expect(
        outputInRange,
        `Actual output ${fmt(actualOutputReceived)} should be within slippage (${slippagePercent}%) of expected ${fmt(expectedOutputRaw)}`
      ).toBe(true);
    }
  );
});
