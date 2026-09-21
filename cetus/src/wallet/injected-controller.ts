import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { Transaction } from '@mysten/sui/transactions';

import { env } from '@/config/env.js';
import { getSuiClient, getKeypairFromEnv } from '@/chain/client.js';
import { dismissBlockingModals, dismissCetusTerms } from '@/utils/dismiss-terms.js';
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
  /** 还剩几次签名请求要按「用户拒签」处理（armRejection 递增）。 */
  pendingRejections: number;
  /** 已经被拒掉的签名请求次数。 */
  rejectedCount: number;
  /**
   * 钱包侧（Node 桥）在构建/签名阶段抛出的错误文案，按顺序。
   *
   * gas 不足这类问题在 tx.build() 就失败了，压根到不了广播，前端只会一直停在
   * "Waiting for Confirmation" 转圈、不弹任何错误弹窗。测试要断言「gas 错误被
   * 正确暴露」时只看 DOM 会误判成「没有任何错误」，必须能读到这里的记录。
   */
  signErrors: string[];
}

const activityByPage = new WeakMap<Page, WalletActivity>();

/**
 * 钱包侧是否观测到 gas / 余额不足。
 *
 * 覆盖两处来源：签名桥抛出的错误（build / 广播阶段），以及 dryRun 的 effects
 * 错误（能构建但链上必然失败）。UI 对这类失败的反馈不可靠 —— 常常只是停在
 * "Waiting for Confirmation" 转圈，所以断言必须能回退到这里。
 */
export function getGasShortageSignal(page: Page): string | null {
  const activity = getWalletActivity(page);
  return (
    activity.signErrors.find(isGasShortageMessage) ??
    activity.dryRunStatuses.find(isGasShortageMessage) ??
    null
  );
}

