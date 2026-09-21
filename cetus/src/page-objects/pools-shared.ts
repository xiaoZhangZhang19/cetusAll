import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { dismissCetusTerms } from '@/utils/dismiss-terms.js';
import { gotoWithRetry } from '@/utils/page-ready.js';

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildPairPattern(baseSymbol: string, quoteSymbol: string) {
  return new RegExp(
    `${escapeRegExp(baseSymbol)}\\s*[-/]\\s*${escapeRegExp(quoteSymbol)}|${escapeRegExp(quoteSymbol)}\\s*[-/]\\s*${escapeRegExp(baseSymbol)}`,
    'i'
  );
}

// ─── My Positions 入口（CLMM / DLMM 持仓类页面共用） ──────────────────────────

/**
 * 打开池子列表页。
 *
 * 不要直接 goto('/pools?tab=positions')：当前站点上该 URL 会落到 CLMM 池子列表，
 * 持仓列表并不会渲染。所以先进池子列表页，再由 openMyPositionsTab() 点击
 * "My Positions" 完成切换。
 */
export async function gotoPoolsList(page: Page, tab = 'clmm_pools') {
  await gotoWithRetry(page, `/pools?tab=${tab}`);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await dismissCetusTerms(page, { timeout: 8_000 });
}

/**
 * 点击池子列表页上的 "My Positions"（与 CLMM / DLMM 同一行的 tab）。
 *
 * 页面布局：[CLMM 1547] [DLMM] [My Positions]  ← 这一行
 * 点击后列表从「全部池子」切到「我的持仓」，URL 变成 /pools?tab=positions。
 * 幂等：已经在持仓视图时直接返回，可以在任意步骤前安全调用。
 */
export async function openMyPositionsTab(page: Page) {
  await dismissCetusTerms(page);

  if (await isOnMyPositionsTab(page)) return;

  const tab = page.getByText(/^my\s*positions(\s*\d+)?$/i).first();

  if (await tab.isVisible({ timeout: 15_000 }).catch(() => false)) {
    await tab.click({ force: true }).catch(async () => {
      const box = await tab.boundingBox();
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    });
  } else {
    // 兜底：tab 没渲染出来时直接走 URL。
    await gotoWithRetry(page, '/pools?tab=positions');
  }

  await waitForMyPositionsReady(page);
}

/** 等持仓列表就绪：URL 带 tab=positions，且出现持仓筛选行或空态。 */
async function waitForMyPositionsReady(page: Page) {
  await page.waitForURL(/tab=positions/i, { timeout: 10_000 }).catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);

  const ready = myPositionsReadySignal(page)
    .or(page.getByText(/no liquidity positions|no position|you have no|connect wallet/i))
    .first();
  await ready.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(500);
}

/** 持仓视图的标志物：子筛选行的 "All N" 或 "Collapse"。 */
function myPositionsReadySignal(page: Page): Locator {
  return page.getByText(/^all\s*\d*$/i).or(page.getByText(/collapse/i));
}

async function isOnMyPositionsTab(page: Page): Promise<boolean> {
  if (!/tab=positions/i.test(page.url())) return false;
  return myPositionsReadySignal(page)
    .first()
    .isVisible({ timeout: 2_000 })
    .catch(() => false);
}

/**
 * 点击 My Positions 里的 CLMM / DLMM 子筛选 chip。
 *
 * UI 布局：
 *   顶部导航 tab   : [CLMM] [DLMM] [My Positions]
 *   子筛选行(目标) : [All 2] [CLMM 1] [DLMM 1]
 *
 * 关键区分点：子筛选 chip 带持仓数量（如 "CLMM 1"），顶部导航 tab 是纯文本。
 * 调用前会自动确保处在 My Positions 视图，否则会点到顶部导航把列表切回全部池子。
 */
