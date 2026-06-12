import { DeepbookLimitPage } from '@/page-objects/deepbook-limit.page.js';

import { test } from '../setup/fixtures.js';

/**
 * P0: DeepBook Spot 限价单挂单 — 买单 + 卖单 + Open Orders 验证
 *
 * 整体流程（单个 test 用例中完成）：
 *
 *   阶段 1 — 获取当前 SUI 市价
 *     通过市价单 Est.Buy（1 USDC → X SUI）推算 SUI/USDC 市价
 *
 *   阶段 2 — 限价买单
 *     切换到 Spot / Limit / Buy
 *     价格填入 SUI 市价 × 80%（以低于市价挂买单）
 *     数量填入 1 SUI
 *     点击 "Place Buy Order" → 钱包确认
 *     等待成功提示
 *
 *   阶段 3 — 限价卖单
 *     切换到 Spot / Limit / Sell
 *     价格填入 SUI 市价 × 120%（以高于市价挂卖单）
 *     数量填入 1 SUI
 *     点击 "Place Sell Order" → 钱包确认
 *     等待成功提示
 *
 *   阶段 4 — Open Orders 验证
 *     点击底部 "Open Orders" 标签
 *     断言列表中至少出现 2 条挂单（买单 + 卖单）
 */

const DEEPBOOK_POOL_PATH =
  '/deepbook/0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407';

/** 限价买单：以市价的 80% 挂单（低于市价，不会立即成交） */
const BUY_PRICE_RATIO = 0.8;

/** 限价卖单：以市价的 120% 挂单（高于市价，不会立即成交） */
const SELL_PRICE_RATIO = 1.2;

/** 买单 / 卖单数量均为 1 SUI */
const ORDER_AMOUNT = '1';

test.describe('Cetus Mainnet DeepBook Limit Order', () => {
  test(
    'places a SUI-USDC limit buy order and limit sell order, then verifies both in Open Orders',
    async ({ page, walletController }) => {
      // 允许 5 分钟：两笔钱包交互 + 链上延迟 + Open Orders 刷新
      test.setTimeout(300_000);

      const limitPage = new DeepbookLimitPage(page);

      // ── 导航 & 连接钱包 ────────────────────────────────────────────────────────
      await limitPage.goto(DEEPBOOK_POOL_PATH);
      await walletController.connect(page);
      console.log('[deepbook-limit:e2e] Wallet connected');

      // ── 阶段 1: 获取 SUI 市价 ─────────────────────────────────────────────────
      const suiMarketPrice = await limitPage.readSuiMarketPrice();
      console.log(`[deepbook-limit:e2e] SUI market price: ${suiMarketPrice.toFixed(6)} USDC`);

      // 买单价格 = 市价 × 80%，保留 6 位小数
      const buyPrice = Math.round(suiMarketPrice * BUY_PRICE_RATIO * 1e6) / 1e6;
      const buyPriceStr = buyPrice.toFixed(6).replace(/\.?0+$/, '');

      // 卖单价格 = 市价 × 120%，保留 6 位小数
      const sellPrice = Math.round(suiMarketPrice * SELL_PRICE_RATIO * 1e6) / 1e6;
      const sellPriceStr = sellPrice.toFixed(6).replace(/\.?0+$/, '');

      console.log(
        `[deepbook-limit:e2e] Buy price (×80%): ${buyPriceStr} USDC` +
          ` | Sell price (×120%): ${sellPriceStr} USDC`
      );

      // ── 阶段 2: 限价买单 ──────────────────────────────────────────────────────
      console.log('[deepbook-limit:e2e] === Phase 2: Limit Buy Order ===');

      await limitPage.ensureSpotLimitBuy();
      await limitPage.fillPrice(buyPriceStr);
      await limitPage.fillLimitAmount(ORDER_AMOUNT);

      console.log(
        `[deepbook-limit:e2e] Placing limit buy: price=${buyPriceStr} USDC, amount=${ORDER_AMOUNT} SUI`
      );

      await limitPage.placeLimitBuyOrder();
      await walletController.approveTransaction(page);
      console.log('[deepbook-limit:e2e] Buy order transaction approved');

      await limitPage.expectSuccess();
      console.log('[deepbook-limit:e2e] ✓ Limit buy order placed successfully');

      // 关闭 "Transaction Completed" 弹窗，避免遮挡卖单界面
      await limitPage.dismissTransactionDialogIfPresent();

      // ── 阶段 3: 限价卖单 ──────────────────────────────────────────────────────
      console.log('[deepbook-limit:e2e] === Phase 3: Limit Sell Order ===');

      await limitPage.ensureSpotLimitSell();
      await limitPage.fillPrice(sellPriceStr);
      await limitPage.fillLimitAmount(ORDER_AMOUNT);

      console.log(
        `[deepbook-limit:e2e] Placing limit sell: price=${sellPriceStr} USDC, amount=${ORDER_AMOUNT} SUI`
      );

      await limitPage.placeLimitSellOrder();
      await walletController.approveTransaction(page);
      console.log('[deepbook-limit:e2e] Sell order transaction approved');

      await limitPage.expectSuccess();
      console.log('[deepbook-limit:e2e] ✓ Limit sell order placed successfully');

      // 关闭卖单成功弹窗
      await limitPage.dismissTransactionDialogIfPresent();

      // ── 阶段 4: 验证 Open Orders ──────────────────────────────────────────────
      console.log('[deepbook-limit:e2e] === Phase 4: Open Orders Verification ===');

      await limitPage.openOpenOrdersTab();

      // 精确验证：本次下的买单（Side=Buy, price≈buyPriceStr）出现在 Open Orders 列表中
      await limitPage.expectOrderInOpenOrders('Buy', buyPriceStr, 30_000);

      // 精确验证：本次下的卖单（Side=Sell, price≈sellPriceStr）出现在 Open Orders 列表中
      await limitPage.expectOrderInOpenOrders('Sell', sellPriceStr, 30_000);

      console.log('[deepbook-limit:e2e] ✓ Buy limit order visible in Open Orders');
      console.log('[deepbook-limit:e2e] ✓ Sell limit order visible in Open Orders');
      console.log('[deepbook-limit:e2e] ✓ All assertions passed');
    }
  );
});
