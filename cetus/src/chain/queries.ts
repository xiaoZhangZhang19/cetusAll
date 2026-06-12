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

  // Extract swap-specific events (Cetus swap events usually contain pool info and amounts)
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

  // Extract error message if transaction failed
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
