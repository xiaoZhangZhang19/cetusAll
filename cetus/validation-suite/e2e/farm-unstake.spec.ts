import { FarmStakePage } from '@/page-objects/farm-stake.page.js';
import { env } from '@/config/env.js';

import { test } from '../setup/fixtures.js';

/**
 * P0: Cetus Farm — haSUI-SUI Unstake
 *
 * 步骤：
 *   1. 进入 /farms 页面
 *   2. 连接钱包
 *   3. 找到 haSUI - SUI 这一行，点击右侧向下箭头展开仓位列表
 *   4. 点击展开区域中的 Unstake 按钮
 *   5. 钱包批准交易
 *   6. 验证 Unstake 成功提示可见
 *
 * 前置条件：
 *   - 钱包在 haSUI-SUI Farm 中有已质押的仓位（Staked position，Unstake 按钮可见）
 */
test.describe('Cetus Mainnet Farm – haSUI-SUI Unstake', () => {
  test(
    'unstakes haSUI-SUI CLMM position from Farm',
    async ({ page, walletController }) => {
      test.setTimeout(120_000);

      const farmPage = new FarmStakePage(page);

      // ── Step 1: Navigate to Farms ───────────────────────────────────────────
      await farmPage.goto();
      console.log('[farm-unstake:e2e] Navigated to /farms');

      // ── Step 2: Connect wallet ──────────────────────────────────────────────
      await walletController.connect(page);
      console.log('[farm-unstake:e2e] Wallet connected');

      // ── Step 3: Expand haSUI-SUI farm row ──────────────────────────────────
      const pairLabel = env.farmPairLabel ?? 'haSUI - SUI';
      await farmPage.expandFarmRow(pairLabel);
      console.log(`[farm-unstake:e2e] Farm row expanded: "${pairLabel}"`);

      // ── Step 4 & 5: Click Unstake + wallet approval ─────────────────────────
      await walletController.approveTransactionForAction(page, () => farmPage.clickUnstake());
      console.log('[farm-unstake:e2e] Transaction approved in wallet');

      // ── Step 6: Verify success ──────────────────────────────────────────────
      await farmPage.expectUnstakeSuccess();

      const digest = await farmPage.readDigest();
      if (digest) {
        console.log(`[farm-unstake:e2e] tx digest: ${digest}`);
      }

      console.log('[farm-unstake:e2e] ✓ Farm Unstake transaction completed successfully');
    }
  );
});
