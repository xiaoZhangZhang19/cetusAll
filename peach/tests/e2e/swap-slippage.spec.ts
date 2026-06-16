/**
 * Test: Swap Slippage Warning Validation
 *
 * 滑点警告提示文案验证：在 Swap Settings 中依次输入三个滑点值，
 * 验证前端展示的警告/错误提示文案是否符合预期。
 * 本测试不执行真实交易。
 *
 * 三种滑点场景（默认值）：
 *   0.05  → 低滑点警告（黄色）：
 *           "Your slippage is quite low and may cause failed transactions in highly volatile markets."
 *   2.5   → 高滑点警告（橙色）：
 *           "Your slippage setting might be high. Consider adjusting it to reduce front-running risks."
 *   20    → 超出上限错误（红色）：
 *           "Enter a valid slippage percentage. Max is 19.99%"
 *           且 Confirm Changes 按钮应置灰/禁用
 *
 * 环境变量配置（.env）：
 *   SLIPPAGE_VALUES  – 逗号分隔的三个滑点值，如 "0.05,2.5,20"（默认 "0.05,2.5,20"）
 *   SLIPPAGE_WARN_LOW    – 低滑点期望提示文案关键词（默认内置）
 *   SLIPPAGE_WARN_HIGH   – 高滑点期望提示文案关键词（默认内置）
 *   SLIPPAGE_WARN_OVER   – 超限滑点期望提示文案关键词（默认内置）
 *
 * 运行命令：
 *   npx playwright test tests/e2e/swap-slippage.spec.ts
 *
 *   # 自定义滑点值
 *   SLIPPAGE_VALUES="0.05,2.5,20" npx playwright test tests/e2e/swap-slippage.spec.ts
 */

import { SwapPage } from '../../src/page-objects/swap.page.js';
import { test, expect } from '../setup/fixtures.js';

// ── 解析滑点值序列 ──────────────────────────────────────────────────────────
function parseSlippageValues(): [string, string, string] {
  const raw = process.env.SLIPPAGE_VALUES ?? '0.05,2.5,20';
  const parts = raw.split(',').map(v => v.trim()).filter(v => v);
  return [parts[0] ?? '0.05', parts[1] ?? '2.5', parts[2] ?? '20'];
}

// ── 期望提示文案关键词（从环境变量或内置默认值）────────────────────────────
const EXPECTED_LOW  = process.env.SLIPPAGE_WARN_LOW  ?? 'Your slippage is quite low and may cause failed transactions in highly volatile markets.';
const EXPECTED_HIGH = process.env.SLIPPAGE_WARN_HIGH ?? 'Your slippage setting might be high. Consider adjusting it to reduce front-running risks.';
const EXPECTED_OVER = process.env.SLIPPAGE_WARN_OVER ?? 'Enter a valid slippage percentage. Max is 19.99%';

const [VAL_LOW, VAL_HIGH, VAL_OVER] = parseSlippageValues();

// ── 每个用例的结果 ───────────────────────────────────────────────────────────
interface SlippageResult {
  value:           string;
  label:           string;      // low / high / over
  warningText:     string;      // 实际读取到的文案
  expectedKeyword: string;      // 期望关键词
  matched:         boolean;     // 文案是否包含期望关键词
  confirmDisabled?: boolean;    // 超限时 Confirm Changes 是否被禁用
  error?:          string;
}

