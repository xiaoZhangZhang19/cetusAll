import { FarmStakePage } from '@/page-objects/farm-stake.page.js';
import { env } from '@/config/env.js';

import { test } from '../setup/fixtures.js';

/**
 * P0: Cetus Farm — haSUI-SUI Claim Rewards
 *
 * 步骤：
 *   1. 进入 /farms 页面
 *   2. 连接钱包
 *   3. 找到 haSUI - SUI 行，直接点击高亮的 Claim 按钮（无需展开行）
 *   4. 钱包批准交易
 *   5. 验证 Claim 成功提示可见
 *
 * 前置条件：
 *   - 钱包在 haSUI-SUI Farm 中有可领取的奖励（Claim 按钮高亮可用）
 */
test.describe('Cetus Mainnet Farm – haSUI-SUI Claim', () => {
  test(
    'claims haSUI-SUI Farm rewards',
    async ({ page, walletController }) => {
      test.setTimeout(120_000);

      const farmPage = new FarmStakePage(page);

      // ── Step 1: Navigate to Farms ───────────────────────────────────────────
      await farmPage.goto();
      console.log('[farm-claim:e2e] Navigated to /farms');

      // ── Step 2: Connect wallet ──────────────────────────────────────────────
      await walletController.connect(page);
      console.log('[farm-claim:e2e] Wallet connected');

      // ── Step 3 & 4: Click Claim + wallet approval ───────────────────────────
      const pairLabel = env.farmPairLabel ?? 'haSUI - SUI';
      await walletController.approveTransactionForAction(
        page,
        () => farmPage.clickClaimForRow(pairLabel)
      );
      console.log('[farm-claim:e2e] Transaction approved in wallet');

      // ── Step 5: Verify success ──────────────────────────────────────────────
      await farmPage.expectClaimSuccess();

      const digest = await farmPage.readDigest();
      if (digest) {
        console.log(`[farm-claim:e2e] tx digest: ${digest}`);
      }

      console.log('[farm-claim:e2e] ✓ Farm Claim transaction completed successfully');
    }
  );
});
