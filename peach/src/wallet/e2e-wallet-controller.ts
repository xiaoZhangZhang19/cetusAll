import { type Page, expect } from '@playwright/test';
import { dismissConsentDialog, waitForOverlayGone } from '../utils/consent-dialog.js';
import type { WalletBridge } from './bridge.js';

/**
 * E2E Wallet 控制器 —— 注入式钱包的对外接口。
 *
 * 页面里注入的是一个假的 EIP-1193 provider（src/wallet/inject/provider.js），
 * 它不持有私钥；需要签名的请求经 exposeBinding 交给 Node 侧的 bridge 处理。
 * 因此这里没有任何「操作钱包 UI」的代码，方法都退化成等页面/等钱包状态：
 *
 *   connect()                    → 等 header 出现地址，必要时点一次连接弹窗
 *   approveTransaction()         → 等钱包真的签名/广播了一次（没有审批弹窗）
 *   approveTransactionForAction()→ 先执行动作，再等钱包活动
 *   rejectTransaction()          → 让 bridge 对下一次签名请求返回 4001
 *   waitForLastReceipt()         → 直接问节点要回执，不信前端的成功提示
 */

/** header 里的缩写地址，例如 0x03b2...99D5。连接成功的唯一判据。 */
const HEADER_ADDRESS = /0x[a-fA-F0-9]{4}/;

export class E2EWalletController {
  constructor(private readonly bridge: WalletBridge) {}

  /** 注入钱包的地址，供余额断言使用。 */
  get address(): string {
    return this.bridge.address;
  }

  /**
   * 钱包被用掉的次数（广播交易数 + 签名数）。
   *
   * 注入钱包是同步签名的，动作可能在「点击确认」那一步就已经完成。
   * 调用点必须在触发动作【之前】读一次这个值作为基线，再用
   * waitForActivitySince() 等增量，否则会漏掉已经发生的签名 ——
   * 表现就是交易明明上链了，测试却报「钱包没有任何签名或交易动作」。
   */
  get activityCount(): number {
    return this.bridge.activityCount;
  }

  /**
   * 连接钱包。没有插件弹窗，也没有审批步骤。
   *
   * 实测前端有两种行为，这里都要覆盖：
   *   A. 自动恢复连接（peach-swap.vercel.app）：provider 对 eth_accounts 返回
   *      非空数组，AppKit 据此判定已授权，页面加载完就是已连接状态。
   *   B. 需要显式点一次（test-peachswap.vercel.app）：header 显示 "Connect"，
   *      要点开 AppKit 弹窗并选中 "E2E Wallet" 才会连上。
   *
   * 先等一段时间看是否走 A，超时再走 B。
   */
  async connect(page: Page): Promise<void> {
    // 同意弹窗由客户端渲染，实测 goto 之后要几秒才挂载，所以给足等待时间。
    // 给太小会误判成「没有弹窗」，然后卡在被遮罩挡住的 Connect 按钮上。
    await this.dismissTermsIfPresent(page, 6_000);

    const header = page.locator('header').first();
    const connected = header.getByText(HEADER_ADDRESS).first();
    const connectBtn = header.getByRole('button', { name: /^connect( wallet)?$/i }).first();

    // ── 阶段 1：等 header hydrate 出可判定的状态 ──────────────────────────
    //
    // 不能盲等固定时长再点击：terminal 页要加载 20+ 代币行情，实测 header 上
    // 的 Connect 按钮要十几秒才挂载。之前固定等 15s 再点，正好撞上页面重渲染，
    // 结果点了个即将被替换掉的元素，连接就没生效。
    // 这里改成等「地址」或「Connect 按钮」任意一个真正出现。
    const readyDeadline = Date.now() + 60_000;
    let sawConnectBtn = false;
    while (Date.now() < readyDeadline) {
      if (await connected.isVisible().catch(() => false)) {
        console.log(`[E2EWallet] Auto-connected as ${this.bridge.address}`);
        return;
      }
      if (await connectBtn.isVisible().catch(() => false)) {
        // Connect 按钮「可见」不等于「可点」：同意弹窗的遮罩盖在整页上，
        // 而 header 上的按钮在 Playwright 眼里仍然是 visible 的。
        // 所以这里必须先把弹窗和遮罩清掉，否则第一次点击会被拦截 ——
        // 而失败的那次点击可能已经透传给 AppKit，重试就会撞上
        // "Connection declined — a previous request is still active"。
        await this.dismissTermsIfPresent(page, 1_500);
        await this.waitForOverlayGone(page);
        sawConnectBtn = true;
        break;
      }
      // 同意弹窗由客户端渲染，可能在 hydrate 之后才挂载
      await this.dismissTermsIfPresent(page, 400);
      await page.waitForTimeout(400);
    }

    if (!sawConnectBtn) {
      const headerText = await header.innerText().catch(() => '(读取失败)');
      throw new Error(
        `[E2EWallet] 60s 内 header 既没出现钱包地址也没出现 Connect 按钮。` +
        `header 当前内容: "${headerText.replace(/\s+/g, ' ')}"。页面可能没加载完或结构已变。`,
      );
    }

    // ── 阶段 2：点 Connect 并在 AppKit 弹窗里选 E2E Wallet ────────────────
    //
    // 重试必须谨慎：AppKit 一旦发起连接请求，再点一次 Connect 会得到
    // "Connection declined — a previous request is still active"。
    // 所以每轮开始前先关掉可能已打开的弹窗，让 AppKit 回到干净状态。
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`[E2EWallet] Connecting via modal (attempt ${attempt}/3)`);

