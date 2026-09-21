import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { Transaction } from '@mysten/sui/transactions';

import { env } from '@/config/env.js';
import { getSuiClient, getKeypairFromEnv } from '@/chain/client.js';
import { dismissCetusTerms } from '@/utils/dismiss-terms.js';
import type { WalletController } from './controller.js';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 注入钱包在 Cetus 连接弹窗里显示的名字。
 *
 * ⚠️ 必须使用 Cetus 白名单里的名字，不能自定义。
 * Cetus 的 "Connect a wallet" 弹窗不是「列出所有已注册的 wallet-standard 钱包」，
 * 而是渲染一份固定的 18 个钱包清单（Slush / Phantom / OKX / Binance +
 * "Other Wallets" 里的 Suiet / Bybit / Gate / Bitget / Backpack /
 * Sui MetaMask Snap / Surf / Coin98 / MSafe / Onekey / TokenPocket /
 * Nightly / Safepal）。名字不在这份清单里的钱包即使注册成功也不会显示。
 *
 * 选 Suiet 而不是 Slush：extension 模式用的是 Slush，两种模式共存时不撞名，
 * 也避免真实 Slush 插件已安装时出现两个同名条目。
 */
export const INJECTED_WALLET_NAME = 'Suiet';

/**
 * 一次运行里钱包被用掉的记录。
 *
 * Cetus 只调 sui:signTransaction、自己广播，所以 Node 侧拿不到「执行结果」，
 * 但 digest 在签名前就确定了，可以在这里记下来。测试据此直接向节点查回执，
 * 不必从 UI 文本里抓 base58（抓不到失败的交易，且容易误匹配 CSS class）。
 */
export interface WalletActivity {
  /** 签名次数（含 signTransaction / signAndExecute / signPersonalMessage）。 */
  signCount: number;
  /** 本次运行签过的所有交易 digest，按顺序。 */
  digests: string[];
  /** WALLET_DRY_RUN=true 时每次 dryRun 的 effects 状态。 */
  dryRunStatuses: string[];
}

const activityByPage = new WeakMap<Page, WalletActivity>();

/** 取某个 page 的钱包活动记录，没有则创建。 */
export function getWalletActivity(page: Page): WalletActivity {
  let activity = activityByPage.get(page);
  if (!activity) {
    activity = { signCount: 0, digests: [], dryRunStatuses: [] };
    activityByPage.set(page, activity);
  }
  return activity;
}

/**
 * Exposes three Node.js signing functions onto the page window so that the
 * injected wallet script can bridge signing requests back to the test process.
 *
 * Must be called once per page, ideally right after the page is created in
 * the `page` fixture (before any navigation).
 */
