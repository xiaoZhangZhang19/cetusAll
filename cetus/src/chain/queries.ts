import type { SuiObjectChange, SuiTransactionBlockResponseOptions } from '@mysten/sui/jsonRpc';

import { getSuiClient } from './client.js';
import type { BalanceSnapshot, TransactionAssertionResult, SuiEvent, SwapEvent, BalanceChange } from './types.js';

const txOptions: SuiTransactionBlockResponseOptions = {
  showEffects: true,
  showObjectChanges: true,
  showEvents: true,
  showBalanceChanges: true
};

export async function getBalanceSnapshot(address: string, coinType: string): Promise<BalanceSnapshot> {
  const client = getSuiClient();
  const response = await client.getBalance({
    owner: address,
    coinType
  });

  return {
    coinType,
    totalBalance: BigInt(response.totalBalance),
    coinObjectCount: response.coinObjectCount
  };
}

export async function getOwnedObjects(address: string) {
  const client = getSuiClient();
  return client.getOwnedObjects({
    owner: address,
    options: {
      showContent: true,
      showDisplay: true,
      showType: true
    }
  });
}

/**
 * 查询指定地址最近发出的交易 digest（按时间倒序）。
 *
 * 用于 UI 不暴露 digest 的场景：Cetus 成功弹窗的 "View on Explorer" 是纯
 * <button>，既没有 href 也不把 digest 渲染进文案，只能回链上取。
 *
 * @param address    发起交易的钱包地址
 * @param excluding  需要排除的 digest（通常是 swap 之前的最新一笔），
 *                   用于确认取到的是本次新产生的交易
 */
export async function getLatestTransactionDigest(
  address: string,
  excluding?: string
): Promise<string | undefined> {
  const client = getSuiClient();
  const response = await client.queryTransactionBlocks({
    filter: { FromAddress: address },
    order: 'descending',
    limit: 5
  });

  const digests = response.data.map((tx) => tx.digest).filter(Boolean);
  if (!excluding) return digests[0];
  return digests.find((digest) => digest !== excluding);
}

export async function getTransactionResult(digest: string): Promise<TransactionAssertionResult> {
  const client = getSuiClient();
  const tx = await client.getTransactionBlock({
    digest,
    options: txOptions
  });

  const createdObjectIds = (tx.objectChanges ?? [])
    .filter((change) => change.type === 'created')
    .map((change: SuiObjectChange) => ('objectId' in change ? change.objectId : ''));

  const mutatedObjectIds = (tx.objectChanges ?? [])
    .filter((change) => change.type === 'mutated')
    .map((change: SuiObjectChange) => ('objectId' in change ? change.objectId : ''));

  // Parse events
  const events: SuiEvent[] = (tx.events ?? []).map((event) => ({
    type: event.type,
    packageId: event.packageId,
    transactionModule: event.transactionModule,
    sender: event.sender,
    parsedJson: event.parsedJson as Record<string, any> | undefined,
    bcs: event.bcs
  }));

  // Extract swap-specific events
  const swapEvents: SwapEvent[] = events
    .filter((event) =>
      event.type.includes('swap') ||
      event.type.includes('Swap') ||
      event.transactionModule.includes('swap')
    )
    .map((event) => ({
      type: event.type,
      pool: event.parsedJson?.pool ?? event.parsedJson?.pool_id,
      amountIn: event.parsedJson?.amount_in?.toString() ?? event.parsedJson?.amountIn?.toString(),
      amountOut: event.parsedJson?.amount_out?.toString() ?? event.parsedJson?.amountOut?.toString(),
      sender: event.parsedJson?.sender ?? event.sender,
      recipient: event.parsedJson?.recipient,
      atob: event.parsedJson?.atob,
      ...event.parsedJson
    }));

  // Parse balance changes
  const balanceChanges: BalanceChange[] = (tx.balanceChanges ?? []).map((change) => {
    let ownerAddress = '';
    if (typeof change.owner === 'object' && change.owner !== null) {
      if ('AddressOwner' in change.owner) {
        ownerAddress = change.owner.AddressOwner;
      } else if ('ObjectOwner' in change.owner) {
        ownerAddress = change.owner.ObjectOwner;
      }
    } else if (typeof change.owner === 'string') {
      ownerAddress = change.owner;
    }

    return {
      owner: ownerAddress,
      coinType: change.coinType,
      amount: change.amount
    };
  });

  const statusError = tx.effects?.status.status === 'failure'
    ? tx.effects?.status.error
    : undefined;

  return {
    digest,
    success: tx.effects?.status.status === 'success',
    status: tx.effects?.status.status ?? 'unknown',
    statusError,
    gasUsed: BigInt(tx.effects?.gasUsed.computationCost ?? 0) +
      BigInt(tx.effects?.gasUsed.storageCost ?? 0) -
      BigInt(tx.effects?.gasUsed.storageRebate ?? 0),
    createdObjectIds,
    mutatedObjectIds,
    events,
    swapEvents,
    balanceChanges
  };
}