      if (attempt > 1) await this.closeAppKitModal(page);
      await this.clickConnectAndPickE2EWallet(page);

      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (await connected.isVisible().catch(() => false)) {
          console.log(`[E2EWallet] Connected as ${this.bridge.address}`);
          return;
        }
        // AppKit 报 "Connection declined" 时会给一个 Try again 按钮，
        // 点它比重新点 header 的 Connect 安全（不会再触发 declined）。
        if (await this.clickTryAgainIfPresent(page)) continue;
        await page.waitForTimeout(400);
      }
    }

    const headerText = await page.locator('header').first().innerText().catch(() => '(读取失败)');
    throw new Error(
      `[E2EWallet] 未能连接钱包。header 当前内容: "${headerText.replace(/\s+/g, ' ')}"。\n` +
      '常见原因：\n' +
      '  1. E2E_CHAIN_ID 与前端默认网络不一致（header 会显示 "Switch to ..."）\n' +
      '  2. 前端未走 EIP-6963 发现协议，弹窗里没有 "E2E Wallet" 选项\n' +
      '  3. APP_URL 指向的链前缀与 E2E_CHAIN_ID 不匹配（如 /arc-testnet vs /bsc）',
    );
  }

  /**
   * 等待一次钱包动作（签名或广播交易）真的发生。
   *
   * 插件方案里这个方法要找弹窗、点确认；注入方案没有弹窗，签名是同步完成的。
   * 但调用点仍然需要一个"钱包这一步已经过去了"的同步点，否则后续断言会跑在
   * 交易还没发出的时候 —— 所以这里等 bridge 的活动计数增加。
   *
   * 计数没涨不算失败：原来的 approveTransaction 也允许"没有弹窗"（比如
   * 已授权的代币不需要 approve），调用点是按最大次数循环调的。
   */
  /**
   * 等活动计数超过给定基线，返回最终计数。
   *
   * 与 approveTransaction() 的区别是基线由调用方提供，因此可以在触发动作
   * 之前就取好基线，不会漏掉「点击确认时就已同步完成」的签名。
   *
   * 已经满足（计数早就涨过了）时立即返回，不做无谓等待。
   */
  async waitForActivitySince(
    page: Page,
    baseline: number,
    timeoutMs = 20_000,
  ): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.bridge.activityCount <= baseline && Date.now() < deadline) {
      // dApp 已经不再显示「等待钱包」时就没必要继续等了
      if (!(await this.isWaitingForWallet(page))) break;
      await page.waitForTimeout(300);
    }
    return this.bridge.activityCount;
  }

  async approveTransaction(page: Page, timeoutMs = 20_000): Promise<boolean> {
    const before = this.bridge.activityCount;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (this.bridge.activityCount > before) {
        console.log(`[E2EWallet] Wallet action completed (${this.bridge.activityCount - before})`);
        return true;
      }
      // 前端可能弹出「Price Updated / Accept」之类需要再确认一次的横幅
      if (!(await this.isWaitingForWallet(page))) break;
      await page.waitForTimeout(300);
    }

    const happened = this.bridge.activityCount > before;
    if (!happened) console.log('[E2EWallet] No wallet action in this step (nothing to sign)');
    return happened;
  }

  /**
   * 先注册好基线再执行动作，避免动作瞬间完成导致计数变化被漏掉。
   * 适用于「点击动作本身就会触发签名」的场景。
   */
  async approveTransactionForAction(page: Page, action: () => Promise<void>): Promise<boolean> {
    const before = this.bridge.activityCount;
    await action();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (this.bridge.activityCount > before) return true;
      if (!(await this.isWaitingForWallet(page))) break;
      await page.waitForTimeout(300);
    }
    return this.bridge.activityCount > before;
  }

  /**
   * 拒签下一次钱包请求。
   *
   * 插件方案要去点弹窗里的 Reject；注入方案直接让 bridge 对下一次需要私钥的
   * 请求返回 EIP-1193 的 4001（user rejected），前端看到的错误码完全一致。
   */
  async rejectTransaction(_page: Page): Promise<void> {
    this.bridge.rejectNext();
    console.log('[E2EWallet] Next wallet request will be rejected with code 4001');
  }

  /**
   * 本次运行已广播的交易笔数。
   *
   * 多方向循环里 lastTxHash 是「全局最后一笔」，某个方向只签名未广播时会读到
   * 上一个方向的旧 hash。调用方应在发起前记下这个计数，事后确认它增加了，
   * 才能认定 lastTxHash 属于当前这次 swap。
   */
  get txCount(): number {
    return this.bridge.txHashes.length;
  }

  /**
   * 取最后一笔广播的交易 hash。没有交易时返回 undefined。
   */
  get lastTxHash(): string | undefined {
    return this.bridge.txHashes.at(-1);
  }

  /**
   * 等最后一笔交易上链并校验回执状态。
   *
   * 这是注入方案带来的额外能力：插件方案只能看前端提示，
   * 「前端弹成功但交易 revert」会被漏掉；这里直接问节点。
   */
  async waitForLastReceipt(timeoutMs = 180_000): Promise<{
    hash: string;
    status: number;
    blockNumber: number;
    gasUsed: string;
  }> {
    const hash = this.lastTxHash;
    if (!hash) throw new Error('[E2EWallet] 没有捕获到任何交易，无法查询回执');

    console.log(`[E2EWallet] Waiting for receipt ${hash}...`);
    const receipt = await this.bridge.provider.waitForTransaction(hash, 1, timeoutMs);
    if (!receipt) throw new Error(`[E2EWallet] 等待回执超时: ${hash}`);

    const result = {
      hash,
      status: receipt.status ?? 0,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
    };
    console.log(
      `[E2EWallet] Receipt status=${result.status} block=${result.blockNumber} gas=${result.gasUsed}`,
    );
    return result;
  }

  /** 断言最后一笔交易在链上成功（status === 1）。 */
  async expectLastTxSucceeded(timeoutMs = 180_000): Promise<void> {
    const receipt = await this.waitForLastReceipt(timeoutMs);
    expect(receipt.status, `交易 ${receipt.hash} 在链上 revert 了`).toBe(1);
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * 点 header 的 Connect，然后在 Reown AppKit 弹窗里选 "E2E Wallet"。
   *
   * 弹窗是 Web Component（wui-* 自定义元素），innerText 抓不到内容，
   * 但 accessible name 是可用的，所以按 role=button + name 定位。
   * 必须精确点 "E2E Wallet"：点到 MetaMask 会去找真实插件然后卡住。
   */
  private async clickConnectAndPickE2EWallet(page: Page): Promise<void> {
    const connectBtn = page
      .locator('header')
      .first()
      .getByRole('button', { name: /^connect( wallet)?$/i })
      .first();

    // 同样用 waitFor 而不是 isVisible({timeout})：后者不轮询
    const hasConnectBtn = await connectBtn
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!hasConnectBtn) {
      console.log('[E2EWallet] header 里没有 Connect 按钮，跳过点击');
      return;
    }

    // 同意弹窗的遮罩带退场动画，没等它消失就点会被判定「被遮挡」而重试到超时；
    // 更糟的是失败的点击若已透传给 AppKit，下一轮重试就会撞上
    // "Connection declined — a previous request is still active"。
    await this.dismissTermsIfPresent(page, 1_000);
    await this.waitForOverlayGone(page);

    let clicked = true;
    await connectBtn.click({ timeout: 10_000 }).catch((err) => {
      clicked = false;
      // 打完整信息：被遮挡时 Playwright 会在这里点明是哪个元素 intercept 了事件
      console.log(`[E2EWallet] ⚠ Connect 点击失败: ${String(err.message).split('\n').slice(0, 3).join(' | ')}`);
    });
    if (!clicked) return;

    // 等钱包列表渲染。实测点击后 0.5~1.2s 出现（Web Component 的渲染延迟）。
    //
    // 必须用 waitFor 而不是 isVisible({timeout})：后者不轮询，只查一次就立即
    // 返回，弹窗还在渲染时必然返回 false —— 这正是之前每轮都报
    // 「暂未出现」然后白等一轮的原因。
    // 这里不抛异常：调用方有重试循环，抛出会打断重试。
    const e2eOption = page.getByRole('button', { name: /e2e wallet/i }).first();
    const appeared = await e2eOption
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);

    if (!appeared) {
      console.log('[E2EWallet] ⚠ 10s 内弹窗里没出现 "E2E Wallet" 选项');
      return;
    }

    await e2eOption.click({ timeout: 10_000 }).catch((err) => {
      console.log(`[E2EWallet] E2E Wallet 点击失败: ${String(err.message).split('\n')[0]}`);
    });
    console.log('[E2EWallet] Picked "E2E Wallet" in the connect modal');
  }

  /**
   * AppKit 报 "Connection declined" 时点它的 Try again。
   *
   * 比重新点 header 的 Connect 安全：后者会让 AppKit 认为上一个请求还在进行，
   * 从而再次 declined，陷入死循环。
   */
  private async clickTryAgainIfPresent(page: Page): Promise<boolean> {
    const tryAgain = page.getByRole('button', { name: /^(try again|retry|重试)$/i }).first();
    if (!(await tryAgain.isVisible({ timeout: 300 }).catch(() => false))) return false;
    console.log('[E2EWallet] AppKit 报 Connection declined —— 点击 Try again');
    await tryAgain.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(1_200);
    return true;
  }

  /**
   * 关掉 AppKit 弹窗，让它回到未发起请求的干净状态。
   * 优先点弹窗自己的关闭按钮，拿不到就按 Escape。
   */
  private async closeAppKitModal(page: Page): Promise<void> {
    const closeBtn = page.getByRole('button', { name: /^(close|关闭)$/i }).first();
    if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await closeBtn.click({ timeout: 3_000 }).catch(() => undefined);
    } else {
      await page.keyboard.press('Escape').catch(() => undefined);
    }
    // AppKit 弹窗有退场动画，等它真的收起再进行下一步
    await page.waitForTimeout(1_200);
  }

  /** dApp 是否还显示「等待钱包交互」类的状态文案。 */
  private async isWaitingForWallet(page: Page): Promise<boolean> {
    return page
      .locator(
        'text=/Continue in your wallet|Confirm in your wallet|Placing order|' +
        'Wrap BNB to WBNB|Waiting for confirmation|Confirming/i',
      )
      .first()
      .isVisible({ timeout: 400 })
      .catch(() => false);
  }

  /** 关掉首次进入的同意弹窗（"Welcome to Peach" / "Terms & Policies"）。 */
  private async dismissTermsIfPresent(page: Page, timeoutMs = 3_000): Promise<boolean> {
    return dismissConsentDialog(page, 'E2EWallet', timeoutMs);
  }

  /** 等 dialog 遮罩层消失，否则后续点击会被它拦截。 */
  private async waitForOverlayGone(page: Page): Promise<void> {
    await waitForOverlayGone(page);
  }
}
