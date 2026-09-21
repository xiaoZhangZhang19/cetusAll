import type { Page } from '@playwright/test';

/**
 * 钱包控制器接口。
 *
 * 当前只有一个实现：InjectedWalletController（注入式钱包，只用私钥签名）。
 * 早期还有一个基于 Slush 浏览器扩展的 ExtensionWalletController，已移除 ——
 * 它依赖本机 Chrome profile 和扩展版本路径（扩展升级后路径就失效），
 * 还要处理解锁密码和弹窗竞态，且跑不了 CI。
 */
export interface WalletController {
  connect(page: Page): Promise<void>;
  approveTransaction(page: Page): Promise<void>;
  approveTransactionForAction(page: Page, action: () => Promise<void>): Promise<void>;
}
