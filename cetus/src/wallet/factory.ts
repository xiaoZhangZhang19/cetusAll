import type { WalletController } from './controller.js';
import { InjectedWalletController } from './injected-controller.js';

/**
 * 创建钱包控制器。
 *
 * 只有注入式一种实现了 —— 基于 Slush 扩展的那套已移除，见 controller.ts 的说明。
 */
export function createWalletController(): WalletController {
  return new InjectedWalletController();
}