test.describe('Peach Swap – Slippage Warning Validation', () => {
  test('validates slippage warning messages for low / high / over-max values', async ({
    workerPage: page,
    workerMetamask: metamask,
  }) => {
    test.setTimeout(300_000);

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  Peach Protocol – Slippage Warning Validation Test');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`Low value:  ${VAL_LOW}%  → expect: "${EXPECTED_LOW}"`);
    console.log(`High value: ${VAL_HIGH}% → expect: "${EXPECTED_HIGH}"`);
    console.log(`Over value: ${VAL_OVER}% → expect: "${EXPECTED_OVER}"`);
    console.log('───────────────────────────────────────────────────────────');

    const swapPage = new SwapPage(page);

    // ── Step 1: 导航并连接钱包 ────────────────────────────────────────────
    console.log('\n[Step 1] Navigating and connecting wallet...');
    await swapPage.goto();
    await metamask.connect(page);
    await expect(page.locator('text=/0x[a-fA-F0-9]{3,}/i').first()).toBeVisible({ timeout: 10000 });
    console.log('✓ Wallet connected');

    const cases: Array<{ value: string; label: string; keyword: string; expectDisabled: boolean }> = [
      { value: VAL_LOW,  label: 'low',  keyword: EXPECTED_LOW,  expectDisabled: false },
      { value: VAL_HIGH, label: 'high', keyword: EXPECTED_HIGH, expectDisabled: false },
      { value: VAL_OVER, label: 'over', keyword: EXPECTED_OVER, expectDisabled: true  },
    ];

    const results: SlippageResult[] = [];

    // ── Step 2: 打开 Settings，在同一弹窗内依次测试三个滑点值 ──────────────
    console.log('\n[Step 2] Opening Settings modal...');
    await swapPage.openSettings();
    // 点一次 Custom 按钮激活输入框（后续直接清空填值即可，不需要重复点）
    await swapPage.activateCustomSlippage();
    console.log('✓ Settings modal open, Custom input activated');

    for (let i = 0; i < cases.length; i++) {
      const { value, label, keyword, expectDisabled } = cases[i];
      console.log(`\n${'─'.repeat(55)}`);
      console.log(`  [${i + 1}/${cases.length}] Testing slippage ${value}% [${label}]`);
      console.log(`${'─'.repeat(55)}`);

      try {
        // 直接清空并填入新值（弹窗保持打开）
        await swapPage.fillSlippageInput(value);

        // 等待警告文案出现/更新
        const warningText = await swapPage.getSlippageWarning();
        console.log(`  Warning text: "${warningText}"`);

        const matched = warningText.toLowerCase().includes(keyword.toLowerCase());
        console.log(`  Expected keyword: "${keyword}"`);
        console.log(`  Match: ${matched ? '✅ YES' : '❌ NO'}`);

        // 超限时验证 Confirm Changes 按钮禁用状态
        let confirmDisabled: boolean | undefined;
        if (expectDisabled) {
          confirmDisabled = !(await swapPage.isConfirmChangesEnabled());
          console.log(`  Confirm Changes disabled: ${confirmDisabled ? '✅ YES (expected)' : '❌ NO (unexpected)'}`);
        }

        // 输出结构化日志（供 dashboard 解析）
        console.log(`##SLIPPAGE_RESULT:value=${value},label=${label},matched=${matched},warning=${warningText.replace(/,/g, ';').replace(/\n/g, ' ')}##`);

        results.push({ value, label, warningText, expectedKeyword: keyword, matched, confirmDisabled });

      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ✗ Error: ${msg}`);
        console.log(`##SLIPPAGE_RESULT:value=${value},label=${label},matched=false,warning=ERROR:${msg}##`);
        results.push({ value, label, warningText: '', expectedKeyword: keyword, matched: false, error: msg });
        // 不关闭弹窗，继续测下一个值
      }
    }

    // 所有值测完后关闭 Settings 弹窗
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
    console.log('✓ Settings modal closed');

    // ── Step 3: 汇总报告 ─────────────────────────────────────────────────
    console.log(`\n${'═'.repeat(60)}`);
    console.log('  SLIPPAGE WARNING VALIDATION REPORT');
    console.log(`${'═'.repeat(60)}`);

    let allPassed = true;
    for (const r of results) {
      const icon = r.matched ? '✅' : '❌';
      console.log(`  ${icon} [${r.label.padEnd(4)}] ${r.value}%`);
      console.log(`       Expected: "${r.expectedKeyword}"`);
      console.log(`       Got:      "${r.warningText}"`);
      if (r.confirmDisabled !== undefined) {
        console.log(`       Confirm disabled: ${r.confirmDisabled}`);
      }
      if (r.error) console.log(`       Error: ${r.error}`);
      if (!r.matched) allPassed = false;
    }

    const passed  = results.filter(r => r.matched).length;
    const failed  = results.filter(r => !r.matched).length;

    console.log(`${'─'.repeat(60)}`);
    console.log(`  Total: ${results.length}  ✅ Passed: ${passed}  ❌ Failed: ${failed}`);

    // 输出汇总标记（供 dashboard 解析）
    console.log(`##SLIPPAGE_SUMMARY:passed=${passed},failed=${failed},total=${results.length}##`);
    console.log(`${'═'.repeat(60)}\n`);

    // 断言：所有三个滑点值均匹配到期望文案
    for (const r of results) {
      expect(
        r.matched,
        `Slippage ${r.value}% [${r.label}]: expected warning to contain "${r.expectedKeyword}", got "${r.warningText}"`,
      ).toBe(true);
    }

    // 额外断言：超限值（VAL_OVER）时 Confirm Changes 应被禁用
    const overResult = results.find(r => r.label === 'over');
    if (overResult?.confirmDisabled !== undefined) {
      expect(
        overResult.confirmDisabled,
        `Slippage ${VAL_OVER}% [over]: Confirm Changes button should be disabled`,
      ).toBe(true);
    }
  });
});