export async function setupSigningBridge(page: Page): Promise<void> {
  const activity = getWalletActivity(page);

  // Sign a transaction and return bytes + signature (no broadcast).
  //
  // 实测 Cetus swap 走的就是这条路径：它只要签名，自己负责广播。
  await page.exposeFunction(
    '__pw_sign_transaction',
    async (txJSON: string): Promise<{ bytes: string; signature: string }> => {
      const keypair = getKeypairFromEnv();
      const client = getSuiClient();
      const tx = Transaction.from(txJSON);
      tx.setSenderIfNotSet(env.testWalletAddress);
      const built = await tx.build({ client });

      // digest 在签名前就已确定，这里记下来供测试断言链上回执用。
      // 不记的话只能从 UI 抓 base58 文本，既不可靠也抓不到失败的交易。
      const digest = await tx.getDigest({ client }).catch(() => undefined);
      if (digest) activity.digests.push(digest);

      if (env.walletDryRun) {
        const status = await dryRunAndReport(built, digest);
        activity.dryRunStatuses.push(status);
        // 返回坏签名让前端广播失败，确保 dry-run 模式下绝不会真上链。
        const real = await keypair.signTransaction(built);
        activity.signCount += 1;
        return { bytes: real.bytes, signature: 'A'.repeat(real.signature.length) };
      }

      const { bytes, signature } = await keypair.signTransaction(built);
      activity.signCount += 1;
      console.log(`[wallet] signTransaction digest=${digest ?? '(unknown)'}`);
      return { bytes, signature };
    }
  );

  // Sign and broadcast a transaction, returning the full SuiTransactionBlockResponse.
  await page.exposeFunction(
    '__pw_sign_and_execute',
    async (txJSON: string): Promise<Record<string, unknown>> => {
      const keypair = getKeypairFromEnv();
      const client = getSuiClient();
      const tx = Transaction.from(txJSON);
      tx.setSenderIfNotSet(env.testWalletAddress);

      if (env.walletDryRun) {
        const built = await tx.build({ client });
        const digest = await tx.getDigest({ client }).catch(() => undefined);
        if (digest) activity.digests.push(digest);
        const status = await dryRunAndReport(built, digest);
        activity.dryRunStatuses.push(status);
        activity.signCount += 1;
        // 抛 4001，前端按「用户拒签」处理，不会卡在等回执上。
        throw Object.assign(new Error('User rejected the request (WALLET_DRY_RUN=true)'), {
          code: 4001,
        });
      }

      const result = await client.signAndExecuteTransaction({
        transaction: tx,
        signer: keypair,
      });
      activity.signCount += 1;
      const digest = (result as { digest?: string }).digest;
      if (digest) {
        activity.digests.push(digest);
        console.log(`[wallet] signAndExecuteTransaction digest=${digest}`);
      }
      // Serialize to a plain object so Playwright's JSON bridge can transfer it.
      return result as unknown as Record<string, unknown>;
    }
  );

  // Sign a personal message (EIP-191 equivalent on Sui).
  await page.exposeFunction(
    '__pw_sign_message',
    async (msgB64: string): Promise<{ bytes: string; signature: string }> => {
      const keypair = getKeypairFromEnv();
      const msgBytes = Buffer.from(msgB64, 'base64');
      const { bytes, signature } = await keypair.signPersonalMessage(msgBytes);
      activity.signCount += 1;
      return { bytes, signature };
    }
  );
}

