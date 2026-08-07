/**
 * 可编排功能清单。
 *
 * 数据源是同目录下的 catalog.json，dashboard 也直接读取该 JSON，
 * 保证前后端只有一份清单，新增 spec 时只改 JSON 一处。
 * id 与 validation-suite/e2e 下的文件名（去掉 .spec.ts）保持一致。
 */

import path from 'node:path';

import catalogJson from './catalog.json' with { type: 'json' };
import type { CatalogItem } from './types.js';

interface GroupDef {
  group: string;
  groupLabel: string;
  icon?: string;
  items: [string, string][];
}

export const E2E_DIR = 'validation-suite/e2e';

const GROUPS = (catalogJson as { groups: GroupDef[] }).groups;

export const CATALOG: readonly CatalogItem[] = GROUPS.flatMap((g) =>
  g.items.map(([id, name]) => ({
    id,
    name,
    group: g.group,
    groupLabel: g.groupLabel,
    spec: path.posix.join(E2E_DIR, `${id}.spec.ts`)
  }))
);

const CATALOG_INDEX = new Map(CATALOG.map((item) => [item.id, item]));

export function findCatalogItem(id: string): CatalogItem | undefined {
  return CATALOG_INDEX.get(id);
}

export function listGroups(): {
  group: string;
  groupLabel: string;
  icon?: string;
  items: CatalogItem[];
}[] {
  return GROUPS.map((g) => ({
    group: g.group,
    groupLabel: g.groupLabel,
    icon: g.icon,
    items: CATALOG.filter((item) => item.group === g.group)
  }));
}
