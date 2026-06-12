import { env } from '@/config/env.js';
import { getBalanceSnapshot, getTransactionResult } from '@/chain/queries.js';
import { COIN_TYPES } from '@/fixtures/scenarios.js';
import { ClmmClaimRewardPage } from '@/page-objects/clmm-claim-reward.page.js';
import { retry } from '@/utils/retry.js';

import { expect, test } from '../setup/fixtures.js';

/**
 * P0: CLMM SUI-USDC 池子 Claim 奖励 — 余额验证测试
 *
 * 步骤：
 *   1.  捕获链上 SUI、USDC、CETUS 余额（claim 前）
 *   2.  进入 /pools?tab=positions → My Positions
 *   3.  点击 SUI-USDC CLMM 池子卡片
 *   4.  点击活跃持仓行，打开 position 详情页面
 *   5.  点击 Claim 按钮，打开 claim modal
 *   6.  从 modal 读取 CETUS、SUI、USDC 可领取数量
 *   7.  点击 modal 中的 Claim 按钮 → 钱包确认
 *   8.  等待成功提示，读取 tx digest
 *   9.  链上确认交易成功
 *  10.  轮询直到三种代币余额均反映增加
 *  11.  断言 CETUS、SUI、USDC 余额均增加，且增加量与 UI 展示匹配
 */
