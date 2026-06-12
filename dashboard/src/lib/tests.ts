export interface TestCase {
  id: string;
  name: string;
  description: string;
  script: string;       // npm script name in QA project
  priority: 'P0' | 'P1' | 'P2';
  tags: string[];
  estimatedSeconds: number;
}

export interface TestGroup {
  id: string;
  name: string;
  icon: string;
  color: string;       // Tailwind bg color class
  borderColor: string; // Tailwind border color class
  tests: TestCase[];
}

export const TEST_GROUPS: TestGroup[] = [
  {
    id: 'swap',
    name: 'Swap 兑换',
    icon: '🔄',
    color: 'bg-slate-800',
    borderColor: 'border-slate-600',
    tests: [
      { id: 'swap', name: '正常兑换', description: '执行 SUI→USDC 兑换，验证链上余额变化', script: 'test:e2e:swap', priority: 'P0', tags: ['swap', 'mainnet'], estimatedSeconds: 90 },
      { id: 'swap-route', name: '路由验证', description: '验证 Auto Router 路由展示', script: 'test:e2e:swap:route', priority: 'P1', tags: ['swap', 'router'], estimatedSeconds: 45 },
      { id: 'swap-balance', name: '余额不足', description: '验证余额不足时的提示', script: 'test:e2e:swap:balance', priority: 'P0', tags: ['swap', 'negative'], estimatedSeconds: 20 },
      { id: 'swap-precision', name: '精度测试', description: '验证不同精度代币交换计算', script: 'test:e2e:swap:precision', priority: 'P1', tags: ['swap', 'precision'], estimatedSeconds: 50 },
      { id: 'swap-impact', name: '高价格冲击', description: '验证大额交易的高价格冲击警告', script: 'test:e2e:swap:impact', priority: 'P1', tags: ['swap', 'impact'], estimatedSeconds: 50 },
      { id: 'swap-dust', name: '尘埃金额', description: '验证极小金额交换拦截', script: 'test:e2e:swap:dust', priority: 'P2', tags: ['swap', 'edge'], estimatedSeconds: 30 },
      { id: 'swap-degradation', name: '路由降级', description: '验证路由 API 失败时降级逻辑', script: 'test:e2e:swap:degradation', priority: 'P1', tags: ['swap', 'router'], estimatedSeconds: 60 },
      { id: 'swap-slippage-warning', name: 'Slippage 警告', description: '验证高 slippage 时警告展示', script: 'test:e2e:swap:slippage:warning', priority: 'P1', tags: ['swap', 'slippage'], estimatedSeconds: 30 },
      { id: 'swap-slippage-0.01', name: '0.01% Slippage', description: '验证 0.01% 最低滑点保护', script: 'test:e2e:swap:slippage:0.01', priority: 'P2', tags: ['swap', 'slippage'], estimatedSeconds: 50 },
      { id: 'swap-rejection', name: '拒绝交易', description: '钱包拒绝后验证 UI 状态回滚', script: 'test:e2e:swap:rejection', priority: 'P1', tags: ['swap', 'negative'], estimatedSeconds: 45 },
      { id: 'merge-swap', name: 'Merge Swap', description: '双输入合并交换功能', script: 'test:e2e:merge-swap', priority: 'P1', tags: ['swap', 'merge'], estimatedSeconds: 80 },
    ],
  },
  {
    id: 'limit',
    name: 'Limit Order 限价单',
    icon: '📋',
    color: 'bg-slate-800',
    borderColor: 'border-slate-600',
    tests: [
      { id: 'limit', name: '下单 (95% 市价)', description: '以市价 95% 挂限价单，验证 Open Orders 和余额变化', script: 'test:e2e:limit', priority: 'P0', tags: ['limit', 'mainnet'], estimatedSeconds: 60 },
      { id: 'limit-market', name: '市价下单', description: '以当前市价创建限价单', script: 'test:e2e:limit:market', priority: 'P0', tags: ['limit'], estimatedSeconds: 55 },
      { id: 'limit-below', name: '低于市价 10%', description: '以市价 90% 挂单，验证挂单状态', script: 'test:e2e:limit:below', priority: 'P1', tags: ['limit'], estimatedSeconds: 55 },
      { id: 'limit-cancel', name: '取消订单', description: '取消现有 Open Order', script: 'test:e2e:limit:cancel', priority: 'P0', tags: ['limit', 'cancel'], estimatedSeconds: 50 },
      { id: 'limit-history', name: 'Order History', description: '验证历史订单记录字段', script: 'test:e2e:limit:history', priority: 'P1', tags: ['limit', 'history'], estimatedSeconds: 180 },
      { id: 'limit-insufficient', name: '余额不足拦截', description: '输入超额金额，验证前端 Insufficient 提示', script: 'test:e2e:limit:insufficient', priority: 'P0', tags: ['limit', 'negative'], estimatedSeconds: 25 },
      { id: 'limit-zero', name: 'Rate=0 拦截', description: '设置 rate 为 0，验证按钮置灰', script: 'test:e2e:limit:0', priority: 'P1', tags: ['limit', 'negative'], estimatedSeconds: 20 },
      { id: 'limit-connect', name: '未连接钱包', description: '验证未连接钱包时显示 Connect Wallet', script: 'test:e2e:limit:connect', priority: 'P0', tags: ['limit', 'auth'], estimatedSeconds: 15 },
      { id: 'limit-reject', name: '拒绝签名', description: '在钱包弹窗中拒绝，验证订单未创建', script: 'test:e2e:limit:reject', priority: 'P1', tags: ['limit', 'negative'], estimatedSeconds: 45 },
      { id: 'limit-expiry', name: '1分钟到期', description: '设置 1 分钟自定义到期，验证到期后消失', script: 'test:e2e:limit:expiry', priority: 'P1', tags: ['limit', 'expiry'], estimatedSeconds: 180 },
      { id: 'limit-ui', name: 'UI 交互验证', description: '验证初始状态/余额/HALF-MAX/代币切换/到期下拉', script: 'test:e2e:limit:ui', priority: 'P1', tags: ['limit', 'ui'], estimatedSeconds: 60 },
    ],
  },
  {
    id: 'dca',
    name: 'DCA 定投',
    icon: '📈',
    color: 'bg-slate-800',
    borderColor: 'border-slate-600',
    tests: [
      { id: 'dca-total', name: 'Total 模式下单', description: '以总额模式创建 DCA 订单', script: 'test:e2e:dca:total', priority: 'P0', tags: ['dca'], estimatedSeconds: 60 },
      { id: 'dca-per-order', name: 'Per Order 模式', description: '以单次模式创建 DCA 订单', script: 'test:e2e:dca:per-order', priority: 'P0', tags: ['dca'], estimatedSeconds: 60 },
      { id: 'dca-close', name: '关闭订单', description: '关闭现有 DCA 活跃订单', script: 'test:e2e:dca:close', priority: 'P1', tags: ['dca', 'cancel'], estimatedSeconds: 50 },
    ],
  },
  {
    id: 'clmm',
    name: 'CLMM 流动性',
    icon: '💧',
    color: 'bg-slate-800',
    borderColor: 'border-slate-600',
    tests: [
      { id: 'clmm-open', name: '开仓', description: '在 CLMM 池开设流动性仓位', script: 'test:e2e:clmm:open', priority: 'P0', tags: ['clmm'], estimatedSeconds: 90 },
      { id: 'clmm-add', name: '增加流动性', description: '向现有仓位添加流动性', script: 'test:e2e:clmm:add', priority: 'P1', tags: ['clmm'], estimatedSeconds: 70 },
      { id: 'clmm-create', name: '创建池子', description: '创建新的 CLMM 流动性池', script: 'test:e2e:clmm:create', priority: 'P2', tags: ['clmm', 'create'], estimatedSeconds: 100 },
      { id: 'clmm-claim', name: '领取奖励', description: '领取 CLMM 仓位奖励', script: 'test:e2e:clmm:claim', priority: 'P1', tags: ['clmm', 'reward'], estimatedSeconds: 60 },
      { id: 'clmm-zap', name: 'Zap In', description: '单币 Zap 进入流动性仓位', script: 'test:e2e:clmm:zap', priority: 'P1', tags: ['clmm', 'zap'], estimatedSeconds: 80 },
      { id: 'clmm-zap-increase', name: 'Zap 加仓', description: '单币 Zap 增加现有仓位', script: 'test:e2e:clmm:zap:increase', priority: 'P2', tags: ['clmm', 'zap'], estimatedSeconds: 80 },
      { id: 'clmm-zap-out', name: 'Zap Out', description: '移除流动性并转换为单币', script: 'test:e2e:clmm:zap:out', priority: 'P2', tags: ['clmm', 'zap'], estimatedSeconds: 80 },
      { id: 'clmm-remove', name: '移除流动性', description: '从仓位移除流动性', script: 'test:e2e:clmm:remove', priority: 'P1', tags: ['clmm'], estimatedSeconds: 70 },
    ],
  },
  {
    id: 'dlmm',
    name: 'DLMM 流动性',
    icon: '💎',
    color: 'bg-slate-800',
    borderColor: 'border-slate-600',
    tests: [
      { id: 'dlmm-open', name: '开仓', description: '在 DLMM 池开设流动性仓位', script: 'test:e2e:dlmm:open', priority: 'P0', tags: ['dlmm'], estimatedSeconds: 90 },
      { id: 'dlmm-add', name: '增加流动性', description: '向现有仓位添加流动性', script: 'test:e2e:dlmm:add', priority: 'P1', tags: ['dlmm'], estimatedSeconds: 70 },
      { id: 'dlmm-create', name: '创建池子', description: '创建新的 DLMM 流动性池', script: 'test:e2e:dlmm:create', priority: 'P2', tags: ['dlmm', 'create'], estimatedSeconds: 100 },
      { id: 'dlmm-claim', name: '领取奖励', description: '领取 DLMM 仓位奖励', script: 'test:e2e:dlmm:claim', priority: 'P1', tags: ['dlmm', 'reward'], estimatedSeconds: 60 },
      { id: 'dlmm-zap', name: 'Zap In', description: '单币 Zap 进入流动性仓位', script: 'test:e2e:dlmm:zap', priority: 'P1', tags: ['dlmm', 'zap'], estimatedSeconds: 80 },
      { id: 'dlmm-zap-increase', name: 'Zap 加仓', description: '单币 Zap 增加现有仓位', script: 'test:e2e:dlmm:zap:increase', priority: 'P2', tags: ['dlmm', 'zap'], estimatedSeconds: 80 },
      { id: 'dlmm-zap-out', name: 'Zap Out', description: '移除流动性并转换为单币', script: 'test:e2e:dlmm:zap:out', priority: 'P2', tags: ['dlmm', 'zap'], estimatedSeconds: 80 },
      { id: 'dlmm-remove', name: '移除流动性', description: '从仓位移除流动性', script: 'test:e2e:dlmm:remove', priority: 'P1', tags: ['dlmm'], estimatedSeconds: 70 },
    ],
  },
  {
    id: 'margin',
    name: 'Margin 杠杆',
    icon: '⚡',
    color: 'bg-slate-800',
    borderColor: 'border-slate-600',
    tests: [
      { id: 'margin-open-long', name: '开多仓', description: '开设杠杆多头仓位', script: 'test:e2e:margin:open:long', priority: 'P0', tags: ['margin', 'long'], estimatedSeconds: 90 },
      { id: 'margin-open-short', name: '开空仓', description: '开设杠杆空头仓位', script: 'test:e2e:margin:open:short', priority: 'P0', tags: ['margin', 'short'], estimatedSeconds: 90 },
      { id: 'margin-close', name: '平仓', description: '关闭杠杆仓位', script: 'test:e2e:margin:close', priority: 'P0', tags: ['margin', 'close'], estimatedSeconds: 70 },
    ],
  },
  {
    id: 'deepbook',
    name: 'DeepBook',
    icon: '📖',
    color: 'bg-slate-800',
    borderColor: 'border-slate-600',
    tests: [
      { id: 'deepbook-buy', name: '现货买入', description: 'DeepBook 现货买入订单', script: 'test:e2e:deepbook:spot:buy', priority: 'P0', tags: ['deepbook', 'spot'], estimatedSeconds: 60 },
      { id: 'deepbook-sell', name: '现货卖出', description: 'DeepBook 现货卖出订单', script: 'test:e2e:deepbook:spot:sell', priority: 'P0', tags: ['deepbook', 'spot'], estimatedSeconds: 60 },
      { id: 'deepbook-insufficient', name: '余额不足', description: 'DeepBook 余额不足拦截', script: 'test:e2e:deepbook:spot:insufficient', priority: 'P1', tags: ['deepbook', 'negative'], estimatedSeconds: 30 },
      { id: 'deepbook-limit', name: '限价单', description: 'DeepBook 限价单下单', script: 'test:e2e:deepbook:limit', priority: 'P1', tags: ['deepbook', 'limit'], estimatedSeconds: 70 },
      { id: 'deepbook-cancel-all', name: '批量取消', description: 'DeepBook 取消所有订单', script: 'test:e2e:deepbook:limit:cancel-all', priority: 'P1', tags: ['deepbook', 'cancel'], estimatedSeconds: 60 },
    ],
  },
];

