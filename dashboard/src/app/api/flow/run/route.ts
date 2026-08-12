import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { promises as fs, existsSync } from 'fs';
import path from 'path';

import type {
  FlowDependencyIssue,
  FlowRunStatus,
  FlowStepState,
  FlowTemplate,
} from '@/lib/flow';

/**
 * 串联执行入口。
 *
 * 复用 cetus 侧的 orchestrator CLI（`npm run flow -- run ... --emit-markers`），
 * dashboard 不重复实现调度、失败策略与日志落盘逻辑，只解析 ##FLOW_*## 标记
 * 还原每步实时状态。
 */

const isWin = process.platform === 'win32';
const nodeExec = process.execPath;
const nodeDir = path.dirname(nodeExec);
const WIN_NPM_CLI = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');

const CETUS_ROOT = path.resolve(process.cwd(), '..', 'cetus');
const FLOW_DIR = path.join(CETUS_ROOT, 'validation-suite', 'orchestrator', 'flows');
/** dashboard 临时写入的流程文件前缀，与用户保存的模板区分 */
const TEMP_PREFIX = '_dashboard-run-';

const spawnNPM = (args: string[], opts: object) => {
  if (isWin) {
    return spawn(nodeExec, [WIN_NPM_CLI, ...args], opts as Parameters<typeof spawn>[2]);
  }
  return spawn('npm', args, { ...(opts as object), shell: true } as Parameters<typeof spawn>[2]);
};

interface FlowRun {
  process: ReturnType<typeof spawn>;
  status: 'running' | 'completed' | 'failed';
  flowName: string;
  steps: FlowStepState[];
  summary?: FlowRunStatus['summary'];
  /** 计划阶段的依赖校验结果 */
  issues?: FlowDependencyIssue[];
  output: string[];
  startTime: number;
  endTime?: number;
  /** 执行结束后需要清理的临时流程文件 */
  tempFile?: string;
}

const flowRuns = new Map<string, FlowRun>();

/** 单机同一时刻只允许一条流程在跑：主网真实交易共用一个钱包，并发会争用 gas coin */
function findRunningFlow(): { runId: string; run: FlowRun } | null {
  for (const [runId, run] of Array.from(flowRuns.entries())) {
    if (run.status === 'running') return { runId, run };
  }
  return null;
}

function finalizeRun(runId: string, status: 'completed' | 'failed') {
  const run = flowRuns.get(runId);
  if (!run) return;
  run.status = status;
  run.endTime = Date.now();
  // 未收到结束标记的步骤按跳过处理，避免前端一直停在"执行中"
  run.steps.forEach((s) => {
    if (s.status === 'running' || s.status === 'pending') {
      s.status = 'skipped';
      s.skipReason = s.skipReason ?? '流程已结束但未收到该步骤结果';
    }
  });
  if (run.tempFile) {
    fs.rm(run.tempFile, { force: true }).catch(() => undefined);
  }
  setTimeout(() => flowRuns.delete(runId), 30 * 60 * 1000);
}

const MARKER_RE = /##FLOW_(PLAN|STEP_START|STEP_END|DONE):([\s\S]*?)##(?:\r?\n|$)/g;

interface PlanPayload {
  runId: string;
  flowName: string;
  issues?: FlowDependencyIssue[];
  steps: {
    index: number;
    id: string;
    key?: string;
    name: string;
    group: string;
    groupLabel: string;
    disabled: boolean;
    stopOnFailure: boolean;
    requires?: string[];
    provides?: string[];
    consumes?: string[];
    destructive?: boolean;
  }[];
}

interface StepStartPayload {
  index: number;
  id: string;
}

interface StepEndPayload {
  index: number;
  id: string;
  status: 'passed' | 'failed' | 'skipped' | 'blocked';
  durationMs: number;
  errorLines?: string[];
  skipReason?: string;
  missingResources?: string[];
}

interface DonePayload {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  blocked?: number;
  aborted: boolean;
}

/** 解析子进程输出中的进度标记，就地更新 run 状态 */
function applyMarkers(run: FlowRun, chunk: string) {
  // 用 exec 循环而非 matchAll：dashboard 的 tsconfig target 不支持迭代器
  MARKER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKER_RE.exec(chunk)) !== null) {
    const [, kind, json] = match;
    let payload: unknown;
    try {
      payload = JSON.parse(json);
    } catch {
      console.warn('[flow/run] 无法解析进度标记:', json.slice(0, 120));
      continue;
    }

    if (kind === 'PLAN') {
      const plan = payload as PlanPayload;
      run.flowName = plan.flowName || run.flowName;
      run.issues = plan.issues;
      run.steps = plan.steps.map((s) => ({
        index: s.index,
        id: s.id,
        key: s.key,
        name: s.name,
        groupLabel: s.groupLabel,
        status: 'pending',
        stopOnFailure: s.stopOnFailure,
        disabled: s.disabled,
        requires: s.requires,
        provides: s.provides,
        consumes: s.consumes,
        destructive: s.destructive,
      }));
    } else if (kind === 'STEP_START') {
      const { index } = payload as StepStartPayload;
      const step = run.steps.find((s) => s.index === index);
      if (step) step.status = 'running';
    } else if (kind === 'STEP_END') {
      const end = payload as StepEndPayload;
      const step = run.steps.find((s) => s.index === end.index);
      if (step) {
        step.status = end.status;
        step.durationMs = end.durationMs;
        step.errorLines = end.errorLines;
        step.skipReason = end.skipReason;
        step.missingResources = end.missingResources;
      }
    } else if (kind === 'DONE') {
      run.summary = payload as DonePayload;
    }
  }
}

