import { ethers } from 'ethers';

/**
 * Balance Checker - 使用 ethers.js 直接从链上查询代币余额
 * 支持原生代币（BNB）和 ERC-20 代币
 */

// ERC-20 最小 ABI，只需要 balanceOf 和 decimals 方法
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

export class BalanceChecker {
  private provider: ethers.JsonRpcProvider;

  constructor(rpcUrl: string) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
  }

  /**
   * 获取原生代币余额（如 BNB、ETH）
   * @param address - 钱包地址
   * @returns 格式化后的余额字符串（已转换为正确的小数位数）
   */
  async getNativeBalance(address: string): Promise<string> {
    try {
      const balance = await this.provider.getBalance(address);
      // 将 wei 转换为 ether（18 位小数）
      const formatted = ethers.formatEther(balance);
      console.log(`[BalanceChecker] Native token balance for ${address}: ${formatted}`);
      return formatted;
    } catch (error) {
      console.error(`[BalanceChecker] Error getting native balance: ${error}`);
      return '0';
    }
  }

  /**
   * 获取 ERC-20 代币余额
   * @param tokenAddress - 代币合约地址
   * @param walletAddress - 钱包地址
   * @returns 格式化后的余额字符串（已转换为正确的小数位数）
   */
  async getERC20Balance(tokenAddress: string, walletAddress: string): Promise<string> {
    try {
      const contract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
      
      // 并行获取余额和小数位数
      const [balance, decimals] = await Promise.all([
        contract.balanceOf(walletAddress),
        contract.decimals(),
      ]);
      
      // 根据代币的 decimals 格式化余额
      const formatted = ethers.formatUnits(balance, decimals);
      console.log(`[BalanceChecker] ERC-20 balance for ${tokenAddress.slice(0, 10)}...: ${formatted}`);
      return formatted;
    } catch (error) {
      console.error(`[BalanceChecker] Error getting ERC-20 balance: ${error}`);
      return '0';
    }
  }

  /**
   * 智能获取余额 - 自动判断是原生代币还是 ERC-20 代币
   * @param tokenAddress - 代币地址（原生代币使用 0xeeee...eeee）
   * @param walletAddress - 钱包地址
   * @returns 格式化后的余额字符串
   */
  async getBalance(tokenAddress: string, walletAddress: string): Promise<string> {
    const isNative = tokenAddress.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    
    if (isNative) {
      return this.getNativeBalance(walletAddress);
    } else {
      return this.getERC20Balance(tokenAddress, walletAddress);
    }
  }

  /**
   * 释放 provider 持有的连接池和内部轮询，防止长时间运行时内存泄漏。
   * 每次测试套件结束后必须调用此方法。
   */
  destroy(): void {
    this.provider.destroy();
  }

  /**
   * 获取代币信息（符号和小数位数）
   * @param tokenAddress - 代币合约地址
   * @returns { symbol: string, decimals: number }
   */
  async getTokenInfo(tokenAddress: string): Promise<{ symbol: string; decimals: number }> {
    try {
      const isNative = tokenAddress.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
      
      if (isNative) {
        return { symbol: 'BNB', decimals: 18 };
      }
      
      const contract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
      const [symbol, decimals] = await Promise.all([
        contract.symbol(),
        contract.decimals(),
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
 * @param rpcUrl - RPC 节点 URL（默认为 BSC 主网）
 */
export function createBalanceChecker(rpcUrl?: string): BalanceChecker {
  const defaultRpcUrl = rpcUrl || 'https://bsc-dataseed.binance.org/';
  return new BalanceChecker(defaultRpcUrl);
}
