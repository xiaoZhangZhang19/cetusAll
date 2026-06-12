import { expect } from 'vitest';

import { getSuiClient } from '@/chain/client.js';

export async function expectEventWithType(txDigest: string, eventType: string) {
  const client = getSuiClient();
  const tx = await client.getTransactionBlock({
    digest: txDigest,
    options: {
      showEvents: true
    }
  });

  const matched = (tx.events ?? []).find((event) => event.type === eventType);
  expect(matched).toBeDefined();
  return matched;
}

export async function expectObjectTypeOwnedByAddress(address: string, objectTypeFragment: string) {
  const client = getSuiClient();
  const objects = await client.getOwnedObjects({
    owner: address,
    options: {
      showType: true
    }
  });

  const matched = objects.data.find((item) => item.data?.type?.includes(objectTypeFragment));
  expect(matched).toBeDefined();
  return matched;
}

export async function expectPoolObjectReadable(poolId: string) {
  const client = getSuiClient();
  const object = await client.getObject({
    id: poolId,
    options: {
      showContent: true,
      showType: true
    }
  });

  expect(object.data).toBeDefined();
  return object.data;
}
