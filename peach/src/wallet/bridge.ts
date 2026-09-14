import { ethers } from 'ethers';

/**
 * 页面 → Node 的 EIP-1193 请求处理器。
 *
 * 关键点：eth_sendTransaction 在这里被拦下，由 ethers 用私钥本地签名后以
 * eth_sendRawTransaction 广播，因此页面永远拿不到私钥，也不会有审批弹窗。
 * 未显式处理的方法直接打到 RPC，保证前端的读链行为完全正常。
 */

export interface WalletBridgeOptions {
  privateKey: string;
  rpcUrl: string;
  chainId: number;
  /** 每笔广播成功的交易 hash 都会回调，测试据此去链上查回执。 */
  onTransaction?: (hash: string) => void;
  log?: (msg: string) => void;
}

export interface WalletBridge {
  readonly address: string;
  readonly provider: ethers.JsonRpcProvider;
  readonly wallet: ethers.Wallet;
  /** 传给 context.exposeBinding('__walletBridge', ...) 的函数。 */
  handle: (source: unknown, payload: { method: string; params?: unknown[] }) => Promise<unknown>;
  /** 本次运行里所有已广播的交易 hash，按时间顺序。 */
  readonly txHashes: readonly string[];
  /**
   * 钱包被"用掉"的次数 = 广播交易数 + 签名数。
   *
   * 插件方案里 approveTransaction() 顺带提供了「等弹窗出现、等它关闭」的
   * 同步语义；注入钱包是同步返回的，没有弹窗可等。测试改用这个计数器判断
   * 「钱包动作是否真的发生了」，语义比等 UI 更准。
   */
  readonly activityCount: number;
  /**
   * 让下一次需要私钥的请求返回 EIP-1193 的 4001（user rejected），
   * 用来模拟"用户在钱包里点了拒绝"。只生效一次。
   */
  rejectNext(): void;
  destroy(): void;
}

/** 页面传来的十六进制/十进制数值统一转 bigint；空值返回 undefined。 */
function toBigInt(v: unknown): bigint | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return BigInt(v as string | number | bigint);
}

/** EIP-712 的 types 里带 EIP712Domain 会让 ethers 报重复定义，必须剔除。 */
function stripDomainType(types: Record<string, unknown>): Record<string, unknown> {
  const { EIP712Domain: _ignored, ...rest } = types;
  return rest;
}

export function createWalletBridge(options: WalletBridgeOptions): WalletBridge {
  const { privateKey, rpcUrl, chainId, onTransaction } = options;
  const log = options.log ?? ((msg: string) => console.log(`[bridge] ${msg}`));

  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error('[bridge] privateKey 格式不对，应为 0x 开头的 64 位十六进制');
  }

  // staticNetwork 跳过 eth_chainId 探测，避免节点抖动时 provider 直接报废
  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  const wallet = new ethers.Wallet(privateKey, provider);
  const txHashes: string[] = [];
  let activityCount = 0;
  let rejectNextRequest = false;

  /** 未显式处理的方法原样转发给 RPC 节点。 */
  async function passthrough(method: string, params: unknown[]): Promise<unknown> {
    return provider.send(method, params ?? []);
  }

  const handlers: Record<string, (params: any[]) => Promise<unknown>> = {
    async eth_sendTransaction([tx = {}]) {
      // gas / gasPrice 一律不用前端给的值：报价页拿到的数字在链上常已过时，
      // 交给 ethers 现场估算更可靠。
      const sent = await wallet.sendTransaction({
        to: tx.to ?? undefined,
        data: tx.data ?? undefined,
        value: toBigInt(tx.value) ?? 0n,
      });
      txHashes.push(sent.hash);
      activityCount += 1;
      onTransaction?.(sent.hash);
      log(`发出交易 ${sent.hash}`);
      return sent.hash;
    },

    async personal_sign([message]) {
      // 参数可能是 hex 编码的 UTF-8 文本，也可能是原始字符串
      const text = ethers.isHexString(message) ? ethers.toUtf8String(message) : String(message);
      activityCount += 1;
      log(`personal_sign: ${text.slice(0, 80)}`);
      return wallet.signMessage(text);
    },

    async eth_sign([, message]) {
      return handlers.personal_sign([message]);
    },

    async eth_signTypedData_v4([, payload]) {
      const typed = typeof payload === 'string' ? JSON.parse(payload) : payload;
      activityCount += 1;
      log(`signTypedData: ${typed.primaryType}`);
      return wallet.signTypedData(
        typed.domain,
        stripDomainType(typed.types) as any,
        typed.message,
      );
    },

    async eth_estimateGas([tx = {}]) {
      const gas = await provider.estimateGas({
        from: wallet.address,
        to: tx.to ?? undefined,
        data: tx.data ?? undefined,
        value: toBigInt(tx.value) ?? 0n,
      });
      return ethers.toBeHex(gas);
    },
  };
  handlers.eth_signTypedData = handlers.eth_signTypedData_v4;
  handlers.eth_signTypedData_v3 = handlers.eth_signTypedData_v4;

  /** 需要私钥的方法。只有这些会被 rejectNext() 拦截。 */
  const SIGNING_METHODS = new Set([
    'eth_sendTransaction', 'personal_sign', 'eth_sign',
    'eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4',
  ]);

  // 返回给 exposeBinding 的函数：异常要序列化成普通对象，
  // 因为跨 binding 抛出的 Error 会丢掉 code 字段，而前端靠 code 区分
  // 「用户拒绝(4001)」和「节点报错」。
  const handle: WalletBridge['handle'] = async (_source, { method, params }) => {
    try {
      const fn = handlers[method];
      // 拒签只针对需要私钥的方法；读链和估 gas 照常放行，否则前端会直接白屏
      if (rejectNextRequest && SIGNING_METHODS.has(method)) {
        rejectNextRequest = false;
        log(`按测试要求拒绝 ${method}`);
        const rejected = new Error('User rejected the request.') as Error & { code: number };
        rejected.code = 4001;
        throw rejected;
      }
      return fn ? await fn((params ?? []) as any[]) : await passthrough(method, params ?? []);
    } catch (error) {
      const err = error as { code?: number; shortMessage?: string; message?: string; data?: unknown };
      log(`RPC ${method} 失败: ${err.shortMessage || err.message}`);
      return {
        __error: true,
        code: err.code ?? -32603,
        message: err.shortMessage || err.message || 'wallet error',
        data: err.data,
      };
    }
  };

  return {
    address: wallet.address,
    provider,
    wallet,
    handle,
    get txHashes() { return txHashes; },
    get activityCount() { return activityCount; },
    rejectNext() { rejectNextRequest = true; },
    destroy() {
      try { provider.destroy(); } catch { /* 已销毁则忽略 */ }
    },
  };
}
