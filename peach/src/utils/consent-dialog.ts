import { type Page } from '@playwright/test';

/**
 * 关闭 Peach 首次进入时的同意弹窗，并等遮罩层彻底消失。
 *
 * 前端出现过两种形态，必须都覆盖：
 *   1. "Welcome to Peach" —— 只有一个 Continue 按钮，没有勾选框（当前线上形态）
 *   2. "Terms & Policies" —— 勾选框 + Confirm 按钮（旧形态）
 * 两者都带 "Terms of Service" / "Privacy Policy" 链接，所以用它做识别锚点，
 * 而不是依赖弹窗标题 —— 按标题精确匹配在改版后会直接失效。
 *
 * 关键点：弹窗 hidden 之后遮罩层（peach-dialog-overlay-motion）还会因为退场
 * 动画在上面停留一会儿，并且 intercept pointer events。这期间点任何按钮都会
 * 被 Playwright 判定「被遮挡」而重试到超时；如果点的是 Connect，首次点击可能
 * 已透传给 AppKit，重试就会得到 "Connection declined — a previous request is
 * still active"。所以必须等遮罩真的消失。
 */

/** 同意弹窗的识别锚点：标题或条款链接。 */
const CONSENT_TEXT = /Welcome to Peach|Terms of Service|Privacy Policy|Terms\s*&?\s*Polic/i;

/** 确认按钮的文案，覆盖两种形态和中文界面。 */
const CONFIRM_TEXT = /^(Continue|Confirm|Agree|Accept|I agree|同意|继续|确认)$/i;

/** Peach 的 dialog 遮罩层。带退场动画，会在弹窗关闭后短暂拦截点击。 */
const OVERLAY_SELECTOR = '[data-slot="dialog-overlay"], .peach-dialog-overlay-motion';

/**
 * 等 dialog 遮罩层从 DOM 移除或变为不可见。
 * 超时不抛异常，只打日志 —— 调用方通常还有重试余地。
 */
export async function waitForOverlayGone(page: Page, timeoutMs = 10_000): Promise<void> {
  const overlay = page.locator(OVERLAY_SELECTOR);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const count = await overlay.count().catch(() => 0);
    if (count === 0) return;

    // 节点仍在 DOM 里也可能已经不可见（动画结束但未卸载）
    let anyVisible = false;
    for (let i = 0; i < count; i++) {
      if (await overlay.nth(i).isVisible().catch(() => false)) {
        anyVisible = true;
        break;
      }
    }
    if (!anyVisible) return;
    await page.waitForTimeout(200);
  }

  console.log('[consent] ⚠ dialog 遮罩层未在超时内消失，后续点击可能被拦截');
}

/**
 * 关闭同意弹窗。
 *
 * @param label     日志前缀，便于分辨是哪个页面触发的
 * @param timeoutMs 等弹窗出现的时长。首次进入建议给足（弹窗由客户端渲染，
 *                  实测 goto 后要几秒才挂载）；作为兜底调用时给小值即可。
 * @returns 弹窗出现并被关闭时返回 true；没有弹窗返回 false。
 */
export async function dismissConsentDialog(
  page: Page,
  label = 'consent',
  timeoutMs = 8_000,
): Promise<boolean> {
  const dialog = page.locator('[role="dialog"]').filter({ hasText: CONSENT_TEXT }).first();

  // isVisible({timeout}) 不轮询，弹窗晚挂载时会误判成「没有弹窗」，所以自己轮询
  const deadline = Date.now() + timeoutMs;
  let found = false;
  while (Date.now() < deadline) {
    if (await dialog.isVisible().catch(() => false)) {
      found = true;
      break;
    }
    await page.waitForTimeout(250);
  }
  if (!found) return false;

  console.log(`[${label}] 同意弹窗出现 — 正在关闭`);

  // 勾选框只在旧形态里存在，没有就跳过（不能用 check()，缺元素会抛错）
  const checkbox = dialog.locator('input[type="checkbox"], [role="checkbox"]').first();
  if (await checkbox.isVisible({ timeout: 1_000 }).catch(() => false)) {
    if (!(await checkbox.isChecked().catch(() => false))) {
      await checkbox.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(300);
    }
  }

  const confirmBtn = dialog.getByRole('button', { name: CONFIRM_TEXT }).first();
  if (await confirmBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await confirmBtn.click({ timeout: 8_000 }).catch((err) => {
      console.log(`[${label}] 确认按钮点击失败: ${String(err).split('\n')[0]}`);
    });
  } else {
    console.log(`[${label}] ⚠ 弹窗里没找到确认按钮，尝试 Escape`);
    await page.keyboard.press('Escape').catch(() => undefined);
  }

  await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
  await waitForOverlayGone(page);
  console.log(`[${label}] 同意弹窗已关闭`);
  return true;
}
