import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Dismisses the Cetus Protocol Terms & Conditions modal if it is present.
 *
 * Steps:
 *   1. Locate "Select default explorer" text, offset downward to hit SuiVision checkbox
 *   2. Click Confirm
 */
export async function dismissCetusTerms(page: Page): Promise<void> {
  const confirmButton = page.getByRole('button', { name: /^confirm$/i }).first();

  const confirmVisible = await confirmButton.isVisible({ timeout: 3_000 }).catch(() => false);
  if (!confirmVisible) {
    return;
  }

  await page.bringToFront().catch(() => undefined);
  await page.waitForTimeout(300);

  // Click "Agree to the terms" checkbox (the square to the left of the label text).
  const agreeLabel = page.getByText('Agree to the terms').first();
  if (await agreeLabel.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const agreeBox = await agreeLabel.boundingBox();
    if (agreeBox) {
      await page.mouse.click(Math.max(0, agreeBox.x - 16), agreeBox.y + agreeBox.height / 2);
      await page.waitForTimeout(200);
    }
  }

  // Locate "Select default explorer" label, then click ~20px below it (SuiVision row).
  const selectLabel = page.getByText('Select default explorer').first();
  if (await selectLabel.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const box = await selectLabel.boundingBox();
    if (box) {
      await page.mouse.click(box.x + 10, box.y + box.height + 20);
      await page.waitForTimeout(200);
    }
  }

  await expect(confirmButton).toBeEnabled({ timeout: 15_000 });
  await confirmButton.click();
  await confirmButton.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
}
