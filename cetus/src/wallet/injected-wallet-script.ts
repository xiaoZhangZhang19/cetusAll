/**
 * Builds a JavaScript string to be injected into every browser page via
 * BrowserContext.addInitScript().
 *
 * The script registers a fake Sui wallet that implements the Wallet Standard
 * (@wallet-standard/core) so that dApps like Cetus can discover and connect to
 * it. Actual signing is bridged back to the Node.js process through three
 * window functions that Playwright exposes via page.exposeFunction():
 *
 *   window.__pw_sign_transaction(txJSON: string) → { bytes, signature }
 *   window.__pw_sign_and_execute(txJSON: string) → SuiTransactionBlockResponse
 *   window.__pw_sign_message(msgB64: string)     → { bytes, signature }
 *
 * @param address   The wallet address (from TEST_WALLET_ADDRESS env var)
 * @param walletName  The name shown in the dApp's wallet picker
 */
export function buildWalletScript(address: string, walletName: string): string {
  // Inline values at build time — the script runs in a sandboxed browser context
  // with no access to Node.js modules or env.
  return `(function () {
  const _address = ${JSON.stringify(address)};
  const _walletName = ${JSON.stringify(walletName)};

  const _account = {
    address: _address,
    publicKey: new Uint8Array(32),
    chains: ['sui:mainnet', 'sui:testnet', 'sui:devnet', 'sui:localnet'],
    features: [
      'standard:connect',
      'standard:disconnect',
      'standard:events',
      'sui:signTransaction',
      'sui:signAndExecuteTransaction',
      'sui:signPersonalMessage',
    ],
  };

  // Tiny EventEmitter for the standard:events feature
  const _listeners = {};
  function _on(event, handler) {
    if (!_listeners[event]) _listeners[event] = [];
    _listeners[event].push(handler);
    return () => {
      _listeners[event] = (_listeners[event] || []).filter((h) => h !== handler);
    };
  }

  const _wallet = {
    version: '1.0.0',
    name: _walletName,
    // Minimal inline SVG icon (required by the standard)
    icon: 'data:image/svg+xml,%3Csvg xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22 viewBox%3D%220 0 100 100%22%3E%3Ccircle cx%3D%2250%22 cy%3D%2250%22 r%3D%2250%22 fill%3D%22%2300b4d8%22%2F%3E%3Ctext y%3D%22.9em%22 font-size%3D%2280%22 x%3D%220.1em%22%3E%F0%9F%A7%AA%3C%2Ftext%3E%3C%2Fsvg%3E',
    chains: ['sui:mainnet', 'sui:testnet', 'sui:devnet', 'sui:localnet'],
    get accounts() {
      return [_account];
    },
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: async () => {
          console.log('[Playwright Wallet] connect() called');
          const result = { accounts: [_account] };
          console.log('[Playwright Wallet] connect() returning:', result);
          return result;
        },
      },
      'standard:disconnect': {
        version: '1.0.0',
        disconnect: async () => {},
      },
      'standard:events': {
        version: '1.0.0',
        on: _on,
      },

      // ── Sui-specific features ────────────────────────────────────────────
      'sui:signTransaction': {
        version: '2.0.0',
        signTransaction: async ({ transaction }) => {
          // transaction is a @mysten/sui Transaction instance from the dApp bundle.
          // Serialize to JSON and hand off to the Node.js signing bridge.
          const txJSON = transaction.toJSON();
          return await window.__pw_sign_transaction(txJSON);
        },
      },

      'sui:signAndExecuteTransaction': {
        version: '2.0.0',
        signAndExecuteTransaction: async ({ transaction }) => {
          const txJSON = transaction.toJSON();
          return await window.__pw_sign_and_execute(txJSON);
        },
      },

      'sui:signPersonalMessage': {
        version: '1.0.0',
        signPersonalMessage: async ({ message }) => {
          // message is Uint8Array; encode to base64 for JSON transport
          const b64 = btoa(String.fromCharCode(...message));
          return await window.__pw_sign_message(b64);
        },
      },
    },
  };

  // ── Registration via Wallet Standard ──────────────────────────────────────
  // Robust multi-pattern registration to handle any timing scenario.
  
  // Initialize the global wallets registry if it doesn't exist yet.
  // This is the canonical storage used by @wallet-standard/app.
  if (!window.__suiWallets) {
    window.__suiWallets = [];
  }
  
  // Pattern 1: Direct registration into the global registry (earliest possible).
  window.__suiWallets.push(_wallet);
  console.log('[Playwright Wallet] Registered in __suiWallets:', _wallet.name);

  // Pattern 2: Dispatch register-wallet event (for apps already listening).
  window.dispatchEvent(
    new CustomEvent('wallet-standard:register-wallet', {
      detail: {
        register(callback) {
          callback(_wallet);
        },
      },
    })
  );
  console.log('[Playwright Wallet] Dispatched wallet-standard:register-wallet');

  // Pattern 3: Listen for app-ready event (for apps that initialize later).
  window.addEventListener('wallet-standard:app-ready', ({ detail }) => {
    detail.register(_wallet);
    console.log('[Playwright Wallet] Registered via wallet-standard:app-ready');
  });

  // Pattern 4: Also register in the legacy window.suiWallet for older dApps.
  if (!window.suiWallet) {
    window.suiWallet = _wallet;
    console.log('[Playwright Wallet] Registered as window.suiWallet (legacy)');
  }
})();`;
}
