import { env } from '@/config/env.js';
import { getSuiClient, getKeypairFromEnv } from '@/chain/client.js';
import { getBalanceSnapshot, getOwnedObjects } from '@/chain/queries.js';

describe('Sui chain integration', () => {
  it('connects to the configured fullnode', async () => {
    const client = getSuiClient();
    const chainId = await client.getChainIdentifier();
    expect(chainId.length).toBeGreaterThan(0);
  });

  it('loads balance for the configured test wallet', async () => {
    const snapshot = await getBalanceSnapshot(env.testWalletAddress, env.swapInputType);
    expect(snapshot.coinType).toBe(env.swapInputType);
    expect(snapshot.coinObjectCount).toBeGreaterThanOrEqual(0);
  });

  it('loads owned objects for the configured test wallet', async () => {
    const objects = await getOwnedObjects(env.testWalletAddress);
    expect(Array.isArray(objects.data)).toBe(true);
  });

  it('builds the configured keypair from the private key', async () => {
    if (!env.testWalletSecretKey) {
      return;
    }

    const keypair = getKeypairFromEnv();
    const address = keypair.getPublicKey().toSuiAddress();
    expect(address.startsWith('0x')).toBe(true);
  });
});
