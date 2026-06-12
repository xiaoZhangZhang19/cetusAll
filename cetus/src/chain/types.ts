export interface BalanceSnapshot {
  coinType: string;
  totalBalance: bigint;
  coinObjectCount: number;
}

export interface SwapExpectation {
  fromCoinType: string;
  toCoinType: string;
  inputAmount: bigint;
  minimumOutputAmount: bigint;
}

export interface SuiEvent {
  type: string;
  packageId: string;
  transactionModule: string;
  sender: string;
  parsedJson?: Record<string, any>;
  bcs?: string;
}

export interface SwapEvent {
  type: string;
  pool?: string;
  amountIn?: string;
  amountOut?: string;
  sender?: string;
  recipient?: string;
  atob?: boolean;
  [key: string]: any;
}

export interface BalanceChange {
  owner: string;
  coinType: string;
  amount: string;
}

export interface TransactionAssertionResult {
  digest: string;
  success: boolean;
  status: string;
  statusError?: string;
  gasUsed: bigint;
  createdObjectIds: string[];
  mutatedObjectIds: string[];
  events: SuiEvent[];
  swapEvents: SwapEvent[];
  balanceChanges: BalanceChange[];
}
