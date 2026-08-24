import type { Page } from '@playwright/test';

/**
 * Cetus 在钱包拒签后弹的提示文案。
 */
export const REJECTION_TEXT_PATTERN =
  'transaction failed|user rejected|transaction rejected|user denied|rejected by user|user cancel';

const WATCHER_KEY = '__cetusRejectionWatcher';

interface WatcherWindow {
  [WATCHER_KEY]?: { seen: string[]; stop: () => void };
}

/**
 * 挂一个 MutationObserver，把出现过的拒签提示文案记录下来。
 *
 * 必须在拒签动作之前调用。Cetus 用 chakra toast 展示 "Transaction failed"，
 * 默认几秒后自动消失；而 rejectTransaction() 还要等钱包弹窗 close 事件，
 * 等回到主页面再去查 DOM 时 toast 往往已经没了——这正是同一份代码在快的
 * 机器上通过、在慢的机器上失败的原因。改成"记录出现过"而不是"此刻可见"。
 */
export async function watchForRejectionMessage(page: Page): Promise<void> {
  await page.evaluate(
    ([key, patternSource]) => {
      const w = window as unknown as WatcherWindow;
      const existing = w[key as typeof WATCHER_KEY];
      if (existing) existing.stop();

      const re = new RegExp(patternSource, 'i');
      const seen: string[] = [];

      const record = (text: string | null | undefined) => {
        const match = text?.match(re);
        if (match) seen.push(match[0]);
      };

      // 观察器挂载前 toast 可能已经渲染出来了，先扫一遍当前 DOM。
      document
        .querySelectorAll('[role="alert"], [role="status"], .chakra-toast, [class*="toast" i]')
        .forEach((el) => record(el.textContent));

      const observer = new MutationObserver((records) => {
        for (const entry of records) {
          entry.addedNodes.forEach((node) => record(node.textContent));
          if (entry.type === 'characterData') record(entry.target.textContent);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });

      w[key as typeof WATCHER_KEY] = { seen, stop: () => observer.disconnect() };
    },
    [WATCHER_KEY, REJECTION_TEXT_PATTERN] as const
  );
}

/**
 * 等拒签提示出现，返回命中的文案（未出现则返回 null）。
 *
 * 同时看两处：watchForRejectionMessage() 记录的历史命中，以及当前 DOM
 * （页面若在中途导航过，观察器会随旧 document 一起失效）。
 */
export async function waitForRejectionMessage(
  page: Page,
  timeoutMs: number = 20_000
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  const liveText = page.getByText(new RegExp(REJECTION_TEXT_PATTERN, 'i')).first();

  while (Date.now() < deadline) {
    const recorded = await page
      .evaluate((key) => {
        const w = window as unknown as WatcherWindow;
        return w[key as typeof WATCHER_KEY]?.seen[0] ?? null;
      }, WATCHER_KEY)
      .catch(() => null);
    if (recorded) return recorded;

    if (await liveText.isVisible().catch(() => false)) {
      const text = (await liveText.innerText().catch(() => '')).trim();
      if (text) return text;
    }

    await page.waitForTimeout(300).catch(() => undefined);
  }

  return null;
}
