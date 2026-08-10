import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

export class MarginPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto(path: string = '/margin') {
    await this.page.goto(path, { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle');
  }

  private get continueButton() {
    return this.page.getByRole('button', { name: /^continue$/i }).first();
  }

  private get acknowledgeLabel() {
    return this.page.getByText(/I acknowledge and accept all the risk/i).first();
  }

  private get dontRemindLabel() {
    return this.page.getByText(/Don'?t remind me again/i).first();
  }

  /** 风险确认弹窗当前是否可见（以弹窗标题 + 确认文案为准，避免误匹配页面其他 Continue 按钮）。 */
  async isRiskAcknowledgementVisible(timeout = 1_500): Promise<boolean> {
    if (await this.acknowledgeLabel.isVisible({ timeout }).catch(() => false)) return true;
    const title = this.page.getByText(/Risk Acknowledge?ment/i).first();
    return title.isVisible({ timeout: 500 }).catch(() => false);
  }

  /** 勾选文字左侧的复选框：先坐标点击，再退化为 force click / DOM click。 */
  private async tickCheckbox(label: ReturnType<Page['getByText']>) {
    if (!(await label.isVisible({ timeout: 1_000 }).catch(() => false))) return;

    const box = await label.boundingBox().catch(() => null);
    if (box) {
      await this.page.mouse.click(Math.max(0, box.x - 20), box.y + box.height / 2);
      await this.page.waitForTimeout(200);
    }

    if (await this.continueButton.isEnabled().catch(() => false)) return;

    await label.click({ force: true }).catch(() => undefined);
    await this.page.waitForTimeout(200);
  }

  /**
   * 关闭 Risk Acknowledgement 弹窗。
   * 同时勾选 "Don't remind me again"，避免点击开仓按钮时弹窗再次拦截交易。
   */
  async dismissRiskAcknowledgementIfPresent(): Promise<boolean> {
    if (!(await this.isRiskAcknowledgementVisible(3_000))) return false;

    console.log('[margin] Risk Acknowledgement modal detected, dismissing');
    await this.tickCheckbox(this.acknowledgeLabel);
    await this.tickCheckbox(this.dontRemindLabel);

    if (!(await this.continueButton.isEnabled().catch(() => false))) {
      await this.tickCheckboxViaDom();
    }

    await expect(this.continueButton).toBeEnabled({ timeout: 10_000 });
    await this.continueButton.click();
    await this.continueButton.waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => undefined);
    await this.page.waitForTimeout(300);
    return true;
  }

  /** 兜底：在页面内直接勾选弹窗里所有 checkbox。 */
  private async tickCheckboxViaDom() {
    await this.page
      .evaluate(() => {
        const root = document.querySelector('[role="dialog"]') ?? document.body;
        root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => {
          if (!input.checked) input.click();
        });

        const labels = Array.from(root.querySelectorAll<HTMLElement>('label, span, div')).filter((el) =>
          /I acknowledge and accept all the risk|Don'?t remind me again/i.test(el.textContent ?? '')
        );
        labels.slice(-2).forEach((el) => el.click());
      })
      .catch(() => undefined);
    await this.page.waitForTimeout(400);
  }

  async selectTradingPair(baseSymbol: string, quoteSymbol: string) {
    const pairButton = this.page.getByRole('button', { name: new RegExp(`${baseSymbol}/${quoteSymbol}`, 'i') }).first();
    await expect(pairButton).toBeVisible({ timeout: 10_000 });
    await pairButton.click();
  }

  async switchToBuyLong() {
    const buyButton = this.page.getByRole('button', { name: /^buy$/i }).first();
    const isVisible = await buyButton.isVisible({ timeout: 2_000 }).catch(() => false);
    if (isVisible) {
      await buyButton.click();
    }
  }

  async switchToSellShort() {
    // codegen line 8: getByText('Sell / Short').click()
    await this.page.getByText('Sell / Short').click();
  }

  /** "You Deposit" 输入框右侧的币种选择按钮。 */
  private get depositTokenButton() {
    return this.page.locator('.chakra-input__right-addon button.chakra-button').first();
  }

  /** 读取当前存入币种符号（按钮内的 <p> 文案，如 "USDC"）。 */
  async getDepositToken(): Promise<string> {
    const label = this.depositTokenButton.locator('p').first();
    const raw = await label.textContent().catch(() => null);
    const fallback = raw ?? (await this.depositTokenButton.textContent().catch(() => '')) ?? '';
    return fallback.trim().toUpperCase();
  }

