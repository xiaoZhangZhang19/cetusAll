import { VaultDepositPage } from '@/page-objects/vault-deposit.page.js';

import { test } from '../setup/fixtures.js';

/**
 * Vault 稳定池 — Withdraw (vault稳定-remove)
 *
 * 与 vault稳定-add 的区别：
 *   - 进入详情页后切换到 Withdraw tab
 *   - 在 haSUI 输入框填入 0.01（SUI 自动计算）
 *   - 点击 Withdraw 按钮直接提交交易（无二次弹窗）
 *   - 验证 Transaction Completed
 *
 * 步骤：
 *   1. 进入 /vaults，连接钱包
 *   2. LST 筛选（可选）→ 点击 haSUI-SUI 行 Deposit 进入详情页
 *   3. 切换到 Withdraw tab
 *   4. 填入 0.01 haSUI
 *   5. 点击 Withdraw → 钱包批准
 *   6. 验证 Transaction Completed
 */
test.describe('Cetus Mainnet Vault – 稳定池', () => {
  test('vault稳定-remove', async ({ page, walletController }) => {
    test.setTimeout(180_000);

    const vaultPage = new VaultDepositPage(page);

    // ── Step 1: Navigate + connect ──────────────────────────────────────────
    await vaultPage.goto();
    console.log('[vault-stable-remove] Navigated to /vaults');

    await walletController.connect(page);
    console.log('[vault-stable-remove] Wallet connected');

    // ── Step 2: Find haSUI-SUI vault and enter detail page ──────────────────
    await vaultPage.filterByLst();
    await vaultPage.clickDepositForPair('haSUI', 'SUI');
    console.log('[vault-stable-remove] Entered haSUI-SUI vault detail page');

    // ── Step 3: Switch to Withdraw tab ──────────────────────────────────────
    await vaultPage.clickWithdrawTab();
    console.log('[vault-stable-remove] Switched to Withdraw tab');

    // ── Step 4: Fill withdraw amount ────────────────────────────────────────
    await vaultPage.fillWithdrawAmount('0.01');
    console.log('[vault-stable-remove] Filled 0.01 haSUI');

    // ── Step 5: Submit + wallet approval ────────────────────────────────────
    await walletController.approveTransactionForAction(page, () => vaultPage.submitWithdraw());
    console.log('[vault-stable-remove] Transaction submitted and approved');

    // ── Step 6: Verify success ───────────────────────────────────────────────
    await vaultPage.expectDepositSuccess();
    console.log('[vault-stable-remove] ✓ Vault Withdraw completed successfully');
  });
});
