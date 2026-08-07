/**
 * 串联执行命令行入口。
 *
 * 用法：
 *   npm run flow -- list                            列出所有可编排功能
 *   npm run flow -- flows                           列出已保存的流程模板
 *   npm run flow -- run <模板名|文件路径> [--dry-run]  执行流程模板
 *   npm run flow -- run-ids <id1,id2,...> [--dry-run] 临时按 id 顺序执行
 *   npm run flow -- save <模板名> <id1,id2,...> [--desc "说明"] [--delay 5000]
 */

import { CATALOG, listGroups } from './catalog.js';
import { buildFlowFromIds, listFlowNames, loadFlow, saveFlow } from './flow-store.js';
import { runFlow } from './runner.js';

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }

  return { command, positionals, flags };
}

function splitIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function toNumber(value: string | boolean | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function cmdList(): void {
  console.log(`\n可编排功能共 ${CATALOG.length} 项：\n`);
  for (const group of listGroups()) {
    console.log(`── ${group.groupLabel} (${group.group}) ──`);
    for (const item of group.items) {
      console.log(`   ${item.id.padEnd(34)} ${item.name}`);
    }
    console.log('');
  }
  console.log('提示：用 id 组合成流程，例如');
  console.log('   npm run flow -- run-ids clmm-open-position,farm-stake,farm-claim\n');
}

function cmdFlows(): void {
  const names = listFlowNames();
  if (names.length === 0) {
    console.log('\n当前没有已保存的流程模板。用 save 命令创建：');
    console.log('   npm run flow -- save 我的流程 swap,limit-order --desc "说明"\n');
    return;
  }
  console.log(`\n已保存的流程模板（${names.length} 个）：\n`);
  for (const name of names) {
    const flow = loadFlow(name);
    const enabled = flow.steps.filter((s) => !s.disabled).length;
    console.log(`── ${flow.name}`);
    if (flow.description) console.log(`   说明：${flow.description}`);
    console.log(`   步骤：${enabled}/${flow.steps.length} 启用 → ${flow.steps.map((s) => s.id).join(' → ')}`);
    console.log('');
  }
}

function cmdSave(args: ParsedArgs): void {
  const [name, idsRaw] = args.positionals;
  if (!name || !idsRaw) {
    throw new Error('用法：npm run flow -- save <模板名> <id1,id2,...> [--desc "说明"] [--delay 5000]');
  }
  const flow = buildFlowFromIds(name, splitIds(idsRaw), {
    description: typeof args.flags.desc === 'string' ? args.flags.desc : undefined,
    continueOnFailure: args.flags['stop-on-failure'] !== true,
    delayMs: toNumber(args.flags.delay)
  });
  const target = saveFlow(flow);
  console.log(`\n✅ 流程模板已保存：${target}`);
  console.log(`   执行：npm run flow -- run ${flow.name}\n`);
}

async function cmdRun(args: ParsedArgs): Promise<number> {
  const [nameOrPath] = args.positionals;
  if (!nameOrPath) {
    throw new Error('用法：npm run flow -- run <模板名|文件路径> [--dry-run]');
  }
  const flow = loadFlow(nameOrPath);
  const result = await runFlow(flow, {
    dryRun: args.flags['dry-run'] === true,
    verbose: args.flags.quiet !== true,
    emitMarkers: args.flags['emit-markers'] === true
  });
  return result.failed > 0 ? 1 : 0;
}

async function cmdRunIds(args: ParsedArgs): Promise<number> {
  const ids = splitIds(args.positionals[0]);
  if (ids.length === 0) {
    throw new Error('用法：npm run flow -- run-ids <id1,id2,...> [--dry-run]');
  }
  const flow = buildFlowFromIds('临时流程', ids, {
    description: '由 run-ids 命令临时生成，未保存',
    continueOnFailure: args.flags['stop-on-failure'] !== true,
    delayMs: toNumber(args.flags.delay)
  });
  const result = await runFlow(flow, {
    dryRun: args.flags['dry-run'] === true,
    verbose: args.flags.quiet !== true,
    emitMarkers: args.flags['emit-markers'] === true
  });
  return result.failed > 0 ? 1 : 0;
}

/** 输出 JSON 供 dashboard 等外部调用方消费 */
function cmdCatalogJson(): void {
  console.log(JSON.stringify({ groups: listGroups(), total: CATALOG.length }));
}

function cmdHelp(): void {
  console.log(`
Cetus 串联执行（Flow Orchestrator）

  npm run flow -- list
      列出所有可编排功能及其 id

  npm run flow -- flows
      列出已保存的流程模板

  npm run flow -- run <模板名|文件路径> [--dry-run] [--quiet]
      按模板顺序串联执行

  npm run flow -- run-ids <id1,id2,...> [--dry-run] [--delay 5000]
      临时按 id 顺序串联执行，不保存模板

  npm run flow -- save <模板名> <id1,id2,...> [--desc "说明"] [--delay 5000]
      保存流程模板，之后可用 run 重复执行

公共可选参数
  --dry-run           只打印执行计划，不真正执行
  --stop-on-failure   某步失败后立即中断（默认失败继续跑完）
  --delay <ms>        步骤之间的等待毫秒数，用于等待链上索引
  --quiet             不透传子进程日志到控制台（仍会落盘）
  --emit-markers      额外输出 ##FLOW_*## 进度标记，供 dashboard 解析

其它
  npm run flow -- catalog-json
      以 JSON 输出功能清单，供 dashboard 等外部调用方消费
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'list':
      cmdList();
      break;
    case 'catalog-json':
      cmdCatalogJson();
      break;
    case 'flows':
      cmdFlows();
      break;
    case 'save':
      cmdSave(args);
      break;
    case 'run':
      process.exitCode = await cmdRun(args);
      break;
    case 'run-ids':
      process.exitCode = await cmdRunIds(args);
      break;
    default:
      cmdHelp();
      break;
  }
}

main().catch((error: unknown) => {
  console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
