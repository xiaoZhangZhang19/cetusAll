/**
 * 串联执行引擎：按顺序逐个启动已有 spec，收集并汇总结果。
 *
 * 设计取舍：
 * - 用子进程逐个跑 `npx playwright test <spec>`，而非在单个会话里复用页面。
 *   现有 spec 的业务逻辑都封闭在 test() 回调内、无导出，进程级串联可以零改动
 *   复用全部用例；且 playwright.config.ts 本身就是 workers:1，串行是既有前提。
 * - 每步日志单独落盘，避免长流程把内存撑爆。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { findCatalogItem } from './catalog.js';
import type { FlowDefinition, FlowRunResult, StepResult } from './types.js';

const MAX_ERROR_LINES = 12;

/** 提取失败原因关键行，供汇总时快速定位 */
const ERROR_PATTERNS = [
  /^\s*\d+\)\s/,
  /Error:/,
  /expect\(.*\)/,
  /Timeout .* exceeded/i,
  /✘|✗|failed/i
];

export interface RunFlowOptions {
  /** 结果与日志输出根目录 */
  outputDir?: string;
  /** 逐行透传子进程输出到控制台 */
  verbose?: boolean;
  /** 只打印执行计划，不真正执行 */
  dryRun?: boolean;
  /**
   * 输出机器可读的进度标记（##FLOW_*##），供 dashboard 等外部调用方解析。
   * 标记与人类可读日志并存，互不影响。
   */
  emitMarkers?: boolean;
}

/** 进度标记前缀，dashboard 侧按此协议解析 */
const MARKER = {
  plan: '##FLOW_PLAN:',
  stepStart: '##FLOW_STEP_START:',
  stepEnd: '##FLOW_STEP_END:',
  done: '##FLOW_DONE:'
} as const;

function emitMarker(kind: keyof typeof MARKER, payload: unknown, enabled: boolean): void {
  if (!enabled) return;
  console.log(`${MARKER[kind]}${JSON.stringify(payload)}##`);
}

