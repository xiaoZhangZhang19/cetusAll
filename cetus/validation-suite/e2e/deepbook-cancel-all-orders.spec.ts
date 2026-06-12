import { DeepbookLimitPage } from '@/page-objects/deepbook-limit.page.js';

import { expect, test } from '../setup/fixtures.js';

/**
 * P0: DeepBook 限价单 — Cancel All + 余额验证
 *
 * ─── 前置条件 ────────────────────────────────────────────────────────────────
 *   Open Orders 中已存在至少 1 笔 Sell 限价单（锁定 SUI）和
 *   至少 1 笔 Buy 限价单（锁定 USDC）。如不存在则自动创建。
 *
 * ─── 测试流程 ────────────────────────────────────────────────────────────────
 *
 *  阶段 1  读取 Open Orders 原始数据
 *    - Buy  单：Price × lockedQty = 预计锁定 USDC
 *    - Sell 单：lockedQty         = 预计锁定 SUI
 *
 *  阶段 2  Hover token row 读取 Locked 数量并与订单计算结果比对
 *    - hover SUI  token 行 → popup 显示 Locked SUI  数量 → ≈ 订单计算值
 *    - hover USDC token 行 → popup 显示 Locked USDC 数量 → ≈ 订单计算值
 *
 *  阶段 3  Cancel All + 钱包确认
 *
 *  阶段 4  刷新页面，验证 Open Orders 为空
 *
 *  阶段 5  再次 hover token row 验证 Locked = 0 且 Free Balance 增加
 *    - hover SUI  token 行 → Locked = 0，Free Balance ≥ 之前 lockedSUI
 *    - hover USDC token 行 → Locked = 0，Free Balance ≥ 之前 lockedUSDC
 *
 *  背景说明：Cetus DeepBook 撤单后资产转为 DeepBook Free Balance，
 *  不会自动退回链上钱包，需手动 Withdraw 才会入账。
 */

const DEEPBOOK_POOL_PATH =
  '/deepbook/0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407';

/** 数值比对容差（覆盖 gas fee 及 UI 显示精度差异） */
const TOLERANCE = 0.05;

