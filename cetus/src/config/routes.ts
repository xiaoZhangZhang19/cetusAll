/**
 * Cetus Aggregator 路由常量定义
 *
 * 数据来源：Aggregator Settings 弹窗实际截图确认（28/28 共 28 条路由 + Other 新增 Bolt = 29 条）
 *
 * 结构说明：
 *   - Dex:          18 条（含子路由协议）
 *   - Other:         7 条（新增 Bolt）
 *   - Oracle-based:  3 条
 *
 * 带子路由的协议（UI 展示 "N/N ▼"）：
 *   Cetus    3/3 → CLMM, DLMM, Cetus Tide（注：Cetus 为锁定协议，不可单独取消）
 *   Kriya    2/2 → Kriya V2, Kriya V3
 *   FlowX    2/2 → FlowX V2, FlowX V3
 *   Magma    2/2 → Magma PropAMM, Magma CLMM
 *   Ferra    2/2 → Ferra CLMM, Ferra DLMM
 *   Haedal   2/2 → Haedal HMM, Haedal Prop（Oracle-based）
 *
 * 无子路由协议（直接勾选卡片）：
 *   DeepBook V3, Aftermath, Turbos, Bluefin, Obric, Momentum, Full Sail
 *   Haedal LSD, Volo, Aftermath LSD, Scallop, SpringSui, stSUI, Bolt
 *   STEAMM OMM
 */

// ── Dex 子路由 ──────────────────────────────────────────────────────────────

export const CETUS_SUB_ROUTES = [
  // Cetus 3/3
  'CLMM',
  'DLMM',
  'Cetus Tide',
  // Kriya 2/2
  'Kriya V2',
  'Kriya V3',
  // FlowX 2/2
  'FlowX V2',
  'FlowX V3',
  // Magma 2/2
  'Magma PropAMM',
  'Magma CLMM',
  // Ferra 2/2
  'Ferra CLMM',
  'Ferra DLMM',
  // Haedal 2/2 (Oracle-based)
  'Haedal HMM',
  'Haedal Prop',
] as const;

// ── 所有可独立选择的路由（29 条）──────────────────────────────────────────

export const CETUS_ROUTES = [
  // ── Dex（含展开后的子路由）──────────────────────────────
  'CLMM',
  'DLMM',
  'Cetus Tide',
  'DeepBook V3',
  'Kriya V2',
  'Kriya V3',
  'FlowX V2',
  'FlowX V3',
  'Aftermath',
  'Turbos',
  'Bluefin',
  'Obric',
  'Momentum',
  'Magma PropAMM',
  'Magma CLMM',
  'Full Sail',
  'Ferra CLMM',
  'Ferra DLMM',

  // ── Other ──────────────────────────────────────────────
  'Haedal LSD',
  'Volo',
  'Aftermath LSD',
  'Scallop',
  'SpringSui',
  'stSUI',
  'Bolt',

  // ── Oracle-based ───────────────────────────────────────
  'Haedal HMM',
  'Haedal Prop',
  'STEAMM OMM',
] as const;

export type CetusRoute = typeof CETUS_ROUTES[number];

/**
 * 带子路由的协议映射：父协议名称 → 子路由列表
 * 用于 selectCetusRoutes() 判断是否需要展开父协议
 */
export const PARENT_ROUTE_MAP: Record<string, readonly string[]> = {
  'Cetus':  ['CLMM', 'DLMM', 'Cetus Tide'] as const,
  'Kriya':  ['Kriya V2', 'Kriya V3'] as const,
  'FlowX':  ['FlowX V2', 'FlowX V3'] as const,
  'Magma':  ['Magma PropAMM', 'Magma CLMM'] as const,
  'Ferra':  ['Ferra CLMM', 'Ferra DLMM'] as const,
  'Haedal': ['Haedal HMM', 'Haedal Prop'] as const,  // Oracle-based
};

/**
 * 子路由 → 父协议的反向映射
 */
export const CHILD_TO_PARENT_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(PARENT_ROUTE_MAP).flatMap(([parent, children]) =>
    children.map((child) => [child, parent])
  )
);

/**
 * 注意：Cetus 协议被锁定（卡片显示🔒），不可单独取消选中。
 * 测试时如需"仅测试单条非 Cetus 路由"，需要先全部关闭再只开目标路由。
 */
export const LOCKED_PROTOCOLS = ['Cetus'] as const;