function createRunId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return `${ts}-${Math.random().toString(36).slice(2, 6)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectErrorLines(output: string[]): string[] {
  const hits = output.filter((line) => ERROR_PATTERNS.some((re) => re.test(line)));
  return hits.slice(-MAX_ERROR_LINES).map((line) => line.trim());
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `${min}m${sec}s` : `${sec}s`;
}

interface ExecOutcome {
  exitCode: number | null;
  errorLines: string[];
}

/** 启动单个 spec 子进程，日志直接写入 logFile */
function execSpec(
  spec: string,
  env: NodeJS.ProcessEnv,
  logFile: string,
  verbose: boolean
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    // 目录可能被外部清理，写入前确保存在
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    // 日志写入失败不应中断整条流程，降级为只在内存保留 tail
    let logWritable = true;
    logStream.on('error', (error) => {
      logWritable = false;
      console.warn(`[orchestrator] 日志写入失败，本步骤仅保留内存日志: ${error.message}`);
    });
    const tail: string[] = [];
    const child = spawn('npx', ['playwright', 'test', spec], {
      cwd: process.cwd(),
      env,
      shell: process.platform === 'win32' ? false : true
    });

    const consume = (chunk: Buffer) => {
      const text = chunk.toString();
      if (logWritable) logStream.write(text);
      if (verbose) process.stdout.write(text);
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 400) tail.shift();
      }
    };

    child.stdout.on('data', consume);
    child.stderr.on('data', consume);

    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      try {
        logStream.end();
      } catch {
        // 忽略关闭异常，不影响流程继续
      }
      resolve({ exitCode, errorLines: collectErrorLines(tail) });
    };

    child.on('error', (error) => {
      const message = `[orchestrator] 子进程启动失败: ${error.message}`;
      logStream.write(`${message}\n`);
      tail.push(message);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

function summarise(
  flow: FlowDefinition,
  runId: string,
  runDir: string,
  steps: StepResult[],
  flowStart: number,
  aborted: boolean
): FlowRunResult {
  return {
    runId,
    flowName: flow.name,
    description: flow.description,
    startedAt: new Date(flowStart).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - flowStart,
    total: flow.steps.length,
    passed: steps.filter((s) => s.status === 'passed').length,
    failed: steps.filter((s) => s.status === 'failed').length,
    skipped: steps.filter((s) => s.status === 'skipped').length,
    aborted,
    steps
  };
}

function printPlan(flow: FlowDefinition, runId: string, runDir: string): void {
  console.log('══════════════════════════════════════════════');
  console.log(`  串联执行：${flow.name}`);
  if (flow.description) console.log(`  说明：${flow.description}`);
  console.log(`  runId：${runId}`);
  console.log(`  失败策略：${flow.continueOnFailure ?? true ? '继续执行后续步骤' : '立即中断'}`);
  console.log(`  产物目录：${path.relative(process.cwd(), runDir)}`);
  console.log('──────────────────────────────────────────────');
  flow.steps.forEach((step, i) => {
    const item = findCatalogItem(step.id)!;
    const flags = [
      step.disabled ? '已禁用' : '',
      step.stopOnFailure ? '失败中断' : '',
      step.env ? `env×${Object.keys(step.env).length}` : ''
    ].filter(Boolean);
    const suffix = flags.length > 0 ? `  [${flags.join(' / ')}]` : '';
    console.log(`  ${String(i + 1).padStart(2, ' ')}. ${item.groupLabel} · ${item.name}${suffix}`);
  });
  console.log('══════════════════════════════════════════════');
}

function printSummary(result: FlowRunResult, runDir: string): void {
  console.log('\n══════════════════════════════════════════════');
  console.log(`  执行汇总：${result.flowName}`);
  console.log(
    `  总计 ${result.total} · 通过 ${result.passed} · 失败 ${result.failed} · 跳过 ${result.skipped}` +
      ` · 耗时 ${formatDuration(result.durationMs)}`
  );
  console.log('──────────────────────────────────────────────');
  const icon = { passed: '✅', failed: '❌', skipped: '⏭ ' } as const;
  for (const step of result.steps) {
    const time = step.status === 'skipped' ? '-' : formatDuration(step.durationMs);
    console.log(`  ${icon[step.status]} ${String(step.index).padStart(2, ' ')}. ${step.name}  ${time}`);
    if (step.status === 'failed' && step.errorLines.length > 0) {
      step.errorLines.slice(0, 3).forEach((line) => console.log(`        ↳ ${line}`));
      console.log(`        ↳ 完整日志: ${step.logFile}`);
    }
  }
  console.log('──────────────────────────────────────────────');
  console.log(`  产物目录：${path.relative(process.cwd(), runDir)}`);
  console.log('══════════════════════════════════════════════');
}

export async function runFlow(
  flow: FlowDefinition,
  options: RunFlowOptions = {}
): Promise<FlowRunResult> {
  const { verbose = true, dryRun = false, emitMarkers = false } = options;
  const continueOnFailure = flow.continueOnFailure ?? true;
  const runId = createRunId();
  // 必须放在 playwright.config.ts 的 outputDir(quality-artifacts) 之外：
  // Playwright 每次启动都会清空 outputDir，会把正在写入的流程日志一起删掉
  const runDir = path.resolve(
    options.outputDir ?? path.resolve(process.cwd(), 'flow-artifacts'),
    runId
  );
  fs.mkdirSync(runDir, { recursive: true });

  const flowStart = Date.now();
  const steps: StepResult[] = [];
  let aborted = false;

  printPlan(flow, runId, runDir);
  emitMarker(
    'plan',
    {
      runId,
      flowName: flow.name,
      description: flow.description,
      continueOnFailure,
      steps: flow.steps.map((step, i) => {
        const item = findCatalogItem(step.id)!;
        return {
          index: i + 1,
          id: item.id,
          name: item.name,
          group: item.group,
          groupLabel: item.groupLabel,
          disabled: step.disabled === true,
          stopOnFailure: step.stopOnFailure === true
        };
      })
    },
    emitMarkers
  );

  if (dryRun) {
    return summarise(flow, runId, runDir, steps, flowStart, false);
  }

  for (let i = 0; i < flow.steps.length; i += 1) {
    const step = flow.steps[i];
    const item = findCatalogItem(step.id)!;
    const index = i + 1;
    const label = `[${index}/${flow.steps.length}] ${item.name} (${item.id})`;

    if (aborted || step.disabled) {
      const skipReason = aborted ? '上游步骤失败且已设置中断' : '步骤被显式禁用';
      const now = new Date().toISOString();
      console.log(`⏭  ${label} → 跳过：${skipReason}`);
      emitMarker(
        'stepEnd',
        { index, id: item.id, status: 'skipped', durationMs: 0, skipReason },
        emitMarkers
      );
      steps.push({
        index,
        id: item.id,
        name: item.name,
        group: item.group,
        status: 'skipped',
        exitCode: null,
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        errorLines: [],
        skipReason
      });
      continue;
    }

    console.log(`\n▶  ${label} → ${item.spec}`);
    emitMarker(
      'stepStart',
      { index, id: item.id, name: item.name, spec: item.spec, total: flow.steps.length },
      emitMarkers
    );
    const stepStart = Date.now();
    const startedAt = new Date().toISOString();
    const logFile = path.join(runDir, `${String(index).padStart(2, '0')}-${item.id}.log`);
    const outcome = await execSpec(
      item.spec,
      { ...process.env, FORCE_COLOR: '0', ...flow.env, ...step.env },
      logFile,
      verbose
    );

    const durationMs = Date.now() - stepStart;
    const passed = outcome.exitCode === 0;
    steps.push({
      index,
      id: item.id,
      name: item.name,
      group: item.group,
      status: passed ? 'passed' : 'failed',
      exitCode: outcome.exitCode,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs,
      logFile: path.relative(process.cwd(), logFile),
      errorLines: passed ? [] : outcome.errorLines
    });

    console.log(
      `${passed ? '✅' : '❌'}  ${label} → ${passed ? '通过' : `失败 (exit=${outcome.exitCode})`}` +
        ` 耗时 ${formatDuration(durationMs)}`
    );
    emitMarker(
      'stepEnd',
      {
        index,
        id: item.id,
        status: passed ? 'passed' : 'failed',
        exitCode: outcome.exitCode,
        durationMs,
        errorLines: passed ? [] : outcome.errorLines.slice(0, 5)
      },
      emitMarkers
    );

    if (!passed && (step.stopOnFailure || !continueOnFailure)) {
      console.log('⛔  已配置失败中断，后续步骤将全部跳过');
      aborted = true;
      continue;
    }

    const delayMs = step.delayMs ?? flow.delayMs ?? 0;
    if (delayMs > 0 && i < flow.steps.length - 1) {
      console.log(`⏳  等待 ${delayMs}ms 后执行下一步（等待链上索引）`);
      await sleep(delayMs);
    }
  }

  const result = summarise(flow, runId, runDir, steps, flowStart, aborted);
  try {
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'summary.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8'
    );
  } catch (error) {
    console.warn(
      `[orchestrator] 汇总写入失败: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  printSummary(result, runDir);
  emitMarker(
    'done',
    {
      runId,
      total: result.total,
      passed: result.passed,
      failed: result.failed,
      skipped: result.skipped,
      durationMs: result.durationMs,
      aborted: result.aborted
    },
    emitMarkers
  );
  return result;
}
