import { expect } from 'vitest';

import { getBalanceSnapshot, getTransactionResult } from './queries.js';

export async function expectBalanceIncreased(address: string, coinType: string, before: bigint) {
  const after = await getBalanceSnapshot(address, coinType);
  expect(after.totalBalance > before).toBe(true);
}

export async function expectBalanceDecreased(address: string, coinType: string, before: bigint) {
  const after = await getBalanceSnapshot(address, coinType);
  expect(after.totalBalance < before).toBe(true);
}

export async function expectTransactionSuccess(digest: string) {
  const result = await getTransactionResult(digest);
  expect(result.success).toBe(true);
  expect(result.status).toBe('success');
  return result;
}

export async function expectCreatedObjects(digest: string) {
  const result = await getTransactionResult(digest);
  expect(result.createdObjectIds.length).toBeGreaterThan(0);
  return result.createdObjectIds;
}
