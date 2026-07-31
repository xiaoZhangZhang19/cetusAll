import { ClmmSwapPage } from '@/page-objects/clmm-swap.page.js';

import { test } from '../setup/fixtures.js';

/**
 * P0: CLMM 池子页面内嵌 Swap 组件 — 交易成功验证
 *
 * 步骤：
 *   1. 进入 /pools（CLMM 列表）
 *   2. 连接钱包
 *   3. 点击左下角悬浮 Swap 入口按钮，打开 Swap 面板
 *   4. 输入 0.01（SUI → USDC 默认代币对）
 *   5. 点击 Swap 按钮，处理可能出现的 Confirm Swap 确认弹窗
 *   6. 钱包批准交易
 *   7. 验证交易成功提示可见
 */
test.describe('Cetus Mainnet CLMM – Swap Widget', () => {
  test(
    'swaps 0.01 SUI via the CLMM page floating swap widget',
    async ({ page, walletController }) => {
      test.setTimeout(120_000);

      const swapPage = new ClmmSwapPage(page);

      // ── Step 1: Navigate to CLMM pools page ─────────────────────────────────
      await swapPage.goto();
      console.log('[clmm-swap:e2e] Navigated to /pools');

      // ── Step 2: Connect wallet ───────────────────────────────────────────────
      await walletController.connect(page);
      console.log('[clmm-swap:e2e] Wallet connected');

      // ── Step 3: Open the floating Swap panel ─────────────────────────────────
      await swapPage.openSwapPanel();
      console.log('[clmm-swap:e2e] Swap panel opened');

      // ── Step 4: Fill the swap amount ─────────────────────────────────────────
      await swapPage.fillAmount('0.01');
      console.log('[clmm-swap:e2e] Filled amount: 0.01');

      // ── Step 5 & 6: Submit swap + wallet approval ─────────────────────────────
      await walletController.approveTransactionForAction(page, () => swapPage.submitSwap());
      console.log('[clmm-swap:e2e] Transaction approved in wallet');

      // ── Step 7: Verify success ────────────────────────────────────────────────
      await swapPage.expectSuccess();

      const digest = await swapPage.readDigest();
      if (digest) {
        console.log(`[clmm-swap:e2e] tx digest: ${digest}`);
      }

      console.log('[clmm-swap:e2e] ✓ CLMM Swap transaction completed successfully');
    }
  );
});
