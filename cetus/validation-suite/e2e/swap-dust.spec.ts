import { env } from '@/config/env.js';
import { SwapPage } from '@/page-objects/swap.page.js';

import { expect, test } from '../setup/fixtures.js';

/**
 * P1: Dust amount (extremely small input) validation test.
 *
 * 测试 SUI → USDC 时输入极小数量（0.00000001）是否显示
 * "Insufficient liquidity for this trade" 提示。
 *
 * 只验证前端提示，不执行实际的 swap 操作。
 */
test.describe('Swap Dust Amount Validation', () => {
  test('shows "Insufficient liquidity" error for 0.00000001 SUI → USDC', async ({ page, walletController }) => {
    const swapPage = new SwapPage(page);
    await swapPage.goto('/swap');
    await walletController.connect(page);

    // 选择 SUI → USDC
    await swapPage.selectFromToken(env.swapInputType); // SUI
    await swapPage.selectToToken(env.swapOutputType); // USDC
    await swapPage.fillAmount('0.00000001');

    // 等待 UI 响应
    await page.waitForTimeout(2_000);

    // 查找 "Insufficient liquidity for this trade" 提示
    const insufficientLiquidityMsg = page.getByText(/Insufficient liquidity for this trade/i).first();
    const hasInsufficientLiquidity = await insufficientLiquidityMsg.isVisible({ timeout: 5_000 }).catch(() => false);

    console.log(`[dust] Input: 0.00000001 SUI → USDC`);
    console.log(`[dust] "Insufficient liquidity" message visible: ${hasInsufficientLiquidity}`);

    // 验证必须显示 "Insufficient liquidity" 提示
    expect(hasInsufficientLiquidity, 'Should show "Insufficient liquidity for this trade" error').toBe(true);
    
    if (hasInsufficientLiquidity) {
      const msg = await insufficientLiquidityMsg.innerText().catch(() => '');
      console.log(`[dust] ✓ Error message displayed: "${msg}"`);
    }
  });
});