export async function clickPositionsSubFilterChip(page: Page, poolType: 'clmm' | 'dlmm') {
  await openMyPositionsTab(page);

  const typeText = poolType.toUpperCase(); // "CLMM" or "DLMM"

  // ── Strategy 1: chip text = "<TYPE> <digits>"，如 "CLMM 1" ────────────────
  const chipWithCount = page
    .locator('*')
    .filter({ hasText: new RegExp(`^${typeText}\\s+\\d+$`) })
    .first();

  if (await chipWithCount.isVisible({ timeout: 8_000 }).catch(() => false)) {
    await chipWithCount.click();
    await page.waitForTimeout(500);
    return;
  }

  // ── Strategy 2: 与 "All N" chip 同一 Y 行 ──────────────────────────────────
  const allChip = page.locator('*').filter({ hasText: /^All\s*\d*$/ }).first();

  if (await allChip.isVisible({ timeout: 5_000 }).catch(() => false)) {
    const allBox = await allChip.boundingBox().catch(() => null);
    if (allBox) {
      const clicked = await page.evaluate(
        ({ typeText, refY }) => {
          const pattern = new RegExp(`^${typeText}(\\s+\\d+)?$`, 'i');
          const candidates = Array.from(document.querySelectorAll<HTMLElement>('*')).filter((el) => {
            const text = (el.textContent ?? '').trim();
            if (!pattern.test(text)) return false;
            const childMatches = Array.from(el.children).some((c) =>
              pattern.test((c.textContent ?? '').trim())
            );
            if (childMatches) return false;
            const rect = el.getBoundingClientRect();
            if (rect.width < 20 || rect.height < 8) return false;
            return Math.abs(rect.top + rect.height / 2 - refY) < 30;
          });
          if (candidates.length === 0) return false;
          candidates[0].click();
          return true;
        },
        { typeText, refY: allBox.y + allBox.height / 2 }
      );

      if (clicked) {
        await page.waitForTimeout(500);
        return;
      }
    }
  }

  // ── Strategy 3: 纯文本匹配，取第二个（第一个通常是顶部导航 tab） ──────────
  const allMatches = page.locator('*').filter({ hasText: new RegExp(`^${typeText}$`, 'i') });
  const total = await allMatches.count().catch(() => 0);
  if (total >= 2) {
    await allMatches.nth(1).click();
    await page.waitForTimeout(500);
    return;
  }
  if (total === 1) {
    await allMatches.first().click();
    await page.waitForTimeout(500);
  }
}

/** Cetus renamed the pools token filter from "Filter by token" to "Search by tokens"; accept both. */
export const TOKEN_FILTER_LABEL = /search by tokens?|filter by tokens?/i;

const TOKEN_FILTER_LABEL_XPATH =
  'contains(normalize-space(.), "Search by tokens") or contains(normalize-space(.), "Filter by token")';

export async function resolveTokenFilterTrigger(page: Page) {
  const triggerCandidates: Locator[] = [
    page.locator(`xpath=//*[starts-with(@id,"popover-trigger-")]//div[${TOKEN_FILTER_LABEL_XPATH}]`).first(),
    page.locator('[id^="popover-trigger-"]').filter({ hasText: TOKEN_FILTER_LABEL }).first(),
    page.getByText(TOKEN_FILTER_LABEL).first(),
    page
      .locator('input[placeholder*="search by token" i], input[placeholder*="filter by token" i], input[placeholder*="filter" i], input[placeholder*="token" i], input[type="search"]')
      .first()
  ];

  for (const candidate of triggerCandidates) {
    const exists = (await candidate.count().catch(() => 0)) > 0;
    if (!exists) continue;
    if (!(await candidate.isVisible({ timeout: 1_000 }).catch(() => false))) continue;
    return candidate;
  }

  throw new Error('Cannot locate "Search by tokens" trigger');
}

