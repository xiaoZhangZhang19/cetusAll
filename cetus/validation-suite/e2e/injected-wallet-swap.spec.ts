/**
 * 验证 injected 钱包模式：只用私钥完成「连接 → 报价 → 签名」，不依赖 Slush 扩展。
 *
 * 运行方式：
 *   npm run test:e2e:injected        # 安全模式：只签名 + dryRun，不上链不花钱
 *   npm run test:e2e:injected:live   # 真实成交，会消耗 gas 和本金
 */
import { env } from '@/config/env.js';
import { SwapPage } from '@/page-objects/swap.page.js';
import { getWalletActivity } from '@/wallet/injected-controller.js';

import { expect, test } from '../setup/fixtures.js';

const AMOUNT = '0.05';

test.describe('Injected wallet (private key only, no extension)', () => {
  test('connects with a private key and signs a SUI→USDC swap', async ({
    page,
    walletController,
  }) => {
    test.setTimeout(240_000);

    const activity = getWalletActivity(page);
    const swapPage = new SwapPage(page);

    // ── 1. 连接：没有插件，没有解锁密码，没有弹窗 ──────────────────────────
    await swapPage.goto('/swap');
    await walletController.connect(page);

    // connect() 内部已断言 header 出现地址，这里再确认一次以留下明确日志
    const addrPrefix = env.testWalletAddress.slice(0, 6);
    await expect(
      page.getByText(new RegExp(addrPrefix, 'i')).first(),
      'header 应显示已连接的钱包地址'
    ).toBeVisible();
    console.log(`[injected:e2e] connected as ${env.testWalletAddress}`);

    // ── 2. 选币并等报价 ───────────────────────────────────────────────────
    await swapPage.selectFromToken('0x2::sui::SUI');
    await swapPage.selectToToken(env.swapOutputType);
    await swapPage.fillAmount(AMOUNT);

    // ── 3. 提交，触发签名 ─────────────────────────────────────────────────
    const signsBefore = activity.signCount;
    await swapPage.submitSwap();

    // 签名是同步完成的，但 build + RPC 需要几秒
    await expect
      .poll(() => activity.signCount, {
        message: '前端应向注入钱包请求一次签名',
        timeout: 60_000,
        intervals: [500],
      })
      .toBeGreaterThan(signsBefore);

    console.log(
      `[injected:e2e] signCount=${activity.signCount} digests=${JSON.stringify(activity.digests)}`
    );

    // ── 4. 断言签名产物 ───────────────────────────────────────────────────
    expect(activity.digests.length, '应捕获到至少一个交易 digest').toBeGreaterThan(0);

    if (env.walletDryRun) {
      // dry-run：证明前端构建的 PTB 在链上是可执行的，但不真的广播
      expect(activity.dryRunStatuses.length, '应有 dry-run 结果').toBeGreaterThan(0);
      expect(
        activity.dryRunStatuses.at(-1),
        `dry-run 应成功，实际: ${activity.dryRunStatuses.at(-1)}`
      ).toBe('success');
      console.log('[injected:e2e] dry-run success — PTB 有效，未上链');
    } else {
      // 真实模式：交易由 Cetus 前端广播，等它成功
      await swapPage.expectSuccess();
      console.log('[injected:e2e] swap confirmed on-chain');
    }
  });
});
