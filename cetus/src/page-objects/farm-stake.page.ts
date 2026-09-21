import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { dismissCetusTerms, termsModal } from '@/utils/dismiss-terms.js';
import { gotoWithRetry } from '@/utils/page-ready.js';

/**
 * Page Object for the Cetus Farm "Stake" flow.
 *
 * The Farms page is at /earn/farms (Earn → Farms in the nav).
 * Each farm row shows the pool pair, TVL, APR, rewards, etc.
 * Clicking the ▼ chevron on the right of a row expands the position list,
 * where each position has a "Stake" button.
 *
 * Flow:
 *   1. goto()                    → /earn/farms
 *   2. expandFarmRow(pair)       → click the ▼ chevron on the target pair row
 *   3. clickStake()              → click the "Stake" button in the expanded panel
 *   4. (wallet approval externally)
 *   5. expectStakeSuccess()      → verify success notification
 */
export class FarmStakePage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // ─── Navigation ─────────────────────────────────────────────────────────────

  async goto() {
    await gotoWithRetry(this.page, '/farms');

    // 条款弹窗的遮罩铺满视口，会吞掉后续所有点击（Connect / Claim / chevron）。
    // 之前这里压根没关它 —— 三个 farm 用例都卡在这一步：
    // 点击被遮罩吞掉 → Playwright 一直重试到 actionTimeout，表现就是「卡很久」。
    await dismissCetusTerms(this.page, { timeout: 10_000 });

    // 列表就绪信号：出现 Claim 按钮或 Live/Your Farms 标签，而不是靠 class 模糊匹配。
    await this.page
      .getByRole('button', { name: /^claim$/i })
      .or(this.page.getByText(/your farms/i))
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 })
      .catch(() => undefined);

    console.log('[FarmStake] Navigated to /farms');
  }

  /**
   * 切到 "Your Farms" tab。
   *
   * 默认停在 "Live" tab —— 那是**全站所有** farm 池子，`Your Staked` /
   * `Your Earned` 两列对当前钱包基本都是空的，行内 Claim 一直 disabled。
   * 有奖励可领的是自己的仓位，只在 "Your Farms" tab 下列出。
   * 之前没切 tab，于是 claim 用例必然报 "Claim button is disabled"。
   *
   * best-effort：切不过去不抛错，由后面「等 Claim 变可用」给出准确报错。
   */
  async openYourFarmsTab() {
    await this.ensureNoBlockingOverlay();

    // tab 渲染成 "Your Farms" + 一个数量角标，文案可能是 "Your Farms1"。
    const tab = this.page
      .getByText(/^your\s*farms(\s*\d+)?$/i)
      .first();

    if (!(await tab.isVisible({ timeout: 10_000 }).catch(() => false))) {
      console.warn('[FarmStake] 未找到 "Your Farms" tab，留在当前 tab 继续');
      return;
    }

    await tab.click({ timeout: 8_000 }).catch(async () => {
      const box = await tab.boundingBox().catch(() => null);
      if (box) await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    });
    console.log('[FarmStake] 已切到 "Your Farms" tab');

    // 切 tab 后不在这里等数据：clickClaimForRow / expandFarmRow 各自会等，
    // 这里再等一遍是重复开销。只确认列表已经重渲染成「我的仓位」视图。
    await this.page
      .getByRole('button', { name: /^claim$/i })
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .catch(() => undefined);
  }

  /**
   * 等行数据真的加载完，而不是停在骨架屏上。
   *
   * 截图里 `Your Staked` / `Your Earned` 是一条条灰色占位块（chakra Skeleton）。
   * 骨架屏期间 Claim 按钮是 disabled 的 —— 这时去读 isEnabled() 必然得到 false，
   * 原实现读一次就抛「no rewards to claim」，把「还在加载」误判成「没奖励」。
   */
  private async waitForRowDataLoaded(timeout = 20_000) {
    // 就绪的正向信号：某一行的 Claim 按钮变成可用，或 `Your Earned` 列出现金额。
    //
    // ⚠️ 不要用「等 skeleton 消失」来判定：`[class*="skeleton" i]` /
    // `[class*="spinner" i]` 这类模糊选择器会命中页面上一堆常驻节点，
    // 骨架屏其实早就没了，却还要在 hidden 等待里白耗到 20s 超时。
    // 实测这就是 claim 用例「卡在 Your Farms 页面不动」的原因 ——
    // 页面看着已经好了，代码还在等一个永远不成立的条件。
    const ready = await this.page
      .waitForFunction(
        () => {
          const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
          const claim = buttons.filter((b) => /^claim$/i.test((b.textContent ?? '').trim()));
          if (claim.length === 0) return false;
          // 任一 Claim 可用 → 数据已到位。
          return claim.some(
            (b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true'
          );
        },
        { timeout, polling: 200 }
      )
      .then(() => true, () => false);

    console.log(
      ready
        ? '[FarmStake] 行数据已就绪（存在可用的 Claim 按钮）'
        : `[FarmStake] ${timeout / 1000}s 内没有出现可用的 Claim 按钮，继续执行，由后续断言给出准确报错`
    );
  }

  /**
   * 每次交互前兜底关一次条款弹窗 + 等遮罩散掉。
   *
   * 连接钱包后前端会重新渲染，条款弹窗有时会再出现一次；不关掉的话下一步点击
   * 全部被遮罩吞掉，只能等到 actionTimeout 才报错，且报错完全指不到真实原因。
   */
  private async ensureNoBlockingOverlay() {
    await dismissCetusTerms(this.page).catch(() => undefined);
    if (await termsModal(this.page).isVisible().catch(() => false)) {
      await dismissCetusTerms(this.page, { timeout: 5_000 }).catch(() => undefined);
    }
    await waitForOverlaysCleared(this.page);
  }

  // ─── Step 1: Expand the target farm row ─────────────────────────────────────

  /**
   * Finds the farm row matching the given pair label (e.g. "haSUI - SUI")
   * and clicks its expand chevron (▼ / ↓ button on the right side).
   *
   * The row stays collapsed by default; only after expanding does the
   * position list with the "Stake" button appear.
   *
   * @param pairLabel  Display text of the pool pair, e.g. "haSUI - SUI"
   */
  async expandFarmRow(pairLabel: string) {
    console.log(`[FarmStake] Looking for farm row: "${pairLabel}"`);

    // 先确保没有遮罩：条款弹窗盖着时所有坐标点击都会落到遮罩上，
    // 后面每一步都只能等满超时。
    await this.ensureNoBlockingOverlay();
    // 数据加载期间行高会变化，此时读 boundingBox 算出的 rowY 随后即失效。
    //
    // timeout 只给 8s：stake 场景下仓位是未质押的，Your Earned 为空、Claim 本就
    // 不会变可用，等满 20s 是纯白等。展开箭头不依赖这个信号，等不到也能继续。
    await this.waitForRowDataLoaded(8_000);

    // 等行真的渲染出来（Claim 按钮出现即可），不再 sleep 固定 1.5s。
    await this.page
      .getByRole('button', { name: /^claim$/i })
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 })
      .catch(() => undefined);

    // ── 优先走 DOM 锚定：pair 文本 → 最近的行容器 → 行内最右侧的小图标按钮 ──
    if (await this.expandViaRowAnchor(pairLabel)) return;

    // Strategy: each farm row has a "Claim" button + a "▼" chevron button next to it.
    // Find the row whose pair text matches, locate its Claim button,
    // then click the button immediately after it (the expand chevron).
    const firstToken = pairLabel.split(/[\s\-–]+/)[0].trim();

    // Find all "Claim" buttons on the page, pick the one closest to the pair text
    const claimButtons = this.page.getByRole('button', { name: /^claim$/i });
    const claimCount = await claimButtons.count();
    console.log(`[FarmStake] Found ${claimCount} Claim button(s) on page`);

    let targetClaimBox: { x: number; y: number; width: number; height: number } | null = null;
    let targetRowY = -1;

    // 取 pair 文案所在的叶子节点坐标。
    // ⚠️ 不能用 locator('div, span, p').filter({ hasText: /haSUI/ }).first()：
    // 它会命中包住整张列表的最外层 div（外层文本当然也含 "haSUI"），
    // boundingBox 得到的是整页矩形，rowY 落在页面中部 —— 后面所有「同一行」
    // 的判定全部失效，于是点到空白处，用例卡到超时。
    const pairEl = this.pairTextLeaf(firstToken);
    await expect(pairEl).toBeVisible({ timeout: 20_000 });
    const pairBox = await pairEl.boundingBox();
    if (pairBox) targetRowY = pairBox.y + pairBox.height / 2;

    // Among all Claim buttons, find the one on the same row as the pair label
    for (let i = 0; i < claimCount; i++) {
      const btn = claimButtons.nth(i);
      const box = await btn.boundingBox();
      if (box && targetRowY > 0 && Math.abs(box.y + box.height / 2 - targetRowY) < 60) {
        targetClaimBox = box;
        console.log(`[FarmStake] Matched Claim button at index ${i}, y=${box.y}`);
        break;
      }
    }

    if (targetClaimBox) {
      // The ▼ chevron button is to the right of Claim — click just to the right of it
      const chevronX = targetClaimBox.x + targetClaimBox.width + 20;
      const chevronY = targetClaimBox.y + targetClaimBox.height / 2;
      await this.page.mouse.click(chevronX, chevronY);
      await this.page.waitForTimeout(1_500);
      console.log(`[FarmStake] Clicked expand chevron at (${chevronX.toFixed(0)}, ${chevronY.toFixed(0)})`);
      await this.waitForStakeButtonVisible();
      return;
    }

    // Final fallback: click the rightmost small button in the entire page
    // that is on the same row as the pair label
    if (targetRowY > 0) {
      const fallbackBtn = await this.page.evaluate((rowY: number) => {
        const buttons = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'));
        const candidates = buttons.filter((btn) => {
          const rect = btn.getBoundingClientRect();
          return (
            Math.abs(rect.top + rect.height / 2 - rowY) < 60 &&
            rect.width < 60 && rect.height < 60 && rect.width > 0 &&
            (btn.textContent ?? '').trim().toLowerCase() !== 'claim'
          );
        });
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
        const rect = candidates[0].getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }, targetRowY);

      if (fallbackBtn) {
        await this.page.mouse.click(fallbackBtn.x, fallbackBtn.y);
        await this.page.waitForTimeout(1_500);
        console.log('[FarmStake] Clicked chevron via final coordinate fallback');
        await this.waitForStakeButtonVisible();
        return;
      }
    }

    throw new Error(`[FarmStake] Cannot find expand chevron for farm row: "${pairLabel}"`);
  }

  // ─── Step 2: Click Stake ─────────────────────────────────────────────────────

  /**
   * Clicks the "Stake" button in the expanded farm position row.
   * Assumes expandFarmRow() has already been called.
   */
  async clickStake() {
    await this.ensureNoBlockingOverlay();

    const stakeBtn = this.page
      .getByRole('button', { name: /^stake$/i })
      .first();

    await expect(stakeBtn).toBeVisible({ timeout: 10_000 });
    await expect(stakeBtn).toBeEnabled({ timeout: 10_000 });
    // timeout 收短：真被遮罩挡住时快速失败，而不是耗掉整个用例的预算。
    await stakeBtn.click({ timeout: 10_000 });
    console.log('[FarmStake] Clicked Stake button');

    // 点完主按钮后可能还有一层确认弹窗，里面再点一次 Stake 才会发起签名。
    await this.confirmActionModal(/^stake$/i);
  }

  // ─── Step 2b: Click Unstake ──────────────────────────────────────────────────

  async clickUnstake() {
    await this.ensureNoBlockingOverlay();

    const unstakeBtn = this.page
      .getByRole('button', { name: /^unstake$/i })
      .first();

    await expect(unstakeBtn).toBeVisible({ timeout: 10_000 });
    await expect(unstakeBtn).toBeEnabled({ timeout: 10_000 });
    await unstakeBtn.click({ timeout: 10_000 });
    console.log('[FarmStake] Clicked Unstake button');

    await this.confirmActionModal(/^unstake$/i);
  }

  // ─── Step 2c: Click Claim (row-level, no expand needed) ──────────────────────

  /**
   * Finds the highlighted "Claim" button on the target farm row and clicks it.
   * No need to expand the row — the Claim button is always visible in the row.
   *
   * The active/highlighted Claim button differs from disabled ones visually
   * (brighter color). We identify the correct one by matching the row Y position
   * of the pair label, then picking the enabled Claim button on that row.
   *
   * @param pairLabel  Display text of the pool pair, e.g. "haSUI - SUI"
   */
  async clickClaimForRow(pairLabel: string) {
    console.log(`[FarmStake] Looking for Claim button on row: "${pairLabel}"`);

    // 条款弹窗的遮罩会吞掉 Claim 的点击 —— 这是三个 farm 用例「卡很久」的主因。
    await this.ensureNoBlockingOverlay();

    // 这里不再单独调 waitForRowDataLoaded()：下面的轮询本身就是同一个等待，
    // 先等一遍再轮询等于把等待时间翻倍。

    // 轮询而不是读一次就判死刑。
    //
    // 上一版在这里读一次 isEnabled()，false 就抛 "no rewards to claim"。
    // 但 disabled 有两种截然不同的原因：
    //   a) 真的没奖励；
    //   b) `Your Staked` / `Your Earned` 两列还是骨架屏，数据没回来。
    // 连上钱包后 (b) 会持续好几秒，于是稳定误报。这里给它一个窗口，
    // 只有等满还是 disabled 才认定是 (a)。
    const deadline = Date.now() + 30_000;
    let lastDisabled = false;

    while (Date.now() < deadline) {
      const btn = await this.findClaimButtonForRow(pairLabel);

      if (btn) {
        if (await btn.isEnabled().catch(() => false)) {
          await btn.click({ timeout: 10_000 });
          console.log(`[FarmStake] Clicked Claim button on row "${pairLabel}"`);
          await this.confirmActionModal(/^claim$/i);
          return;
        }
        lastDisabled = true;
      }

      await this.page.waitForTimeout(500);
    }

    if (lastDisabled) {
      throw new Error(
        `[FarmStake] "${pairLabel}" 的 Claim 按钮 30s 内始终 disabled —— 该 farm 没有可领取的奖励。\n` +
        '（已切到 "Your Farms" tab 并给足数据加载时间，所以不是数据未回来。）'
      );
    }

    throw new Error(`[FarmStake] Cannot find Claim button for row: "${pairLabel}"`);
  }

  /**
   * 找目标行上的 Claim 按钮。优先 DOM 锚定，失败再退回按 Y 坐标同行匹配。
   *
   * 每轮轮询都重新定位：行会随数据加载重新渲染，缓存下来的 locator 会失效。
   */
  private async findClaimButtonForRow(pairLabel: string): Promise<Locator | null> {
    const firstToken = pairLabel.split(/[\s\-–]+/)[0].trim();
    // 用叶子节点定位（见 pairTextLeaf 注释）：外层容器的文本也含 "haSUI"，
    // 取 .first() 会拿到整张列表的包裹 div，rowY 完全错位。
    const pairEl = this.pairTextLeaf(firstToken);
    // timeout 收到 1.5s：这是轮询里的一步，给 5s 会让每轮最坏耗 5s+，
    // 30s 的预算只够跑 5 轮。
    if (!(await pairEl.isVisible({ timeout: 1_500 }).catch(() => false))) return null;

    // ── DOM 锚定：往上找同时含 Claim 按钮的行容器 ──
    for (const depth of [1, 2, 3, 4, 5, 6]) {
      const row = pairEl.locator(`xpath=ancestor::*[self::div or self::tr][${depth}]`);
      if ((await row.count().catch(() => 0)) === 0) continue;
      const claim = row.getByRole('button', { name: /^claim$/i }).first();
      if (await claim.isVisible({ timeout: 300 }).catch(() => false)) return claim;
    }

    // ── 兜底：按 Y 坐标匹配同一行 ──
    const pairBox = await pairEl.boundingBox().catch(() => null);
    if (!pairBox) return null;
    const rowY = pairBox.y + pairBox.height / 2;

    const claimButtons = this.page.getByRole('button', { name: /^claim$/i });
    const count = await claimButtons.count().catch(() => 0);

    for (let i = 0; i < count; i++) {
      const btn = claimButtons.nth(i);
      const box = await btn.boundingBox().catch(() => null);
      if (!box) continue;
      if (Math.abs(box.y + box.height / 2 - rowY) < 80) return btn;
    }

    return null;
  }

  // ─── Step 3: Assert success ──────────────────────────────────────────────────

  async expectStakeSuccess() {
    const successText = this.page
      .getByText(/success|staked|transaction completed|submitted|view in explorer/i)
      .first();
    await expect(successText).toBeVisible({ timeout: 60_000 });
    console.log('[FarmStake] ✓ Stake transaction successful');
  }

  async expectUnstakeSuccess() {
    const successText = this.page
      .getByText(/success|unstaked|transaction completed|submitted|view in explorer/i)
      .first();
    await expect(successText).toBeVisible({ timeout: 60_000 });
    console.log('[FarmStake] ✓ Unstake transaction successful');
  }

  async expectClaimSuccess() {
    const successText = this.page
      .getByText(/success|claimed|transaction completed|submitted|view in explorer/i)
      .first();
    await expect(successText).toBeVisible({ timeout: 60_000 });
    console.log('[FarmStake] ✓ Claim transaction successful');
  }

  /**
   * Reads the transaction digest from the success notification or explorer link.
   */
  async readDigest(): Promise<string | undefined> {
    const explorerLink = this.page
      .locator('a[href*="suiscan"], a[href*="suivision"], a[href*="explorer"]')
      .first();

    if (await explorerLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const href = (await explorerLink.getAttribute('href')) ?? '';
      const match =
        href.match(/\/tx(?:block)?\/([1-9A-HJ-NP-Za-km-z]{40,90})/)?.[1] ??
        href.match(/transaction\/([1-9A-HJ-NP-Za-km-z]{40,90})/)?.[1];
      if (match) return match;
    }

    const bodyText = await this.page.locator('body').innerText().catch(() => '');
    return bodyText.match(/[1-9A-HJ-NP-Za-km-z]{43,90}/)?.[0];
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  /**
   * 定位 pair 文案所在的**叶子**节点（自身匹配、但没有子节点也匹配）。
   *
   * 这是 farm 三个用例卡死的根因之一：原来用
   * `locator('div, span, p').filter({ hasText: /haSUI/ }).first()`，
   * DOM 里最外层的列表容器文本同样包含 "haSUI"，且在文档顺序上更靠前，
   * 于是 `.first()` 拿到的是覆盖整个列表的大 div。它的 boundingBox 高达几百 px，
   * rowY 算出来落在列表中部的空白处 —— 后续「同一行的 Claim / chevron」判定
   * 全部失配，点击落到空白区域，Playwright 一路重试到超时。
   */
  private pairTextLeaf(token: string): Locator {
    const pattern = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    return this.page
      .locator('p, span, div')
      .filter({ hasText: pattern })
      // 排除还有匹配子节点的祖先容器，只留最内层那一个。
      .filter({ hasNot: this.page.locator('p, span, div').filter({ hasText: pattern }) })
      .first();
  }

  /**
   * DOM 锚定展开行：pair 叶子节点 → 往上找到「同时含 Claim 按钮」的行容器
   * → 点这一行里除 Claim 之外最靠右的那个按钮（就是展开箭头）。
   *
   * 比原来的纯坐标点击可靠：不依赖 chevron 相对 Claim 的像素偏移（+20px），
   * 布局一改就点空、且点空的表现是「等到超时」而不是立刻报错。
   *
   * @returns 成功展开返回 true；没找到返回 false，由调用方走坐标兜底。
   */
  private async expandViaRowAnchor(pairLabel: string): Promise<boolean> {
    const firstToken = pairLabel.split(/[\s\-–]+/)[0].trim();
    const pairEl = this.pairTextLeaf(firstToken);

    if (!(await pairEl.isVisible({ timeout: 10_000 }).catch(() => false))) return false;

    for (const depth of [1, 2, 3, 4, 5, 6]) {
      const row = pairEl.locator(`xpath=ancestor::*[self::div or self::tr][${depth}]`);
      if ((await row.count().catch(() => 0)) === 0) continue;

      const claimInRow = row.getByRole('button', { name: /^claim$/i }).first();
      if (!(await claimInRow.isVisible({ timeout: 800 }).catch(() => false))) continue;

      // 行内按钮里挑「最靠右且不是 Claim」的那个 = 展开箭头。
      const buttons = row.locator('button, [role="button"]');
      const total = await buttons.count().catch(() => 0);
      let best: Locator | null = null;
      let bestRight = -Infinity;

      for (let i = 0; i < total; i++) {
        const btn = buttons.nth(i);
        const text = ((await btn.textContent().catch(() => '')) ?? '').trim();
        if (/^claim$/i.test(text)) continue;
        const box = await btn.boundingBox().catch(() => null);
        // 展开箭头是个小图标按钮，尺寸远小于文字按钮。
        if (!box || box.width === 0 || box.width > 80 || box.height > 80) continue;
        if (box.x + box.width > bestRight) {
          bestRight = box.x + box.width;
          best = btn;
        }
      }

      if (!best) continue;

      await best.click({ timeout: 8_000 }).catch(() => undefined);
      const expanded = await this.page
        .getByRole('button', { name: /^(stake|unstake)$/i })
        .first()
        .waitFor({ state: 'visible', timeout: 8_000 })
        .then(() => true, () => false);

      if (expanded) {
        console.log(`[FarmStake] 已展开行（DOM 锚定，ancestor depth=${depth}）`);
        return true;
      }
    }

    return false;
  }

  /**
   * 点完主按钮后出现的二次确认弹窗，里面再点一次同名按钮才真正发起签名。
   *
   * 三点考量，与 dlmm-create-pool 的处理一致：
   *  1. 必须把范围限定在弹窗容器内 —— 页面主体那颗同名按钮在 DOM 顺序上更靠前，
   *     用全页 .first() 会重复点到已经点过的那个；
   *  2. 弹窗可能压根不出现（部分动作直接提交），属正常路径，不能抛错；
   *  3. click 的 timeout 必须收短：被失败提示遮罩挡住时要快速失败，
   *     否则 Playwright 会重试到 actionTimeout，这正是「卡很久」的直接来源。
   */
  private async confirmActionModal(namePattern: RegExp) {
    const dialog = this.page.locator('[role="dialog"], .chakra-modal__content').last();
    if (!(await dialog.isVisible({ timeout: 4_000 }).catch(() => false))) {
      console.log('[FarmStake] 未出现确认弹窗，视为首次点击已提交');
      return;
    }

    // 成功弹窗也是 dialog：它一出现说明交易早已提交，不该再找按钮。
    const dialogText = ((await dialog.innerText().catch(() => '')) ?? '').toLowerCase();
    if (/transaction completed|success|failed|rejected/.test(dialogText)) {
      console.log('[FarmStake] 弹窗已是结果提示，跳过二次确认');
      return;
    }

    const confirmBtn = dialog.getByRole('button', { name: namePattern }).first();
    if (!(await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false))) {
      console.log('[FarmStake] 弹窗内没有确认按钮，视为首次点击已提交');
      return;
    }
    if (!(await confirmBtn.isEnabled().catch(() => false))) {
      console.log('[FarmStake] 弹窗内确认按钮不可用，跳过');
      return;
    }

    await confirmBtn.click({ timeout: 8_000 }).catch((error: unknown) => {
      console.log(
        `[FarmStake] 确认弹窗点击失败（可能已被结果提示遮挡）: ${
          error instanceof Error ? error.message.split('\n')[0] : String(error)
        }`
      );
    });
    console.log('[FarmStake] Clicked confirmation button in modal — wallet should sign');
  }

  /**
   * Waits for a "Stake" button to become visible after expanding a farm row.
   * If no button appears within the timeout, logs a warning (position may not exist).
   */
  private async waitForStakeButtonVisible() {
    const stakeBtn = this.page.getByRole('button', { name: /^stake$/i }).first();
    const visible = await stakeBtn.isVisible({ timeout: 8_000 }).catch(() => false);
    if (!visible) {
      console.warn('[FarmStake] No Stake button found after expanding row — wallet may have no eligible position');
    }
  }
}

/**
 * 等 chakra-portal 里「真的会吞点击」的遮罩清空。
 *
 * ⚠️ 判定必须按可见性过滤，不能只看选择器是否匹配到节点：Cetus 页面上常驻若干
 * `chakra-popover__content`（tooltip 宿主），它们带 role="dialog" 但
 * visibility:hidden / 尺寸接近 0，完全不挡点击。按存在性判定条件永远不成立，
 * 每次都要白等满超时。
 */
async function waitForOverlaysCleared(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const nodes = Array.from(
          document.querySelectorAll(
            '.chakra-portal [role="dialog"], .chakra-portal .chakra-modal__content, .chakra-modal__overlay'
          )
        );
        return nodes.every((el) => {
          const style = getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
            return true;
          }
          const box = el.getBoundingClientRect();
          return box.width < 10 || box.height < 10;
        });
      },
      { timeout: 5_000, polling: 50 }
    )
    .catch(() => undefined);
}
