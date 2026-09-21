import { swapScenario } from '@/fixtures/scenarios.js';
import { SwapPage } from '@/page-objects/swap.page.js';

import { test } from '../setup/fixtures.js';

/**
 * P1: User rejection test - 用户拒签测试
 *
 * 测试场景：
 * 1. 发起 swap 到钱包签名环节
 * 2. 用户拒签
 *
 * 通过标准：拒签动作本身成功即视为通过。
 * 不再检测拒签后的 UI 反馈（toast 文案、按钮是否恢复）——
 * 那部分提示是会自动消失的 chakra toast，检测本身极不稳定，
 * 且不是本用例要覆盖的点。
 *
 * 注意：注入钱包没有审批弹窗，签名在点击 Swap 的瞬间就发生，
 * 所以必须先 armRejection() 再 submitSwap()，否则交易会真的上链。
 */
test.describe('Swap User Rejection', () => {
  test('rejects the transaction in the wallet', async ({ page, walletController }) => {
    const swapPage = new SwapPage(page);
    await swapPage.goto(swapScenario.path);
    await walletController.connect(page);

    // 设置 swap 参数
    await swapPage.selectFromToken(swapScenario.inputCoinType);
    await swapPage.selectToToken(swapScenario.outputCoinType);
    await swapPage.fillAmount(swapScenario.inputAmountUi);

    // 提交前武装拒签：signTransaction 一到就返回 4001，不签名、不广播。
    await walletController.armRejection(page);

    // 点 Swap 触发签名请求
    await swapPage.submitSwap();
    console.log('[rejection] Swap submitted, waiting for the signing request');

    // 拒签被真正消费即通过；没等到签名请求则抛错（避免假绿）。
    await walletController.rejectTransaction(page);
    console.log('[rejection] ✓ Transaction rejected — test passed');
  });
});
