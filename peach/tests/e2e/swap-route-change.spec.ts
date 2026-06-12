/**
 * Test: Swap Route Count Change Monitoring
 *
 * 路由数量变化监测测试：通过更改 swap 金额，观察 Auto Router 显示的路由/Stream 数量是否发生变化。
 * 本测试不执行真实交易，仅验证报价和路由信息。
 *
 * 测试流程：
 *   1. 连接 MetaMask 钱包到 Peach Protocol
 *   2. 选择代币对（Pay / Receive）
 *   3. 全选所有 24 条流动性路由（确保路由计算覆盖全部来源）
 *   4. 依次输入多个金额（如 0.01, 0.02, 0.03）
 *   5. 对每个金额：获取报价、读取路由数量、记录结果
 *   6. 检查不同金额下路由数量是否存在变化
 *   7. 输出对比报告
 *
 * 环境变量配置（.env）：
 *   ROUTE_CHANGE_AMOUNTS     – 逗号分隔的金额序列，例如 "0.01,0.02,0.03"（默认 "0.001,0.01,0.1"）
 *   SWAP_PAY_TOKEN           – You Pay 代币地址（默认 BNB）
 *   SWAP_RECEIVE_TOKEN       – You Receive 代币地址（默认 USDT）
 *
 * 注意：EXECUTE_SWAP 始终为 false，本测试不发送链上交易。
 *
 * 运行命令：
 *   npx playwright test tests/e2e/swap-route-change.spec.ts
 *
 *   # 指定金额序列
 *   ROUTE_CHANGE_AMOUNTS="0.001,0.01,0.1,1" npx playwright test tests/e2e/swap-route-change.spec.ts
 *
 *   # 指定代币对
 *   SWAP_PAY_TOKEN="0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" \
 *   SWAP_RECEIVE_TOKEN="0x55d398326f99059fF775485246999027B3197955" \
 *   ROUTE_CHANGE_AMOUNTS="0.01,0.05,0.1" \
 *   npx playwright test tests/e2e/swap-route-change.spec.ts
 */

import { SwapPage } from '../../src/page-objects/swap.page.js';
import { test, expect } from '../setup/fixtures.js';

// ── 默认 Token 地址（BNB Smart Chain）──────────────────────────────────────
const DEFAULT_TOKEN_ADDRESSES = {
  BNB:  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  USDT: '0x55d398326f99059fF775485246999027B3197955',
} as const;

// ── 从环境变量读取参数 ────────────────────────────────────────────────────
const PAY_TOKEN     = process.env.SWAP_PAY_TOKEN      ?? DEFAULT_TOKEN_ADDRESSES.BNB;
const RECEIVE_TOKEN = process.env.SWAP_RECEIVE_TOKEN  ?? DEFAULT_TOKEN_ADDRESSES.USDT;

/** 从 ROUTE_CHANGE_AMOUNTS 解析金额序列，默认为 ['0.001', '0.01', '0.1'] */
function parseAmounts(): string[] {
  const raw = process.env.ROUTE_CHANGE_AMOUNTS ?? '0.001,0.01,0.1';
  return raw
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a.length > 0 && !isNaN(parseFloat(a)));
}

const AMOUNTS = parseAmounts();

// ── 每个金额测试结果 ─────────────────────────────────────────────────────
interface AmountResult {
  amount:      string;
  routeCount:  number;
  quote:       string;
  exchangeRate: string;
  durationMs:  number;
  error?:      string;
}

