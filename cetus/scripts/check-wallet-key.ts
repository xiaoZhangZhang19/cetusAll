/**
 * 校验 WALLET_PRIVATE_KEY 与 TEST_WALLET_ADDRESS 是否指向同一个钱包。
 *
 * 两者不一致时，injected 模式下交易会被节点拒绝：
 *   Invalid user signature: Required Signature from 0x... is absent
 *
 * 用法: npx tsx scripts/check-wallet-key.ts
 */
import { getKeypairFromEnv } from '../src/chain/client.js';
import { env } from '../src/config/env.js';

const keypair = getKeypairFromEnv();
const derived = keypair.toSuiAddress();
const configured = env.testWalletAddress;
const match = derived === configured;

console.log('');
console.log('  私钥推导出的地址 :', derived);
console.log('  TEST_WALLET_ADDRESS:', configured);
console.log('');

if (match) {
  console.log('  ✅ 一致 —— injected 模式可以正常签名');
  console.log('');
} else {
  console.log('  ❌ 不一致！');
  console.log('');
  console.log('  injected 模式下交易会被节点拒绝，报错形如：');
  console.log(`    Invalid user signature: Required Signature from ${configured} is absent`);
  console.log('');
  console.log('  修复方式（二选一）：');
  console.log(`    a) 把 .env 的 TEST_WALLET_ADDRESS 改成 ${derived}`);
  console.log('    b) 把 WALLET_PRIVATE_KEY 换成 TEST_WALLET_ADDRESS 对应的私钥');
  console.log('');
  process.exitCode = 1;
}
