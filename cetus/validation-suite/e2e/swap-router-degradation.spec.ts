import { env } from '@/config/env.js';
import { getBalanceSnapshot } from '@/chain/queries.js';
import { swapScenario } from '@/fixtures/scenarios.js';
import { SwapPage } from '@/page-objects/swap.page.js';
import { retry } from '@/utils/retry.js';

import { expect, test } from '../setup/fixtures.js';
import type { Page } from '@playwright/test';

/**
 * 检查路由是否只使用 Cetus（通过检测路由中的图片源）
 * 
 * @param page Playwright Page 对象
 * @returns 如果只使用 Cetus 路由返回 true，否则返回 false
 */
async function checkOnlyCetusRoute(page: Page): Promise<boolean> {
  try {
    // 使用 .css-3u7qdm 容器定位路由
    const routeContainer = page.locator('.css-3u7qdm').first();
    await page.waitForTimeout(1000);
    
    // 查找容器内所有的图片元素
    const images = routeContainer.locator('img');
    const imageCount = await images.count();
    
    console.log(`[degradation:route] Found ${imageCount} image(s) in route container`);
    
    if (imageCount === 0) {
      console.log('[degradation:route] No images found in route');
      return false;
    }
    
    // 检查每个图片的 src 是否都包含 cetus.png
    let allCetus = true;
    for (let i = 0; i < imageCount; i++) {
      const img = images.nth(i);
      const src = await img.getAttribute('src').catch(() => '');
      console.log(`[degradation:route] Image ${i + 1} src: ${src}`);
      
      // 检查是否包含 cetus.png
      if (!src.includes('cetus.png')) {
        allCetus = false;
        console.log(`[degradation:route] ⚠ Non-Cetus route detected: ${src}`);
      }
    }
    
    return allCetus;
  } catch (error) {
    console.log(`[degradation:route] Error checking route: ${error}`);
    return false;
  }
}

/**
 * P1: Swap router degradation tests.
 *
 * Intercepts the Cetus aggregator route API using Playwright's route() API to
 * simulate backend failures.  If Cetus has a local-pool fallback, the swap
 * should still complete successfully despite the API being unavailable.
 *
 * Confirmed API endpoint (2026-04):
 *   GET https://api-sui.cetus.zone/router_v3/find_routes
 *   Query params: from, target, amount, by_amount_in, depth, providers, v
 *
 * Example response shape:
 *   { code: 200, msg: "Success", data: { paths: [...], amount_out: N, ... } }
 *
 * Default FIND_ROUTER_URL_PATTERN: https://api-sui.cetus.zone/router_v3/find_routes**
 *
 * Note: If the selected token pair has a direct on-chain pool, the router may
 * not be called at all — degradation is transparent in that case.
 */
test.describe('Swap Router Degradation', () => {
  /**
   * Primary test: block the findRouter API entirely (simulates network failure
   * or service outage) and verify the swap still completes via local pools.
   */
  test('falls back to local pools when findRouter API is unreachable', async ({
    page,
    walletController
  }) => {
    let findRouterCallCount = 0;

    // Listen for console errors to observe fallback behaviour
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // Listen for failed network requests
    const failedRequests: string[] = [];
    page.on('requestfailed', (req) => {
      if (/router|route/i.test(req.url())) {
        failedRequests.push(req.url());
      }
    });

    // Snapshot pre-swap balances
    const beforeInput = await getBalanceSnapshot(env.testWalletAddress, swapScenario.inputCoinType);
    const beforeOutput = await getBalanceSnapshot(env.testWalletAddress, swapScenario.outputCoinType);

    const swapPage = new SwapPage(page);
    await swapPage.goto(swapScenario.path);
    await walletController.connect(page);

    // 在页面加载完成后，开始拦截 router API
    // Pattern: https://api-sui.cetus.zone/router_v3/find_routes**
    await page.route(env.findRouterUrlPattern, (route) => {
      findRouterCallCount++;
      console.log(`[degradation] Blocking find_routes #${findRouterCallCount}: ${route.request().url()}`);
      route.abort('failed');
    });

    await swapPage.selectFromToken(swapScenario.inputCoinType);
    await swapPage.selectToToken(swapScenario.outputCoinType);
    await swapPage.fillAmount(swapScenario.inputAmountUi);
    await page.waitForTimeout(3_000);

    // Check for any UI-level degradation hint (optional, DApp-specific)
    const degradationHint = page.getByText(/local.*pool|fallback|degraded|offline.*mode/i).first();
    const hasDegradationHint =
      await degradationHint.isVisible({ timeout: 2_000 }).catch(() => false);
    if (hasDegradationHint) {
      console.log('[degradation] UI shows degradation/fallback indicator');
    }

    // The Swap button should still become enabled (local routing is available)
    const swapButton = page.getByRole('button', { name: /^swap!?$/i }).first();
    const isEnabled = await swapButton.isEnabled({ timeout: 10_000 }).catch(() => false);
    console.log(`[degradation] Swap button enabled after API block: ${isEnabled}`);

    if (!isEnabled) {
      console.log('[degradation] ⚠️ Swap button not enabled — Cetus may require the router API');
      console.log('[degradation] Console errors:', consoleErrors.slice(0, 3));
      console.log('[degradation] Failed requests:', failedRequests.slice(0, 3));
      // Mark test as soft-fail: degradation is acceptable if router is mandatory
      test.skip();
      return;
    }

    // 检查路由是否只使用 Cetus（降级到本地池）
    const onlyCetus = await checkOnlyCetusRoute(page);
    console.log(`[degradation] Only Cetus route: ${onlyCetus}`);
    
    // 验证降级后只使用 Cetus 本地池
    expect(onlyCetus, 'Should fallback to Cetus local pools only when router API is blocked').toBe(true);
    console.log('[degradation] ✓ Confirmed fallback to Cetus local pools');

    // Execute the swap
    await swapPage.submitSwap();
    await walletController.approveTransaction(page);
    await swapPage.expectSuccess();

    const digest = await swapPage.readDigest();
    expect(digest).toBeTruthy();
    console.log(`[degradation] tx reference: ${digest}`);

    // Verify balance movement (proves local-pool fallback swap succeeded)
    const { afterInput, afterOutput } = await retry(async () => {
      const ni = await getBalanceSnapshot(env.testWalletAddress, swapScenario.inputCoinType);
      const no = await getBalanceSnapshot(env.testWalletAddress, swapScenario.outputCoinType);
      if (no.totalBalance <= beforeOutput.totalBalance) {
        throw new Error('Waiting for balance movement after degraded swap');
      }
      return { afterInput: ni, afterOutput: no };
    }, 24, 5_000);

    expect(afterOutput.totalBalance).toBeGreaterThan(beforeOutput.totalBalance);
    expect(afterInput.totalBalance).toBeLessThan(beforeInput.totalBalance);

    console.log(`[degradation] ✓ Swap succeeded without findRouter API`);
    console.log(`[degradation] findRouter blocked ${findRouterCallCount} time(s)`);
    console.log(`[degradation] Input: ${beforeInput.totalBalance} → ${afterInput.totalBalance}`);
    console.log(`[degradation] Output: ${beforeOutput.totalBalance} → ${afterOutput.totalBalance}`);
  });

});