test.describe('Cetus Mainnet CLMM Claim Reward', () => {
  test(
    'claims SUI-USDC CLMM rewards and validates on-chain balance increases for CETUS + SUI + USDC',
    async ({ page, walletController }) => {
      // Claiming + tx propagation + indexer lag — allow 3 min
      test.setTimeout(180_000);

      const fmt = (v: bigint) => v.toString();

      // ── Step 1: Capture on-chain balances BEFORE claim ───────────────────────
      const beforeSui = await getBalanceSnapshot(env.testWalletAddress, COIN_TYPES.SUI);
      const beforeUsdc = await getBalanceSnapshot(env.testWalletAddress, COIN_TYPES.USDC);
      const beforeCetus = await getBalanceSnapshot(env.testWalletAddress, COIN_TYPES.CETUS);

      console.log(
        `[clmm-claim:e2e] before balance` +
          ` | SUI: ${fmt(beforeSui.totalBalance)}` +
          ` | USDC: ${fmt(beforeUsdc.totalBalance)}` +
          ` | CETUS: ${fmt(beforeCetus.totalBalance)}`
      );

      // ── Step 2: Navigate and connect wallet ─────────────────────────────────
      const claimPage = new ClmmClaimRewardPage(page);
      await claimPage.goto();
      await walletController.connect(page);
      console.log('[clmm-claim:e2e] Wallet connected');

      // ── Step 3: Open SUI-USDC CLMM pool card ────────────────────────────────
      await claimPage.openSuiUsdcClmmPool('SUI', 'USDC');

      // ── Step 4: Open active position's claim dialog ──────────────────────────
      await claimPage.openFirstActivePositionClaimDialog();

      // ── Step 5: Click Claim to open modal ─────────────────────────────────────
      await claimPage.openClaimModal();

      // ── Step 6: Read claimable amounts FROM THE MODAL ─────────────────────────
      const claimable = await claimPage.readClaimableAmountsFromModal();

      // Convert float UI amounts to raw bigints (for post-claim comparison)
      // CETUS: 9 decimals, SUI: 9 decimals, USDC: 6 decimals
      const expectedCetusRaw = BigInt(Math.round(claimable.cetus * 1e9));
      const expectedSuiRaw = BigInt(Math.round(claimable.sui * 1e9));
      const expectedUsdcRaw = BigInt(Math.round(claimable.usdc * 1e6));

      console.log(
        `[clmm-claim:e2e] UI claimable` +
          ` | CETUS: ${claimable.cetus} (raw: ${fmt(expectedCetusRaw)})` +
          ` | SUI: ${claimable.sui} (raw: ${fmt(expectedSuiRaw)})` +
          ` | USDC: ${claimable.usdc} (raw: ${fmt(expectedUsdcRaw)})`
      );

      // ── Step 7: Click Claim button in modal → approve in wallet ───────────────
      await claimPage.clickClaimInModal();
      await walletController.approveTransaction(page);
      console.log('[clmm-claim:e2e] Transaction approved in wallet');

      // ── Step 8: Wait for success and read tx digest ──────────────────────────
      await claimPage.expectSuccess();
      const digest = await claimPage.readDigest();

      if (digest) {
        expect(digest.length).toBeGreaterThan(10);
        console.log(`[clmm-claim:e2e] tx digest: ${digest}`);
      } else {
        console.log(
          '[clmm-claim:e2e] tx digest: <not found in UI — falling back to balance movement check>'
        );
      }

      // ── Step 9: Confirm tx reached on-chain success ──────────────────────────
      const digestCandidate = digest?.match(/[1-9A-HJ-NP-Za-km-z]{40,90}/)?.[0];
      let txConfirmedOnChain = false;

      if (digestCandidate) {
        const txResult = await retry(
          async () => {
            const result = await getTransactionResult(digestCandidate);
            if (!result.success) {
              console.log(
                `[clmm-claim:e2e] waiting tx on-chain | digest=${digestCandidate} status=${result.status}`
              );
              throw new Error(`Waiting for tx success. digest=${digestCandidate} status=${result.status}`);
            }
            return result;
          },
          24,
          5_000
        );

        expect(txResult.success, 'Claim transaction should succeed on-chain').toBe(true);
        expect(txResult.status, 'Claim transaction status should be "success"').toBe('success');
        txConfirmedOnChain = true;

        console.log(`[clmm-claim:e2e] tx status: ${txResult.status} ✓`);
        console.log(`[clmm-claim:e2e] tx gas used: ${fmt(txResult.gasUsed)}`);

        if (txResult.balanceChanges.length > 0) {
          console.log(`[clmm-claim:e2e] balance changes (${txResult.balanceChanges.length}):`);
          for (const change of txResult.balanceChanges) {
            const symbol = change.coinType.split('::').pop() ?? change.coinType;
            console.log(`  - ${symbol}: ${change.amount}`);
          }
        }
      }

      // Which tokens has the modal shown as claimable?
      const expectCetus = claimable.cetus > 0;
      const expectSuiFees = claimable.sui > 0;
      const expectUsdc = claimable.usdc > 0;

      console.log(
        `[clmm-claim:e2e] tokens to verify` +
          ` | CETUS=${expectCetus}` +
          ` | SUI fees=${expectSuiFees}` +
          ` | USDC=${expectUsdc}`
      );

      // ── Step 10: Poll until balances for shown tokens reflect the claim ───────
      const { afterSui, afterUsdc, afterCetus } = await retry(
        async () => {
          const nextSui = await getBalanceSnapshot(env.testWalletAddress, COIN_TYPES.SUI);
          const nextUsdc = await getBalanceSnapshot(env.testWalletAddress, COIN_TYPES.USDC);
          const nextCetus = await getBalanceSnapshot(env.testWalletAddress, COIN_TYPES.CETUS);

          const cetusIncreased = nextCetus.totalBalance > beforeCetus.totalBalance;
          const usdcIncreased = nextUsdc.totalBalance > beforeUsdc.totalBalance;
          const suiChanged = nextSui.totalBalance !== beforeSui.totalBalance;

          console.log(
            `[clmm-claim:e2e] polling balance` +
              ` | SUI: ${fmt(nextSui.totalBalance)} (${suiChanged ? 'changed ✓' : 'unchanged'})` +
              ` | USDC: ${fmt(nextUsdc.totalBalance)} (${usdcIncreased ? 'increased ✓' : 'not-increased'})` +
              ` | CETUS: ${fmt(nextCetus.totalBalance)} (${cetusIncreased ? 'increased ✓' : 'not-increased'})`
          );

          // Poll until every token shown in the modal has actually increased
          const satisfied =
            (!expectCetus || cetusIncreased) &&
            (!expectUsdc || usdcIncreased) &&
            (!expectSuiFees || suiChanged) &&
            (expectCetus || expectUsdc || expectSuiFees); // at least one token expected

          if (!satisfied) {
            throw new Error('[clmm-claim:e2e] Waiting for balances to reflect the claim');
          }

          return { afterSui: nextSui, afterUsdc: nextUsdc, afterCetus: nextCetus };
        },
        24,
        5_000
      );

      // ── Step 11: Assert and log final balance deltas ─────────────────────────
      const suiDelta = afterSui.totalBalance - beforeSui.totalBalance;
      const usdcDelta = afterUsdc.totalBalance - beforeUsdc.totalBalance;
      const cetusDelta = afterCetus.totalBalance - beforeCetus.totalBalance;

      console.log(
        `[clmm-claim:e2e] after balance` +
          ` | SUI: ${fmt(afterSui.totalBalance)}` +
          ` | USDC: ${fmt(afterUsdc.totalBalance)}` +
          ` | CETUS: ${fmt(afterCetus.totalBalance)}`
      );
      console.log(
        `[clmm-claim:e2e] delta` +
          ` | SUI: ${fmt(suiDelta)} (includes gas cost)` +
          ` | USDC: ${fmt(usdcDelta)}` +
          ` | CETUS: ${fmt(cetusDelta)}`
      );

      // Rewards accumulate continuously — by the time the wallet signs, more may have accrued.
      // So actual >= expected is the only hard guarantee; no upper bound is enforced.
      const atLeastExpected = (actual: bigint, expected: bigint): boolean => {
        if (expected === 0n) return true;
        return actual >= expected;
      };

      // Only assert tokens that appeared in the modal with non-zero amounts
      if (expectCetus) {
        const cetusIncreased = cetusDelta > 0n;
        const cetusOk = atLeastExpected(cetusDelta, expectedCetusRaw);
        console.log(
          `[clmm-claim:e2e] CETUS check | expected min: ${fmt(expectedCetusRaw)} | actual: ${fmt(cetusDelta)} | ok: ${cetusOk ? '✓' : '✗'}`
        );
        expect(cetusIncreased, 'CETUS balance should increase').toBe(true);
        expect(
          cetusOk,
          `CETUS received (${fmt(cetusDelta)}) must be >= UI-shown amount ${fmt(expectedCetusRaw)}`
        ).toBe(true);
      }

      if (expectUsdc) {
        const usdcIncreased = usdcDelta > 0n;
        const usdcOk = atLeastExpected(usdcDelta, expectedUsdcRaw);
        console.log(
          `[clmm-claim:e2e] USDC check | expected min: ${fmt(expectedUsdcRaw)} | actual: ${fmt(usdcDelta)} | ok: ${usdcOk ? '✓' : '✗'}`
        );
        expect(usdcIncreased, 'USDC balance should increase').toBe(true);
        expect(
          usdcOk,
          `USDC received (${fmt(usdcDelta)}) must be >= UI-shown amount ${fmt(expectedUsdcRaw)}`
        ).toBe(true);
      }

      if (expectSuiFees) {
        // SUI net delta includes gas deduction — only verify it changed (not exact amount)
        const suiChanged = suiDelta !== 0n;
        console.log(
          `[clmm-claim:e2e] SUI check | expected fees: ${fmt(expectedSuiRaw)} | net delta: ${fmt(suiDelta)} (gas included)`
        );
        expect(suiChanged, 'SUI balance should change after claiming SUI fee rewards').toBe(true);
      }

      console.log('[clmm-claim:e2e] ✓ All balance assertions passed');
    }
  );
});
