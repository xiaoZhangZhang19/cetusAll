import { swapScenario } from '@/fixtures/scenarios.js';
import { SwapPage } from '@/page-objects/swap.page.js';

import { expect, test } from '../setup/fixtures.js';

/**
 * P1: 极低/极高滑点提示测试
 *
 * 测试场景：
 * 1. 设置滑点为 0.01%，验证弹窗内显示低滑点风险提示
 * 2. 设置滑点为 10%，验证弹窗内显示高滑点风险提示
 *
 * 期望结果：
 * - 滑点设置为 0.01% 时，显示提示："Slippage is low. Your transaction may fail."
 * - 滑点设置为 10% 时，显示提示："Be cautious when setting a high slippage tolerance.
 *   It's possible to expose your trade to frontrun risk, causing larger slippage loss."
 *
 * 阈值来自 Cetus 前端逻辑：滑点 >0 且 <0.05% 走低滑点提示，其余非安全区间走高滑点提示；
 * 安全区间（常规币对 ≤5%）不显示任何提示（noTip）。
 *
 * 注意：本测试仅验证前端提示，无需选择 token 或填写交易金额。
 */

/**
 * 打开滑点设置面板的公共辅助函数：不依赖当前滑点具体数值。
 *
 * 面板是 chakra popover（role="dialog"），标题为 "Swap Slippage Tolerance"，
 * 并不含 "Settings" 字样，因此按标题正则匹配而非硬编码 "Settings"。
 */
async function openSlippagePanel(page: import('@playwright/test').Page) {
  // 等待 swap 页面主体渲染完成（Aggregator Mode 出现说明 swap 面板已就绪）
  await page.getByText('Aggregator Mode').waitFor({ state: 'visible', timeout: 10_000 });

  // 滑点设置按钮紧邻 Aggregator Mode，且文字为百分比格式（如 0.5%、10%）
  // 用正则过滤排除钱包账户按钮（显示钱包地址，不含 %）
  const settingsBtn = page
    .locator('[aria-haspopup="dialog"]')
    .filter({ hasText: /^\d+(\.\d+)?%$/ });
  await settingsBtn.click();

  const panel = page
    .locator('[role="dialog"]')
    .filter({ hasText: /slippage tolerance/i })
    .first();
  await expect(panel, 'Slippage tolerance panel should open').toBeVisible({ timeout: 8_000 });
  return panel;
}

test.describe('Swap Slippage Warning', () => {
  test('shows low slippage warning when slippage is set to 0.01%', async ({ page, walletController }) => {
    const swapPage = new SwapPage(page);
    await swapPage.goto(swapScenario.path);
    await walletController.connect(page);

    console.log('[slippage-warning] Opening slippage settings');
    const panel = await openSlippagePanel(page);
    console.log('[slippage-warning] Slippage panel opened');

    // 定位 Custom 输入框并输入 0.01%
    const input = panel.locator('input[placeholder="0.0"]').first();
    await input.fill('0.01');
    await expect(input).toHaveValue('0.01');
    console.log('[slippage-warning] Slippage value set to 0.01%');

    // 等待警告提示渲染
    await page.waitForTimeout(500);

    // 验证低滑点警告提示在面板内可见
    const lowSlippageWarning = panel.getByText(/slippage is low[.\s\S]*transaction may fail/i);
    await expect(
      lowSlippageWarning,
      'Should show: "Slippage is low. Your transaction may fail."'
    ).toBeVisible({ timeout: 3_000 });

    const warningText = await lowSlippageWarning.innerText().catch(() => '');
    console.log(`[slippage-warning] Warning text: "${warningText}"`);
    console.log('[slippage-warning] ✓ Low slippage warning displayed correctly');
  });

  test('shows high slippage warning when slippage is set to 10%', async ({ page, walletController }) => {
    const swapPage = new SwapPage(page);
    await swapPage.goto(swapScenario.path);
    await walletController.connect(page);

    console.log('[slippage-warning] Opening slippage settings');
    const panel = await openSlippagePanel(page);
    console.log('[slippage-warning] Slippage panel opened');

    // 定位 Custom 输入框并输入 10%
    const input = panel.locator('input[placeholder="0.0"]').first();
    await input.fill('10');
    await expect(input).toHaveValue('10');
    console.log('[slippage-warning] Slippage value set to 10%');

    // 等待警告提示渲染
    await page.waitForTimeout(500);

    // 验证高滑点警告提示在面板内可见
    const highSlippageWarning = panel.getByText(/be cautious[\s\S]*high slippage[\s\S]*frontrun[\s\S]*slippage loss/i);
    await expect(
      highSlippageWarning,
      'Should show: "Be cautious when setting a high slippage tolerance..."'
    ).toBeVisible({ timeout: 3_000 });

    const warningText = await highSlippageWarning.innerText().catch(() => '');
    console.log(`[slippage-warning] Warning text: "${warningText}"`);
    console.log('[slippage-warning] ✓ High slippage warning displayed correctly');
  });
});