export async function openTokenFilterPanel(page: Page, filterTrigger: Locator) {
  const clickCandidates: Locator[] = [
    filterTrigger,
    filterTrigger.locator('xpath=ancestor::*[self::div or self::button][1]'),
    filterTrigger.locator('xpath=ancestor::*[self::div or self::button][2]')
  ];

  for (const candidate of clickCandidates) {
    if (!(await candidate.isVisible({ timeout: 1_000 }).catch(() => false))) continue;
    await candidate.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(300);
    if (await hasVisibleTokenOptionNearTrigger(page, 'SUI', filterTrigger)) return;
  }

  const box = await filterTrigger.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.click(box.x + Math.min(24, box.width * 0.15), box.y + box.height / 2);
    await page.waitForTimeout(300);
    if (await hasVisibleTokenOptionNearTrigger(page, 'SUI', filterTrigger)) return;
  }

  throw new Error('Failed to open "Search by tokens" panel');
}

export async function ensureTokenCheckedInFilter(page: Page, symbol: string, filterTrigger: Locator) {
  const symbolPattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`, 'i');

  if (
    await filterTrigger
      .locator('span, div, button')
      .filter({ hasText: symbolPattern })
      .first()
      .isVisible({ timeout: 800 })
      .catch(() => false)
  ) {
    return;
  }

  const tokenOption = await findTokenOptionNearTrigger(page, symbol, filterTrigger);
  if (!tokenOption) {
    throw new Error(`Cannot find token option "${symbol}" in filter dropdown`);
  }
  await tokenOption.click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(250);

  const selected = await filterTrigger
    .locator('span, div, button')
    .filter({ hasText: symbolPattern })
    .first()
    .isVisible({ timeout: 1_500 })
    .catch(() => false);
  if (selected) return;

  const secondTry = await findTokenOptionNearTrigger(page, symbol, filterTrigger);
  if (secondTry) {
    await secondTry.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(250);
  }

  const selectedAfterRetry = await filterTrigger
    .locator('span, div, button')
    .filter({ hasText: symbolPattern })
    .first()
    .isVisible({ timeout: 1_500 })
    .catch(() => false);
  if (!selectedAfterRetry) {
    throw new Error(`Failed to select token "${symbol}" from filter dropdown`);
  }
}

export async function findFirstPoolRowByPair(page: Page, pairPattern: RegExp, filterTrigger?: Locator) {
  const rowCandidates = page.locator('tr, [role="row"], div');
  const count = await rowCandidates.count().catch(() => 0);
  const triggerBox = await filterTrigger?.boundingBox().catch(() => null);
  let bestRow: Locator | undefined;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let i = 0; i < count; i++) {
    const row = rowCandidates.nth(i);
    if (!(await row.isVisible({ timeout: 200 }).catch(() => false))) continue;
    const box = await row.boundingBox().catch(() => null);
    if (!box) continue;
    if (box.width < 420 || box.height < 32 || box.height > 160) continue;

    const text = ((await row.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (!text || !pairPattern.test(text)) continue;
    if (/search by tokens?|filter by tokens?|watchlist|incentivized only|all pools|create a new pool/i.test(text)) continue;

    const isBelowFilter = triggerBox ? box.y > triggerBox.y + 40 : box.y > 220;
    if (!isBelowFilter) continue;

    const score = box.y * 10 + box.x;
    if (score < bestScore) {
      bestScore = score;
      bestRow = row;
    }
  }

  if (!bestRow) {
    throw new Error(`Cannot find visible pool row for pair ${pairPattern}`);
  }

  return bestRow;
}

// ─── 仓位 Liquidity 表格读数（remove / zap-out 类页面共用） ────────────────────

export interface LiquidityTableAmounts {
  sui: number;
  usdc: number;
}

/**
 * 判断一个 Chakra Switch 当前是否已打开。
 *
 * ⚠️ 不能只读外层 `.chakra-switch`（一个 LABEL）上的 aria-checked / data-checked：
 * 实测 Cetus 的 Zap Out 开关把状态放在内嵌的 `input.chakra-switch__input` 上
 * （`type=checkbox` + `aria-checked`），LABEL 上什么都没有。按 LABEL 判定会永远
 * 得到「未打开」，于是幂等失效 —— 重复调用 enableZapOut() 会把开关又关回去。
 */
export async function isSwitchOn(switchLocator: Locator): Promise<boolean> {
  const input = switchLocator.locator('input[type="checkbox"]').first();
  if ((await input.count().catch(() => 0)) > 0) {
    if (await input.isChecked().catch(() => false)) return true;
    if ((await input.getAttribute('aria-checked').catch(() => null)) === 'true') return true;
    return false;
  }

  if ((await switchLocator.getAttribute('aria-checked').catch(() => null)) === 'true') return true;
  return (await switchLocator.getAttribute('data-checked').catch(() => null)) !== null;
}

/**
 * 读左侧 Liquidity 表格里的当前 SUI / USDC 持仓量。
 *
 * 页面上有三张同构表（Liquidity / Fees / Mining Rewards），都以 "Token" 作表头，
 * 取第一个即 Liquidity 表。
 */
export async function readLiquidityTableAmounts(page: Page): Promise<LiquidityTableAmounts> {
  const tokenHeader = page.getByText(/^token$/i).first();
  await tokenHeader.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(1_000);

  const tableContainer = tokenHeader.locator(
    'xpath=ancestor::*[self::div or self::section or self::table][3]'
  );
  const tableText = await tableContainer.innerText().catch(() => '');
  const lines = tableText.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  let sui = 0;
  let usdc = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i] === 'SUI' && /^[\d.]+$/.test(lines[i + 1])) sui = parseFloat(lines[i + 1]);
    if (lines[i] === 'USDC' && /^[\d.]+$/.test(lines[i + 1])) usdc = parseFloat(lines[i + 1]);
  }
  return { sui, usdc };
}

/**
 * 关掉 "Transaction Completed" 弹窗，并等它的遮罩真正消失。
 *
 * 必须关掉、且必须确认关掉了：弹窗的 `chakra-modal__content-container` /
 * `chakra-modal__overlay` 铺满视口，会吞掉后续所有点击。留着它，下一步操作会以
 * 「xxx intercepts pointer events」超时的形式失败，报错完全指不到真正的原因。
 *
 * ⚠️ 定位范围只能用 `[role="dialog"]`，不能带 `[class*="modal"]`：
 * 后者会一并匹配到内层的 `chakra-modal__body`（"Transaction Completed" 这段文字
 * 就在 body 里），`.last()` 于是落到 body 上 —— 而关闭按钮是 body 的**兄弟节点**，
 * 在 body 里永远找不到：
 *
 *   SECTION.chakra-modal__content[role=dialog]
 *   ├── HEADER.chakra-modal__header
 *   ├── BUTTON[aria-label="Close"].chakra-modal__close-btn   ← 兄弟，不在 body 内
 *   └── DIV.chakra-modal__body        ← "Transaction Completed" 在这里
 *
 * 关闭手段逐级降级：点 X → 点弹窗外部（overlay）→ Escape。
 * 实测这个弹窗不响应 Escape，所以前两种才是真正有效的路径。
 */
export async function closeTransactionCompletedModal(page: Page): Promise<void> {
  const dialog = page
    .locator('[role="dialog"]')
    .filter({ hasText: /transaction completed/i })
    .last();

  if (!(await dialog.isVisible({ timeout: 3_000 }).catch(() => false))) return;

  const closeBtn = dialog
    .locator('button[aria-label="Close"], button.chakra-modal__close-btn, button[aria-label*="close" i]')
    .first();

  const strategies: Array<[string, () => Promise<void>]> = [
    // 1. 弹窗右上角的 X。
    ['X 按钮', async () => {
      if (!(await closeBtn.isVisible({ timeout: 2_000 }).catch(() => false))) return;
      await closeBtn.click({ force: true }).catch(() => undefined);
    }],
    // 2. 点弹窗外部：overlay / content-container 铺满视口，点左上角就落在弹窗之外，
    //    触发 Chakra 的 closeOnOverlayClick。
    ['点击弹窗外部', async () => {
      await page.mouse.click(8, 8).catch(() => undefined);
    }],
    // 3. Escape 兜底（这个弹窗实测不响应，但留着不亏）。
    ['Escape', async () => {
      await page.keyboard.press('Escape').catch(() => undefined);
    }]
  ];

  for (let round = 1; round <= 2; round++) {
    for (const [label, close] of strategies) {
      await close();
      const hidden = await dialog
        .waitFor({ state: 'hidden', timeout: 4_000 })
        .then(() => true, () => false);
      if (hidden) {
        console.log(`[modal] Transaction Completed 弹窗已关闭（${label}）`);
        await waitForModalOverlaysCleared(page);
        return;
      }
    }
    console.warn(`[modal] 第 ${round} 轮尝试后弹窗仍在，重试`);
  }

  throw new Error(
    '[modal] "Transaction Completed" 弹窗关不掉（已尝试 X 按钮 / 点击弹窗外部 / Escape，各两轮）。\n' +
      '它的遮罩铺满视口会吞掉后续所有点击，继续执行只会得到 ' +
      '「intercepts pointer events」这种指不到真实原因的超时，所以这里直接失败。'
  );
}

/**
 * 等 modal 的遮罩层真正从 portal 里消失。
 *
 * 弹窗 hidden 之后关闭动画可能还在跑，残留的 container / overlay 仍会吞点击。
 * 只统计「可见且占真实面积」的节点 —— 页面上常驻若干 visibility:hidden 的
 * popover 宿主，按选择器存在性判定会永远不成立、白等满超时。
 */
async function waitForModalOverlaysCleared(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const nodes = Array.from(
          document.querySelectorAll('.chakra-modal__overlay, .chakra-modal__content-container')
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

/**
 * 交易成功后读仓位数量 —— 轮询到数值相对 `before` 真的变了才返回。
 *
 * 为什么不能读一次就信：链上成功（有 digest + Transaction Completed 弹窗）不等于
 * 前端 Liquidity 表格已经是新值。仓位数据要等索引器同步 + 前端重新拉取，关掉弹窗
 * 后立刻读大概率还是旧值，断言就会拿 before 去比 predicted，报成「偏差超过 5%」
 * 这种指向完全错误的失败。
 *
 * @param refresh 可选的兜底刷新动作（通常是 reload + 重建面板状态）。前端自己没能
 *   重新拉取时，走到一半超时就调用一次，之后继续轮询。
 */
export async function readLiquidityTableAmountsUntilChanged(
  page: Page,
  before: LiquidityTableAmounts,
  options: { timeout?: number; epsilon?: number; refresh?: () => Promise<void> } = {}
): Promise<LiquidityTableAmounts> {
  const timeout = options.timeout ?? 60_000;
  const epsilon = options.epsilon ?? 1e-9;
  const start = Date.now();
  const deadline = start + timeout;
  const refreshAt = start + timeout / 2;

  let latest = before;
  let attempt = 0;
  let refreshed = false;

  while (true) {
    attempt++;
    latest = await readLiquidityTableAmounts(page);
    const changed =
      Math.abs(latest.sui - before.sui) > epsilon || Math.abs(latest.usdc - before.usdc) > epsilon;

    if (changed) {
      console.log(
        `[position] 仓位数据已刷新（第 ${attempt} 次读取）：` +
          `SUI=${latest.sui.toFixed(6)}  USDC=${latest.usdc.toFixed(6)}`
      );
      return latest;
    }

    if (Date.now() >= deadline) break;

    if (!refreshed && options.refresh && Date.now() >= refreshAt) {
      refreshed = true;
      console.log('[position] 前端迟迟没重新拉取，主动刷新一次后继续轮询');
      // 刷新本身可能撞上 CDN 抖动；失败不该终止轮询。
      await options.refresh().catch((error: unknown) => {
        const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
        console.warn(`[position] 刷新失败：${message} — 继续重试`);
      });
      continue;
    }

    await page.waitForTimeout(1_500);
  }

  throw new Error(
    `仓位数量在 ${timeout / 1000}s 内始终未变化（读了 ${attempt} 次${refreshed ? '，含一次刷新' : ''}）。\n` +
      `  before: SUI=${before.sui.toFixed(6)}  USDC=${before.usdc.toFixed(6)}\n` +
      `  latest: SUI=${latest.sui.toFixed(6)}  USDC=${latest.usdc.toFixed(6)}\n` +
      '可能原因：1) 索引器同步比预期慢；2) 交易虽然上链但实际未改变该仓位。'
  );
}

export async function clickMaxForTokenInRemovePanel(page: Page, tokenSymbol?: string) {
  const removePanel = page
    .locator('section, div')
    .filter({ hasText: /remove amounts/i })
    .first();
  await expect(removePanel).toBeVisible({ timeout: 10_000 });

  if (tokenSymbol) {
    const tokenPattern = new RegExp(`^${escapeRegExp(tokenSymbol)}$`, 'i');
    const tokenLabel = removePanel.getByText(tokenPattern).first();
    if (await tokenLabel.isVisible({ timeout: 3_000 }).catch(() => false)) {
      for (const depth of [1, 2, 3]) {
        const row = tokenLabel.locator(`xpath=ancestor::*[self::div or self::section][${depth}]`);
        const rowMax = row
          .locator('button, [role="button"]')
          .filter({ hasText: /^max$/i })
          .first();
        if (await rowMax.isVisible({ timeout: 1_000 }).catch(() => false)) {
          await rowMax.click();
          return;
        }
      }
    }
  }

  const firstMax = removePanel
    .locator('button, [role="button"]')
    .filter({ hasText: /^max$/i })
    .first();
  await expect(firstMax).toBeVisible({ timeout: 10_000 });
  await firstMax.click();
}

export async function clickFirstActionButtonInActionsColumn(page: Page): Promise<boolean> {
  const actionsHeader = page.getByText(/^actions$/i).first();
  const hasActionsHeader = await actionsHeader.isVisible({ timeout: 8_000 }).catch(() => false);
  if (!hasActionsHeader) return false;

  const headerBox = await actionsHeader.boundingBox();
  if (!headerBox) return false;

  const clicked = await page.evaluate(
    ({ x, y }) => {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]')).filter((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 14 || rect.height < 14) return false;
        if (rect.right < x - 80) return false;
        if (rect.top < y + 14) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') return false;
        if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
        return true;
      });

      candidates.sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        if (Math.abs(ar.top - br.top) > 6) return ar.top - br.top;
        return ar.left - br.left;
      });

      const target = candidates[0];
      if (!target) return false;
      target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    },
    { x: headerBox.x, y: headerBox.y }
  );

  if (clicked) {
    await page.waitForTimeout(400);
  }
  return clicked;
}

async function hasVisibleTokenOptionNearTrigger(page: Page, symbol: string, filterTrigger: Locator) {
  return (await findTokenOptionNearTrigger(page, symbol, filterTrigger)) !== undefined;
}

async function findTokenOptionNearTrigger(page: Page, symbol: string, filterTrigger: Locator) {
  const triggerBox = await filterTrigger.boundingBox().catch(() => null);
  const candidates = page.locator(`text=/^\\s*${escapeRegExp(symbol)}\\s*$/i`);
  const count = await candidates.count().catch(() => 0);
  let bestIndex: number | undefined;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let i = 0; i < count; i++) {
    const candidate = candidates.nth(i);
    if (!(await candidate.isVisible({ timeout: 500 }).catch(() => false))) continue;
    const box = await candidate.boundingBox().catch(() => null);
    if (!box) continue;

    if (triggerBox) {
      const samePanelZone =
        box.y >= triggerBox.y - 8 &&
        box.y <= triggerBox.y + 380 &&
        box.x <= triggerBox.x + 220;
      if (!samePanelZone) continue;

      const score = Math.abs(box.y - triggerBox.y) + Math.abs(box.x - triggerBox.x);
      if (score < bestScore) {
        bestScore = score;
        bestIndex = i;
      }
      continue;
    }

    if (box.x > 500 || box.y > 700) continue;
    const score = box.x + box.y;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return bestIndex === undefined ? undefined : candidates.nth(bestIndex);
}
