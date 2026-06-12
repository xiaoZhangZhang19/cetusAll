import { env } from '@/config/env.js';
import { ExtensionWalletController, type WalletController } from './controller.js';
import { InjectedWalletController } from './injected-controller.js';

export function createWalletController(): WalletController {
  if (env.walletMode === 'injected') {
    return new InjectedWalletController();
  }
  return new ExtensionWalletController();
}
