import { env } from '@/config/env.js';
import { getBalanceSnapshot, getTransactionResult } from '@/chain/queries.js';
import { COIN_TYPES } from '@/fixtures/scenarios.js';
import { DlmmClaimRewardPage } from '@/page-objects/dlmm-claim-reward.page.js';
import { retry } from '@/utils/retry.js';

import { expect, test } from '../setup/fixtures.js';

/**
 * P0: DLMM SUI-USDC 池子 Claim 奖励 — 余额验证测试
 *
 * 步骤：
 *   1.  捕获链上 SUI、USDC、CETUS 余额（claim 前）
 *   2.  进入 /pools?tab=positions → My Positions
 *   3.  点击 SUI-USDC DLMM 池子卡片（区别于 CLMM）
 *   4.  点击活跃持仓行，打开 position 详情页面
 *   5.  点击 Claim 按钮，打开 claim modal
 *   6.  从 modal 读取各代币可领取数量（只断言 modal 中显示的代币）
 *   7.  点击 modal 中的 Claim 按钮 → 钱包确认
 *   8.  等待成功提示
 *   9.  轮询直到余额反映增加
 *  10.  断言每个有奖励的代币余额均增加，且 >= UI 展示数量
 */
test.describe('Cetus Mainnet DLMM Claim Reward', () => {
  test(
    'claims SUI-USDC DLMM rewards and validates on-chain balance increases',
    async ({ page, walletController }) => {
      test.setTimeout(180_000);

      const fmt = (v: bigint) => v.toString();

      // ── Step 1: Capture on-chain balances BEFORE claim ───────────────────────
      const beforeSui = await getBalanceSnapshot(env.testWalletAddress, COIN_TYPES.SUI);
      const beforeUsdc = await getBalanceSnapshot(env.testWalletAddress, COIN_TYPES.USDC);
      const beforeCetus = await getBalanceSnapshot(env.testWalletAddress, COIN_TYPES.CETUS);

      console.log(
        `[dlmm-claim:e2e] before balance` +
          ` | SUI: ${fmt(beforeSui.totalBalance)}` +
          ` | USDC: ${fmt(beforeUsdc.totalBalance)}` +
          ` | CETUS: ${fmt(beforeCetus.totalBalance)}`
      );

      // ── Step 2: Navigate and connect wallet ─────────────────────────────────
      const claimPage = new DlmmClaimRewardPage(page);
      await claimPage.goto();
      await walletController.connect(page);
      console.log('[dlmm-claim:e2e] Wallet connected');

      // ── Step 3: Open SUI-USDC DLMM pool card ────────────────────────────────
      await claimPage.openSuiUsdcDlmmPool('SUI', 'USDC');

      // ── Step 4: Open active position's detail page ───────────────────────────
      await claimPage.openFirstActivePositionClaimDialog();

      // ── Step 5: Click Claim to open modal ────────────────────────────────────
      await claimPage.openClaimModal();

      // ── Step 6: Read claimable amounts from modal ─────────────────────────────
      const claimable = await claimPage.readClaimableAmountsFromModal();

      // Convert to raw bigints: CETUS 9 decimals, SUI 9 decimals, USDC 6 decimals
      const expectedCetusRaw = BigInt(Math.round(claimable.cetus * 1e9));
      const expectedSuiRaw = BigInt(Math.round(claimable.sui * 1e9));
      const expectedUsdcRaw = BigInt(Math.round(claimable.usdc * 1e6));

      console.log(
        `[dlmm-claim:e2e] UI claimable` +
          ` | CETUS: ${claimable.cetus} (raw: ${fmt(expectedCetusRaw)})` +
          ` | SUI: ${claimable.sui} (raw: ${fmt(expectedSuiRaw)})` +
          ` | USDC: ${claimable.usdc} (raw: ${fmt(expectedUsdcRaw)})`
      );

      // Ensure at least one token has a non-zero claimable amount
      const expectCetus = claimable.cetus > 0;
      const expectSuiFees = claimable.sui > 0;
      const expectUsdc = claimable.usdc > 0;
      expect(
        expectCetus || expectSuiFees || expectUsdc,
        'At least one token should have a claimable reward in the modal'
      ).toBe(true);

      // ── Step 7: Click Claim in modal → approve in wallet ─────────────────────
      await claimPage.clickClaimInModal();
      await walletController.approveTransaction(page);
      console.log('[dlmm-claim:e2e] Transaction approved in wallet');

      // ── Step 8: Wait for success ──────────────────────────────────────────────
      await claimPage.expectSuccess();
      const digest = await claimPage.readDigest();

      if (digest) {
        expect(digest.length).toBeGreaterThan(10);
        console.log(`[dlmm-claim:e2e] tx digest: ${digest}`);
      } else {
        console.log('[dlmm-claim:e2e] tx digest: <not found — falling back to balance check>');
      }

      // ── Step 9: (Optional) confirm on-chain ───────────────────────────────────
      const digestCandidate = digest?.match(/[1-9A-HJ-NP-Za-km-z]{40,90}/)?.[0];
      if (digestCandidate) {
        const txResult = await retry(
          async () => {
            const result = await getTransactionResult(digestCandidate);
            if (!result.success) {
              throw new Error(`Waiting for tx. digest=${digestCandidate} status=${result.status}`);
            }
            return result;
          },
          24,
          5_000
        );
        expect(txResult.success, 'Claim tx should succeed on-chain').toBe(true);
        console.log(`[dlmm-claim:e2e] tx status: ${txResult.status} ✓`);
      }

      // ── Step 10: Poll until balances reflect the claim ────────────────────────
      console.log(
        `[dlmm-claim:e2e] tokens to verify | CETUS=${expectCetus} | SUI fees=${expectSuiFees} | USDC=${expectUsdc}`
      );

      const { afterSui, afterUsdc, afterCetus } = await retry(
        async () => {
          const nextSui = await getBalanceSnapshot(env.testWalletAddress, COIN_TYPES.SUI);
          const nextUsdc = await getBalanceSnapshot(env.testWalletAddress, COIN_TYPES.USDC);
          const nextCetus = await getBalanceSnapshot(env.testWalletAddress, COIN_TYPES.CETUS);

          const cetusIncreased = nextCetus.totalBalance > beforeCetus.totalBalance;
          const usdcIncreased = nextUsdc.totalBalance > beforeUsdc.totalBalance;
          const suiChanged = nextSui.totalBalance !== beforeSui.totalBalance;

          console.log(
            `[dlmm-claim:e2e] polling balance` +
              ` | SUI: ${fmt(nextSui.totalBalance)} (${suiChanged ? 'changed ✓' : 'unchanged'})` +
              ` | USDC: ${fmt(nextUsdc.totalBalance)} (${usdcIncreased ? 'increased ✓' : 'not-increased'})` +
              ` | CETUS: ${fmt(nextCetus.totalBalance)} (${cetusIncreased ? 'increased ✓' : 'not-increased'})`
          );

          // All tokens shown in modal must have reflected the increase
          const satisfied =
            (!expectCetus || cetusIncreased) &&
            (!expectUsdc || usdcIncreased) &&
            (!expectSuiFees || suiChanged);

          if (!satisfied) {
            throw new Error('[dlmm-claim:e2e] Waiting for balances to reflect the claim');
          }

          return { afterSui: nextSui, afterUsdc: nextUsdc, afterCetus: nextCetus };
        },
        24,
        5_000
      );

      // ── Step 11: Final assertions ─────────────────────────────────────────────
      const suiDelta = afterSui.totalBalance - beforeSui.totalBalance;
      const usdcDelta = afterUsdc.totalBalance - beforeUsdc.totalBalance;
      const cetusDelta = afterCetus.totalBalance - beforeCetus.totalBalance;

      console.log(
        `[dlmm-claim:e2e] delta` +
          ` | SUI: ${fmt(suiDelta)} (gas included)` +
          ` | USDC: ${fmt(usdcDelta)}` +
          ` | CETUS: ${fmt(cetusDelta)}`
      );

      // actual >= expected (rewards accumulate between reading and signing)
      const atLeastExpected = (actual: bigint, expected: bigint) =>
        expected === 0n || actual >= expected;

      if (expectCetus) {
        const cetusOk = atLeastExpected(cetusDelta, expectedCetusRaw);
        console.log(
          `[dlmm-claim:e2e] CETUS check | min: ${fmt(expectedCetusRaw)} | actual: ${fmt(cetusDelta)} | ok: ${cetusOk ? '✓' : '✗'}`
        );
        expect(cetusDelta > 0n, 'CETUS balance should increase').toBe(true);
        expect(
          cetusOk,
          `CETUS received (${fmt(cetusDelta)}) must be >= UI-shown ${fmt(expectedCetusRaw)}`
        ).toBe(true);
      }

      if (expectUsdc) {
        const usdcOk = atLeastExpected(usdcDelta, expectedUsdcRaw);
        console.log(
          `[dlmm-claim:e2e] USDC check | min: ${fmt(expectedUsdcRaw)} | actual: ${fmt(usdcDelta)} | ok: ${usdcOk ? '✓' : '✗'}`
        );
        expect(usdcDelta > 0n, 'USDC balance should increase').toBe(true);
        expect(
          usdcOk,
          `USDC received (${fmt(usdcDelta)}) must be >= UI-shown ${fmt(expectedUsdcRaw)}`
        ).toBe(true);
      }

      if (expectSuiFees) {
        console.log(
          `[dlmm-claim:e2e] SUI check | expected fees: ${fmt(expectedSuiRaw)} | net delta: ${fmt(suiDelta)} (gas included)`
        );
        expect(suiDelta !== 0n, 'SUI balance should change after claiming SUI fee rewards').toBe(true);
      }

      console.log('[dlmm-claim:e2e] ✓ All balance assertions passed');
    }
  );
});