/** 取某个 page 的钱包活动记录，没有则创建。 */
export function getWalletActivity(page: Page): WalletActivity {
  let activity = activityByPage.get(page);
  if (!activity) {
    activity = {
      signCount: 0,
      digests: [],
      dryRunStatuses: [],
      pendingRejections: 0,
      rejectedCount: 0,
      signErrors: [],
    };
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
/**
 * 已武装拒签时消费一次，并抛出 dApp 能识别为「用户拒签」的错误。
 *
 * 错误形态对齐真实钱包：EIP-1193 风格的 code 4001 + "User rejected the request"
 * 文案。Playwright 的 exposeFunction 只把 message 透传回页面，所以 message 里
 * 必须自带这句话 —— Cetus 靠它来判定是拒签而不是失败。
 */
function throwIfRejectionArmed(activity: WalletActivity, label: string): void {
  if (activity.pendingRejections <= 0) return;

  activity.pendingRejections -= 1;
  activity.rejectedCount += 1;
  console.log(`[wallet] ${label}: 按用户拒签处理（不签名、不广播）`);

  throw Object.assign(new Error('User rejected the request'), { code: 4001 });
}

/** 识别「gas / 余额不足」类链上错误：dryRun、build、广播三个阶段的文案都覆盖。 */
const GAS_ERROR_PATTERN =
  /insufficient\s*(gas|balance|coin balance|funds)|InsufficientGas|InsufficientCoinBalance|GasBalanceTooLow|No valid gas coins|gas\w*\s*(budget|payment).*(insufficient|not enough|too low)|unable to select.*gas|balance.*too low/i;

/** 给定错误文案是否属于 gas / 余额不足。 */
export function isGasShortageMessage(message: string): boolean {
  return GAS_ERROR_PATTERN.test(message);
}

/**
 * 记下签名桥抛出的错误，并把它转成 dApp 能正常处理的形态再抛回页面。
 *
 * 不加这一层时：tx.build() 因 gas 不足抛错 → exposeFunction 把错误透传回页面 →
 * Cetus 的 catch 分支认不出这种文案，UI 一直停在 "Waiting for Confirmation"
 * 转圈，既不弹错误弹窗也不关闭 modal。测试于是等不到任何错误提示。
 */
function recordSignError(activity: WalletActivity, label: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  activity.signErrors.push(message);
  console.log(`[wallet] ${label} 失败: ${message.slice(0, 300)}`);

  if (isGasShortageMessage(message)) {
    // 带上 4001 + "User rejected the request"：Cetus 只认这一种形态，能让它
    // 立刻收起 "Waiting for Confirmation" 并给出失败提示，而不是无限转圈。
    // 真实原因保留在 message 后半段，也记在 activity.signErrors 里供断言。
    throw Object.assign(
      new Error(`User rejected the request — insufficient gas: ${message.slice(0, 200)}`),
      { code: 4001 }
    );
  }

  throw error instanceof Error ? error : new Error(message);
}

export async function setupSigningBridge(page: Page): Promise<void> {
  const activity = getWalletActivity(page);

  // Sign a transaction and return bytes + signature (no broadcast).
  //
  // 实测 Cetus swap 走的就是这条路径：它只要签名，自己负责广播。
  await page.exposeFunction(
    '__pw_sign_transaction',
    async (txJSON: string): Promise<{ bytes: string; signature: string }> => {
      // 拒签判定必须在构建/签名之前：一旦签出来就可能被前端广播。
      throwIfRejectionArmed(activity, 'signTransaction');

      console.log('[wallet] 收到 signTransaction 请求');
      const keypair = getKeypairFromEnv();
      const client = getSuiClient();
      const tx = Transaction.from(txJSON);
      tx.setSenderIfNotSet(env.testWalletAddress);

      // build 是 gas 不足最先暴露的地方（选不出 gas coin / 余额不够付 budget）。
      // 不接住的话错误会裸着透传回页面，Cetus 认不出来就一直转圈。
      let built: Uint8Array;
      try {
        built = await tx.build({ client });
      } catch (error) {
        recordSignError(activity, 'signTransaction build', error);
      }

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

      // 真正上链前先 dryRun 一次：gas 不足在 build 阶段未必报错（budget 能算出来，
      // 但余额付不起），dryRun 才会给出 InsufficientGas。不做这一步会把一笔注定
      // 失败的交易签出去让前端广播，UI 停在转圈，测试拿不到任何错误信号。
      const preflight = await dryRunAndReport(built, digest);
      activity.dryRunStatuses.push(preflight);
      if (isGasShortageMessage(preflight)) {
        recordSignError(activity, 'signTransaction preflight', new Error(preflight));
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
      throwIfRejectionArmed(activity, 'signAndExecuteTransaction');

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

      // 同 __pw_sign_transaction：gas 不足会在这里抛错，必须记下来并转成 4001，
      // 否则前端只会无限停在 "Waiting for Confirmation"。
      let result: Awaited<ReturnType<typeof client.signAndExecuteTransaction>>;
      try {
        result = await client.signAndExecuteTransaction({
          transaction: tx,
          signer: keypair,
        });
      } catch (error) {
        recordSignError(activity, 'signAndExecuteTransaction', error);
      }
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

/**
 * dryRun 一份已构建的交易字节，打印并返回「状态 + 错误详情」拼成的一行文本。
 *
 * 返回值里必须带上 effects.status.error：gas 不足时 status 只是 'failure'，
 * 真正的 InsufficientGas 字样在 error 里。只返回 status 的话调用方无法判断
 * 失败原因，也就没法把 gas 问题和别的失败区分开。
 */
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
    return error ? `${status}: ${error}` : status;
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
    //
    // 这里用 timeout=0（只做一次即时判定）而不是 3_000：
    // 调用方（SwapPage.goto 等）已经把条款弹窗关掉了，再轮询 3s 是 100% 白等
    // —— 每个用例都要付这 3s。真的还没关掉（测试自己 goto 的场景），下面
    // 「点 Connect → 弹窗没开」的重试循环里会再关一次，不会漏。
    // 条款 + 风险确认两个弹窗都要关：任一盖着都会让下面的 Connect 按钮
    // 从 a11y 树里消失（chakra 给兄弟节点打 aria-hidden）。
    await dismissBlockingModals(page).catch(() => undefined);

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
    let outcome = await raceVisible(20_000, {
      connected: connectedAddr,
      header: headerConnect,
      any: anyConnect,
    });

    if (outcome === 'connected') {
      console.log(`[wallet] Already connected as ${env.testWalletAddress}`);
      return;
    }

    // 三路全落空最常见的原因是还有 modal 盖着（margin 的 Risk Acknowledgement）：
    // chakra 打开 modal 时给兄弟节点加 aria-hidden，header 的 Connect 在 a11y 树里
    // 直接消失，getByRole 永远匹配不到。关掉弹窗再竞速一次。
    if (outcome === 'none') {
      console.log('[wallet] 未找到 Connect 按钮，尝试关闭遮挡弹窗后重试');
      await dismissBlockingModals(page, { timeout: 3_000 }).catch(() => undefined);
      outcome = await raceVisible(10_000, {
        connected: connectedAddr,
        header: headerConnect,
        any: anyConnect,
      });

      if (outcome === 'connected') {
        console.log(`[wallet] Already connected as ${env.testWalletAddress}`);
        return;
      }
      // 还是没有：不能像以前那样静默 return —— 那会让用例在「钱包没连」的状态下
      // 继续跑，最终报成「Open SUI Long 按钮找不到」，跟真实原因完全不沾边。
      if (outcome === 'none') {
        throw new Error(
          '[wallet] 页面上既没有钱包地址也没有 Connect 按钮（已尝试关闭条款/风险弹窗）。' +
          '通常是页面没加载成功，或仍有 modal 盖着导致按钮不在可访问性树中。'
        );
      }
    }

    // 'any' 先赢不代表 header 里没有按钮 —— 表单按钮在 DOM 顺序上更靠前，可能只是
    // 早了几十毫秒。再给 header 一个短暂的窗口，避免退化成点错按钮。
    //
    // 宽限只给 1s：两个按钮同属首屏，实测间隔在百毫秒级；header 里真没有按钮时
    // 这 1s 是纯白等，给 3s 相当于每个用例多付 2s。
    const connectBtn =
      outcome === 'header' ||
      (await headerConnect.waitFor({ state: 'visible', timeout: 1_000 }).then(() => true, () => false))
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
      // 最常见的原因是条款/风险弹窗还盖着（它的遮罩会吞掉 Connect 的点击）。
      // 上面 connect() 开头只做了一次即时判定，这里给它一个轮询窗口补救。
      await dismissBlockingModals(page, { timeout: 5_000 }).catch(() => undefined);
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

  /**
   * 武装「下一次签名请求按用户拒签处理」。见 WalletController.armRejection 的说明：
   * 必须在触发签名的点击之前调用。
   */
  async armRejection(page: Page): Promise<void> {
    const activity = getWalletActivity(page);
    activity.pendingRejections += 1;
    console.log('[wallet] 已武装拒签：下一次签名请求将返回 4001 User rejected the request');
  }

  /**
   * 等已武装的拒签真正被消费。
   *
   * 注入钱包没有审批弹窗，所以这里不是「点 Reject」，而是等 dApp 发起签名请求、
   * 被桥挡下来这件事发生。没等到就抛错 —— 说明提交动作没走到签名这一步，
   * 静默通过会让用例假绿。
   *
   * 判据是 pendingRejections 归零（已武装的拒签全部被消费），而不是
   * rejectedCount 相对本方法调用时刻的增量 —— 拒签常在调用前就已完成。
   */
  async rejectTransaction(page: Page, timeoutMs = 30_000): Promise<void> {
    const activity = getWalletActivity(page);

    if (activity.pendingRejections === 0 && activity.rejectedCount === 0) {
      throw new Error(
        '[wallet] rejectTransaction() 之前没有调用 armRejection()。' +
        '注入钱包没有审批弹窗，签名在点击提交的瞬间就完成了，' +
        '必须在提交前武装拒签，否则交易会真的上链。'
      );
    }

    // 关键：武装的拒签可能在本方法被调用之前就已经被消费掉了。
    //
    // 注入钱包没有审批弹窗，dApp 一调 signTransaction 就同步走完拒签分支。
    // 提交动作（如 clickCreate）内部往往还带着二次确认点击和 waitForTimeout，
    // 等控制权回到用例时 rejectedCount 早就 +1 了。
    // 原实现用 before = rejectedCount 快照再等「新增」，这种情况下永远等不到，
    // 30s 后抛「没有收到任何签名请求」—— 页面其实已经正确显示拒签提示，纯误报。
    //
    // 正确判据是「已武装的拒签是否都被消费完」：pendingRejections 归零即达成。
    if (activity.pendingRejections === 0) {
      console.log('[wallet] 签名请求已被拒绝（用户拒签，发生在 rejectTransaction 调用之前）');
      return;
    }

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (activity.pendingRejections === 0) {
        console.log('[wallet] 签名请求已被拒绝（用户拒签）');
        return;
      }
      await page.waitForTimeout(100);
    }

    throw new Error(
      `[wallet] 武装拒签后 ${timeoutMs}ms 内没有收到任何签名请求。` +
      '通常是提交按钮没真正点到，或前端在签名前就报错了。'
    );
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
 * 等所有 chakra-portal 里「真的会吞点击」的遮罩清空。
 *
 * 连接成功后 header 立刻显示地址，但 modal 的关闭动画还没跑完，portal 里残留的
 * 遮罩层会吞掉后续点击（表现为「点了 Swap 没反应」）。这里轮询真实的 DOM 条件。
 *
 * ⚠️ 判定条件必须按「可见性」过滤，不能只按选择器匹配节点是否存在。
 *
 * 原实现用 `p.querySelector('[role="dialog"], .chakra-modal__content')` 判定，
 * 条件永远不成立 —— Cetus 连上后 portal 里常驻 3 个 `chakra-popover__content`
 * （tooltip 的宿主），它们带 role="dialog" 但是 visibility:hidden / opacity:0、
 * 尺寸只有 304x2，完全不挡点击。于是每次连接后都白等满 8s 超时（实测 13s，
 * 期间还夹着一次页面 reload），这就是「每个用例连上钱包后都停 3s+」的真凶。
 *
 * 现在只统计「占真实面积且可见」的节点，正常路径下 50ms 内即返回。
 */
async function waitForOverlaysCleared(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const nodes = Array.from(
          document.querySelectorAll('.chakra-portal [role="dialog"], .chakra-portal .chakra-modal__content')
        );
        return nodes.every((el) => {
          const style = getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
            return true;
          }
          // 关闭动画收尾时节点还在但已缩到极小，不足以挡住按钮。
          const box = el.getBoundingClientRect();
          return box.width < 10 || box.height < 10;
        });
      },
      { timeout: 5_000, polling: 50 }
    )
    .catch(() => undefined);
}