export function findTestById(id: string): TestCase | undefined {
  for (const group of TEST_GROUPS) {
    const found = group.tests.find((t) => t.id === id);
    if (found) return found;
  }
  return undefined;
}

// ── Peach Protocol ────────────────────────────────────────────────────────────

export const PEACH_ROUTES = [
  'Uniswap V2',
  'Uniswap V3',
  'Uniswap V4',
  'PancakeSwap V1',
  'PancakeSwap V2',
  'PancakeSwap V3',
  'PancakeSwap Stable',
  'PancakeSwap Infinity CL',
  'PancakeSwap Infinity LBAMM',
  'Thena V3',
  'Thena Fusion',
  'Lista Stable',
  'SushiSwap V2',
  'SushiSwap V3',
  'DODO',
  'Nomiswap Stable',
  'BiSwap',
  'ApeSwap',
  'BabySwap',
  'SquadSwap V2',
  'SquadSwap V3',
  'Wombat',
  'BakerySwap',
  'BabyDogeSwap',
] as const;

export type PeachRoute = (typeof PEACH_ROUTES)[number];

/** Peach swap test cases — source of truth for case count */
export const PEACH_SWAP_TESTS = [
  { id: 'peach-swap',         name: '多路由兑换',       priority: 'P0' as const, description: '选择指定流动性路由，执行真实链上 Swap 交易并验证余额变化' },
  { id: 'peach-route-change', name: '路由数量变化监测', priority: 'P1' as const, description: '输入多个金额，观察 Auto Router 路由数量是否随金额变化' },
  { id: 'peach-slippage',     name: '滑点警告验证',     priority: 'P1' as const, description: '输入三个滑点值，验证对应警告/错误提示文案是否正确展示' },
  { id: 'peach-gas',          name: 'Gas 不足提示验证', priority: 'P1' as const, description: '输入超过余额的金额，验证页面显示 gas 不足警告文案' },
] as const;

