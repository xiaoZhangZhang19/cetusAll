import { VaultDepositPage } from '@/page-objects/vault-deposit.page.js';

import { test } from '../setup/fixtures.js';

/**
 * Vault 稳定池 — Zap In (vault稳定-zap in)
 *
 * 与 vault稳定-add 的区别：
 *   - 开启 Zap In 开关，进入单 Token 存入模式
 *   - 分两轮执行：
 *       Round 1: haSUI only 存入 0.01
 *       Round 2: SUI only   存入 0.01
 *   - 每轮：输入金额 → 点击 Zap In → 弹窗点 Deposit → 确认 Transaction Completed → 关闭弹窗
 *   - 两轮全部成功则测试通过
 *
 * 步骤：
 *   1. 进入 /vaults，连接钱包
 *   2. LST 筛选（可选）→ 点击 haSUI-SUI 行 Deposit 进入详情页
 *   3. 开启 Zap In toggle
 *   ── Round 1: haSUI only ──
 *   4. 选择 "haSUI only" tab
 *   5. 输入 0.01
 *   6. 点击 Zap In → 弹窗点 Deposit → 钱包批准
 *   7. 验证 Transaction Completed → 关闭弹窗
 *   ── Round 2: SUI only ──
 *   8. 选择 "SUI only" tab
 *   9. 输入 0.01
 *  10. 点击 Zap In → 弹窗点 Deposit → 钱包批准
 *  11. 验证 Transaction Completed
 */
test.describe('Cetus Mainnet Vault – 稳定池', () => {
  test('vault稳定-zap in', async ({ page, walletController }) => {
    test.setTimeout(300_000);

    const vaultPage = new VaultDepositPage(page);

    // ── Step 1: Navigate + connect ──────────────────────────────────────────
    await vaultPage.goto();
    console.log('[vault-stable-zap] Navigated to /vaults');

    await walletController.connect(page);
    console.log('[vault-stable-zap] Wallet connected');

    // ── Step 2: Find haSUI-SUI vault and enter detail page ──────────────────
    await vaultPage.filterByLst();
    await vaultPage.clickDepositForPair('haSUI', 'SUI');
    console.log('[vault-stable-zap] Entered haSUI-SUI vault detail page');

    // ── Step 3: Enable Zap In ───────────────────────────────────────────────
    await vaultPage.enableZapIn();
    console.log('[vault-stable-zap] Zap In enabled');

    // ── Round 1: haSUI only ─────────────────────────────────────────────────
    console.log('[vault-stable-zap] === Round 1: haSUI only ===');

    await vaultPage.selectZapToken('haSUI only');
    await vaultPage.fillZapAmount('0.01');
    console.log('[vault-stable-zap] Round 1 — filled 0.01 haSUI');

    await walletController.approveTransactionForAction(page, () => vaultPage.submitZapIn());
    console.log('[vault-stable-zap] Round 1 — transaction approved');

    await vaultPage.expectDepositSuccess();
    console.log('[vault-stable-zap] Round 1 — ✓ Transaction Completed');

    await vaultPage.closeSuccessModal();
    console.log('[vault-stable-zap] Round 1 — modal closed');

    // ── Round 2: SUI only ───────────────────────────────────────────────────
    console.log('[vault-stable-zap] === Round 2: SUI only ===');

    await vaultPage.selectZapToken('SUI only');
    await vaultPage.fillZapAmount('0.01');
    console.log('[vault-stable-zap] Round 2 — filled 0.01 SUI');

    await walletController.approveTransactionForAction(page, () => vaultPage.submitZapIn());
    console.log('[vault-stable-zap] Round 2 — transaction approved');

    await vaultPage.expectDepositSuccess();
    console.log('[vault-stable-zap] Round 2 — ✓ Transaction Completed');

    console.log('[vault-stable-zap] ✓ Both Zap In rounds completed successfully');
  });
});
