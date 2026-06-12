import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildPairPattern(baseSymbol: string, quoteSymbol: string) {
  return new RegExp(
    `${escapeRegExp(baseSymbol)}\\s*[-/]\\s*${escapeRegExp(quoteSymbol)}|${escapeRegExp(quoteSymbol)}\\s*[-/]\\s*${escapeRegExp(baseSymbol)}`,
    'i'
  );
}

export async function resolveTokenFilterTrigger(page: Page) {
  const triggerCandidates: Locator[] = [
    page.locator('xpath=//*[starts-with(@id,"popover-trigger-")]//div[contains(normalize-space(.), "Filter by token")]').first(),
    page.locator('[id^="popover-trigger-"]').filter({ hasText: /filter by token/i }).first(),
    page.getByText(/filter by token/i).first(),
    page
      .locator('input[placeholder*="filter by token" i], input[placeholder*="filter" i], input[placeholder*="token" i], input[type="search"]')
      .first()
  ];

  for (const candidate of triggerCandidates) {
    const exists = (await candidate.count().catch(() => 0)) > 0;
    if (!exists) continue;
    if (!(await candidate.isVisible({ timeout: 1_000 }).catch(() => false))) continue;
    return candidate;
  }

  throw new Error('Cannot locate "Filter by token" trigger');
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

  throw new Error('Failed to open "Filter by token" panel');
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
    if (/filter by token|watchlist|incentivized only|all pools|create a new pool/i.test(text)) continue;

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
