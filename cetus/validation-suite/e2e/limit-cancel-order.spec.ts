import { LimitPage } from '@/page-objects/limit.page.js';

import { test } from '../setup/fixtures.js';

test.describe('Cetus Mainnet Limit Order Cancel', () => {
  test('cancels an existing SUI limit order', async ({ page, walletController }) => {
    const limitPage = new LimitPage(page);
    await limitPage.goto();

    await walletController.connect(page);
    await limitPage.openOrdersPanel();
    if (!(await limitPage.hasOpenOrderToCancel())) {
      throw new Error('No open limit order available to cancel.');
    }

    await limitPage.cancelFirstOpenOrder();
    await walletController.approveTransaction(page);
    await limitPage.expectOrderCancelled();
  });
});
