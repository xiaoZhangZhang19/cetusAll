import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

import type { FlowCatalogGroup } from '@/lib/flow';

/**
 * 读取 cetus 侧的功能清单（catalog.json）。
 * 该文件是前后端唯一数据源，dashboard 不缓存副本。
 */
const CATALOG_PATH = path.resolve(
  process.cwd(),
  '..',
  'cetus',
  'validation-suite',
  'orchestrator',
  'catalog.json',
);

const E2E_DIR = 'validation-suite/e2e';

// 需要在请求时读磁盘，禁止构建期静态预渲染
export const dynamic = 'force-dynamic';

interface RawGroup {
  group: string;
  groupLabel: string;
  icon?: string;
  items: [string, string][];
}

export async function GET() {
  try {
    const raw = await fs.readFile(CATALOG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as { groups: RawGroup[] };

    const groups: FlowCatalogGroup[] = parsed.groups.map((g) => ({
      group: g.group,
      groupLabel: g.groupLabel,
      icon: g.icon,
      items: g.items.map(([id, name]) => ({
        id,
        name,
        group: g.group,
        groupLabel: g.groupLabel,
        spec: `${E2E_DIR}/${id}.spec.ts`,
      })),
    }));

    const total = groups.reduce((sum, g) => sum + g.items.length, 0);
    return NextResponse.json({ groups, total });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[flow/catalog] 读取功能清单失败:', message);
    return NextResponse.json(
      { error: `读取功能清单失败: ${message}` },
      { status: 500 },
    );
  }
}
