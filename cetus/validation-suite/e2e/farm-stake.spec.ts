import { FarmStakePage } from '@/page-objects/farm-stake.page.js';
import { env } from '@/config/env.js';

import { test } from '../setup/fixtures.js';

/**
 * P0: Cetus Farm — haSUI-SUI Stake
 *
 * 步骤：
 *   1. 进入 /earn/farms 页面
 *   2. 连接钱包
 *   3. 找到 haSUI - SUI 这一行，点击右侧向下箭头展开仓位列表
 *   4. 点击展开区域中的 Stake 按钮
 *   5. 钱包批准交易
 *   6. 验证 Stake 成功提示可见
 *
 * 前置条件：
 *   - 钱包在 haSUI-SUI CLMM 池有未质押的活跃仓位（Active position）
 */
test.describe('Cetus Mainnet Farm – haSUI-SUI Stake', () => {
  test(
    'stakes haSUI-SUI CLMM position in Farm',
    async ({ page, walletController }) => {
      test.setTimeout(120_000);

      const farmPage = new FarmStakePage(page);

      // ── Step 1: Navigate to Farms ───────────────────────────────────────────
      await farmPage.goto();
      console.log('[farm-stake:e2e] Navigated to /earn/farms');

      // ── Step 2: Connect wallet ──────────────────────────────────────────────
      await walletController.connect(page);
      console.log('[farm-stake:e2e] Wallet connected');

      // ── Step 3: Expand haSUI-SUI farm row ──────────────────────────────────
      const pairLabel = env.farmPairLabel ?? 'haSUI - SUI';
      await farmPage.expandFarmRow(pairLabel);
      console.log(`[farm-stake:e2e] Farm row expanded: "${pairLabel}"`);

      // ── Step 4 & 5: Click Stake + wallet approval ───────────────────────────
      await walletController.approveTransactionForAction(page, () => farmPage.clickStake());
      console.log('[farm-stake:e2e] Transaction approved in wallet');

      // ── Step 6: Verify success ──────────────────────────────────────────────
      await farmPage.expectStakeSuccess();

      const digest = await farmPage.readDigest();
      if (digest) {
        console.log(`[farm-stake:e2e] tx digest: ${digest}`);
      }

      console.log('[farm-stake:e2e] ✓ Farm Stake transaction completed successfully');
    }
  );
});
