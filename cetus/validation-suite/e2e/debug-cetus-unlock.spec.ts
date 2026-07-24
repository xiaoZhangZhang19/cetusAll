/**
 * 诊断测试 v9：用 CDP dispatchMouseEvent 发送 isTrusted 事件绕过 React 的事件过滤
 *
 * 背景：Cetus 子路由的勾选框用 cursor:not-allowed + isTrusted 检测做了防自动化保护。
 *       page.mouse.click 的 isTrusted=false，React 忽略它。
 *       CDP Input.dispatchMouseEvent 可以发送 isTrusted=true 的事件。
 *
 * 运行：npx playwright test debug-cetus-unlock --headed --timeout 180000
 */

import { test } from '../setup/fixtures.js';
import type { CDPSession } from '@playwright/test';

test('debug: CDP trusted click on Cetus sub-route', async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto('https://app.cetus.zone/swap', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2_000);

  // ── 关闭服务条款 ──────────────────────────────────────────────────────────
  const confirmBtn = page.locator('button').filter({ hasText: /^confirm$/i }).last();
  if (await confirmBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    const agreeText = page.getByText(/agree to the terms/i).first();
    if (await agreeText.isVisible({ timeout: 2_000 }).catch(() => false)) {
      const box = await agreeText.boundingBox().catch(() => null);
      if (box) await page.mouse.click(Math.max(0, box.x - 14), box.y + box.height / 2);
      await page.waitForTimeout(300);
    }
    await confirmBtn.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(1_000);
  }

  // ── 打开 Aggregator Settings ──────────────────────────────────────────────
  const aggregatorLabel = page.getByText(/aggregator mode/i).first();
  await aggregatorLabel.waitFor({ state: 'visible', timeout: 8_000 });
  const triggerContainer = aggregatorLabel.locator('xpath=ancestor::*[4]');
  await triggerContainer.locator('button, [role="button"]').first().click();

  const aggDialog = page.locator('[role="dialog"]').filter({ has: page.getByText('Aggregator Settings') }).last();
  await aggDialog.waitFor({ state: 'visible', timeout: 8_000 });

  // ── 计数工具 ──────────────────────────────────────────────────────────────
  const getCounter = async () => aggDialog.evaluate((el: Element) => {
    const inp = el.querySelector<HTMLInputElement>('input#select-all');
    if (!inp) return -1;
    let anc: Element | null = inp.parentElement;
    for (let i = 0; i < 8 && anc; i++) {
      const m = (anc.textContent ?? '').match(/(\d+)\s*\/\s*28/);
      if (m) return parseInt(m[1], 10);
      anc = anc.parentElement;
    }
    return -1;
  }).catch(() => -1);

  // ── CDP 可信点击工具 ──────────────────────────────────────────────────────
  const cdp: CDPSession = await page.context().newCDPSession(page);

  const trustedClick = async (x: number, y: number) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers: 0 });
    await page.waitForTimeout(50);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers: 0 });
    await page.waitForTimeout(100);
  };

  console.log(`Initial: ${await getCounter()}/28`);

  // ── 展开 Cetus，记录子路由坐标 ────────────────────────────────────────────
  const cetusBadge = aggDialog.locator('button.chakra-menu__menu-button').first();
  await cetusBadge.click();
  await page.waitForTimeout(600);

  const badgeBox = await cetusBadge.boundingBox();

  const subRouteCoords = await aggDialog.evaluate((dialogEl: Element) => {
    const targets = ['CLMM', 'DLMM', 'Cetus Tide'];
    const coords: Record<string, { x: number; y: number }> = {};
    for (const name of targets) {
      const all = Array.from(dialogEl.querySelectorAll<HTMLElement>('*'));
      for (const el of all) {
        const directText = Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => (n.textContent ?? '').trim())
          .join('');
        if (directText !== name) continue;
        let row: Element | null = el;
        for (let i = 0; i < 6 && row; i++) {
          if ((row as HTMLElement).className?.includes?.('css-3dlw9v')) break;
          row = row.parentElement;
        }
        const checkIcon = (row ?? el).querySelector<HTMLElement>('.css-u8o7oo');
        if (checkIcon) {
          const rect = checkIcon.getBoundingClientRect();
          coords[name] = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
        break;
      }
    }
    return coords;
  });
  console.log('Coords:', JSON.stringify(subRouteCoords));

  // ── 辅助：展开 + CDP 点击 ─────────────────────────────────────────────────
  const expandAndTrustedClick = async (routeName: string) => {
    // 如果菜单关了，重新展开
    const menuOpen = await aggDialog.locator('.chakra-menu__menu-list').isVisible({ timeout: 500 }).catch(() => false);
    if (!menuOpen && badgeBox) {
      await trustedClick(badgeBox.x + badgeBox.width / 2, badgeBox.y + badgeBox.height / 2);
      await page.waitForTimeout(400);
    }
    const coord = subRouteCoords[routeName];
    if (!coord) return;
    await trustedClick(coord.x, coord.y);
    await page.waitForTimeout(300);
  };

  // ── 对 CLMM 执行 5 次 CDP 可信点击 ───────────────────────────────────────
  console.log('\n=== 5x CDP trusted click on CLMM ===');
  for (let i = 1; i <= 5; i++) {
    await expandAndTrustedClick('CLMM');
    const count = await getCounter();
    const badgeTxt = (await cetusBadge.innerText().catch(() => '')).trim().replace(/\s+/g, ' ');
    console.log(`  [${i}] counter=${count}/28 badge="${badgeTxt}"`);
    if (count !== 3) {
      console.log(`  ✓ Changed after ${i} CDP clicks!`);
      break;
    }
  }

  const afterClmm = await getCounter();
  console.log(`\nAfter CLMM: ${afterClmm}/28`);

  if (afterClmm < 3) {
    console.log('✓ CDP trusted click works! This is the solution.');

    // 验证 DLMM
    console.log('\n=== 5x CDP on DLMM ===');
    for (let i = 1; i <= 5; i++) {
      await expandAndTrustedClick('DLMM');
      const count = await getCounter();
      console.log(`  DLMM [${i}] counter=${count}/28`);
      if (count !== afterClmm) break;
    }
    const afterDlmm = await getCounter();

    // 验证 Cetus Tide
    console.log('\n=== 5x CDP on Cetus Tide ===');
    for (let i = 1; i <= 5; i++) {
      await expandAndTrustedClick('Cetus Tide');
      const count = await getCounter();
      console.log(`  CetusTide [${i}] counter=${count}/28`);
      if (count !== afterDlmm) break;
    }

    console.log(`\nFinal: ${await getCounter()}/28 (expected 0)`);
  } else {
    console.log('✗ CDP trusted click also had no effect.');
    console.log('The protection may be more sophisticated (e.g. click count threshold in React state).');

    // 尝试快速连续发 5 次 CDP click 不展开
    console.log('\n=== Rapid 5x CDP click without re-expand ===');
    // 先展开一次
    if (badgeBox) {
      await trustedClick(badgeBox.x + badgeBox.width / 2, badgeBox.y + badgeBox.height / 2);
      await page.waitForTimeout(500);
    }
    const coord = subRouteCoords['CLMM'];
    if (coord) {
      for (let i = 1; i <= 5; i++) {
        await trustedClick(coord.x, coord.y);
        await page.waitForTimeout(150);
        const count = await getCounter();
        console.log(`  rapid [${i}] counter=${count}/28`);
        if (count !== 3) {
          console.log(`  ✓ Changed after ${i} rapid CDP clicks!`);
          break;
        }
      }
    }
    console.log(`Final: ${await getCounter()}/28`);
  }

  await cdp.detach();
  console.log('\n=== Diagnosis complete ===');
});
