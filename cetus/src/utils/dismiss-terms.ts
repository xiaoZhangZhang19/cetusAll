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
 * Margin 页的「Risk Acknowledgement」弹窗容器。
 *
 * /margin 首次进入会连着弹两个 modal：条款弹窗（Select default explorer）和这个
 * 风险确认弹窗。它盖着的时候 chakra 会给兄弟节点打 aria-hidden，header 上的
 * Connect 按钮在 a11y 树里直接消失 —— connect() 里那三路 getByRole 竞速会全部
 * 落空、白等满 20s，然后静默返回「没连上」。所以必须在 connect 之前关掉。
 */
export function riskAckModal(page: Page): Locator {
  return page
    .locator('[role="dialog"], .chakra-modal__content')
    .filter({ hasText: /risk acknowledge?ment/i })
    .last();
}

/** 条款弹窗容器。 */
export function termsModal(page: Page): Locator {
  // 用「Select default explorer」锚定条款弹窗本体：这段文案只在条款弹窗里出现，
  // 比全局找 Confirm 按钮安全 —— 代币选择器弹窗也有 Confirm，会被误判成条款弹窗。
  return page
    .locator('[role="dialog"], .chakra-modal__content')
    .filter({ hasText: /select default explorer/i })
    .last();
}

/**
 * Dismisses the Cetus Protocol Terms & Conditions modal if it is present.
 *
 * 弹窗由前端本地状态驱动，DOM 一 hydrate 就出现，不必先等整页 networkidle。
 *
 * Steps:
 *   1. 勾选 "Agree to the terms"（自定义 div 复选框，非 input）
 *   2. 勾选一个默认浏览器（SuiVision）
 *   3. 点 Confirm 并等弹窗消失
 */
export async function dismissCetusTerms(page: Page, options: DismissTermsOptions = {}): Promise<void> {
  const timeout = options.timeout ?? 0;
  const modal = termsModal(page);
  const confirmButton = modal.getByRole('button', { name: /^confirm$/i }).first();

  // timeout=0 → 只做一次即时判定，不轮询、不等待。
  const appeared = timeout > 0
    ? await modal.waitFor({ state: 'visible', timeout }).then(() => true, () => false)
    : await modal.isVisible().catch(() => false);
  if (!appeared) {
    return;
  }

  await page.bringToFront().catch(() => undefined);

  // 提前介入意味着弹窗可能还在做入场动画，坐标点击前必须等位置稳定，
  // 否则 boundingBox 拿到的是动画中间帧，点击会落空。
  await waitForStableBox(page, confirmButton);

  // 必须两个条件都满足 Confirm 才会启用：勾同意条款 + 选一个 explorer。
  await checkTermsOption(modal, 'Agree to the terms');
  await checkTermsOption(modal, 'SuiVision');

  await expect(confirmButton).toBeEnabled({ timeout: 15_000 });
  await confirmButton.click();
  await confirmButton.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
}

/**
 * 关掉 margin 的 Risk Acknowledgement 弹窗。
 *
 * 复选框结构与条款弹窗一致（文案左侧的空 div，勾上后插入 svg），所以直接复用
 * checkTermsOption，不再用「boundingBox 左移 20px 像素点击 + sleep 200ms」那套。
 *
 * 顺手勾上 "Don't remind me again"，否则点开仓按钮时它会再弹一次、拦住交易。
 */
export async function dismissRiskAcknowledgement(
  page: Page,
  options: DismissTermsOptions = {}
): Promise<boolean> {
  const timeout = options.timeout ?? 0;
  const modal = riskAckModal(page);
  const continueButton = modal.getByRole('button', { name: /^continue$/i }).first();

  const appeared = timeout > 0
    ? await modal.waitFor({ state: 'visible', timeout }).then(() => true, () => false)
    : await modal.isVisible().catch(() => false);
  if (!appeared) return false;

  await page.bringToFront().catch(() => undefined);
  await waitForStableBox(page, continueButton);

  // 用正则而不是 exact 字符串：文案带句点（"...all the risk."），且 "Don't" 的撇号
  // 有直/弯两种写法，exact 匹配一旦对不上就勾不上、Continue 永远 disabled。
  await checkTermsOption(modal, /^\s*I acknowledge and accept all the risk\.?\s*$/i);
  await checkTermsOption(modal, /^\s*Don.?t remind me again\.?\s*$/i);

  await expect(continueButton).toBeEnabled({ timeout: 15_000 });
  await continueButton.click();
  await modal.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
  return true;
}

