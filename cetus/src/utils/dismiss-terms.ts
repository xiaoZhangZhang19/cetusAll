import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

export interface DismissTermsOptions {
  /**
   * 等待弹窗出现的最长时间（毫秒）。
   *
   * - 页面刚 `domcontentloaded` 后调用：给 8~10s，覆盖 hydrate 到弹窗挂载的窗口。
   * - 测试中途的保险调用：用默认的 0（只查一次，不轮询）。此时页面早已 hydrate，
   *   弹窗要么正盖在那儿、要么不会再出现，轮询纯属白等 —— 这类调用点有十几处，
   *   每处哪怕只等 1s 也会白白拖慢整个套件。
   */
  timeout?: number;
}

/**
 * Dismisses the Cetus Protocol Terms & Conditions modal if it is present.
 *
 * 弹窗由前端本地状态驱动，DOM 一 hydrate 就出现，**不需要**先等整页
 * networkidle 再来处理。所以这里只是轮询等弹窗自己冒出来，调用方可以在
 * `goto(..., { waitUntil: 'domcontentloaded' })` 之后立即调用，把原先花在
 * 等图表 / 报价请求收敛上的那几秒省下来。
 *
 * Steps:
 *   1. Locate "Select default explorer" text, offset downward to hit SuiVision checkbox
 *   2. Click Confirm
 */
export async function dismissCetusTerms(page: Page, options: DismissTermsOptions = {}): Promise<void> {
  const timeout = options.timeout ?? 0;
  const confirmButton = page.getByRole('button', { name: /^confirm$/i }).first();

  // timeout=0 → 只做一次即时判定，不轮询、不等待。
  const appeared = timeout > 0
    ? await confirmButton.waitFor({ state: 'visible', timeout }).then(() => true, () => false)
    : await confirmButton.isVisible().catch(() => false);
  if (!appeared) {
    return;
  }

  await page.bringToFront().catch(() => undefined);

  // 提前介入意味着弹窗可能还在做入场动画，坐标点击前必须等位置稳定，
  // 否则 boundingBox 拿到的是动画中间帧，点击会落空。
  await waitForStableBox(page, confirmButton);

  // Click "Agree to the terms" checkbox (the square to the left of the label text).
  const agreeLabel = page.getByText('Agree to the terms').first();
  if (await agreeLabel.waitFor({ state: 'visible', timeout: 2_000 }).then(() => true, () => false)) {
    const agreeBox = await agreeLabel.boundingBox();
    if (agreeBox) {
      await page.mouse.click(Math.max(0, agreeBox.x - 16), agreeBox.y + agreeBox.height / 2);
      await page.waitForTimeout(200);
    }
  }

  // Locate "Select default explorer" label, then click ~20px below it (SuiVision row).
  const selectLabel = page.getByText('Select default explorer').first();
  if (await selectLabel.waitFor({ state: 'visible', timeout: 2_000 }).then(() => true, () => false)) {
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

/** 轮询 boundingBox 直到连续两帧位置一致，确认入场动画已结束。 */
async function waitForStableBox(page: Page, locator: Locator, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  let previous = await locator.boundingBox().catch(() => null);
  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    const current = await locator.boundingBox().catch(() => null);
    if (current && previous && current.x === previous.x && current.y === previous.y) {
      return;
    }
    previous = current;
  }
}
