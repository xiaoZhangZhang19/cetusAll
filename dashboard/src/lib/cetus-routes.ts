/**
 * Cetus Aggregator 路由名称获取。
 *
 * 路由列表由 router_v3/status 接口动态决定（会随线上开关变化），
 * 网络失败时降级到 lib/tests.ts 里的静态列表。
 */

import { CETUS_ROUTES } from '@/lib/tests';

/** provider key → 展示名称，与 Aggregator Settings 弹窗保持一致 */
export const PROVIDER_DISPLAY_NAME: Record<string, string> = {
  CETUS: 'CLMM',
  CETUSDLMM: 'DLMM',
  CETUS_TIDE: 'Cetus Tide',
  DEEPBOOKV3: 'DeepBook V3',
  KRIYA: 'Kriya V2',
  KRIYAV3: 'Kriya V3',
  FLOWX: 'FlowX V2',
  FLOWXV3: 'FlowX V3',
  AFTERMATH: 'Aftermath',
  TURBOS: 'Turbos',
  BLUEFIN: 'Bluefin',
  BLUEMOVE: 'BlueMove',
  OBRIC: 'Obric',
  MOMENTUM: 'Momentum',
  MAGMA: 'Magma CLMM',
  MAGMAPROPAMM: 'Magma PropAMM',
  FERRACLMM: 'Ferra CLMM',
  FERRADLMM: 'Ferra DLMM',
  FULLSAIL: 'Full Sail',
  SEVENK: '7K Spot',
  HAEDAL: 'Haedal LSD',
  HAWAL: 'Haedal LSD',
  HAEDALPROPAMM: 'Haedal Prop',
  HAEDALPMM: 'Haedal HMM',
  HAEDALHMMV2: 'Haedal HMM',
  VOLO: 'Volo',
  AFSUI: 'Aftermath LSD',
  SCALLOP: 'Scallop',
  SPRINGSUI: 'SpringSui',
  ALPHAFI: 'stSUI',
  BOLT: 'Bolt',
  STEAMM: 'STEAMM CPMM',
  STEAMM_OMM_V2: 'STEAMM OMM',
  METASTABLE: 'Metastable',
};

export const ROUTER_STATUS_API = 'https://api-sui.cetus.zone/router_v3/status';

/** 拉取可用路由展示名列表（去重）；失败时返回静态列表 */
export async function fetchRouteNames(): Promise<string[]> {
  try {
    const res = await fetch(ROUTER_STATUS_API);
    const json = (await res.json()) as { code: number; data?: { providers?: string[] } };
    const providers = json?.data?.providers ?? [];
    if (providers.length > 0) {
      const seen = new Set<string>();
      return providers
        .map((p) => PROVIDER_DISPLAY_NAME[p] ?? p)
        .filter((name) => {
          if (seen.has(name)) return false;
          seen.add(name);
          return true;
        });
    }
  } catch {
    // 网络失败时降级到静态列表
  }
  return [...CETUS_ROUTES];
}