/**
 * 一次关掉「条款 + 风险确认」两个弹窗。
 *
 * /margin 是两个连着弹：条款关掉后风险弹窗才挂载，所以关完第一个要再给第二个
 * 一个轮询窗口；反过来（风险先出现）也成立，因此两轮各查一次。
 * 普通页面只有条款弹窗，第二次查询即时返回 false，不额外付时间。
 */
export async function dismissBlockingModals(
  page: Page,
  options: DismissTermsOptions = {}
): Promise<void> {
  // 不能「先等条款 10s、再等风险 3s」串起来：/margin 上条款弹窗可能根本不出现，
  // 那样每次都白等满 10s。这里竞速等「两者任一可见」，关掉后再用短窗口找下一个。
  let budget = options.timeout ?? 0;

  for (let round = 0; round < 3; round++) {
    const which = budget > 0
      ? await raceFirstVisible(budget, { terms: termsModal(page), risk: riskAckModal(page) })
      : await firstVisibleNow(page);
    if (which === 'none') return;

    if (which === 'terms') await dismissCetusTerms(page).catch(() => undefined);
    else await dismissRiskAcknowledgement(page).catch(() => undefined);

    // 第一个关掉后第二个才挂载，给它一个短窗口；再往后就只做即时判定。
    budget = round === 0 ? 3_000 : 0;
  }
}

/** 即时判定哪个弹窗正盖着（不轮询）。 */
async function firstVisibleNow(page: Page): Promise<'terms' | 'risk' | 'none'> {
  if (await riskAckModal(page).isVisible().catch(() => false)) return 'risk';
  if (await termsModal(page).isVisible().catch(() => false)) return 'terms';
  return 'none';
}

/** 竞速等多个 locator 任一可见，返回最先可见的 key；全超时返回 'none'。 */
async function raceFirstVisible<K extends string>(
  timeout: number,
  locators: Record<K, Locator>
): Promise<K | 'none'> {
  const branches = (Object.entries(locators) as Array<[K, Locator]>).map(([key, locator]) =>
    locator.waitFor({ state: 'visible', timeout }).then(
      () => key,
      () => null
    )
  );

  return Promise.any(
    branches.map((b) => b.then((key) => (key === null ? Promise.reject(new Error('not visible')) : key)))
  ).catch(() => 'none' as const);
}

/**
 * 勾选条款弹窗里的一个自定义复选框。
 *
 * 这些「复选框」不是 `input[type=checkbox]`，而是文案左侧的一个空 `<div>`；
 * 勾上之后该 div 内部才会插入一个 `<svg>` 对勾。所以：
 *   - 定位：文案 `<p>` 的父容器（chakra Stack 行）下的第一个 `<div>`；
 *   - 判定已勾选：该 div 内部存在 svg。
 * 旧实现用 label 的 boundingBox 做像素偏移点击，布局一变就点空，
 * Confirm 保持 disabled，用例直接卡死在这里。
 */
async function checkTermsOption(modal: Locator, label: string | RegExp): Promise<void> {
  const text = typeof label === 'string'
    ? modal.getByText(label, { exact: true }).first()
    : modal.getByText(label).first();
  // 找不到就直接返回：风险弹窗里 "Don't remind me again" 的撇号有直/弯两种写法，
  // 调用方会把两种都试一遍，没命中的那次不该白等 3s。
  if (!(await text.waitFor({ state: 'visible', timeout: 1_500 }).then(() => true, () => false))) return;

  const box = text.locator('xpath=..').locator('> div').first();
  for (let attempt = 0; attempt < 3; attempt++) {
    if ((await box.locator('svg').count().catch(() => 0)) > 0) return;
    await box.click({ timeout: 3_000 }).catch(() => undefined);
    await expect(box.locator('svg').first())
      .toBeAttached({ timeout: 1_500 })
      .catch(() => undefined);
  }
}

/** 轮询 boundingBox 直到连续两帧位置一致，确认入场动画已结束。 */
async function waitForStableBox(page: Page, locator: Locator, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  let previous = await locator.boundingBox().catch(() => null);
  while (Date.now() < deadline) {
    // 50ms 一帧：chakra 的入场动画约 150~200ms，轮询越密越早返回。
    await page.waitForTimeout(50);
    const current = await locator.boundingBox().catch(() => null);
    if (current && previous && current.x === previous.x && current.y === previous.y) {
      return;
    }
    previous = current;
  }
}
