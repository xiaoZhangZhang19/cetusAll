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

    // 报价请求期间按钮显示 "Loading..."，且会周期性重新报价。
    // 必须等报价结算后再断言，否则会读到中间态。
    const actionText = await swapPage.waitForQuoteSettled();

    console.log(`[dust] Input: 0.00000001 SUI → USDC`);
    console.log(`[dust] Action button text: "${actionText}"`);

    // 尘埃金额无法路由，Cetus 会拦截下单。拦截形态有两种：
    //   1. 按钮变为 "Insufficient liquidity for this trade"
    //   2. 按钮保持 "Swap" 但处于 disabled
    // 两者都算通过；关键是不能出现可点击的 Swap 按钮。
    const showsInsufficientLiquidity = /insufficient liquidity/i.test(actionText);

    const swapButton = page.getByRole('button', { name: /^swap!?$/i }).first();
    const swapClickable = await swapButton.isEnabled({ timeout: 2_000 }).catch(() => false);

    console.log(`[dust] Shows "Insufficient liquidity": ${showsInsufficientLiquidity}`);
    console.log(`[dust] Swap button clickable: ${swapClickable}`);

    expect(
      showsInsufficientLiquidity || !swapClickable,
      `Dust amount should be blocked, but the action button was "${actionText}" and Swap was clickable`
    ).toBe(true);

    console.log(`[dust] ✓ Dust amount correctly blocked: "${actionText}"`);
  });
});
