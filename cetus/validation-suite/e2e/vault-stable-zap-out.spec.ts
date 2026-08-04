import { VaultDepositPage } from '@/page-objects/vault-deposit.page.js';

import { test } from '../setup/fixtures.js';

/**
 * Vault 稳定池 — Zap Out (vault稳定-zap out)
 *
 * 与 vault稳定-zap in 的区别：
 *   - 进入 Withdraw tab 后开启 Zap Out toggle
 *   - 两轮退出：
 *       Round 1: haSUI only — 点击 HALF 退出一半资金
 *       Round 2: SUI only   — 点击 MAX 退出全部剩余资金
 *   - 每轮：快捷按钮填充金额 → 点击 Zap Out → 钱包批准（无二次弹窗）
 *   - 两轮均验证 Transaction Completed
 *
 * 步骤：
 *   1. 进入 /vaults，连接钱包
 *   2. LST 筛选（可选）→ 点击 haSUI-SUI 行 Deposit 进入详情页
 *   3. 切换到 Withdraw tab
 *   4. 开启 Zap Out toggle
 *   ── Round 1: haSUI only ──
 *   5. 选择 "haSUI only" tab
 *   6. 点击 HALF
 *   7. 点击 Zap Out → 钱包批准
 *   8. 验证 Transaction Completed → 关闭弹窗
 *   ── Round 2: SUI only ──
 *   9. 选择 "SUI only" tab
 *  10. 点击 MAX
 *  11. 点击 Zap Out → 钱包批准
 *  12. 验证 Transaction Completed
 */
test.describe('Cetus Mainnet Vault – 稳定池', () => {
  test('vault稳定-zap out', async ({ page, walletController }) => {
    test.setTimeout(300_000);

    const vaultPage = new VaultDepositPage(page);

    // ── Step 1: Navigate + connect ──────────────────────────────────────────
    await vaultPage.goto();
    console.log('[vault-stable-zap-out] Navigated to /vaults');

    await walletController.connect(page);
    console.log('[vault-stable-zap-out] Wallet connected');

    // ── Step 2: Find haSUI-SUI vault and enter detail page ──────────────────
    await vaultPage.filterByLst();
    await vaultPage.clickDepositForPair('haSUI', 'SUI');
    console.log('[vault-stable-zap-out] Entered haSUI-SUI vault detail page');

    // ── Step 3: Switch to Withdraw tab ──────────────────────────────────────
    await vaultPage.clickWithdrawTab();
    console.log('[vault-stable-zap-out] Switched to Withdraw tab');

    // ── Step 4: Enable Zap Out ──────────────────────────────────────────────
    await vaultPage.enableZapOut();
    console.log('[vault-stable-zap-out] Zap Out enabled');

    // ── Round 1: haSUI only — HALF ──────────────────────────────────────────
    console.log('[vault-stable-zap-out] === Round 1: haSUI only (HALF) ===');

    await vaultPage.selectZapToken('haSUI only');
    await vaultPage.clickZapOutQuickAmount('HALF');
    console.log('[vault-stable-zap-out] Round 1 — HALF filled');

    await walletController.approveTransactionForAction(page, () => vaultPage.submitZapOut());
    console.log('[vault-stable-zap-out] Round 1 — transaction approved');

    await vaultPage.expectDepositSuccess();
    console.log('[vault-stable-zap-out] Round 1 — ✓ Transaction Completed');

    await vaultPage.closeSuccessModal();
    console.log('[vault-stable-zap-out] Round 1 — modal closed');

    // ── Round 2: SUI only — MAX ─────────────────────────────────────────────
    console.log('[vault-stable-zap-out] === Round 2: SUI only (MAX) ===');

    await vaultPage.selectZapToken('SUI only');
    await vaultPage.clickZapOutQuickAmount('MAX');
    console.log('[vault-stable-zap-out] Round 2 — MAX filled');

    await walletController.approveTransactionForAction(page, () => vaultPage.submitZapOut());
    console.log('[vault-stable-zap-out] Round 2 — transaction approved');

    await vaultPage.expectDepositSuccess();
    console.log('[vault-stable-zap-out] Round 2 — ✓ Transaction Completed');

    console.log('[vault-stable-zap-out] ✓ Both Zap Out rounds completed successfully');
  });
});