test.describe('Cetus Mainnet DeepBook Cancel All Limit Orders', () => {
  test(
    'cancel all orders: verify locked amounts then confirm locked→0 and free balance increases',
    async ({ page, walletController }) => {
      test.setTimeout(300_000);

      const limitPage = new DeepbookLimitPage(page);

      // ── 导航 & 连接钱包 ───────────────────────────────────────────────────────
      await limitPage.goto(DEEPBOOK_POOL_PATH);
      await walletController.connect(page);
      console.log('[deepbook-cancel-all:e2e] Wallet connected');

      // ── 前置：若无挂单则先创建 1 笔买单 + 1 笔卖单 ───────────────────────────
      await limitPage.openOpenOrdersTab();
      let orders = await limitPage.readOpenOrderRows();

      if (orders.length === 0) {
        console.log('[deepbook-cancel-all:e2e] No open orders found — creating test orders first');

        const suiMarketPrice = await limitPage.readSuiMarketPrice();
        const buyPriceStr  = (Math.round(suiMarketPrice * 0.8  * 1e6) / 1e6)
          .toFixed(6).replace(/\.?0+$/, '');
        const sellPriceStr = (Math.round(suiMarketPrice * 1.2  * 1e6) / 1e6)
          .toFixed(6).replace(/\.?0+$/, '');

        await limitPage.ensureSpotLimitBuy();
        await limitPage.fillPrice(buyPriceStr);
        await limitPage.fillLimitAmount('1');
        await limitPage.placeLimitBuyOrder();
        await walletController.approveTransaction(page);
        await limitPage.expectSuccess();
        await limitPage.dismissTransactionDialogIfPresent();
        console.log(`[deepbook-cancel-all:e2e] Buy order placed at ${buyPriceStr} USDC`);

        await limitPage.ensureSpotLimitSell();
        await limitPage.fillPrice(sellPriceStr);
        await limitPage.fillLimitAmount('1');
        await limitPage.placeLimitSellOrder();
        await walletController.approveTransaction(page);
        await limitPage.expectSuccess();
        await limitPage.dismissTransactionDialogIfPresent();
        console.log(`[deepbook-cancel-all:e2e] Sell order placed at ${sellPriceStr} USDC`);

        await limitPage.goto(DEEPBOOK_POOL_PATH);
        await walletController.connect(page);
        await limitPage.openOpenOrdersTab();
        await page.waitForTimeout(5_000);

        orders = await limitPage.readOpenOrderRows();
        console.log(`[deepbook-cancel-all:e2e] ${orders.length} order(s) now visible`);
      }

      // ════════════════════════════════════════════════════════════════
      // 阶段 1  读取 Open Orders 原始数据，计算预计 locked 数量
      // ════════════════════════════════════════════════════════════════
      console.log('[deepbook-cancel-all:e2e] === Phase 1: Read open order rows ===');

      expect(orders.length, 'At least one open order must exist before Cancel All').toBeGreaterThan(0);

      const buyOrders  = orders.filter(o => o.side === 'Buy');
      const sellOrders = orders.filter(o => o.side === 'Sell');

      // Buy  order: locked USDC = price × lockedQty
      const expectedLockedUsdc = buyOrders.reduce((sum, o) => sum + o.price * o.lockedQuantity, 0);
      // Sell order: locked SUI  = lockedQty
      const expectedLockedSui  = sellOrders.reduce((sum, o) => sum + o.lockedQuantity, 0);

      console.log(
        `[deepbook-cancel-all:e2e] Orders — Buy: ${buyOrders.length}, Sell: ${sellOrders.length}`
      );
      console.log(
        `[deepbook-cancel-all:e2e] Expected locked → SUI: ${expectedLockedSui.toFixed(6)}` +
        ` | USDC: ${expectedLockedUsdc.toFixed(6)}`
      );

      // ════════════════════════════════════════════════════════════════
      // 阶段 2  Hover token row，从 popup 读取 Locked 数量并与订单计算比对
      //
      //  Hover SUI / USDC token 行 → popup 弹出：
      //    Locked      SUI   X ($...)     ← 当前被锁定量
      //    Free Balance SUI  Y ($...)     ← 当前空闲量
      // ════════════════════════════════════════════════════════════════
      console.log('[deepbook-cancel-all:e2e] === Phase 2: Hover token rows — verify locked amounts ===');

      // Hover SUI token 行
      const suiBefore = await limitPage.hoverTokenAndReadLockedFreeBalance('SUI');
      console.log(
        `[deepbook-cancel-all:e2e] SUI  before → locked=${suiBefore?.locked ?? 'n/a'}` +
        ` freeBalance=${suiBefore?.freeBalance ?? 'n/a'}`
      );

      // Hover USDC token 行
      const usdcBefore = await limitPage.hoverTokenAndReadLockedFreeBalance('USDC');
      console.log(
        `[deepbook-cancel-all:e2e] USDC before → locked=${usdcBefore?.locked ?? 'n/a'}` +
        ` freeBalance=${usdcBefore?.freeBalance ?? 'n/a'}`
      );

      // 验证 hover 读到的 locked 值 ≈ 订单计算值
      if (suiBefore !== null && expectedLockedSui > 0) {
        expect(
          suiBefore.locked,
          `SUI Locked from popup (${suiBefore.locked}) should ≈ order calc (${expectedLockedSui})`
        ).toBeCloseTo(expectedLockedSui, 1);
        console.log(
          `[deepbook-cancel-all:e2e] ✓ SUI  locked matches: popup=${suiBefore.locked}` +
          ` ≈ calc=${expectedLockedSui.toFixed(4)}`
        );
      }

      if (usdcBefore !== null && expectedLockedUsdc > 0) {
        expect(
          usdcBefore.locked,
          `USDC Locked from popup (${usdcBefore.locked}) should ≈ order calc (${expectedLockedUsdc})`
        ).toBeCloseTo(expectedLockedUsdc, 1);
        console.log(
          `[deepbook-cancel-all:e2e] ✓ USDC locked matches: popup=${usdcBefore.locked}` +
          ` ≈ calc=${expectedLockedUsdc.toFixed(4)}`
        );
      }

      // ════════════════════════════════════════════════════════════════
      // 阶段 3  Cancel All + 钱包确认
      // ════════════════════════════════════════════════════════════════
      console.log('[deepbook-cancel-all:e2e] === Phase 3: Cancel All ===');

      await limitPage.clickCancelAllOrders();
      console.log('[deepbook-cancel-all:e2e] Clicked "Cancel All"');

      await walletController.approveTransaction(page);
      console.log('[deepbook-cancel-all:e2e] Wallet transaction approved');

      await limitPage.expectSuccess();
      console.log('[deepbook-cancel-all:e2e] ✓ Cancel All confirmed on-chain');

      // ════════════════════════════════════════════════════════════════
      // 阶段 4  刷新页面，验证 Open Orders 为空
      // ════════════════════════════════════════════════════════════════
      console.log('[deepbook-cancel-all:e2e] === Phase 4: Reload & verify Open Orders is empty ===');

      await limitPage.goto(DEEPBOOK_POOL_PATH);
      await walletController.connect(page);
      await limitPage.openOpenOrdersTab();
      await page.waitForTimeout(4_000);

      const ordersAfter = await limitPage.readOpenOrderRows();
      console.log(`[deepbook-cancel-all:e2e] Open Orders after cancel: ${ordersAfter.length} row(s)`);
      expect(ordersAfter.length, 'Open Orders should be empty after Cancel All').toBe(0);
      console.log('[deepbook-cancel-all:e2e] ✓ Open Orders is empty — all orders cancelled');

      // ════════════════════════════════════════════════════════════════
      // 阶段 5  再次 hover token row，验证：
      //   - Locked     = 0 （原 locked 数量消失）
      //   - Free Balance ≥ 之前被 locked 的数量（locked → free 的转移）
      // ════════════════════════════════════════════════════════════════
      console.log('[deepbook-cancel-all:e2e] === Phase 5: Hover token rows — verify locked=0 & free balance increased ===');

      // Hover SUI token 行（撤单后）
      const suiAfter = await limitPage.hoverTokenAndReadLockedFreeBalance('SUI');
      console.log(
        `[deepbook-cancel-all:e2e] SUI  after  → locked=${suiAfter?.locked ?? 'n/a'}` +
        ` freeBalance=${suiAfter?.freeBalance ?? 'n/a'}`
      );

      // Hover USDC token 行（撤单后）
      const usdcAfter = await limitPage.hoverTokenAndReadLockedFreeBalance('USDC');
      console.log(
        `[deepbook-cancel-all:e2e] USDC after  → locked=${usdcAfter?.locked ?? 'n/a'}` +
        ` freeBalance=${usdcAfter?.freeBalance ?? 'n/a'}`
      );

      // ── SUI 验证 ─────────────────────────────────────────────────────────────
      if (suiAfter !== null) {
        // Locked 应为 0
        expect(
          suiAfter.locked,
          `SUI Locked should be 0 after Cancel All, got ${suiAfter.locked}`
        ).toBeLessThanOrEqual(TOLERANCE);
        console.log(`[deepbook-cancel-all:e2e] ✓ SUI  Locked  = ${suiAfter.locked} (≈ 0 ✓)`);

        // Free Balance 应 ≥ 之前被锁定的量
        if (expectedLockedSui > 0) {
          const suiFreeBaseline = suiBefore?.freeBalance ?? 0;
          expect(
            suiAfter.freeBalance,
            `SUI Free Balance after cancel (${suiAfter.freeBalance}) should be ≥` +
            ` baseline+locked (${(suiFreeBaseline + expectedLockedSui).toFixed(4)})`
          ).toBeGreaterThanOrEqual(suiFreeBaseline + expectedLockedSui - TOLERANCE);
          console.log(
            `[deepbook-cancel-all:e2e] ✓ SUI  Free Balance = ${suiAfter.freeBalance}` +
            ` ≥ ${(suiFreeBaseline + expectedLockedSui).toFixed(4)} ✓`
          );
        }
      }

      // ── USDC 验证 ────────────────────────────────────────────────────────────
      if (usdcAfter !== null) {
        // Locked 应为 0
        expect(
          usdcAfter.locked,
          `USDC Locked should be 0 after Cancel All, got ${usdcAfter.locked}`
        ).toBeLessThanOrEqual(TOLERANCE);
        console.log(`[deepbook-cancel-all:e2e] ✓ USDC Locked  = ${usdcAfter.locked} (≈ 0 ✓)`);

        // Free Balance 应 ≥ 之前被锁定的量
        if (expectedLockedUsdc > 0) {
          const usdcFreeBaseline = usdcBefore?.freeBalance ?? 0;
          expect(
            usdcAfter.freeBalance,
            `USDC Free Balance after cancel (${usdcAfter.freeBalance}) should be ≥` +
            ` baseline+locked (${(usdcFreeBaseline + expectedLockedUsdc).toFixed(4)})`
          ).toBeGreaterThanOrEqual(usdcFreeBaseline + expectedLockedUsdc - TOLERANCE);
          console.log(
            `[deepbook-cancel-all:e2e] ✓ USDC Free Balance = ${usdcAfter.freeBalance}` +
            ` ≥ ${(usdcFreeBaseline + expectedLockedUsdc).toFixed(4)} ✓`
          );
        }
      }

      console.log('[deepbook-cancel-all:e2e] ✓ All assertions passed');
    }
  );
});
