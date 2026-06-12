import { swapScenario } from '@/fixtures/scenarios.js';
import { SwapPage } from '@/page-objects/swap.page.js';

import { expect, test } from '../setup/fixtures.js';

/**
 * P1: User rejection test - 用户拒签测试
 *
 * 测试场景：
 * 1. 发起 swap 到钱包签名弹窗
 * 2. 用户点击 Reject
 * 3. 观察 UI 状态变化
 *
 * 期望结果：
 * - 显示 'User rejected the request' 提示
 * - swap 界面恢复初始状态
 * - 无链上 tx（不执行实际交易）
 */
test.describe('Swap User Rejection', () => {
  test('shows correct UI feedback when user rejects transaction', async ({ page, walletController }) => {
    const swapPage = new SwapPage(page);
    await swapPage.goto(swapScenario.path);
    await walletController.connect(page);

    // 设置 swap 参数
    await swapPage.selectFromToken(swapScenario.inputCoinType);
    await swapPage.selectToToken(swapScenario.outputCoinType);
    await swapPage.fillAmount(swapScenario.inputAmountUi);
    await page.waitForTimeout(2_000);

    // 验证 swap 按钮可用
    const swapButton = page.getByRole('button', { name: /^swap!?$/i }).first();
    await expect(swapButton).toBeEnabled({ timeout: 10_000 });
    console.log('[rejection] Swap button enabled');

    // 点击 swap 按钮触发钱包弹窗
    await swapPage.submitSwap();
    console.log('[rejection] Swap button clicked, waiting for wallet popup');

    // 用户拒签
    await walletController.rejectTransaction(page);
    console.log('[rejection] Transaction rejected by user');

    // 等待 UI 响应
    await page.waitForTimeout(2_000);

    // 验证显示拒签提示
    // 根据用户提供的截图，提示是 "Transaction failed" 和 "User rejected the request"
    const rejectionMessage = page.getByText(/transaction failed|user rejected|transaction rejected|user denied|rejected by user/i).first();
    const hasRejectionMessage = await rejectionMessage.isVisible({ timeout: 5_000 }).catch(() => false);
    
    console.log(`[rejection] Rejection message visible: ${hasRejectionMessage}`);
    
    if (hasRejectionMessage) {
      const messageText = await rejectionMessage.innerText().catch(() => '');
      console.log(`[rejection] Message text: "${messageText}"`);
    }

    // 验证至少显示了拒签相关的提示
    expect(hasRejectionMessage, 'Should show transaction rejection message').toBe(true);
    console.log('[rejection] ✓ Transaction rejection message displayed');

    // 关闭错误弹窗（如果有关闭按钮）
    const closeButton = page.locator('button[aria-label="Close"], button:has-text("×"), button:has-text("close")').first();
    if (await closeButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await closeButton.click();
      console.log('[rejection] Closed error dialog');
      await page.waitForTimeout(1_000);
    }

    // 验证 swap 界面恢复到初始状态（swap 按钮仍然可用）
    const swapButtonAfterRejection = page.getByRole('button', { name: /^swap!?$/i }).first();
    const isEnabled = await swapButtonAfterRejection.isEnabled({ timeout: 10_000 }).catch(() => false);
    
    console.log(`[rejection] Swap button enabled after rejection: ${isEnabled}`);
    expect(isEnabled, 'Swap button should be enabled after rejection (UI should restore to initial state)').toBe(true);

    console.log('[rejection] ✓ UI correctly handles user rejection');
    console.log('[rejection] ✓ Swap interface restored to initial state');
  });
});
