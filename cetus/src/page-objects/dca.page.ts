import { expect } from '@playwright/test';

import { SwapPage } from './swap.page.js';

function toOneDecimal(value: number) {
  return value.toFixed(1);
}

/** Rounds UP to 1 decimal so the resulting USD value never falls below the target. */
function ceilToOneDecimal(value: number) {
  return Math.ceil(value * 10) / 10;
}

/**
 * Active DCAs 列表的加载判定结果。
 * `empty` 是确定结论（可直接结束），`timeout` 仅表示未能判定（值得刷新重试）。
 */
type OrdersState = 'orders' | 'empty' | 'timeout';

export class DcaPage extends SwapPage {
  /** Cetus rejects DCA orders whose per-cycle size is below this USD amount. */
  private static readonly MIN_PER_ORDER_USD = 3;

  /** Order cycles used by the Total-mode scenario (matches the widget default). */
  private static readonly ORDER_COUNT = 2;

  /** Extra headroom over the minimum to absorb price drift between fill and submit. */
  private static readonly SAFETY_FACTOR = 1.05;

  /** widget 头部标签，订单图标坐标扫描失败时用于兜底定位。 */
  private static readonly WIDGET_LABEL = /^DCA$/i;

  /** 订单面板标题，用于确认 popover 已展开。 */
  private static readonly ORDERS_PANEL_TITLE = /^Active DCAs?$/i;

  /**
   * 空态文案，用于区分"还在加载"和"确实没有订单"。
   * Cetus 实际渲染的是 "No active orders"，其余为历史/兜底写法。
   */
  private static readonly EMPTY_STATE_TEXT =
    /no active orders?|you don't have any active dcas?|no active dcas?/i;

