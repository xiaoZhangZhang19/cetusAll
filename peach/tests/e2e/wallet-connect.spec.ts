/**
 * Test: E2E Wallet 注入链路冒烟测试
 *
 * 验证注入式钱包这一层本身是通的，不涉及任何业务流程、不花 gas：
 *   1. 页面加载后自动进入已连接状态（无需点 Connect、无需审批弹窗）
 *   2. header 上显示的地址与 Node 侧私钥推导出的地址一致
 *   3. 前端能通过注入的 provider 正常读链（eth_chainId / eth_blockNumber）
 *   4. bridge 的签名通道可用（personal_sign 不上链、不花钱）
 *
 * 其它 spec 失败时先跑这个，可以快速区分「钱包层坏了」和「业务流程变了」。
 *
 * 运行命令：
 *   npx playwright test tests/e2e/wallet-connect.spec.ts
 */

import { ethers } from 'ethers';
import { env, chainPath } from '../../src/config/env.js';
import { test, expect } from '../setup/fixtures.js';

/** 带链前缀的交易页路径，例如 /bsc/swap。 */
const CHAIN_PATH = chainPath('/swap');

test.describe('E2E Wallet – 注入链路冒烟测试', () => {
  test('injected provider auto-connects and can sign', async ({
    workerPage: page,
    workerWallet: wallet,
    workerWalletBridge: bridge,
  }) => {
    test.setTimeout(120_000);

    // ── Step 1: 打开交易页并连接 ───────────────────────────────────────────
    // 必须带链前缀：站点根路径 "/" 会被重定向到默认链（实测是 ARC Testnet），
    // 与 E2E_CHAIN_ID=56 不匹配时 header 只会显示 "Switch to ..."。
    console.log('\n[Step 1] Loading app and connecting...');
    await page.goto(CHAIN_PATH, { waitUntil: 'domcontentloaded' });
    await wallet.connect(page);

    // ── Step 2: header 地址与私钥推导地址一致 ──────────────────────────────
    console.log('\n[Step 2] Verifying header address matches the signing key...');
    const headerText = await page.locator('header').first().innerText();
    // 前端显示的是缩写形式，例如 0x03b2...99D5
    const prefix = bridge.address.slice(0, 6);
    expect(
      headerText.toLowerCase(),
      `header 里应出现 ${prefix}，实际内容: ${headerText}`,
    ).toContain(prefix.toLowerCase());
    console.log(`✓ Connected as ${bridge.address}`);

    // ── Step 3: 前端可通过注入的 provider 读链 ─────────────────────────────
    console.log('\n[Step 3] Reading chain through the injected provider...');
    const chainIdHex = await page.evaluate(
      () => (window as any).ethereum.request({ method: 'eth_chainId' }) as Promise<string>,
    );
    expect(parseInt(chainIdHex, 16)).toBe(env.e2eChainId);

    // eth_blockNumber 没有本地实现，会真的走 bridge 透传到 RPC，
    // 因此这一步同时验证了「页面 → Node → 节点」整条通道
    const blockHex = await page.evaluate(
      () => (window as any).ethereum.request({ method: 'eth_blockNumber' }) as Promise<string>,
    );
    const blockNumber = parseInt(blockHex, 16);
    expect(blockNumber).toBeGreaterThan(0);
    console.log(`✓ chainId=${env.e2eChainId}, blockNumber=${blockNumber} (via bridge passthrough)`);

    // ── Step 4: 签名通道可用（不上链、不花 gas）────────────────────────────
    console.log('\n[Step 4] Signing a message through the bridge...');
    const message = `peach-e2e-smoke-${Date.now()}`;
    const signature = await page.evaluate(
      ([msg, addr]) =>
        (window as any).ethereum.request({
          method: 'personal_sign',
          params: [msg, addr],
        }) as Promise<string>,
      [message, bridge.address] as const,
    );

    // 用签名反推地址，确认签名确实来自我们的私钥
    const recovered = ethers.verifyMessage(message, signature);
    expect(recovered.toLowerCase()).toBe(bridge.address.toLowerCase());
    console.log(`✓ personal_sign verified, recovered ${recovered}`);

    // 签名也应被计入活动计数（其它 page-object 靠它做同步点）
    expect(bridge.activityCount).toBeGreaterThan(0);

    console.log('\n══════════════════════════════════════════════');
    console.log('  E2E Wallet 链路正常：自动连接 / 读链 / 签名');
    console.log('══════════════════════════════════════════════\n');
  });
});