function toFileSlug(name: string): string {
  const slug = name
    .trim()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('流程名无法转换为合法文件名');
  return slug;
}

/**
 * 解析待执行的流程文件名（不含 .json）。
 * - templateName：直接执行已保存的模板
 * - flow：临时编排，先落地成临时文件再交给 CLI，执行结束自动清理
 */
async function resolveFlowTarget(body: {
  templateName?: string;
  flow?: FlowTemplate;
}): Promise<{ flowArg: string; flowName: string; tempFile?: string }> {
  if (body.templateName) {
    const slug = toFileSlug(body.templateName);
    const file = path.join(FLOW_DIR, `${slug}.json`);
    if (!existsSync(file)) throw new Error(`流程模板不存在: ${body.templateName}`);
    return { flowArg: slug, flowName: body.templateName };
  }

  const flow = body.flow;
  if (!flow || !Array.isArray(flow.steps) || flow.steps.length === 0) {
    throw new Error('请至少选择一个功能');
  }

  const slug = `${TEMP_PREFIX}${Date.now()}`;
  const tempFile = path.join(FLOW_DIR, `${slug}.json`);
  const payload: FlowTemplate = {
    name: slug,
    description: flow.description || '由 Dashboard 临时编排，执行后自动清理',
    continueOnFailure: flow.continueOnFailure ?? true,
    delayMs: flow.delayMs,
    ignoreDependencies: flow.ignoreDependencies,
    steps: flow.steps,
  };

  await fs.mkdir(FLOW_DIR, { recursive: true });
  await fs.writeFile(tempFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { flowArg: slug, flowName: flow.name?.trim() || '临时流程', tempFile };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const existing = findRunningFlow();
    if (existing) {
      return NextResponse.json({
        success: true,
        runId: existing.runId,
        alreadyRunning: true,
        message: '已有流程正在执行，返回其 runId 继续轮询',
      });
    }

    const { flowArg, flowName, tempFile } = await resolveFlowTarget(body);
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0' };
    if (body.appUrl) env.APP_URL = body.appUrl;

    console.log(`[flow/${runId}] 启动串联执行: ${flowName} (${flowArg})`);

    // detached: 让子进程自成进程组，中止时可用 kill(-pid) 连带终止 playwright 子进程
    const child = spawnNPM(['run', 'flow', '--', 'run', flowArg, '--emit-markers'], {
      cwd: CETUS_ROOT,
      env,
      detached: !isWin,
    });

    const run: FlowRun = {
      process: child,
      status: 'running',
      flowName,
      steps: [],
      output: [],
      startTime: Date.now(),
      tempFile,
    };
    flowRuns.set(runId, run);

    const consume = (data: Buffer) => {
      const text = data.toString();
      run.output.push(text);
      // 只保留最近若干块，长流程输出量很大
      if (run.output.length > 2000) run.output.splice(0, run.output.length - 2000);
      applyMarkers(run, text);
    };

    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);

    child.on('close', (code) => {
      console.log(`[flow/${runId}] 执行结束 exit=${code}`);
      finalizeRun(runId, code === 0 ? 'completed' : 'failed');
    });
    child.on('error', (err) => {
      run.output.push(`[flow] 子进程启动失败: ${err.message}\n`);
      finalizeRun(runId, 'failed');
    });

    return NextResponse.json({ success: true, runId, flowName });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[flow/run] 启动失败:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const runId = req.nextUrl.searchParams.get('runId');

  if (!runId) {
    const runs = Array.from(flowRuns.entries()).map(([id, run]) => ({
      runId: id,
      flowName: run.flowName,
      status: run.status,
      duration: (run.endTime ?? Date.now()) - run.startTime,
      summary: run.summary,
    }));
    return NextResponse.json({ runs: runs.reverse().slice(0, 20) });
  }

  const run = flowRuns.get(runId);
  if (!run) {
    return NextResponse.json({ error: '流程执行记录不存在或已过期' }, { status: 404 });
  }

  const payload: FlowRunStatus = {
    runId,
    status: run.status,
    flowName: run.flowName,
    duration: (run.endTime ?? Date.now()) - run.startTime,
    steps: run.steps,
    summary: run.summary,
    issues: run.issues,
    output: run.output,
  };
  return NextResponse.json(payload);
}

/** 中止正在执行的流程 */
export async function DELETE(req: NextRequest) {
  const runId = req.nextUrl.searchParams.get('runId');
  if (!runId) {
    return NextResponse.json({ error: '缺少 runId 参数' }, { status: 400 });
  }

  const run = flowRuns.get(runId);
  if (!run) {
    return NextResponse.json({ error: '流程执行记录不存在' }, { status: 404 });
  }
  if (run.status !== 'running') {
    return NextResponse.json({ success: true, message: '流程已结束' });
  }

  // 负 pid 终止整个进程组，确保 CLI 派生的 playwright 子进程一并退出
  try {
    if (isWin) {
      run.process.kill();
    } else if (run.process.pid) {
      process.kill(-run.process.pid, 'SIGTERM');
    }
  } catch {
    run.process.kill('SIGKILL');
  }

  run.output.push('\n[flow] 已收到中止请求，正在终止流程…\n');
  return NextResponse.json({ success: true, message: '已发送中止信号' });
}