  async goto() {
    await this.page.goto('/dca', { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle');
    await this.dismissTermsModalIfPresent();
    await expect(this.inputAmount).toBeVisible();
  }

  /**
   * Reads the price used to size the order.
   *
   * Prefers the widget's own "Current Rate" (1 SUI ≈ N USDC) because that is the
   * quote Cetus applies when validating the $3 per-order minimum. The watchlist
   * ticker at the top of the page can differ from it by 20 % or more, which is
   * enough to push a freshly filled order below the minimum.
   */
  async readCurrentSuiPriceUsd() {
    const bodyText = await this.page.locator('body').innerText();

    const rate = bodyText.match(/1\s*SUI\s*[≈=~]\s*([0-9]+(?:\.[0-9]+)?)\s*USDC/i)?.[1];
    if (rate && Number(rate) > 0) {
      return Number(rate);
    }

    const ticker = bodyText.match(/SUI\s*\$([0-9]+(?:\.[0-9]+)?)/i)?.[1];
    if (ticker && Number(ticker) > 0) {
      return Number(ticker);
    }

    throw new Error('Unable to read current SUI price from DCA page.');
  }

  /**
   * Switches the "You Pay" input mode to "Total" (default).
   * In Total mode the amount entered is the overall SUI to spend across all orders.
   */
  async switchToTotalMode(): Promise<void> {
    const btn = this.page
      .locator('button, [role="button"], div, span')
      .filter({ hasText: /^total$/i })
      .first();
    if (await btn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await btn.click();
      await this.page.waitForTimeout(400);
    }
  }

  /**
   * Switches the "You Pay" input mode to "Per Order".
   * In Per Order mode the amount entered is the SUI spent per single order cycle.
   */
  async switchToPerOrderMode(): Promise<void> {
    const btn = this.page
      .locator('button, [role="button"], div, span')
      .filter({ hasText: /^per order$/i })
      .first();
    await expect(btn).toBeVisible({ timeout: 5_000 });
    await btn.click();
    await this.page.waitForTimeout(400);
  }

  /**
   * Fills the DCA form in **Total** mode.
   *
   * Amount logic:
   *   perOrder = ceil($3 × 1.05 / suiPrice, 1 decimal)  — clears the per-order minimum
   *   total    = perOrder × 2                            — 2 order cycles
   * The filled total is then verified against the widget's own USD readout and
   * raised if it still values each cycle below $3.
   * Price range: market ±10 %
   */
  async fillOrderByPrice(price: number) {
    const { MIN_PER_ORDER_USD, ORDER_COUNT, SAFETY_FACTOR } = DcaPage;
    const perOrder = ceilToOneDecimal((MIN_PER_ORDER_USD * SAFETY_FACTOR) / price);
    let totalAmount = toOneDecimal(perOrder * ORDER_COUNT);

    const lowerPrice = (price * 0.9).toFixed(4);
    const upperPrice = (price * 1.1).toFixed(4);
    const inputs = this.page.locator('input');

    await this.fillPayAmount(totalAmount);
    await inputs.nth(3).fill(lowerPrice);
    await inputs.nth(3).press('Tab');
    await inputs.nth(4).fill(upperPrice);
    await inputs.nth(4).press('Tab');

    totalAmount = await this.ensureMinimumPerOrder(totalAmount);

    return { totalAmount, lowerPrice, upperPrice };
  }

  /**
   * Re-reads the USD value the widget itself renders for the filled amount and
   * tops the total up until each cycle clears the $3 minimum.
   *
   * The computed amount can still land under the minimum when the price feed used
   * for sizing differs from the widget's own valuation, so this closes the loop on
   * the number Cetus actually validates instead of trusting the estimate.
   */
  private async ensureMinimumPerOrder(initialTotal: string): Promise<string> {
    const { MIN_PER_ORDER_USD, ORDER_COUNT, SAFETY_FACTOR } = DcaPage;
    let totalAmount = initialTotal;

    for (let attempt = 0; attempt < 4; attempt++) {
      await this.page.waitForTimeout(600);
      const payUsd = await this.readPanelUsdValue('from');
      if (payUsd === null) return totalAmount;

      const perOrderUsd = payUsd / ORDER_COUNT;
      if (perOrderUsd >= MIN_PER_ORDER_USD) return totalAmount;

      const impliedPrice = payUsd / Number(totalAmount);
      const perOrder = ceilToOneDecimal((MIN_PER_ORDER_USD * SAFETY_FACTOR) / impliedPrice);
      const next = toOneDecimal(Math.max(perOrder * ORDER_COUNT, Number(totalAmount) + 0.1));

      console.log(
        `[dca:e2e] per-order $${perOrderUsd.toFixed(3)} < $${MIN_PER_ORDER_USD}, ` +
          `raising total ${totalAmount} -> ${next} SUI`
      );

      totalAmount = next;
      await this.fillPayAmount(totalAmount);
    }

    return totalAmount;
  }

  /** Fills the "You Pay" field and blurs it so the widget re-validates the order. */
  private async fillPayAmount(amount: string): Promise<void> {
    const input = this.page.locator('input').nth(0);
    await input.fill(amount);
    await input.press('Tab');
  }

  /**
   * Fills the DCA form in **Per Order** mode.
   *
   * Amount logic:
   *   perOrderAmount = ⌈($3 × 1.05 / suiPrice) × 10⌉ / 10  (1-decimal ceiling)
   *   Using ceiling (not round) plus headroom guarantees the per-cycle value stays
   *   above Cetus's "Minimum $3 per order" requirement.
   * Price range: market ±10 %
   */
  async fillPerOrderByPrice(price: number) {
    const { MIN_PER_ORDER_USD, SAFETY_FACTOR } = DcaPage;
    // Ceiling at 1 decimal place: e.g. 3.15/0.9259 = 3.402 → ceil = 3.5 SUI
    const perOrderAmount = ceilToOneDecimal((MIN_PER_ORDER_USD * SAFETY_FACTOR) / price).toFixed(1);
    const lowerPrice = (price * 0.9).toFixed(4);
    const upperPrice = (price * 1.1).toFixed(4);
    const inputs = this.page.locator('input');

    await this.fillPayAmount(perOrderAmount);
    await inputs.nth(3).fill(lowerPrice);
    await inputs.nth(3).press('Tab');
    await inputs.nth(4).fill(upperPrice);
    await inputs.nth(4).press('Tab');

    return { perOrderAmount, lowerPrice, upperPrice };
  }

  async submitDcaOrder() {
    const createButton = this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /^create dca order$/i })
      .first();
    await expect(createButton).toBeVisible({ timeout: 20_000 });
    await expect(createButton).toBeEnabled({ timeout: 20_000 });
    await createButton.click();

    const reviewButton = this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /^(confirm|create dca order|place order)$/i })
      .last();
    const hasReviewStep = await reviewButton.isVisible({ timeout: 5_000 }).catch(() => false);
    if (hasReviewStep) {
      await expect(reviewButton).toBeEnabled({ timeout: 10_000 });
      await reviewButton.click();
    }
  }

  async expectOrderSubmitted() {
    const successText = this.page
      .getByText(/success|completed|submitted|order created|transaction completed|view on explorer|view in explorer/i)
      .first();
    await expect(successText).toBeVisible({ timeout: 60_000 });
  }

  /**
   * 打开 DCA 订单面板（widget 头部右侧的列表图标）。
   *
   * 与 Limit 一致：图标坐标由 svg #icon-History 扫描得到，因为下单成功后
   * Cetus 会重新挂载 widget，popover 的 React id 和 DOM 层级都会变。
   * 面板是 popover，点击外部即关闭，因此失败时要重新点而不是干等。
   */
  async openOrdersPanel() {
    await this.dismissSuccessDialogIfPresent();

    const panelTitle = this.page.getByText(DcaPage.ORDERS_PANEL_TITLE).first();

    for (let attempt = 0; attempt < 3; attempt++) {
      await this.waitForOrderIcon();
      await this.clickOrderIcon(DcaPage.WIDGET_LABEL);
      await this.dismissSuccessDialogIfPresent();

      if (await panelTitle.isVisible({ timeout: 5_000 }).catch(() => false)) {
        this.lastOrdersState = await this.waitForActiveOrdersLoaded();
        return;
      }

      console.warn(`[DcaPage] DCA orders panel not open (attempt ${attempt + 1}/3), retrying...`);
      await this.page.waitForTimeout(1_500);
    }

    await expect(panelTitle).toBeVisible({ timeout: 20_000 });
    this.lastOrdersState = await this.waitForActiveOrdersLoaded();
  }

  /** openOrdersPanel() 已完成的加载判定结果，供 hasActiveOrderToClose() 复用，避免重复等待。 */
  private lastOrdersState: OrdersState | null = null;

  private get closeAndWithdrawButton() {
    return this.page.getByRole('button', { name: /^close and withdraw$/i }).first();
  }

  private get emptyStateText() {
    return this.page.getByText(DcaPage.EMPTY_STATE_TEXT).first();
  }

  /**
   * 订单列表是否仍在渲染骨架屏。
   *
   * 以 "Active DCAs" 标题为锚点向上找到 popover 容器，只检测容器内的
   * `chakra-skeleton`：页面常驻 TradingView spinner 和 toast 占位，
   * 全页匹配会永远为真。骨架屏也可能不带 chakra 类名，因此同时兜底
   * 匹配脉冲动画的占位块。
   */
  private async hasVisibleSkeleton(): Promise<boolean> {
    return this.page
      .evaluate(() => {
        const isVisible = (el: HTMLElement) => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetHeight > 0;
        };

        const title = Array.from(document.querySelectorAll<HTMLElement>('div, span, p, button')).find(
          (el) => {
            const text = (el.textContent ?? '').trim();
            return text.length < 24 && /active\s+dcas?/i.test(text);
          }
        );

        // 向上找到既含标题、又高到足以包住订单列表的容器
        let panel: HTMLElement | null = title ?? null;
        while (panel?.parentElement && panel.offsetHeight < 160) {
          panel = panel.parentElement;
        }
        const root: ParentNode = panel ?? document.body;

        const nodes = root.querySelectorAll<HTMLElement>(
          '.chakra-skeleton, [class*="skeleton"], [class*="Skeleton"], [class*="animate-pulse"]'
        );
        return Array.from(nodes).some(isVisible);
      })
      .catch(() => false);
  }

  /**
   * 等待 Active DCAs 列表加载完成（骨架屏消失）。
   *
   * 拉取订单期间 Cetus 用骨架屏填充面板，此时 "Close and Withdraw" 按钮和
   * 空态文案都还不存在。网络慢时读到的就是骨架屏，会把有订单的钱包误判成空。
   *
   * 返回三态而不是布尔：`empty` 是列表已加载完的确定结论，可以直接结束；
   * `timeout` 只说明没能判定，需要调用方决定是否刷新重试。
   */
  async waitForActiveOrdersLoaded(timeoutMs = 12_000): Promise<OrdersState> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      // 骨架屏期间两种结果都还没渲染，直接进入下一轮轮询
      if (await this.hasVisibleSkeleton()) {
        await this.page.waitForTimeout(300);
        continue;
      }
      if (await this.closeAndWithdrawButton.isVisible({ timeout: 300 }).catch(() => false)) {
        console.log('[DcaPage] Active DCAs loaded: has existing orders');
        return 'orders';
      }
      if (await this.emptyStateText.isVisible({ timeout: 300 }).catch(() => false)) {
        console.log('[DcaPage] Active DCAs loaded: empty state');
        return 'empty';
      }
      await this.page.waitForTimeout(300);
    }

    console.warn(`[DcaPage] Active DCAs list did not settle within ${timeoutMs}ms`);
    return 'timeout';
  }

  /**
   * 定位 "Close All" 右侧的刷新图标坐标。
   *
   * 与订单入口图标同理：Cetus 用 svg sprite 渲染，React id 会随重新挂载变化，
   * 所以按 `<use href="#icon-Refresh">` 扫描并取可点击祖先的中心点。
   */
  private async findRefreshIconPoint(): Promise<{ x: number; y: number } | null> {
    return this.page
      .evaluate(() => {
        for (const use of Array.from(document.querySelectorAll('use'))) {
          const ref =
            (use as SVGUseElement).href?.baseVal ??
            use.getAttribute('xlink:href') ??
            use.getAttribute('href') ??
            '';
          if (!/icon[-_]?(Refresh|Reload|Sync)/i.test(ref)) continue;

          let node: Element | null = use.closest('button') ?? use.closest('svg');
          while (node) {
            const rect = node.getBoundingClientRect();
            if (rect.width >= 12 && rect.height >= 12) {
              return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            }
            node = node.parentElement;
          }
        }

        // 兜底：取 "Active DCAs" 同一行、最靠右且无文字的小图标。
        // 必须先收窄到左侧订单面板：同一行右侧还有 Swap/Pro/图表等无文字图标。
        const title = Array.from(document.querySelectorAll<HTMLElement>('div, span, p')).find((el) => {
          const text = (el.textContent ?? '').trim();
          return text.length < 24 && /active\s+dcas?/i.test(text);
        });
        if (!title) return null;

        let panel: HTMLElement | null = title;
        while (panel && !(panel.offsetWidth >= 300 && /past\s+dcas?/i.test(panel.textContent ?? ''))) {
          panel = panel.parentElement;
        }
        if (!panel) return null;

        const row = title.getBoundingClientRect();
        const icons = Array.from(panel.querySelectorAll<HTMLElement>('button, [role="button"], svg')).filter(
          (el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width < 12 || rect.width > 48 || rect.height < 12 || rect.height > 48) return false;
            if (Math.abs(rect.top - row.top) > 32) return false;
            return (el.textContent ?? '').trim() === '';
          }
        );
        if (icons.length === 0) return null;

        const rect = icons
          .reduce((best, el) =>
            el.getBoundingClientRect().left > best.getBoundingClientRect().left ? el : best
          )
          .getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })
      .catch(() => null);
  }

  /**
   * 点击面板上的刷新图标重新拉取订单，并等待骨架屏消失。
   *
   * 图标找不到时退回整页 reload，保证刷新动作总能生效。
   */
  async refreshOrdersPanel(): Promise<OrdersState> {
    const point = await this.findRefreshIconPoint();
    if (point) {
      await this.page.mouse.click(point.x, point.y);
      await this.page.waitForTimeout(300);
      return this.waitForActiveOrdersLoaded();
    }

    console.warn('[DcaPage] refresh icon not found, falling back to page reload');
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle').catch(() => undefined);
    await this.dismissTermsModalIfPresent();
    await this.openOrdersPanel();
    return this.waitForActiveOrdersLoaded();
  }

  /**
   * 判断是否存在可关闭的 DCA 订单。
   *
   * 三态短路：拿到 `empty` 说明列表确实加载完且没有订单，立即返回，不再刷新重试；
   * 只有 `timeout`（骨架屏没散、无法判定）才刷新，最多重试 2 次。
   */
  async hasActiveOrderToClose() {
    // 复用 openOrdersPanel() 刚拿到的结论，不重复等一遍
    let state = this.lastOrdersState ?? (await this.waitForActiveOrdersLoaded());
    this.lastOrdersState = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      if (state === 'orders') return true;
      if (state === 'empty') return false;

      console.warn(`[DcaPage] Active DCAs still loading (attempt ${attempt + 1}/3), refreshing...`);
      state = await this.refreshOrdersPanel();
    }

    return state === 'orders';
  }

  async closeFirstActiveOrder() {
    const closeButton = this.page.getByRole('button', { name: /^close and withdraw$/i }).first();
    await expect(closeButton).toBeVisible({ timeout: 20_000 });
    await expect(closeButton).toBeEnabled({ timeout: 20_000 });
    await closeButton.click();
  }

  async expectOrderClosed() {
    const successText = this.page
      .getByText(/transaction completed|order closed successfully|dca order closed|view on explorer|view in explorer/i)
      .first();
    await expect(successText).toBeVisible({ timeout: 60_000 });
  }
}
