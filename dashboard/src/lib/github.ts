const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;
const GITHUB_OWNER = process.env.GITHUB_OWNER!;
const GITHUB_REPO = process.env.GITHUB_REPO!;
const WORKFLOW_FILE = process.env.GITHUB_WORKFLOW_FILE ?? 'qa.yml';
const BASE = 'https://api.github.com';

function headers() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

/** Trigger a workflow_dispatch event for a specific test script */
export async function triggerWorkflow(testScript: string, testId: string) {
  const url = `${BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;

  const res = await fetch(url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      ref: 'main',
      inputs: { test_script: testScript, test_id: testId },
    }),
  });

  if (!res.ok && res.status !== 204) {
    const body = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${body}`);
  }

  // GitHub returns 204 No Content on success; wait a moment then find the run ID
  await new Promise((r) => setTimeout(r, 3_000));
  return findLatestRunId(testId);
}

/** Find the most recently created workflow run for this test */
async function findLatestRunId(testId: string): Promise<number | null> {
  const url = `${BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=5&event=workflow_dispatch`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return null;

  const data = await res.json();
  const run = data.workflow_runs?.[0];
  return run ? run.id : null;
}

export interface WorkflowRunStatus {
  id: number;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  run_started_at: string | null;
}

/** Poll the status of a specific workflow run */
export async function getRunStatus(runId: number): Promise<WorkflowRunStatus> {
  const url = `${BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${runId}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`Failed to get run status: ${res.status}`);
  return res.json();
}

/** Get the latest workflow run for the workflow (for initial status check) */
export async function getLatestRun(): Promise<WorkflowRunStatus | null> {
  const url = `${BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=1`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return null;
  const data = await res.json();
  return data.workflow_runs?.[0] ?? null;
}
