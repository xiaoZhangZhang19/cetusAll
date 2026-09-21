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

  /**
   * 武装「下一次签名请求按用户拒签处理」。
   *
   * ⚠️ 必须在触发签名的那个点击**之前**调用。注入钱包没有审批弹窗，
   * dApp 一调 signTransaction 就会立刻拿到签名 —— 提交之后再武装已经来不及，
   * 交易会真的上链（建池这类用例还会真的花钱）。
   */
  armRejection(page: Page): Promise<void>;

  /** 等已武装的拒签真正被某次签名请求消费掉。 */
  rejectTransaction(page: Page, timeoutMs?: number): Promise<void>;
}
