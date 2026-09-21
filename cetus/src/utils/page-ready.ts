import type { Page, Response } from '@playwright/test';

/**
 * app.cetus.zone 走 Netlify + CloudFront，偶发会在 TLS 握手后直接 reset 连接，
 * Chromium 报成 ERR_HTTP_RESPONSE_CODE_FAILURE / ERR_CONNECTION_RESET 等。
 * 这类抖动重试一次基本就好了，但裸 page.goto() 会让用例在第一步就红。
 */
const RETRYABLE_NAV_ERRORS = [
  'ERR_HTTP_RESPONSE_CODE_FAILURE',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_FAILED',
  'ERR_EMPTY_RESPONSE',
  'ERR_SOCKET_NOT_CONNECTED',
  'ERR_NETWORK_CHANGED',
  'ERR_TIMED_OUT',
  'ERR_ABORTED',
];

function isRetryableNavError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return RETRYABLE_NAV_ERRORS.some((code) => message.includes(code));
}

/**
 * 带重试的 page.goto()，供各 page-object 的 goto() 统一使用。
 *
 * 只重试上面列出的网络层错误码；断言失败、超时之外的错误一律直接抛出，
 * 避免把真实问题重试成「更慢的失败」。
 */
export async function gotoWithRetry(
  page: Page,
  url: string,
  options: { attempts?: number; timeout?: number } = {}
): Promise<Response | null> {
  const attempts = options.attempts ?? 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await page.goto(url, {
        waitUntil: 'domcontentloaded',
        ...(options.timeout ? { timeout: options.timeout } : {}),
      });
    } catch (error) {
      lastError = error;
      if (!isRetryableNavError(error) || attempt === attempts) throw error;

      const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
      console.warn(`[page-ready] 导航 ${url} 失败（${attempt}/${attempts}）：${message} — 重试`);
      // CDN 抖动通常是瞬时的，退避一小段再试比立刻重试命中率高。
      await page.waitForTimeout(1_000 * attempt);
    }
  }

  throw lastError;
}

/**
 * 等「页面壳已经可以交互」，替代 waitForLoadState('networkidle')。
 *
 * 为什么不用 networkidle：Cetus 首屏会持续拉 K 线、行情、报价、价格推送，
 * networkidle 要求 500ms 内零请求，实测经常要 5s+ 才满足，有时干脆等到超时。
 * 而「关掉条款弹窗 → 点 header 的 Connect」这一步真正依赖的只有两件事：
 *
 *   1. 交易表单已挂载（出现可输入的金额框）；
 *   2. header 已 hydrate（要么显示 Connect 按钮，要么已显示地址徽章）。
 *
 * 这两个条件通常在 domcontentloaded 后几百毫秒内就满足，比 networkidle 早好几秒，
 * 且是「真的能点了」的充分条件，不是靠猜的固定时长。
 *
 * 两个条件都是尽力而为（各自 catch）：不同页面布局差异大（deepbook / merge-swap
 * 结构和 swap 不一样），任一等不到都不该让 goto 失败 —— 调用方自己还有更精确的
 * 断言（如 expect(inputAmount).toBeVisible()），connect() 里也有 raceVisible 兜底。
 * 但至少要有一个成立，否则等于没等。
 */
export async function waitForAppShellReady(
  page: Page,
  options: { timeout?: number } = {}
): Promise<void> {
  const timeout = options.timeout ?? 30_000;

  const amountInput = page
    .locator('input[inputmode="decimal"], input[placeholder="0"], input[placeholder="0.0"], input[type="text"], input[type="number"]')
    .first();

  // header 就绪的两种形态：未连接显示 Connect 按钮，已连接显示地址徽章。
  // 用 getByRole + or() 而不是 filter({ hasText }) —— accessible name 匹配会规范化
  // 空白，避免 "Connect " 这类尾随空格让 /^connect$/ 落空、白等满 timeout。
  const header = page.locator('header');
  const headerReady = header
    .getByRole('button', { name: /^connect( wallet)?$/i })
    .or(header.getByText(/0x[0-9a-fA-F]{4}/i))
    .first();

  // 不能直接 Promise.all 两个 30s 的等待：某些布局里其中一个永远不会出现
  // （如 merge-swap 没有 <header>），那样每次都要白等满 30s —— 比 networkidle 更糟。
  // 做法是「谁先就绪就以谁为准，再给另一个一个短暂的宽限窗口」。
  const first = amountInput
    .waitFor({ state: 'visible', timeout })
    .then(() => 'input' as const, () => null);
  const second = headerReady
    .waitFor({ state: 'visible', timeout })
    .then(() => 'header' as const, () => null);

  const winner = await Promise.any([
    first.then((r) => (r ? r : Promise.reject(new Error('input not ready')))),
    second.then((r) => (r ? r : Promise.reject(new Error('header not ready')))),
  ]).catch(() => null);

  if (winner) {
    // 宽限窗口只有 2s：正常路径下两者相隔几十毫秒，这里几乎立即返回；
    // 另一个确实不存在时也只多付 2s，而不是 30s。
    const grace = winner === 'input' ? second : first;
    await Promise.race([
      grace,
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }

  if (!winner) {
    console.warn(
      `[page-ready] 表单输入框与 header 按钮在 ${timeout}ms 内都未出现，` +
      '页面可能没加载成功。继续执行，由后续断言给出准确报错。'
    );
  }
}