test.describe('Peach Swap – Route Count Change Test', () => {
  test('monitors route count changes across different amounts', async ({
    page,
    metamask,
  }) => {
    // 全选路由只需点一下（约 5 秒），每个金额测试约需 90 秒
    const timeoutMs = Math.max(300_000, 60_000 + AMOUNTS.length * 90_000);
    test.setTimeout(timeoutMs);

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  Peach Protocol – Swap Route Count Change Test');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`Amounts:       ${AMOUNTS.join(', ')}`);
    console.log(`Pay Token:     ${PAY_TOKEN}`);
    console.log(`Receive Token: ${RECEIVE_TOKEN}`);
    console.log(`Mode:          DRY RUN (no on-chain transactions)`);
    console.log('───────────────────────────────────────────────────────────');

    const swapPage = new SwapPage(page);

    // ── Step 1: 导航到页面并连接钱包 ─────────────────────────────────────
    console.log('\n[Step 1] Navigating and connecting wallet...');
    await swapPage.goto();
    await metamask.connect(page);

    await expect(
      page.locator('text=/0x[a-fA-F0-9]{3,}/i').first(),
    ).toBeVisible({ timeout: 10000 });
    console.log('✓ Wallet connected');

    // ── Step 2: 选择代币对 ───────────────────────────────────────────────
    console.log('\n[Step 2] Selecting token pair...');
    console.log(`Pay:     ${PAY_TOKEN}`);
    console.log(`Receive: ${RECEIVE_TOKEN}`);
    await swapPage.selectToken('pay', PAY_TOKEN);
    await swapPage.selectToken('receive', RECEIVE_TOKEN);
    console.log('✓ Token pair selected');

    // ── Step 3: 选中全部 24 条路由 ──────────────────────────────────────
    // 直接点击 Liquidity Sources 面板右上角的全选 checkbox，一键选中全部 24 条
    console.log('\n[Step 3] Selecting all 24 liquidity sources via select-all toggle...');
    await swapPage.openSettings();
    await swapPage.openLiquiditySources();
    await swapPage.selectAllSources();
    await swapPage.confirmSettingsChanges();
    console.log('✓ All 24 routes selected and confirmed');

    // ── Step 4: 依次测试每个金额 ─────────────────────────────────────────
    console.log('\n[Step 4] Testing route counts for each amount...');
    const results: AmountResult[] = [];

    for (let i = 0; i < AMOUNTS.length; i++) {
      const amount = AMOUNTS[i];
      const startMs = Date.now();
      console.log(`\n${'─'.repeat(55)}`);
      console.log(`  [${i + 1}/${AMOUNTS.length}] Amount: ${amount}`);
      console.log(`${'─'.repeat(55)}`);

      try {
        // 输入金额并等待报价
        await swapPage.enterPayAmount(amount);
        console.log(`  ✓ Amount entered: ${amount}`);

        // 等待 UI 稳定（金额越大路由重新计算越慢，动态等待）
        const amountVal = parseFloat(amount);
        const waitMs = amountVal >= 1 ? 4000 : 2000;
        await page.waitForTimeout(waitMs);

        // 读取报价
        const quote = await swapPage.getReceiveAmount();
        console.log(`  Quote: ${amount} → ${quote || '(none)'}`);

        // 读取路由数量
        const routeCount = await swapPage.getRouteCount();
        console.log(`  Route Count: ${routeCount}`);

        // 计算汇率（用去掉千位逗号的 safeQuote）
        const safeQuote = (quote || '0').replace(/,/g, '');
        const quoteValue = parseFloat(safeQuote);
        const amountValue = parseFloat(amount);
        const exchangeRate = quoteValue > 0 && amountValue > 0
          ? (quoteValue / amountValue).toFixed(6)
          : '0';

        console.log(`  Exchange Rate: 1 : ${exchangeRate}`);
        console.log(`  Duration: ${((Date.now() - startMs) / 1000).toFixed(1)}s`);

        // 输出结构化日志（供 dashboard 解析）
        console.log(`##ROUTE_CHANGE_RESULT:amount=${amount},routeCount=${routeCount},quote=${safeQuote},rate=${exchangeRate}##`);

        results.push({
          amount,
          routeCount,
          quote: safeQuote,
          exchangeRate,
          durationMs: Date.now() - startMs,
        });

      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const safemsg = msg.replace(/[,#\n\r]/g, ' ').trim();
        console.log(`  ✗ Error for amount ${amount}: ${msg}`);
        console.log(`##ROUTE_CHANGE_RESULT:amount=${amount},routeCount=0,quote=0,rate=0,error=${safemsg}##`);

        results.push({
          amount,
          routeCount: 0,
          quote: '0',
          exchangeRate: '0',
          durationMs: Date.now() - startMs,
          error: msg,
        });

        // 刷新页面，继续下一个金额
        try {
          await page.reload({ waitUntil: 'networkidle' });
          await page.waitForTimeout(2000);
          // 重新选择代币，并重新全选路由
          await swapPage.selectToken('pay', PAY_TOKEN);
          await swapPage.selectToken('receive', RECEIVE_TOKEN);
          await swapPage.openSettings();
          await swapPage.openLiquiditySources();
          await swapPage.selectAllSources();
          await swapPage.confirmSettingsChanges();
          console.log('  ✓ Recovered: token pair and all routes re-selected');
        } catch (_) {
          // 忽略恢复错误
        }
      }
    }

    // ── Step 5: 输出汇总报告 ──────────────────────────────────────────────
    console.log(`\n${'═'.repeat(60)}`);
    console.log('  ROUTE COUNT CHANGE TEST REPORT');
    console.log(`${'═'.repeat(60)}`);
    console.log(`  Pay Token:     ${PAY_TOKEN}`);
    console.log(`  Receive Token: ${RECEIVE_TOKEN}`);
    console.log(`${'─'.repeat(60)}`);
    console.log(`  ${'Amount'.padEnd(12)} ${'Route Count'.padEnd(14)} ${'Quote'.padEnd(20)} ${'Rate'.padEnd(14)} ${'Duration'}`);
    console.log(`  ${'─'.repeat(55)}`);

    const routeCounts = new Set<number>();
    for (const r of results) {
      const icon = r.error ? '✗' : '✓';
      const durationStr = `${(r.durationMs / 1000).toFixed(1)}s`;
      console.log(
        `  ${icon} ${r.amount.padEnd(12)} ${String(r.routeCount).padEnd(14)} ${r.quote.padEnd(20)} 1:${r.exchangeRate.padEnd(10)} ${durationStr}`,
      );
      if (!r.error) routeCounts.add(r.routeCount);
    }

    console.log(`${'─'.repeat(60)}`);

    // ── 路由变化分析 ──
    const hasRouteChange = routeCounts.size > 1;
    const routeCountList = [...routeCounts].sort((a, b) => a - b);

    console.log(`\n  Route Count Analysis:`);
    console.log(`  Observed counts: ${routeCountList.join(', ')}`);
    console.log(`  Route changed:   ${hasRouteChange ? 'YES ✓ (different amounts yield different route counts)' : 'NO — All amounts use the same route count'}`);

    // 输出结构化汇总（供 dashboard 解析）
    console.log(`##ROUTE_CHANGE_SUMMARY:changed=${hasRouteChange},counts=${routeCountList.join('|')},totalAmounts=${results.length}##`);

    if (hasRouteChange) {
      console.log('\n  Route count changes detected:');
      for (let i = 1; i < results.length; i++) {
        const prev = results[i - 1];
        const curr = results[i];
        if (prev.routeCount !== curr.routeCount) {
          console.log(
            `  → Amount ${prev.amount} (${prev.routeCount} route${prev.routeCount !== 1 ? 's' : ''})` +
            ` → Amount ${curr.amount} (${curr.routeCount} route${curr.routeCount !== 1 ? 's' : ''})`,
          );
        }
      }
    }

    console.log(`${'═'.repeat(60)}\n`);

    // 验证：所有金额都应成功获取报价（没有全部报错）
    const successCount = results.filter((r) => !r.error).length;
    expect(
      successCount,
      `At least one amount should successfully fetch a quote (got ${successCount}/${results.length})`,
    ).toBeGreaterThan(0);
  });
});
