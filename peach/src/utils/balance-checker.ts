import { ethers } from 'ethers';

/**
 * Balance Checker - 使用 ethers.js 直接从链上查询代币余额
 * 支持原生代币（BNB）和 ERC-20 代币
 *
 * 设计要点：查询失败必须抛 BalanceQueryError，绝不能降级返回 '0'。
 * 返回 '0' 会让「RPC 不可用」和「余额确实为 0」无法区分，导致 swap
 * 成功却被余额断言判成失败。
 */

// ERC-20 最小 ABI，只需要 balanceOf 和 decimals 方法
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

export const NATIVE_TOKEN_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

/** BSC 主网 chainId，显式传入可跳过 ethers 的网络自动探测。 */
const BSC_CHAIN_ID = 56;

/** 备用公共节点：主节点限流/不可用时依次回退。 */
const FALLBACK_BSC_RPC_URLS = [
  'https://bsc-dataseed.binance.org/',
  'https://bsc-dataseed1.defibit.io/',
  'https://bsc-dataseed1.ninicoin.io/',
  'https://rpc.ankr.com/bsc',
  'https://bsc.publicnode.com',
];

/**
 * 链上余额查询失败（网络错误、节点限流、合约调用异常等）。
 * 调用方据此区分「查不到」与「余额为 0」。
 */
export class BalanceQueryError extends Error {
  readonly tokenAddress: string;
  readonly cause?: unknown;

  constructor(tokenAddress: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'BalanceQueryError';
    this.tokenAddress = tokenAddress;
    this.cause = cause;
  }
}

export class BalanceChecker {
  private readonly rpcUrls: string[];
  private providers: ethers.JsonRpcProvider[];
  private activeIndex = 0;
  /** decimals 是不变量，缓存避免每次查询都多打一次 RPC。 */
  private decimalsCache = new Map<string, number>();

  constructor(rpcUrl?: string | string[]) {
    const requested = Array.isArray(rpcUrl) ? rpcUrl : rpcUrl ? [rpcUrl] : [];
    // 去重后拼上备用节点，保证至少有一个可用候选
    this.rpcUrls = Array.from(new Set([...requested, ...FALLBACK_BSC_RPC_URLS]));
    // staticNetwork 跳过 eth_chainId 探测，避免节点抖动时
    // "failed to detect network and cannot startup" 直接让 provider 报废
    this.providers = this.rpcUrls.map(
      (url) => new ethers.JsonRpcProvider(url, BSC_CHAIN_ID, { staticNetwork: true }),
    );
  }