/** Peach Limit Order test cases */
export const PEACH_LIMIT_TESTS = [
  {
    id: 'peach-limit',
    name: 'Limit 挂单 P0',
    priority: 'P0' as const,
    description: '以 BNB 数量挂 +5% 限价单，验证 Open Orders 出现并属于本次操作',
  },
  {
    id: 'peach-limit-price-guard',
    name: '不合理价格限制 P0',
    priority: 'P0' as const,
    description: '输入市价 × 94.9% 触发价格保护，验证按钮置灰且显示 "Adjust price to continue"',
  },
  {
    id: 'peach-limit-price-direction',
    name: '价格方向自动判定 P0',
    priority: 'P0' as const,
    description: '输入 50% 市价验证 below（红色），输入 150% 市价验证 above（绿色）',
  },
  {
    id: 'peach-limit-price-mode',
    name: '价格模式联动 P0',
    priority: 'P0' as const,
    description: '+5%/+10% → 验证 rate 换算；输入 rate=100/200 → 验证百分比反算',
  },
] as const;

/** Peach module groups — cases count derived dynamically from tests arrays */
export const PEACH_GROUPS = [
  { id: 'swap',     name: 'Swap 兑换',         tests: PEACH_SWAP_TESTS },
  { id: 'limit',    name: 'Limit 限价单',       tests: PEACH_LIMIT_TESTS },
  { id: 'terminal', name: 'Terminal',  tests: [
    { id: 'peach-terminal', name: 'Top Token Swap 验证', priority: 'P0' as const, description: 'Top-20 代币 swap 验证' },
  ]},
] as const;

/** Peach Terminal test config */
export const PEACH_TERMINAL_CONFIG = {
  script: 'test:e2e:terminal',
  payAmount: '0.0001',       // BNB
  tokenCount: 20,
  usdThreshold: 0.5,         // 50%
} as const;
