import { DcaPage } from '@/page-objects/dca.page.js';

import { test } from '../setup/fixtures.js';

test.describe('Cetus Mainnet DCA Close', () => {
  test('closes an existing DCA order', async ({ page, walletController }) => {
    const dcaPage = new DcaPage(page);
    await dcaPage.goto();

    await walletController.connect(page);
    await dcaPage.openOrdersPanel();
    if (!(await dcaPage.hasActiveOrderToClose())) {
      throw new Error('No active DCA order available to close.');
    }

    await dcaPage.closeFirstActiveOrder();
    await walletController.approveTransaction(page);
    await dcaPage.expectOrderClosed();
  });
});