  /**
   * 依次在所有节点上重试同一次查询。
   * 全部失败才抛 BalanceQueryError，成功的节点会被记为首选。
   */
  private async withFailover<T>(
    tokenAddress: string,
    label: string,
    fn: (provider: ethers.JsonRpcProvider) => Promise<T>,
  ): Promise<T> {
    const errors: string[] = [];
    const total = this.providers.length;

    // 每个节点给 2 次机会（覆盖瞬时限流），从上次成功的节点开始
    for (let round = 0; round < 2; round++) {
      for (let offset = 0; offset < total; offset++) {
        const idx = (this.activeIndex + offset) % total;
        try {
          const result = await fn(this.providers[idx]);
          if (idx !== this.activeIndex) {
            console.log(`[BalanceChecker] Switched to RPC #${idx}: ${this.rpcUrls[idx]}`);
            this.activeIndex = idx;
          }
          return result;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${this.rpcUrls[idx]}: ${msg}`);
        }
      }
      if (round === 0) await new Promise((r) => setTimeout(r, 800));
    }

    throw new BalanceQueryError(
      tokenAddress,
      `${label} failed on all ${total} RPC endpoint(s) — ${errors.slice(0, 3).join(' | ')}`,
    );
  }

  /**
   * 获取原生代币余额（如 BNB、ETH）
   * @param address - 钱包地址
   * @returns 格式化后的余额字符串（已转换为正确的小数位数）
   * @throws BalanceQueryError 所有 RPC 节点都查询失败时
   */
  async getNativeBalance(address: string): Promise<string> {
    const balance = await this.withFailover(
      NATIVE_TOKEN_ADDRESS,
      `Native balance query for ${address}`,
      (provider) => provider.getBalance(address),
    );
    const formatted = ethers.formatEther(balance);
    console.log(`[BalanceChecker] Native token balance for ${address}: ${formatted}`);
    return formatted;
  }

  /** 读取并缓存 ERC-20 的 decimals。 */
  private async getDecimals(tokenAddress: string): Promise<number> {
    const key = tokenAddress.toLowerCase();
    const cached = this.decimalsCache.get(key);
    if (cached !== undefined) return cached;

    const decimals = await this.withFailover(
      tokenAddress,
      `decimals() query for ${tokenAddress}`,
      async (provider) => {
        const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        return Number(await contract.decimals());
      },
    );
    this.decimalsCache.set(key, decimals);
    return decimals;
  }

  /**
   * 获取 ERC-20 代币余额
   * @param tokenAddress - 代币合约地址
   * @param walletAddress - 钱包地址
   * @returns 格式化后的余额字符串（已转换为正确的小数位数）
   * @throws BalanceQueryError 所有 RPC 节点都查询失败时
   */
  async getERC20Balance(tokenAddress: string, walletAddress: string): Promise<string> {
    const decimals = await this.getDecimals(tokenAddress);
    const balance = await this.withFailover(
      tokenAddress,
      `balanceOf() query for ${tokenAddress}`,
      async (provider) => {
        const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        return contract.balanceOf(walletAddress) as Promise<bigint>;
      },
    );
    const formatted = ethers.formatUnits(balance, decimals);
    console.log(`[BalanceChecker] ERC-20 balance for ${tokenAddress.slice(0, 10)}...: ${formatted}`);
    return formatted;
  }

  /**
   * 智能获取余额 - 自动判断是原生代币还是 ERC-20 代币
   * @param tokenAddress - 代币地址（原生代币使用 0xeeee...eeee）
   * @param walletAddress - 钱包地址
   * @returns 格式化后的余额字符串
   * @throws BalanceQueryError 查询失败时（调用方必须区别对待，不可当作 0）
   */
  async getBalance(tokenAddress: string, walletAddress: string): Promise<string> {
    const isNative = tokenAddress.toLowerCase() === NATIVE_TOKEN_ADDRESS;
    return isNative
      ? this.getNativeBalance(walletAddress)
      : this.getERC20Balance(tokenAddress, walletAddress);
  }

  /**
   * 探测链上连通性。返回 false 时调用方应跳过余额断言，
   * 而不是把查询失败当成余额未变化。
   */
  async isReachable(): Promise<boolean> {
    try {
      await this.withFailover('', 'blockNumber probe', (p) => p.getBlockNumber());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 释放 provider 持有的连接池和内部轮询，防止长时间运行时内存泄漏。
   * 每次测试套件结束后必须调用此方法。
   */
  destroy(): void {
    for (const provider of this.providers) {
      try { provider.destroy(); } catch { /* 已销毁则忽略 */ }
    }
    this.providers = [];
    this.decimalsCache.clear();
  }

  /**
   * 获取代币信息（符号和小数位数）
   * @param tokenAddress - 代币合约地址
   * @returns { symbol: string, decimals: number }
   */
  async getTokenInfo(tokenAddress: string): Promise<{ symbol: string; decimals: number }> {
    if (tokenAddress.toLowerCase() === NATIVE_TOKEN_ADDRESS) {
      return { symbol: 'BNB', decimals: 18 };
    }
    try {
      const [symbol, decimals] = await Promise.all([
        this.withFailover(tokenAddress, `symbol() query`, async (provider) => {
          const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
          return contract.symbol() as Promise<string>;
        }),
        this.getDecimals(tokenAddress),
      ]);
      return { symbol, decimals };
    } catch (error) {
      console.error(`[BalanceChecker] Error getting token info: ${error}`);
      return { symbol: 'UNKNOWN', decimals: 18 };
    }
  }
}

/**
 * 创建 Balance Checker 实例
 * @param rpcUrl - RPC 节点 URL（默认为 BSC 主网，失败时自动回退备用节点）
 */
export function createBalanceChecker(rpcUrl?: string | string[]): BalanceChecker {
  return new BalanceChecker(rpcUrl);
}
