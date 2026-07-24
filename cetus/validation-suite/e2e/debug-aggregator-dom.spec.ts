/**
 * 诊断测试 v2：打开弹窗，打印完整 DOM 结构
 *
 * 运行：npx playwright test debug-aggregator-dom --headed --timeout 120000
 */

import { test } from '../setup/fixtures.js';

test('debug: print aggregator settings DOM', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto('https://app.cetus.zone/swap', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2_000);

  // 关闭服务条款弹窗
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

  // ── 打印 Aggregator Mode 附近的所有元素 ──────────────────────────────
  console.log('\n=== Aggregator Mode area ===');
  const aggLabel = page.getByText(/aggregator mode/i).first();
  for (const depth of [1, 2, 3, 4, 5]) {
    const container = aggLabel.locator(`xpath=ancestor::*[${depth}]`);
    const tagName = await container.evaluate((el) => el.tagName).catch(() => '?');
    const className = await container.evaluate((el) => el.className?.toString?.() ?? '').catch(() => '');
    const innerText = (await container.innerText().catch(() => '')).replace(/\n/g, ' | ').substring(0, 120);
    const btns = await container.locator('button, [role="button"]').count().catch(() => 0);
    console.log(`  ancestor[${depth}] <${tagName}> class="${className.substring(0, 60)}" btns=${btns} text="${innerText}"`);
  }

  // ── 尝试打开弹窗：点击 "0.5%" 按钮（ancestor[4] 内的按钮）──────────────
  console.log('\n=== Trying to open Aggregator Settings ===');

  // 找 ancestor[4] 内所有按钮
  const container4 = aggLabel.locator(`xpath=ancestor::*[4]`);
  const btnsInContainer = container4.locator('button, [role="button"]');
  const btnCount = await btnsInContainer.count();
  console.log(`Buttons in ancestor[4]: ${btnCount}`);
  for (let i = 0; i < btnCount; i++) {
    const btn = btnsInContainer.nth(i);
    const visible = await btn.isVisible().catch(() => false);
    const txt = (await btn.innerText().catch(() => '')).trim().replace(/\n/g, '|');
    const cls = await btn.evaluate((el) => el.className?.toString?.() ?? '').catch(() => '');
    console.log(`  btn[${i}] visible=${visible} text="${txt}" class="${cls.substring(0, 60)}"`);
  }

  // 尝试点击每个按钮，看哪个能打开弹窗
  for (let i = 0; i < btnCount; i++) {
    const btn = btnsInContainer.nth(i);
    if (!(await btn.isVisible().catch(() => false))) continue;
    const txt = (await btn.innerText().catch(() => '')).trim();
    console.log(`\nClicking btn[${i}] "${txt}"...`);
    await btn.click().catch(() => {});
    await page.waitForTimeout(800);

    const dialogs = page.locator('[role="dialog"]');
    const dialogCount = await dialogs.count();
    console.log(`Dialogs after click: ${dialogCount}`);
    for (let d = 0; d < dialogCount; d++) {
      const dialog = dialogs.nth(d);
      if (!(await dialog.isVisible().catch(() => false))) continue;
      const txt2 = (await dialog.innerText().catch(() => '')).substring(0, 100).replace(/\n/g, ' | ');
      console.log(`  dialog[${d}]: "${txt2}"`);
    }

    const hasAggSettings = await page.getByText('Aggregator Settings').first().isVisible({ timeout: 1_000 }).catch(() => false);
    if (hasAggSettings) {
      console.log(`✓ Aggregator Settings opened by btn[${i}]`);
      break;
    }

    // 关掉可能打开的其他弹窗
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }

  // ── 打印弹窗完整结构 ───────────────────────────────────────────────────
  const aggDialog = page.locator('[role="dialog"]').filter({ has: page.getByText('Aggregator Settings') }).last();
  const dialogOpen = await aggDialog.isVisible({ timeout: 3_000 }).catch(() => false);
  console.log(`\nAggregator Settings dialog open: ${dialogOpen}`);

  if (!dialogOpen) {
    console.log('Dialog not open, trying parent-level click areas...');

    // 最后尝试：找页面上所有含 "0.5" 或 "setting" 的按钮
    const allBtns = page.locator('button, [role="button"]');
    const totalBtns = await allBtns.count();
    for (let i = 0; i < totalBtns; i++) {
      const btn = allBtns.nth(i);
      if (!(await btn.isVisible().catch(() => false))) continue;
      const txt = (await btn.innerText().catch(() => '')).trim();
      const ariaLabel = await btn.getAttribute('aria-label').catch(() => '');
      if (/0\.5|setting|aggreg/i.test(txt + (ariaLabel ?? ''))) {
        console.log(`  Candidate btn: "${txt}" aria-label="${ariaLabel}"`);
      }
    }

    // 尝试点击 SVG 按钮（设置图标）
    const svgBtns = page.locator('button').filter({ has: page.locator('svg') });
    const svgBtnCount = await svgBtns.count();
    console.log(`\nSVG buttons: ${svgBtnCount}`);
    for (let i = 0; i < Math.min(svgBtnCount, 10); i++) {
      const btn = svgBtns.nth(i);
      if (!(await btn.isVisible().catch(() => false))) continue;
      const txt = (await btn.innerText().catch(() => '')).trim().replace(/\n/g, '|');
      const cls = await btn.evaluate((el) => el.className?.toString?.() ?? '').catch(() => '');
      const rect = await btn.boundingBox().catch(() => null);
      console.log(`  svg-btn[${i}] text="${txt}" class="${cls.substring(0, 60)}" pos=(${rect?.x?.toFixed(0) ?? '?'},${rect?.y?.toFixed(0) ?? '?'})`);
    }

    console.log('\n=== Diagnosis complete (dialog not found) ===');
    return;
  }

  // ── 弹窗打开了，打印详细结构 ──────────────────────────────────────────
  console.log('\n=== Dialog full text ===');
  const fullText = await aggDialog.innerText().catch(() => '');
  console.log(fullText);

  console.log('\n=== Select all row ===');
  const selectAllInfo = await aggDialog.evaluate((el: Element) => {
    const results: string[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ALL);
    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === Node.TEXT_NODE && /select\s*all/i.test(node.textContent ?? '')) {
        let anc: Element | null = node.parentElement;
        results.push(`TEXT "${node.textContent?.trim()}" in <${anc?.tagName}> class="${anc?.className}"`);
        for (let i = 0; i < 6 && anc; i++) {
          const cb = anc.querySelector('input[type="checkbox"]');
          const sw = anc.querySelector('[class*="switch"], [role="switch"]');
          results.push(`  anc[${i}] <${anc.tagName}> class="${anc.className?.toString?.().substring(0, 80)}" hasCheckbox=${!!cb} hasSwitch=${!!sw}`);
          anc = anc.parentElement;
        }
      }
      node = walker.nextNode();
    }
    return results;
  }).catch(() => ['error']);
  console.log(selectAllInfo.join('\n'));

  console.log('\n=== All switches ===');
  const switchInfo = await aggDialog.evaluate((el: Element) => {
    const results: string[] = [];
    const items = el.querySelectorAll('[class*="switch"], [role="switch"], input[type="checkbox"]');
    items.forEach((sw, i) => {
      const htm = sw as HTMLElement;
      const inp = sw as HTMLInputElement;
      const rect = htm.getBoundingClientRect();
      const checked = inp.type === 'checkbox' ? inp.checked :
        htm.hasAttribute('data-checked') || htm.getAttribute('aria-checked') === 'true';
      const nearText = (htm.closest('div')?.textContent ?? '').trim().substring(0, 60).replace(/\n/g, '|');
      results.push(`[${i}] <${htm.tagName}> cls="${htm.className?.toString?.().substring(0, 60)}" checked=${checked} pos=(${rect.x.toFixed(0)},${rect.y.toFixed(0)}) near="${nearText}"`);
    });
    return results;
  }).catch(() => ['error']);
  console.log(switchInfo.join('\n'));

  console.log('\n=== Dialog buttons ===');
  const btnInfo = await aggDialog.evaluate((el: Element) => {
    const results: string[] = [];
    const btns = el.querySelectorAll<HTMLElement>('button, [role="button"]');
    btns.forEach((btn, i) => {
      const rect = btn.getBoundingClientRect();
      if (rect.width === 0) return;
      const txt = (btn.textContent ?? '').trim().replace(/\n/g, '|').substring(0, 80);
      results.push(`[${i}] cls="${btn.className?.toString?.().substring(0, 50)}" txt="${txt}" pos=(${rect.x.toFixed(0)},${rect.y.toFixed(0)})`);
    });
    return results;
  }).catch(() => ['error']);
  console.log(btnInfo.join('\n'));

  console.log('\n=== Dialog outerHTML (first 4000 chars) ===');
  const html = await aggDialog.evaluate((el) => el.outerHTML).catch(() => '');
  console.log(html.substring(0, 4000));

  console.log('\n=== Diagnosis complete ===');
});
