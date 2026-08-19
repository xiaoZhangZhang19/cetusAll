import { expect, test } from '../setup/fixtures.js';
import { SwapPage } from '@/page-objects/swap.page.js';
import { TOKEN_DECIMALS } from '@/fixtures/scenarios.js';
import type { Page } from '@playwright/test';

/**
 * 统计路由数量（.css-3u7qdm 容器内 popover-trigger div 的数量）。
 *
 * 等价的浏览器端写法：
 * ```javascript
 * document.querySelector('.css-3u7qdm')
 *   .querySelectorAll('div[id^="popover-trigger"]').length;
 * ```
 *
 * @returns popover-trigger div 数量，-1 表示无法读取
 */
async function getRouteCount(page: Page, timeoutMs: number = 15_000): Promise<number> {
  try {
    const routeContainer = page.locator('.css-3u7qdm').first();
    const popoverTriggers = routeContainer.locator('div[id^="popover-trigger"]');

    // 轮询等待路由区渲染：find_routes 未返回时容器内为空，
    // 固定 waitForTimeout 会读到 0 并误判为无路由。
    let count = 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      count = await popoverTriggers.count().catch(() => 0);
      if (count > 0) break;
      await page.waitForTimeout(500);
    }

    console.log(`[getRouteCount] Found ${count} route(s) in .css-3u7qdm container`);

    for (let i = 0; i < count; i++) {
      const elem = popoverTriggers.nth(i);
      const text = await elem.innerText().catch(() => '');
      const id = await elem.getAttribute('id').catch(() => '');
      console.log(`[getRouteCount] Token ${i + 1}: "${text.trim()}" (id: ${id})`);
    }

    return count === 0 ? -1 : count;
  } catch (error) {
    console.log(`[getRouteCount] Error: ${error}`);
    return -1;
  }
}

/**
 * 读取 Price Difference / price impact 文案（观察用，失败不影响断言）。
 */
async function readPriceInfo(page: Page): Promise<string> {
  return page
    .locator('text=/Price.*Difference|price.*impact/i')
    .first()
    .innerText()
    .catch(() => 'N/A');
}

/**
 * Route 验证套件：**只验证路由选择与 quote 计算**，不发送任何链上交易。
 *
 * ## 单进程设计
 *
 * 三个场景合并进同一个 test，用 test.step 划分。原本三个独立 test 各自
 * goto + connect wallet + enableAllRoutes，同样的准备动作重复三遍（约 1.7 分钟）。
 * 合并后浏览器会话、钱包连接、流动性源配置各只做一次；且场景 2 采集的
 * 1000 SUI 报价可直接被场景 3 复用，只需再补一次 10000 SUI。
 *
 * ## 路由数量判断
 *
 * 统计 `id` 以 `popover-trigger-` 开头的 div 数量（路由中的代币节点）：
 * - 2 个代币  = 单跳路由（SUI → MEOW 直接池子交换）
 * - >= 3 个代币 = 多跳路由（SUI → vSUI → CETUS → USDC）
 *
 * 注意：线上流动性随时变化，代币数量属于观察指标而非硬断言；
 * 硬断言只覆盖"报价必须为正"和"输出随输入单调增长"这类确定性属性。
 */

const routeTestTokens = {
  // 单池：SUI → MEOW
  singlePool: {
    fromCoin: '0x2::sui::SUI',
    toCoin: '0x06b145d0322e389d6225f336ab57bba4c67e4e701bd6c6bc959d90675900a17e::meow::MEOW',
    fromSymbol: 'SUI',
    toSymbol: 'MEOW',
    testAmount: '1'
  },
  // 多池：SUI → USDC（大金额更易触发多跳）
  multiPool: {
    fromCoin: '0x2::sui::SUI',
    toCoin: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
    fromSymbol: 'SUI',
    toSymbol: 'USDC',
    testAmounts: ['1000', '10000']
  }
};

/** 一次金额测试采集到的观察数据 */
interface QuoteSample {
  amount: string;
  output: number;
  priceInfo: string;
  hasAutoRouter: boolean;
  routeCount: number;
}

