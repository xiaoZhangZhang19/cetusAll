import { VaultDepositPage } from '@/page-objects/vault-deposit.page.js';

import { test } from '../setup/fixtures.js';

/**
 * Vault 稳定池 — Deposit (vault稳定-add)
 *
 * 步骤：
 *   1. 进入 /vaults 页面
 *   2. 连接钱包
 *   3. 点击 LST 标签筛选
 *   4. 找到 haSUI-SUI vault 行 → 点击 Deposit
 *   5. 等待详情页加载完毕
 *   6. 在 haSUI 输入框填入 0.01，SUI 金额自动计算
 *   7. 点击详情页 Deposit 按钮 → 在确认弹窗中再次点击 Deposit → 钱包批准
 *   8. 验证出现 "Transaction Completed" 字样
 */
test.describe('Cetus Mainnet Vault – 稳定池', () => {
  test('vault稳定-add', async ({ page, walletController }) => {
    test.setTimeout(180_000);

    const vaultPage = new VaultDepositPage(page);

    // ── Step 1: Navigate ─────────────────────────────────────────────────────
    await vaultPage.goto();
    console.log('[vault-stable-add] Navigated to /vaults');

    // ── Step 2: Connect wallet ────────────────────────────────────────────────
    await walletController.connect(page);
    console.log('[vault-stable-add] Wallet connected');

    // ── Step 3: Filter by LST tab ─────────────────────────────────────────────
    await vaultPage.filterByLst();
    console.log('[vault-stable-add] LST filter applied');

    // ── Step 4: Click Deposit on haSUI-SUI row ────────────────────────────────
    await vaultPage.clickDepositForPair('haSUI', 'SUI');
    console.log('[vault-stable-add] Entered haSUI-SUI vault detail page');

    // ── Step 5: Fill 0.01 haSUI ───────────────────────────────────────────────
    await vaultPage.fillDepositAmount('0.01');
    console.log('[vault-stable-add] Filled 0.01 haSUI');

    // ── Step 6: Submit + wallet approval ─────────────────────────────────────
    await walletController.approveTransactionForAction(page, () => vaultPage.submitDeposit());
    console.log('[vault-stable-add] Transaction submitted and approved');

    // ── Step 7: Verify success ────────────────────────────────────────────────
    await vaultPage.expectDepositSuccess();

    const digest = await vaultPage.readDigest();
    if (digest) {
      console.log(`[vault-stable-add] tx digest: ${digest}`);
    }

    console.log('[vault-stable-add] ✓ Vault Deposit completed successfully');
  });
});
