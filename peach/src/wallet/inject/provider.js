// 在页面加载前注入的假钱包（"E2E Wallet"）。它不持有私钥，也不做签名：
// 所有需要私钥的方法都通过 window.__walletBridge（Playwright exposeBinding）
// 转交 Node 进程，由 ethers 用私钥处理；其余方法当作普通 RPC 透传。
//
// 这样做的好处：不装浏览器插件、没有审批弹窗、不需要在页面里打包 ethers，
// 而前端拿到的仍然是一个行为正常的 EIP-1193 注入式 provider。
//
// 注意：本文件是纯 JS，运行时被 readFile 成字符串喂给 context.addInitScript()，
// 不参与 TypeScript 编译，因此不要在这里写任何 TS 语法或 import。
(() => {
  const cfg = window.__WALLET_CONFIG__;
  const listeners = new Map();

  const call = (method, params) =>
    window.__walletBridge({ method, params: params ?? [] }).then((res) => {
      if (res && res.__error) {
        const err = new Error(res.message || 'wallet error');
        err.code = res.code ?? 4001;
        err.data = res.data;
        throw err;
      }
      return res;
    });

  const permission = () => [
    {
      parentCapability: 'eth_accounts',
      caveats: [{ type: 'restrictReturnedAccounts', value: [cfg.address] }],
    },
  ];

  // 只答应切到我们真正配置好的那条链。
  //
  // 这里不能无脑返回 null：前端会据此认为切链成功并继续用新 chainId 组装交易，
  // 而 Node 侧的 signer 仍绑在原链上，结果是「界面显示正常但签出的交易链不对」。
  // 抛 4902（unrecognized chain）能让配置错误立刻暴露出来。
  const switchChain = (params) => {
    const requested = params?.[0]?.chainId;
    if (!requested) return null;
    if (String(requested).toLowerCase() === cfg.chainIdHex.toLowerCase()) return null;
    const err = new Error(
      `E2E Wallet 只配置了 chainId ${cfg.chainId} (${cfg.chainIdHex})，` +
      `前端请求切换到 ${requested}。请把 E2E_CHAIN_ID / E2E_RPC_URL 改成目标链。`,
    );
    err.code = 4902;
    throw err;
  };

  // 本地即可答复的方法，省掉一次 bridge 往返
  const local = {
    eth_chainId: () => cfg.chainIdHex,
    net_version: () => String(cfg.chainId),
    // 返回非空数组即代表"这个 dApp 已被授权"，AppKit / wagmi 据此自动恢复连接，
    // 所以每个全新 context 天生就是已连接状态，不需要持久化 profile。
    eth_accounts: () => [cfg.address],
    eth_requestAccounts: () => [cfg.address],
    eth_coinbase: () => cfg.address,
    wallet_switchEthereumChain: switchChain,
    wallet_addEthereumChain: () => null,
    wallet_revokePermissions: () => null,
    wallet_requestPermissions: permission,
    wallet_getPermissions: permission,
    wallet_watchAsset: () => true,
  };

  const provider = {
    // 部分前端只在 isMetaMask 为真时才走注入式分支，这里保持兼容
    isMetaMask: true,
    isConnected: () => true,
    chainId: cfg.chainIdHex,
    networkVersion: String(cfg.chainId),
    selectedAddress: cfg.address,
    _metamask: { isUnlocked: async () => true },

    async request({ method, params }) {
      if (method in local) return local[method](params);
      return call(method, params);
    },

    // 老式回调接口，个别库仍在用
    sendAsync(payload, cb) {
      this.request(payload).then(
        (result) => cb(null, { id: payload.id, jsonrpc: '2.0', result }),
        (error) => cb(error),
      );
    },
    send(payload, cb) {
      if (typeof cb === 'function') return this.sendAsync(payload, cb);
      return this.request(typeof payload === 'string' ? { method: payload, params: cb } : payload);
    },

    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return provider;
    },
    removeListener(event, handler) {
      listeners.get(event)?.delete(handler);
      return provider;
    },
    once(event, handler) {
      const wrapped = (...args) => { provider.removeListener(event, wrapped); handler(...args); };
      return provider.on(event, wrapped);
    },
    emit(event, ...args) {
      listeners.get(event)?.forEach((fn) => { try { fn(...args); } catch { /* 忽略消费者异常 */ } });
    },
  };

  // 经典注入点。用 defineProperty 防止真钱包或前端把它覆盖掉。
  try {
    Object.defineProperty(window, 'ethereum', {
      value: provider, writable: false, configurable: true,
    });
  } catch { window.ethereum = provider; }
  window.__E2E_WALLET__ = provider;

  // EIP-6963：Reown AppKit / wagmi / RainbowKit 等现代连接器优先走这条发现协议。
  // peach 前端用的是 AppKit（页面里有 w3m-modal），只挂 window.ethereum 不够。
  const detail = Object.freeze({
    info: {
      uuid: cfg.uuid,
      name: 'E2E Wallet',
      icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
      rdns: 'org.e2e.wallet',
    },
    provider,
  });
  const announce = () =>
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));

  window.addEventListener('eip6963:requestProvider', announce);
  announce();
})();
