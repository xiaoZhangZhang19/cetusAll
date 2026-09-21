import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { dismissBlockingModals, dismissRiskAcknowledgement, riskAckModal } from '@/utils/dismiss-terms.js';
import { gotoWithRetry, waitForAppShellReady } from '@/utils/page-ready.js';
import { getWalletActivity } from '@/wallet/injected-controller.js';

export class MarginPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * 打开 margin 页并把两个弹窗都关掉。
   *
   * 关键顺序：**必须在 connect() 之前**关完条款弹窗和 Risk Acknowledgement。
   * 风险弹窗盖着时 chakra 给兄弟节点打 aria-hidden，header 的 Connect 按钮从
   * a11y 树里消失，connect() 的三路 getByRole 竞速会全部落空、白等 20s 后静默
   * 返回「没连上」，测试就会在未连接钱包的状态下继续跑。
   *
   * 也不再等 networkidle：K 线和行情推送会把它拖到 5s+ 甚至等不到。
   */
  async goto(path: string = '/margin') {
    await gotoWithRetry(this.page, path);
    // 竞速等两个弹窗中任一出现 → 关掉 → 再用短窗口接第二个，不做串行的固定等待。
    await dismissBlockingModals(this.page, { timeout: 10_000 });
    await waitForAppShellReady(this.page);
    // shell 就绪后风险弹窗才挂载的情况：即时补一次，不存在就立刻返回。
    await dismissRiskAcknowledgement(this.page).catch(() => false);
  }

  private get continueButton() {
    return riskAckModal(this.page).getByRole('button', { name: /^continue$/i }).first();
  }

  /** 风险确认弹窗当前是否可见。 */
  async isRiskAcknowledgementVisible(timeout = 0): Promise<boolean> {
    const modal = riskAckModal(this.page);
    return timeout > 0
      ? modal.waitFor({ state: 'visible', timeout }).then(() => true, () => false)
      : modal.isVisible().catch(() => false);
  }

  /**
   * 关闭 Risk Acknowledgement 弹窗（不存在时立刻返回 false，不轮询）。
   *
   * 勾选逻辑统一走 utils/dismiss-terms：那边按 DOM 结构点复选框、用「svg 对勾是否
   * 出现」做判据，不再依赖「文案左移 20px 像素点击 + sleep」。失败时兜底用页面内
   * 直接点击所有复选框。
   */
  async dismissRiskAcknowledgementIfPresent(timeout = 0): Promise<boolean> {
    const dismissed = await dismissRiskAcknowledgement(this.page, { timeout }).catch(() => false);
    if (dismissed) {
      console.log('[margin] Risk Acknowledgement modal dismissed');
      return true;
    }

    // 复选框没勾上导致 Continue 一直 disabled：用 DOM 兜底再试一次。
    if (!(await riskAckModal(this.page).isVisible().catch(() => false))) return false;

    console.log('[margin] Risk Acknowledgement still open, falling back to DOM clicks');
    await this.tickCheckboxViaDom();
    await expect(this.continueButton).toBeEnabled({ timeout: 10_000 });
    await this.continueButton.click();
    await riskAckModal(this.page).waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => undefined);
    return true;
  }

  /** 兜底：在页面内直接勾选弹窗里所有 checkbox。 */
  private async tickCheckboxViaDom() {
    await this.page
      .evaluate(() => {
        const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
        const root =
          dialogs.find((el) => /risk acknowledge?ment/i.test(el.textContent ?? '')) ??
          dialogs.at(-1) ??
          document.body;
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

    // 几何筛选全部落空时的最后手段：在页面内找「紧贴触发按钮下方」的那个选项并合成点击。
    if (await this.pickTokenViaDom(target)) {
      console.log(`[margin] Deposit token switched to ${symbol} (DOM fallback)`);
      return;
    }

    throw new Error(`Failed to switch deposit token to ${symbol} (still ${await this.getDepositToken()})`);
  }

  /**
   * 兜底：在页面内直接找下拉项并派发合成点击事件。
   *
   * 判据与 clickTokenOptionBelowTrigger 一致（紧贴触发按钮下方、横向重叠、文案精确
   * 相等），但绕开 Playwright 的可点击性检查 —— 浮层带 pointer-events 遮罩时真实
   * 点击会被吞掉。
   */
  private async pickTokenViaDom(target: string): Promise<boolean> {
    await this.depositTokenButton.click().catch(() => undefined);
    await this.page.waitForTimeout(400);

    await this.page
      .evaluate((symbol) => {
        const trigger = document.querySelector<HTMLElement>('.chakra-input__right-addon button.chakra-button');
        if (!trigger) return;
        const t = trigger.getBoundingClientRect();

        const nodes = Array.from(document.querySelectorAll<HTMLElement>('p, span, div, li, button'));
        const hit = nodes
          .filter((el) => (el.textContent ?? '').trim().toUpperCase() === symbol.toUpperCase())
          .map((el) => ({ el, box: el.getBoundingClientRect() }))
          .filter(({ box }) => box.width > 0 && box.height > 0)
          .filter(({ box }) => box.top - t.bottom > -t.height / 2 && box.top - t.bottom < 120)
          .filter(({ box }) => box.right > t.left - 40 && box.left < t.right + 40)
          .sort((a, b) => a.box.top - b.box.top)[0];
        if (!hit) return;

        const node = hit.el.closest('button, li, [role="option"], [role="menuitem"]') ?? hit.el;
        ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((type) =>
          node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
        );
      }, target)
      .catch(() => undefined);

    return this.waitForDepositToken(target, 3_000);
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
   * 按文案全页匹配 SUI 会命中 "Short Size" 面板里的币种标签 —— 它同样位于触发按钮
   * 下方、也与其横向重叠，且 DOM 顺序更靠前，所以旧的「在下方 + 横向重叠」两个
   * 条件不足以区分，每次都点在那个纯展示标签上，币种自然切不过去。
   *
   * 这里改成：候选必须紧贴触发按钮下方（纵向间距 < 120px，下拉项就贴着按钮弹出，
   * 而 Short Size 面板隔着一大段距离），并在所有合格候选里取间距最小的那个；
   * 点击对象也换成最近的可点击祖先（下拉项的点击事件挂在行容器上，不在文字节点）。
   */
  private async clickTokenOptionBelowTrigger(target: string): Promise<boolean> {
    const trigger = await this.depositTokenButton.boundingBox();
    if (!trigger) return false;

    const triggerBottom = trigger.y + trigger.height;
    const candidates = this.page.getByText(new RegExp(`^\\s*${target}\\s*$`, 'i'));
    const count = await candidates.count().catch(() => 0);

    let best: Locator | null = null;
    let bestGap = Infinity;

    for (let i = 0; i < count; i++) {
      const candidate = candidates.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) continue;

      const box = await candidate.boundingBox().catch(() => null);
      if (!box) continue;

      // 下拉项紧贴按钮下沿弹出；Short Size 面板在更下方，靠这个间距阈值排除。
      const gap = box.y - triggerBottom;
      if (gap < -trigger.height / 2 || gap > 120) continue;
      if (box.x + box.width <= trigger.x - 40 || box.x >= trigger.x + trigger.width + 40) continue;

      if (gap < bestGap) {
        bestGap = gap;
        best = candidate;
      }
    }

    if (!best) return false;

    // 点击事件挂在下拉行容器上，点文字节点可能落在不带 handler 的 <p> 上。
    const clickable = best.locator('xpath=ancestor-or-self::*[self::button or self::li or self::div][1]');
    const targetNode = (await clickable.isVisible().catch(() => false)) ? clickable : best;

    await targetNode.click({ timeout: 5_000 }).catch(() => undefined);
    if (await this.waitForDepositToken(target, 1_500)) return true;

    // 没生效再退化为坐标直击 + force click：浮层有时套了一层拦截指针事件的遮罩。
    const box = await best.boundingBox().catch(() => null);
    if (box) {
      await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      if (await this.waitForDepositToken(target, 1_500)) return true;
    }
    await targetNode.click({ force: true, timeout: 3_000 }).catch(() => undefined);
    return true;
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
    await this.expectPositionOpened();
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

  /** 是否出现了 "Waiting for Confirmation" 弹窗（交易已提交、正等钱包签名）。 */
  private async isWaitingForConfirmation(): Promise<boolean> {
    return this.page
      .getByText(/waiting for confirmation|confirm this transaction in your wallet/i)
      .first()
      .isVisible()
      .catch(() => false);
  }

  /**
   * 提交开仓。风险弹窗可能在点击开仓按钮时才弹出并拦截交易，
   * 因此这里循环：点击 → 若弹窗出现则关闭 → 重新点击，直到交易真正发出。
   */
  private async submitOpenPosition(buttonText: string) {
    await this.dismissRiskAcknowledgementIfPresent();

    const openButton = await this.waitForOpenPositionButtonReady(buttonText);
    // 签名次数是「交易真的发出去了」的唯一硬证据：注入钱包没有审批弹窗，
    // dApp 一调 signTransaction 就同步走完，signCount 会 +1。
    const activity = getWalletActivity(this.page);
    const signsBefore = activity.signCount;

    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`[margin] Click #${attempt}: "${buttonText}"`);
      await openButton.click({ timeout: 10_000 }).catch(() => undefined);
      await this.page.waitForTimeout(1_200);

      if (activity.signCount > signsBefore) {
        console.log(`[margin] "${buttonText}" 已触发签名（signCount ${signsBefore} → ${activity.signCount}）`);
        return;
      }

      // 弹窗拦截了交易：关闭后等面板重新就绪再重试点击
      if (await this.dismissRiskAcknowledgementIfPresent()) {
        await this.waitForOpenPositionButtonReady(buttonText, 10_000).catch(() => undefined);
        continue;
      }

      // 「Waiting for Confirmation」只说明前端开始构建交易，不等于签名已发生。
      //
      // 以前这里一看到它就 return，把「等钱包」这一步整个跳过了 —— 而 Cetus 构建
      // margin 交易还要先拿 Pyth 价格更新数据，这段有网络往返，签名请求往往在
      // 点击后好几秒才发出。结果就是：用例在弹窗刚出现时就往下走，
      // signCount 还是 0，最终报成「开仓应至少触发一次签名」。
      //
      // 正确做法是：看到弹窗后就地等签名，而不是 return。
      if (await this.isTransactionInFlight()) {
        console.log('[margin] 交易已提交，等待钱包签名...');
        if (await this.waitForSignature(signsBefore, 45_000)) {
          console.log(`[margin] "${buttonText}" 已触发签名（signCount ${signsBefore} → ${activity.signCount}）`);
          return;
        }
        // 等不到签名：可能是前端构建交易失败后把弹窗关了，跳出去按失败处理。
        console.warn('[margin] 弹窗出现但 45s 内没有签名请求');
        break;
      }

      await this.waitForOpenPositionButtonReady(buttonText, 8_000).catch(() => undefined);
    }

    // 点击可能发出交易但签名稍晚到（前端要先构建 tx），再给一个短窗口。
    const signed = await this.waitForSignature(signsBefore, 15_000);
    if (signed) {
      console.log(`[margin] "${buttonText}" 已触发签名（signCount ${signsBefore} → ${activity.signCount}）`);
      return;
    }

    // 三轮都没触发签名：必须抛错。
    // 以前这里只打一行日志就继续，于是「按钮没点到」会被后面的 expectOpenXSuccess
    // 咽掉（它匹配任意 Close 按钮，连 modal 右上角的关闭图标都算），用例直接假绿。
    //
    // 两种失败形态要分开报，否则排查方向完全被带偏：
    if (await this.isWaitingForConfirmation()) {
      throw new Error(
        `[margin] "${buttonText}" 已点击成功（页面停在 "Waiting for Confirmation"），` +
        '但注入钱包始终没收到签名请求。说明 margin 面板调用的签名 feature 没有被注册 —— ' +
        '检查 injected-wallet-script.ts 的 features 是否覆盖了它用的方法名' +
        '（v2: sui:signTransaction / v1: sui:signTransactionBlock），' +
        '并看浏览器 console 有没有 "[Playwright Wallet] sign* called" 日志。'
      );
    }

    throw new Error(
      `[margin] 点击 "${buttonText}" 3 次后仍未发出交易（signCount 始终为 ${signsBefore}）。` +
      '按钮可能被弹窗/遮罩挡住、处于 disabled（金额或余额不足），或文案与定位不匹配。'
    );
  }

  /** 等 signCount 超过基线，说明 dApp 真的发起了签名请求。 */
  private async waitForSignature(signsBefore: number, timeoutMs: number): Promise<boolean> {
    const activity = getWalletActivity(this.page);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (activity.signCount > signsBefore) return true;
      await this.page.waitForTimeout(200);
    }
    return false;
  }

  /** 交易是否已发出：钱包扩展页已打开，或页面进入 pending/loading 状态。 */
  private async isTransactionInFlight(): Promise<boolean> {
    const hasWalletPage = this.page
      .context()
      .pages()
      .some((candidate) => !candidate.isClosed() && candidate.url().startsWith('chrome-extension://'));
    if (hasWalletPage) return true;

    // 文案要够具体：原来的 /pending|processing|waiting for/ 会命中页面上无关的
    // 常驻文本（持仓表头、提示语等），让「交易已发出」误判成真。
    const pendingText = this.page
      .getByText(
        /waiting for confirmation|confirm this transaction in your wallet|confirm(ing)? in wallet|submitting transaction/i
      )
      .first();
    return pendingText.isVisible().catch(() => false);
  }

  async expectOpenShortSuccess() {
    await this.expectPositionOpened();
  }

  /**
   * 开仓成功断言：链上签名已发生 + Active Positions 里真的多了一条持仓。
   *
   * 不能再用 `getByRole('button', { name: /^close$/i }).last()`：
   * chakra 弹窗右上角的关闭图标 aria-label 正好就是 "Close"，页面上随便开个 modal
   * 都能让它可见 —— 开仓按钮根本没点到也会绿。
   */
  private async expectPositionOpened() {
    const activity = getWalletActivity(this.page);
    expect(activity.signCount, '开仓应至少触发一次签名').toBeGreaterThan(0);

    // UI 证据：Active Positions 的计数徽章 > 0，或空态 "No positions" 消失。
    // 徽章数字和文案常常是两个相邻节点（textContent 可能拼成 "Active Positions0"），
    // 所以取包含该文案的容器整体文本再抽数字，不依赖具体标签结构。
    await expect
      .poll(async () => this.hasActivePosition(), {
        message: '开仓后 Active Positions 应出现至少一条持仓',
        timeout: 90_000,
        intervals: [1_000]
      })
      .toBe(true);

    console.log(`[margin] 开仓成功：signCount=${activity.signCount} digests=${JSON.stringify(activity.digests)}`);
  }

  /** Active Positions 里是否已有持仓（徽章计数 > 0，或空态提示已消失）。 */
  private async hasActivePosition(): Promise<boolean> {
    return this.page
      .evaluate(() => {
        const nodes = Array.from(document.querySelectorAll<HTMLElement>('p, div, span'));

        // 找「文案就是 Active Positions」的那个节点，读它父容器的文本里的数字。
        const tab = nodes.find((el) => /^\s*active positions\s*\d*\s*$/i.test(el.textContent ?? ''));
        if (tab) {
          const scope = (tab.parentElement ?? tab).textContent ?? '';
          const matched = scope.match(/active positions\s*(\d+)/i);
          if (matched) return Number(matched[1]) > 0;
        }

        // 没有徽章数字的布局：以空态提示是否还在为准。
        const empty = nodes.some(
          (el) => /^\s*no positions\s*$/i.test(el.textContent ?? '') && el.offsetHeight > 0
        );
        return !empty;
      })
      .catch(() => false);
  }

  /** Active Positions 面板：同时含 "Active Positions" 与表头 "Position" 的最内层容器。 */
  private get positionsPanel(): Locator {
    return this.page
      .locator('div')
      .filter({ has: this.page.locator('p', { hasText: /^Active Positions$/i }) })
      .filter({ has: this.page.locator('p', { hasText: /^Position$/i }) })
      .last();
  }

  /**
   * 指定交易对的持仓行（行尾带展开箭头的那一层容器）。
   *
   * 不再用 Emotion 生成的 hash 类名（如 `.css-u7ab40`）：那串 hash 随前端每次
   * 构建变化，之前就是因为它变成了 `css-6jqwcr` 导致点击超时。这里按结构定位：
   * 面板内同时包含「交易对文案」和「箭头 svg」的最内层 div 就是持仓行。
   */
  private positionRow(baseSymbol: string, quoteSymbol: string): Locator {
    const pairText = new RegExp(`^\\s*${baseSymbol}\\s*/\\s*${quoteSymbol}\\s*$`, 'i');
    return this.positionsPanel
      .locator('div')
      .filter({ has: this.page.locator('p', { hasText: pairText }) })
      .filter({ has: this.page.locator('svg') })
      .last();
  }

  /** 底部悬浮的 swap widget 气泡会压住持仓行左侧，先关掉避免点击被拦截。 */
  private async dismissFloatingSwapWidget() {
    const widget = this.page.locator('.react-draggable').filter({ hasText: /call out swap widget/i }).first();
    if (!(await widget.isVisible({ timeout: 1_000 }).catch(() => false))) return;

    await widget.locator('svg').last().click({ force: true, timeout: 3_000 }).catch(() => undefined);
    await this.page.waitForTimeout(300);
    console.log('[margin] Dismissed floating swap widget tooltip');
  }

  /** 关掉可能残留的下拉浮层（如交易对选择菜单），否则会遮住持仓表格。 */
  private async dismissOpenMenus() {
    const menu = this.page.locator('[role="menu"]:visible, .chakra-menu__menu-list:visible').first();
    if (!(await menu.isVisible({ timeout: 500 }).catch(() => false))) return;

    await this.page.keyboard.press('Escape').catch(() => undefined);
    await this.page.waitForTimeout(300);
  }

  /** 持仓行是否已展开（展开后出现 Position ID 与 Close / Manage 按钮）。 */
  private async isPositionRowExpanded(): Promise<boolean> {
    const marker = this.page.getByText(/position id/i).first();
    return marker.isVisible({ timeout: 1_000 }).catch(() => false);
  }

  /**
   * 点击行尾箭头展开持仓详情。
   * 箭头是行内唯一的 svg（币种图标是 <img>），所以取行内最后一个 svg 即可。
   */
  private async expandPositionRow(row: Locator) {
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.scrollIntoViewIfNeeded().catch(() => undefined);

    for (let attempt = 1; attempt <= 3; attempt++) {
      if (await this.isPositionRowExpanded()) return;

      const chevron = row.locator('svg').last();
      await chevron.click({ force: true, timeout: 5_000 }).catch(() => undefined);
      await this.page.waitForTimeout(600);

      if (await this.isPositionRowExpanded()) {
        console.log(`[margin] Position row expanded (attempt #${attempt})`);
        return;
      }

      // 箭头被遮挡时退化为点击整行
      await row.click({ force: true, timeout: 5_000 }).catch(() => undefined);
      await this.page.waitForTimeout(600);
    }

    throw new Error('Failed to expand the position row (Position ID / Close never appeared)');
  }

  /** 展开区域里的 "Close" 按钮（与 "Manage" 并排）。 */
  private async clickCloseInExpandedRow() {
    const closeButton = this.positionsPanel
      .locator('button, [role="button"]')
      .filter({ hasText: /^\s*close\s*$/i })
      .last();

    await expect(closeButton).toBeVisible({ timeout: 15_000 });
    await expect(closeButton).toBeEnabled({ timeout: 10_000 });
    await closeButton.scrollIntoViewIfNeeded().catch(() => undefined);
    await closeButton.click();
    console.log('[margin] Clicked "Close" in the expanded position row');
  }

  async startCloseFromPositionsTable(baseSymbol: string, quoteSymbol: string) {
    await this.dismissOpenMenus();
    await this.dismissFloatingSwapWidget();

    const positionsTab = this.page
      .locator('p, div')
      .filter({ hasText: /^Positions$/ })
      .first();
    if (await positionsTab.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await positionsTab.click({ force: true }).catch(() => undefined);
      await this.page.waitForTimeout(800);
    }

    await this.expandPositionRow(this.positionRow(baseSymbol, quoteSymbol));
    await this.clickCloseInExpandedRow();
    await this.page.waitForTimeout(500);
  }

  /** "Manage Position" 弹窗容器。 */
  private get managePositionModal(): Locator {
    return this.page
      .locator('[role="dialog"], section.chakra-modal__content')
      .filter({ hasText: /manage position/i })
      .last();
  }

  /**
   * 在 "Manage Position" 弹窗里点击提交按钮。
   *
   * 弹窗内 "Close Position" 出现两次：一个是可折叠的小标题，一个是底部蓝色提交按钮。
   * 原来的 `.nth(1)` 依赖两者都被识别成 button 且顺序固定，很脆弱；
   * 这里先限定弹窗范围，再取真正可点击的提交按钮（页面纵向位置最下的那个）。
   */
  async confirmClosePositionInModal() {
    const modal = this.managePositionModal;
    await expect(modal).toBeVisible({ timeout: 20_000 });

    const submitButton = await this.resolveClosePositionSubmit(modal);
    await expect(submitButton).toBeEnabled({ timeout: 20_000 });
    await submitButton.click();
    console.log('[margin] Clicked "Close Position" in the Manage Position modal');
  }

  /** 弹窗内文案为 Close Position 的候选里，挑纵向位置最靠下的那个（即提交按钮）。 */
  private async resolveClosePositionSubmit(modal: Locator): Promise<Locator> {
    const candidates = modal.locator('button').filter({ hasText: /^\s*close position\s*$/i });
    await expect(candidates.first()).toBeVisible({ timeout: 20_000 });

    const count = await candidates.count().catch(() => 0);
    let best = candidates.first();
    let bestY = -Infinity;

    for (let i = 0; i < count; i++) {
      const candidate = candidates.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) continue;

      const box = await candidate.boundingBox().catch(() => null);
      if (box && box.y > bestY) {
        bestY = box.y;
        best = candidate;
      }
    }

    return best;
  }

  /** 关仓成功：Manage Position 弹窗关闭。 */
  async expectClosePositionSuccess() {
    await expect(this.managePositionModal).toBeHidden({ timeout: 90_000 });
    console.log('[margin] Close position confirmed — modal dismissed');
  }
}