test.describe('Swap Route Selection', () => {
  // 三个场景串在一个 test 里，整体预算放宽到 4 分钟
  test.setTimeout(240_000);

  test('verifies Cetus Auto Router quote & route selection', async ({ page, walletController }) => {
    const single = routeTestTokens.singlePool;
    const multi = routeTestTokens.multiPool;
    const multiDecimal = TOKEN_DECIMALS[multi.toCoin] ?? 9;

    const swapPage = new SwapPage(page);

    // 跨 step 复用：multi 场景采集的 1000 SUI 样本直接作为 amounts 场景的第一个数据点
    const samples: QuoteSample[] = [];

    /** 填入金额 → 等新报价落地 → 采集一组观察数据 */
    const collectSample = async (amount: string): Promise<QuoteSample> => {
      const output = await swapPage.fillAmountAndWaitForFreshQuote(amount);
      const hasAutoRouter = await swapPage.waitForAutoRouter(10_000);
      const routeCount = await getRouteCount(page);
      const priceInfo = await readPriceInfo(page);

      const sample: QuoteSample = {
        amount,
        output: output ?? 0,
        priceInfo,
        hasAutoRouter,
        routeCount
      };
      samples.push(sample);

      console.log(
        `[route:sample] ${amount} ${multi.fromSymbol} → ${sample.output.toFixed(multiDecimal)} ` +
          `${multi.toSymbol} (autoRouter: ${hasAutoRouter}, routes: ${routeCount}, ${priceInfo})`
      );
      return sample;
    };

    // 会话级准备：只做一次（原来每个 test 各做一遍）
    await test.step('setup: open swap page, connect wallet, enable all liquidity sources', async () => {
      await swapPage.goto();
      await walletController.connect(page);

      // 持久化 profile 可能残留上一次运行的单一 provider 勾选，
      // 那会让大额报价直接返回 insufficient liquidity。
      const enabled = await swapPage.enableAllRoutes();
      console.log(`[route:setup] Liquidity sources enabled: ${enabled}`);
    });
    // multi / amounts 都用 USDC 作为 to token，连续跑完再切到 MEOW，
    // 避免在 to 面板上来回换币（每次切换都要重开一次代币弹窗）。
    await test.step(`multi pool: ${multi.fromSymbol} → ${multi.toSymbol} @ ${multi.testAmounts[0]}`, async () => {
      await swapPage.selectFromToken(multi.fromCoin);
      await swapPage.selectToToken(multi.toCoin);

      const sample = await collectSample(multi.testAmounts[0]);

      expect(sample.output, 'multi-pool quote should be positive').toBeGreaterThan(0);
      expect(sample.hasAutoRouter, 'multi-pool route should show Auto Router').toBe(true);

      const minReceived = await swapPage.getMinimumReceived(multi.toSymbol);
      if (minReceived) {
        // Minimum Received 必须小于报价（滑点保护向下取值）
        expect(minReceived.value).toBeLessThanOrEqual(sample.output);
        console.log(`[route:multi] Minimum Received: ${minReceived.text}`);
      }

      const slippage = await swapPage.getCurrentSlippagePercent();
      console.log(`[route:multi] Slippage: ${slippage}%`);
    });
    await test.step('different input amounts: quote scales monotonically', async () => {
      // samples[0] 已由上一个 step 采集（1000 SUI），这里只补剩下的金额
      for (const amount of multi.testAmounts.slice(1)) {
        await collectSample(amount);
      }

      const [first, second] = samples.slice(-multi.testAmounts.length);
      const amount1 = parseFloat(first.amount);
      const amount2 = parseFloat(second.amount);

      // 报价必须真的刷新过：相等说明读到了上一轮的陈旧值
      expect(
        second.output,
        `stale quote: ${second.amount} ${multi.fromSymbol} returned the same output ` +
          `as ${first.amount} (${first.output}); the receive field never refreshed`
      ).not.toBe(first.output);
      expect(second.output).toBeGreaterThan(first.output);

      // 量级校验：输入放大 N 倍，输出至少应放大 N/2 倍。
      // 留一半余量吸收价格影响（大额吃深度会压低单位汇率），
      // 同时又能拦住"输出只涨了个零头"这类明显错读。
      const amountRatio = amount2 / amount1;
      const outputRatio = second.output / first.output;
      expect(
        outputRatio,
        `output ratio ${outputRatio.toFixed(3)} is far below the ${amountRatio}x input ratio`
      ).toBeGreaterThan(amountRatio / 2);

      const rate1 = first.output / amount1;
      const rate2 = second.output / amount2;

      console.log('\n[route:amounts] ✓ Route correctly handles different amounts');
      for (const [sample, rate] of [[first, rate1], [second, rate2]] as const) {
        console.log(
          `  - ${sample.amount} ${multi.fromSymbol} → ${sample.output.toFixed(6)} ${multi.toSymbol} ` +
            `(rate: ${rate.toFixed(6)}, routes: ${sample.routeCount})`
        );
      }

      if (rate2 < rate1) {
        console.log(
          `[route:amounts] ℹ Price impact: rate ${rate1.toFixed(6)} → ${rate2.toFixed(6)}`
        );
      }
      if (second.routeCount > first.routeCount) {
        console.log(
          `[route:amounts] ℹ Route complexity: ${first.routeCount} → ${second.routeCount}`
        );
      }
    });

    await test.step(`single pool: ${single.fromSymbol} → ${single.toSymbol}`, async () => {
      await swapPage.selectFromToken(single.fromCoin);
      await swapPage.selectToToken(single.toCoin);

      const output = await swapPage.fillAmountAndWaitForFreshQuote(single.testAmount);
      expect(output, 'single-pool quote should be positive').toBeGreaterThan(0);

      const hasAutoRouter = await swapPage.waitForAutoRouter(8_000);
      const routeCount = await getRouteCount(page);

      console.log(
        `[route:single] ${single.testAmount} ${single.fromSymbol} → ${output} ${single.toSymbol} ` +
          `(autoRouter: ${hasAutoRouter}, routes: ${routeCount})`
      );
    });

    console.log('[route] ✓ All route scenarios verified (no actual swap executed)');
  });
});
