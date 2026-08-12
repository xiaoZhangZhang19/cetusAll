/**
 * 可编排功能清单。
 *
 * 数据源是同目录下的 catalog.json，dashboard 也直接读取该 JSON，
 * 保证前后端只有一份清单，新增 spec 时只改 JSON 一处。
 * id 与 validation-suite/e2e 下的文件名（去掉 .spec.ts）保持一致。
 */

import path from 'node:path';

import catalogJson from './catalog.json' with { type: 'json' };
import type { CatalogItem, ResourceContract } from './types.js';

/** [id, 展示名, 资源契约?]，第三项省略表示该用例无依赖关系 */
type ItemTuple = [string, string] | [string, string, ResourceContract];

interface GroupDef {
  group: string;
  groupLabel: string;
  icon?: string;
  items: ItemTuple[];
}

export const E2E_DIR = 'validation-suite/e2e';

// JSON 导入会被推断成宽泛的数组类型而非元组，需经 unknown 收窄
const catalogData = catalogJson as unknown as {
  resources?: Record<string, string>;
  groups: GroupDef[];
};

const GROUPS = catalogData.groups;

/** 资源名 → 中文展示名。面向用户的输出一律用它，避免暴露 clmm.position 这类内部名 */
export const RESOURCE_LABELS: Readonly<Record<string, string>> = catalogData.resources ?? {};

export function resourceLabel(resource: string): string {
  return RESOURCE_LABELS[resource] ?? resource;
}

export const CATALOG: readonly CatalogItem[] = GROUPS.flatMap((g) =>
  g.items.map(([id, name, contract]) => ({
    id,
    name,
    group: g.group,
    groupLabel: g.groupLabel,
    spec: path.posix.join(E2E_DIR, `${id}.spec.ts`),
    ...(contract ?? {})
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