/** dryRun 一份已构建的交易字节，打印并返回 effects 状态。 */
async function dryRunAndReport(
  built: Uint8Array,
  digest: string | undefined
): Promise<string> {
  const client = getSuiClient() as unknown as {
    dryRunTransactionBlock(input: { transactionBlock: Uint8Array }): Promise<{
      effects?: { status?: { status?: string; error?: string }; gasUsed?: unknown };
      balanceChanges?: unknown;
    }>;
  };

  try {
    const res = await client.dryRunTransactionBlock({ transactionBlock: built });
    const status = res.effects?.status?.status ?? 'unknown';
    const error = res.effects?.status?.error ?? '';
    console.log(
      `[wallet:dry-run] digest=${digest ?? '(unknown)'} status=${status}` +
      (error ? ` error=${error}` : '') +
      ` gas=${JSON.stringify(res.effects?.gasUsed ?? {})}`
    );
    console.log(`[wallet:dry-run] balanceChanges=${JSON.stringify(res.balanceChanges ?? [])}`);
    return status;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[wallet:dry-run] failed: ${message.slice(0, 300)}`);
    return `dry-run-failed: ${message.slice(0, 120)}`;
  }
}

/**
 * 注入式钱包的 WalletController 实现。
 *
 *  - 不需要浏览器扩展，也不需要持久化 profile。
 *  - 签名由 Node 侧的桥（setupSigningBridge）用私钥完成。
 *  - approveTransaction 是空操作 —— 没有审批弹窗，签名是同步完成的。
 *    需要「等钱包这一步过去」的同步点时，读 getWalletActivity(page).signCount。
 */
export class InjectedWalletController implements WalletController {
  async connect(page: Page): Promise<void> {
    // 不等 networkidle：连接只依赖 header hydrate 完（Connect 按钮可点），
    // 跟 K 线 / 行情 / 报价那些后台请求无关。下面的 connectBtn.waitFor() 本身
    // 就是正确的同步点，多等一个 networkidle 只是白等好几秒。
    await this.dismissCetusTermsIfPresent(page, 3_000);

    const addrPrefix = env.testWalletAddress.slice(0, 6);
    const connectedAddr = page.getByText(new RegExp(addrPrefix, 'i')).first();

    // 必须精确匹配按钮文案，且优先用 header 里的那个。
    //
    // 用 filter({ hasText: /connect wallet|connect/i }).first() 会命中 swap 表单
    // 主体里的 "Connect Wallet"（它在 DOM 顺序上更靠前），而那个按钮点下去并不
    // 打开钱包选择弹窗 —— 表现就是 selectWalletFromModal() 报
    // "Connect modal not visible" 然后静默跳过，最后卡在「没连上」。
    const headerConnect = page
      .locator('header')
      .getByRole('button', { name: /^connect( wallet)?$/i })
      .first();
    const anyConnect = page
      .getByRole('button', { name: /^connect( wallet)?$/i })
      .first();

    // 去掉 networkidle 之后 header 可能还没 hydrate，所以不能再用「立即判定」的
    // isVisible()/count() 做分支 —— 那会在 header 尚未挂载时误判成「已连接=否 +
    // 只有表单按钮」，点到不会开弹窗的那个。
    //
    // 这里三路竞速，谁先给出结论就按谁走：
    //   a) header 出现地址   → 已经连上，直接返回；
    //   b) header 的 Connect → 正常路径，用它；
    //   c) 任意 Connect      → header 里确实没有，兜底用表单里的。
    //
    // 用 raceVisible 而不是裸 Promise.race：后者在第一个 promise 被 reject 时
    // 整体 reject，且落败的分支到 20s 时才 reject、没人接，会冒出
    // unhandled rejection 警告。
    const outcome = await raceVisible(20_000, {
      connected: connectedAddr,
      header: headerConnect,
      any: anyConnect,
    });

    if (outcome === 'connected') {
      console.log(`[wallet] Already connected as ${env.testWalletAddress}`);
      return;
    }
    if (outcome === 'none') {
      return;
    }

    // 'any' 先赢不代表 header 里没有按钮 —— 表单按钮在 DOM 顺序上更靠前，可能只是
    // 早了几十毫秒。再给 header 一个短暂的窗口，避免退化成点错按钮。
    const connectBtn =
      outcome === 'header' ||
      (await headerConnect.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false))
        ? headerConnect
        : anyConnect;

    // 弹窗要么没开、要么开了但列表没渲染完，所以允许重试几轮。
    for (let attempt = 1; attempt <= 3; attempt++) {
      await connectBtn.click({ force: true }).catch(() => undefined);

      const opened = await page
        .getByText(/connect a wallet/i)
        .first()
        .waitFor({ state: 'visible', timeout: 8_000 })
        .then(() => true)
        .catch(() => false);

      if (opened) break;

      console.log(`[wallet] 点击 Connect 后弹窗未出现，重试 (${attempt}/3)`);
      await page.keyboard.press('Escape').catch(() => undefined);
      // Escape 后等遮罩散掉再重点，比 sleep 800ms 更快也更可靠。
      await waitForOverlaysCleared(page);
    }

    // 把「连上了」的判定条件交给 selectWalletFromModal：它一看到 header 出现
    // 地址就立刻返回，不再逐轮 sleep 等固定时长。
    await this.selectWalletFromModal(page, connectedAddr);

    // 确认真的连上了，而不是默默走完流程。
    // 不加这一步的话，连接失败要到后面「Swap 按钮其实是 Connect Wallet」时才
    // 暴露，报错信息跟真实原因完全不沾边。
    //
    // 正常路径下 selectWalletFromModal 返回时地址已经可见，这里是立即通过的。
    const connectedNow = await connectedAddr
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (!connectedNow) {
      throw new Error(
        `[wallet] 点选 "${INJECTED_WALLET_NAME}" 后 15s 内 header 仍未显示地址 ` +
        `${addrPrefix}...。可能是 TEST_WALLET_ADDRESS 与 WALLET_PRIVATE_KEY 不匹配，` +
        '或注入脚本未被 Cetus 的 wallet-standard 注册。'
      );
    }
    // 地址已出现，但 chakra 的 modal 关闭动画可能还留着一层 portal 遮罩，
    // 它会吞掉后续的点击。等遮罩真正消失，而不是 sleep 一个固定时长。
    await waitForOverlaysCleared(page);

    console.log(`[wallet] Connected as ${env.testWalletAddress} (injected, no extension)`);
  }

  /** No-op: the injected wallet auto-approves transactions via the Node.js bridge. */
  async approveTransaction(_page: Page): Promise<void> {}

  /** No-op: just execute the action; no popup to handle. */
  async approveTransactionForAction(_page: Page, action: () => Promise<void>): Promise<void> {
    await action();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * 在连接弹窗里点选注入钱包。
   *
   * @param connectedAddr header 上的地址文本 locator —— 一旦它可见就说明连接
   *   已经生效，可以立刻返回，不必再等弹窗关闭动画或固定时长。
   */
  private async selectWalletFromModal(page: Page, connectedAddr: Locator): Promise<void> {
    await page.bringToFront().catch(() => undefined);

    const modalTitle = page.getByText(/connect a wallet/i).first();
    const modalVisible = await modalTitle
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!modalVisible) {
      // 不能静默 return：之前这里只打一行日志就走掉，结果「点错了按钮导致弹窗
      // 没开」这种问题被咽掉，最终以「header 没有地址」的形式报出来，
      // 排查方向完全被带偏。
      throw new Error(
        '[wallet] 点击 Connect 后没有出现 "Connect a wallet" 弹窗。' +
        '通常是点到了 swap 表单里的 "Connect Wallet"（它不打开弹窗）而不是 header 上的那个。'
      );
    }

    console.log('[wallet] Connect modal visible, checking for Other Wallets section');

    // Cetus 弹窗默认只显示 4 个钱包，其余 14 个折叠在 "Other Wallets(14)" 里。
    // Suiet 属于折叠部分，必须先展开。
    const walletText = page
      .getByText(new RegExp(`^${escapeRegExp(INJECTED_WALLET_NAME)}$`, 'i'))
      .first();

    const otherWalletsBtn = page.getByText(/other wallets/i).first();
    const hasOtherWallets = await otherWalletsBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    console.log(`[wallet] Other Wallets section visible: ${hasOtherWallets}`);

    if (hasOtherWallets) {
      await otherWalletsBtn.click({ force: true }).catch(() => undefined);
      // 等展开后的条目真的出现，而不是 sleep 800ms。
      await walletText.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined);
      console.log('[wallet] Clicked Other Wallets to expand');
    }

    // walletText 用精确匹配（见上方声明）。用 exact:false 会命中包含该名字的
    // 长文本块（整个弹窗的文本节点都含有它），点到错误的祖先元素。
    const walletVisible = await walletText
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    console.log(`[wallet] "${INJECTED_WALLET_NAME}" visible: ${walletVisible}`);

    if (!walletVisible) {
      const modalText = await page
        .locator('[role="dialog"], .chakra-modal__content')
        .last()
        .innerText()
        .catch(() => '(读取失败)');
      await page.keyboard.press('Escape').catch(() => undefined);
      throw new Error(
        `[wallet] 连接弹窗里没有 "${INJECTED_WALLET_NAME}"。\n` +
        `Cetus 的钱包列表是固定白名单，注入钱包的名字必须命中其中一项。\n` +
        `当前弹窗内容: ${modalText.replace(/\s+/g, ' ').slice(0, 500)}`
      );
    }

    console.log(`[wallet] Found "${INJECTED_WALLET_NAME}", attempting to click`);


    // 注入钱包的 connect() 是同步返回的，点中之后 header 上的地址几乎立刻出现。
    // 所以每次点击后不再 sleep 固定时长，而是竞速等「地址出现」或「弹窗消失」
    // ——任一成立即说明这一击生效，马上返回。
    const settled = async () => {
      // 两个分支各自 catch，避免落败分支超时后无人接管造成 unhandled rejection。
      const addrVisible = connectedAddr
        .waitFor({ state: 'visible', timeout: 2_000 })
        .then(() => true, () => false);
      const modalGone = modalTitle
        .waitFor({ state: 'hidden', timeout: 2_000 })
        .then(() => true, () => false);
      return Promise.any([
        addrVisible.then((ok) => (ok ? true : Promise.reject(new Error('addr not visible')))),
        modalGone.then((ok) => (ok ? true : Promise.reject(new Error('modal still open')))),
      ]).catch(() => false);
    };

    // 三种点击手段逐级降级，每种都等一个真实信号再判断要不要升级。
    const strategies: Array<() => Promise<void>> = [
      // 1. 坐标直击。
      async () => {
        const box = await walletText.boundingBox().catch(() => null);
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      },
      // 2. force-click 最近的可点击祖先。
      async () => {
        const card = walletText.locator('xpath=ancestor::*[self::button or self::div][1]');
        await card.click({ force: true }).catch(() => undefined);
      },
      // 3. 合成事件兜底。
      async () => {
        await page.evaluate((name) => {
          const root =
            document.querySelector('[role="dialog"]') ??
            document.querySelector('.chakra-modal__content') ??
            document.body;
          const candidates = Array.from(root.querySelectorAll<HTMLElement>('button, [role="button"], div, li'));
          const el = candidates.find((c) =>
            (c.textContent ?? '').trim().toLowerCase().includes(name.toLowerCase())
          );
          if (!el) return;
          ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((type) =>
            el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
          );
        }, INJECTED_WALLET_NAME).catch(() => undefined);
      },
    ];

    for (let attempt = 0; attempt < 3; attempt++) {
      for (const click of strategies) {
        if (!(await modalTitle.isVisible().catch(() => false))) return;
        await click();
        if (await settled()) return;
      }
    }

    // 三轮都没等到信号：给弹窗关闭留最后一段时间，真的没连上由 connect() 抛错。
    await modalTitle.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
  }

  /**
   * 关掉首次进入的「Terms & Conditions」弹窗。
   *
   * 直接复用 utils/dismiss-terms.ts，不再维护第二份实现：原来这里有一份独立的
   * 70 行版本，用 isVisible() 不带 timeout 做首次判定，页面还没 hydrate 完时
   * 会判成「没有弹窗」直接返回，于是遮罩一直盖着，后面点 Connect 看起来点了
   * 却没有任何反应（弹窗根本没打开）。
   */
  private async dismissCetusTermsIfPresent(page: Page, timeout = 0): Promise<void> {
    await dismissCetusTerms(page, { timeout }).catch(() => undefined);
  }

}

/**
 * 竞速等多个 locator 中任意一个可见，返回最先可见的那个的 key。
 *
 * 每个分支都自带 catch（落败分支超时后静默解析为 null），所以不会产生
 * unhandled rejection；全部超时则返回 'none'。
 */
async function raceVisible<K extends string>(
  timeout: number,
  locators: Record<K, Locator>
): Promise<K | 'none'> {
  const branches = (Object.entries(locators) as Array<[K, Locator]>).map(([key, locator]) =>
    locator.waitFor({ state: 'visible', timeout }).then(
      () => key,
      () => null,
    )
  );

  // 用 Promise.any 取「第一个非 null」：Promise.race 会被最先解析的 null 抢走。
  return Promise.any(
    branches.map((b) => b.then((key) => (key === null ? Promise.reject(new Error('not visible')) : key)))
  ).catch(() => 'none' as const);
}

/**
 * 等所有 chakra-portal 里的弹窗/遮罩清空。
 *
 * 连接成功后 header 立刻显示地址，但 modal 的关闭动画还没跑完，portal 里残留的
 * 遮罩层会吞掉后续点击（表现为「点了 Swap 没反应」）。这里轮询真实的 DOM 条件，
 * 通常 100ms 内就返回，替代原来无条件的 waitForTimeout(300)。
 */
async function waitForOverlaysCleared(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const portals = Array.from(document.querySelectorAll('.chakra-portal'));
        return portals.every((p) => !p.querySelector('[role="dialog"], .chakra-modal__content'));
      },
      { timeout: 8_000, polling: 50 }
    )
    .catch(() => undefined);
}