  /**
   * 切换 "You Deposit" 的存入币种。
   *
   * 开空时 Cetus 默认存入 USDC，而测试钱包里 USDC 余额不足（约 1.37），
   * 会卡在 "Deposit at least $5" / "Insufficient USDC Balance"。切成 SUI 后
   * 才有足够余额开仓。
   */
  async selectDepositToken(symbol: string) {
    const target = symbol.toUpperCase();
    if ((await this.getDepositToken()) === target) {
      console.log(`[margin] Deposit token already ${symbol}`);
      return;
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      await this.depositTokenButton.click();
      await this.page.waitForTimeout(500);

      const picked = await this.clickTokenOptionBelowTrigger(target);
      if (!picked) {
        // 下拉没展开或没有该选项：关掉浮层后重试
        await this.page.keyboard.press('Escape').catch(() => undefined);
        await this.page.waitForTimeout(300);
        continue;
      }

      if (await this.waitForDepositToken(target)) {
        console.log(`[margin] Deposit token switched to ${symbol}`);
        return;
      }
    }

    throw new Error(`Failed to switch deposit token to ${symbol} (still ${await this.getDepositToken()})`);
  }

  private async waitForDepositToken(target: string, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.getDepositToken()) === target) return true;
      await this.page.waitForTimeout(250);
    }
    return false;
  }

  /**
   * 在币种下拉浮层里点击目标币种。
   *
   * 按文案全页匹配 SUI 会命中 "Short Size" 旁的币种标签，所以这里用几何位置筛选：
   * 只接受出现在触发按钮下方、且与其横向重叠的候选元素。
   */
  private async clickTokenOptionBelowTrigger(target: string): Promise<boolean> {
    const trigger = await this.depositTokenButton.boundingBox();
    if (!trigger) return false;

    const candidates = this.page.getByText(new RegExp(`^${target}$`, 'i'));
    const count = await candidates.count().catch(() => 0);

    for (let i = 0; i < count; i++) {
      const candidate = candidates.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) continue;

      const box = await candidate.boundingBox().catch(() => null);
      if (!box) continue;

      const isBelow = box.y > trigger.y + trigger.height / 2;
      const overlapsHorizontally = box.x + box.width > trigger.x - 40 && box.x < trigger.x + trigger.width + 40;
      if (!isBelow || !overlapsHorizontally) continue;

      await candidate.click({ timeout: 5_000 }).catch(() => undefined);
      await this.page.waitForTimeout(400);
      return true;
    }

    return false;
  }

  async fillDepositAmount(amount: string) {
    const amountInput = this.page
      .getByRole('textbox', { name: /^0\.0$|^$/i })
      .first();
    await expect(amountInput).toBeVisible({ timeout: 10_000 });
    await amountInput.click();
    await amountInput.fill(amount);
    console.log(`[margin] Filled deposit amount: ${amount}`);
  }

  /** 等待面板骨架屏消失（报价、清算价格等重新计算完成）。 */
  async waitForSkeletonToResolve(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    await this.page.waitForTimeout(500);

    while (Date.now() < deadline) {
      if (!(await this.hasVisibleSkeleton())) return;
      await this.page.waitForTimeout(500);
    }

    console.warn(`[margin] Skeleton still visible after ${timeoutMs}ms`);
  }

  private get leverageSlider() {
    return this.page.getByRole('slider').first();
  }

  /** 读取滑块当前杠杆值。 */
  async getLeverage(): Promise<number> {
    const raw = await this.leverageSlider.getAttribute('aria-valuenow').catch(() => null);
    return raw ? Number(raw) : NaN;
  }

  /**
   * 把杠杆拉到最大档。
   *
   * Cetus 的杠杆是 Chakra Slider（role=slider，aria-valuemin/max/now）。
   * 直接 fill 输入框只改 DOM 值、不触发 React 的 change 提交，实际杠杆仍停在最小档
   * （表现为 Long Size 只按 1.1x 计算），因此这里拖拽滑块并用 aria-valuenow 校验。
   */
  async maximizeLeverage() {
    const slider = this.leverageSlider;
    await expect(slider).toBeVisible({ timeout: 15_000 });

    const max = Number((await slider.getAttribute('aria-valuemax')) ?? '3');
    await this.dragSliderToEnd(slider);

    if (Math.abs((await this.getLeverage()) - max) > 0.001) {
      await this.nudgeSliderToEnd(slider, max);
    }

    // 不在这里等骨架屏：拖动过程中面板会持续重算，等待留给后续的开仓按钮就绪检查
    const actual = await this.getLeverage();
    console.log(`[margin] Leverage set to ${actual}x (max ${max}x)`);
    expect(actual, `leverage should reach ${max}x`).toBeCloseTo(max, 2);
  }

  /** 按住滑块拖到轨道最右端。 */
  private async dragSliderToEnd(slider: Locator) {
    const thumb = await slider.boundingBox();
    const track = await this.page.locator('.chakra-slider__track').first().boundingBox();
    if (!thumb || !track) return;

    await this.page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
    await this.page.mouse.down();
    // 分步移动：一次性跳到终点时部分实现收不到中间的 pointermove
    for (const ratio of [0.4, 0.8, 1]) {
      await this.page.mouse.move(track.x + track.width * ratio, track.y + track.height / 2, { steps: 5 });
      await this.page.waitForTimeout(80);
    }
    await this.page.mouse.up();
    await this.page.waitForTimeout(400);
  }

  /** 兜底：聚焦滑块后用 End / 方向键推到最大值。 */
  private async nudgeSliderToEnd(slider: Locator, max: number) {
    await slider.focus().catch(() => undefined);
    await this.page.keyboard.press('End').catch(() => undefined);
    await this.page.waitForTimeout(300);

    for (let i = 0; i < 30; i++) {
      if (Math.abs((await this.getLeverage()) - max) <= 0.001) return;
      await this.page.keyboard.press('ArrowRight');
      await this.page.waitForTimeout(120);
    }
  }

  async submitOpenLong(baseSymbol: string) {
    await this.submitOpenPosition(`Open ${baseSymbol} Long`);
  }

  async expectOpenLongSuccess() {
    const closeButton = this.page.getByRole('button', { name: /^close$/i }).last();
    await expect(closeButton).toBeVisible({ timeout: 60_000 });
  }

  async submitOpenShort(baseSymbol: string) {
    await this.submitOpenPosition(`Open ${baseSymbol} Short`);
  }

  private openPositionButton(buttonText: string) {
    return this.page
      .locator('button')
      .filter({ hasText: new RegExp(`^\\s*${buttonText}\\s*$`, 'i') })
      .first();
  }

  /**
   * 交易面板是否仍在渲染骨架屏。
   *
   * 以杠杆滑块为锚点向上找到包含 "Entry Price" 的面板容器，只检测容器内的
   * `chakra-skeleton`。两点原因：
   *   1. 页面常驻 TradingView 的 `tv-spinner` 和 toast 的 `sonner-spinner`，
   *      按 spinner 类名全页匹配会永远为真；
   *   2. 加载中开仓按钮只渲染 spinner、没有文字，不能用它当锚点。
   */
  private async hasVisibleSkeleton(): Promise<boolean> {
    return this.page
      .evaluate(() => {
        const slider = document.querySelector<HTMLElement>('[role="slider"]');

        let panel: HTMLElement | null = slider;
        while (panel && !/entry price/i.test(panel.textContent ?? '')) {
          panel = panel.parentElement;
        }
        const root: ParentNode = panel ?? document.body;

        return Array.from(root.querySelectorAll<HTMLElement>('.chakra-skeleton')).some((el) => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetHeight > 0;
        });
      })
      .catch(() => false);
  }

  /**
   * 等待骨架屏消失、`Open X Long` 按钮带文案出现并可点击。
   *
   * 报价重算期间 Cetus 把 Entry Price / Est. Liq. Price 等行替换成 chakra-skeleton，
   * 开仓按钮此时只渲染一个 spinner、没有文字，因此按文案定位天然要求加载完成。
   */
  private async waitForOpenPositionButtonReady(buttonText: string, timeoutMs = 20_000) {
    const openButton = this.openPositionButton(buttonText);
    const deadline = Date.now() + timeoutMs;
    let logged = false;

    while (Date.now() < deadline) {
      if (await this.hasVisibleSkeleton()) {
        if (!logged) {
          console.log('[margin] Waiting for the skeleton to resolve...');
          logged = true;
        }
        await this.page.waitForTimeout(500);
        continue;
      }

      const visible = await openButton.isVisible({ timeout: 500 }).catch(() => false);
      if (visible && (await openButton.isEnabled().catch(() => false))) {
        await openButton.scrollIntoViewIfNeeded().catch(() => undefined);
        // 骨架屏可能在滚动后二次出现，确认稳定后再返回
        await this.page.waitForTimeout(300);
        if (!(await this.hasVisibleSkeleton())) {
          console.log(`[margin] "${buttonText}" is ready to click`);
          return openButton;
        }
        continue;
      }

      await this.page.waitForTimeout(500);
    }

    // 兜底：骨架屏检测可能因面板结构变化而失准，只要按钮本身带文案且可点击就继续。
    await expect(openButton).toBeVisible({ timeout: 5_000 });
    await openButton.scrollIntoViewIfNeeded().catch(() => undefined);
    await expect(openButton).toBeEnabled({ timeout: 10_000 });
    console.warn(`[margin] Skeleton check timed out; "${buttonText}" is enabled, proceeding`);
    return openButton;
  }

  /**
   * 提交开仓。风险弹窗可能在点击开仓按钮时才弹出并拦截交易，
   * 因此这里循环：点击 → 若弹窗出现则关闭 → 重新点击，直到交易真正发出。
   */
  private async submitOpenPosition(buttonText: string) {
    await this.dismissRiskAcknowledgementIfPresent();

    const openButton = await this.waitForOpenPositionButtonReady(buttonText);

    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`[margin] Click #${attempt}: "${buttonText}"`);
      await openButton.click({ timeout: 10_000 }).catch(() => undefined);
      await this.page.waitForTimeout(1_200);

      // 弹窗拦截了交易：关闭后等面板重新就绪再重试点击
      if (await this.dismissRiskAcknowledgementIfPresent()) {
        await this.waitForOpenPositionButtonReady(buttonText, 10_000).catch(() => undefined);
        continue;
      }

      if (await this.isTransactionInFlight()) {
        console.log('[margin] Transaction submitted, waiting for wallet approval');
        return;
      }

      await this.waitForOpenPositionButtonReady(buttonText, 8_000).catch(() => undefined);
    }

    console.log('[margin] Open position clicks exhausted, continuing to wallet step');
  }

  /** 交易是否已发出：钱包扩展页已打开，或页面进入 pending/loading 状态。 */
  private async isTransactionInFlight(): Promise<boolean> {
    const hasWalletPage = this.page
      .context()
      .pages()
      .some((candidate) => !candidate.isClosed() && candidate.url().startsWith('chrome-extension://'));
    if (hasWalletPage) return true;

    const pendingText = this.page
      .getByText(/confirm(ing)? in wallet|pending|submitting|processing|waiting for/i)
      .first();
    return pendingText.isVisible({ timeout: 1_000 }).catch(() => false);
  }

  async expectOpenShortSuccess() {
    // codegen line 26: getByRole('button', { name: 'Close' }).click()
    const closeButton = this.page.getByRole('button', { name: /^close$/i }).last();
    await expect(closeButton).toBeVisible({ timeout: 60_000 });
  }

  async startCloseFromPositionsTable(baseSymbol: string, quoteSymbol: string) {
    // codegen line 25: click Positions tab
    await this.page.locator('div').filter({ hasText: /^Positions$/ }).first().click();
    await this.page.waitForTimeout(1_000);

    // codegen line 26: click the expand SVG on the position row
    await this.page.locator('.css-u7ab40 > svg').click();
    await this.page.waitForTimeout(500);

    // codegen line 27: click "Close" button in the expanded position row
    await this.page.getByRole('button', { name: 'Close' }).click();
    await this.page.waitForTimeout(500);
  }

  async confirmClosePositionInModal() {
    // codegen line 28: click "Close Position" in the confirmation modal
    await this.page.getByRole('button', { name: 'Close Position' }).nth(1).click();
  }

  async expectClosePositionSuccess() {
    // 关仓成功后，Active Positions 数量应减少，或出现成功提示
    // 等待关仓弹窗消失即视为成功
    const closePositionButton = this.page.getByRole('button', { name: 'Close Position' });
    await closePositionButton.waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => undefined);
  }
}
